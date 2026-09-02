import { createRequire } from 'node:module';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { satisfies, validRange } from 'semver';
import { ResolutionConflictError } from './errors.js';
import { packageIdentityFromResolvedSource, packageIdentityHash } from './package-identity.js';
import { sanitizePersistedLocator } from './lockfile.js';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const require = createRequire(import.meta.url);
/**
 * Default adapter for npm's tree interpreter. It never calls reify(), so Arborist
 * cannot write node_modules or run lifecycle scripts on Node Glue's behalf.
 */
export class NpmArboristAdapter {
    projectRoot;
    options;
    constructor(projectRoot, options) {
        this.projectRoot = projectRoot;
        this.options = options;
    }
    async loadVirtual() {
        return this.run('loadVirtual');
    }
    async buildIdealTree() {
        return this.run('buildIdealTree');
    }
    async run(method) {
        const Arborist = require('@npmcli/arborist');
        const arborist = new Arborist({
            path: this.projectRoot,
            ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
            ignoreScripts: true,
            binLinks: false,
            packageLockOnly: true,
            ...(this.options.includeDevDependencies === false ? { omit: ['dev'] } : {})
        });
        const result = await arborist[method]();
        return result;
    }
}
export class DefaultArboristAdapterFactory {
    create(projectRoot, options) {
        return new NpmArboristAdapter(projectRoot, options);
    }
}
/**
 * Resolves an npm tree into Node Glue's source-aware, placement-preserving graph.
 * Arborist is used only for no-lockfile ideal-tree construction; lockfile inputs
 * are normalized directly from InputReader's already validated representation.
 */
export class DependencyResolver {
    options;
    constructor(options = {}) {
        this.options = options;
    }
    async resolve(input, options = {}) {
        const graph = input.lockfile === undefined
            ? await this.graphFromArborist(input, options)
            : this.graphFromLockfile(input, options);
        const root = graph.find((node) => node.path === '');
        if (root === undefined) {
            throw new ResolutionConflictError('Resolved dependency graph has no project root.', {
                projectRoot: input.projectRoot,
                graphPaths: graph.map((node) => node.path)
            });
        }
        const activeNodes = graph.filter((node) => this.includeNode(node, options, input.projectRoot));
        const selectedByPath = new Map();
        const sources = [];
        const packages = [];
        const packageByHash = new Map();
        for (const node of activeNodes) {
            if (node.path === '')
                continue;
            const source = await this.sourceForNode(node, input, options);
            const identity = packageIdentityFromResolvedSource(source);
            const identityHash = packageIdentityHash(identity);
            const instance = {
                identity,
                identityHash,
                // Content is acquired by PackageStore after resolution. Resolver never fetches/reifies it.
                contentPath: '',
                manifest: source.manifest ?? node.package,
                verifiedAt: this.options.now?.() ?? new Date(0).toISOString()
            };
            const selected = { graph: node, source, instance };
            selectedByPath.set(node.path, selected);
            if (!sources.some((candidate) => sameSource(candidate, source)))
                sources.push(source);
            if (!packageByHash.has(identityHash)) {
                packageByHash.set(identityHash, instance);
                packages.push(instance);
            }
        }
        this.validateRootDependencies(root, activeNodes, selectedByPath, options, input.projectRoot);
        for (const node of activeNodes) {
            if (node.path === '')
                continue;
            this.validateDependencies(node, activeNodes, selectedByPath, options, input.projectRoot);
        }
        const placements = activeNodes
            .filter((node) => node.path !== '')
            .map((node) => {
            const selected = selectedByPath.get(node.path);
            if (selected === undefined) {
                throw new ResolutionConflictError('Resolved package was not assigned a Package Instance.', {
                    packageName: node.name,
                    graphPaths: [node.path]
                });
            }
            const peerContext = this.peerContext(node, activeNodes, selectedByPath, options, input.projectRoot);
            return {
                relativePath: normalizePlacementPath(node.path),
                packageIdentityHash: selected.instance.identityHash,
                packageName: node.name,
                ...(peerContext === undefined ? {} : { peerContext }),
                ...(node.bin === undefined ? {} : { binEntries: node.bin })
            };
        })
            .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        return {
            projectRoot: input.projectRoot,
            // A no-lockfile graph is keyed by package.json until LockfileWriter publishes it.
            lockfileHash: input.lockfileHash ?? input.packageJsonHash,
            placements,
            sources: sources.sort(compareSources),
            packages: packages.sort((left, right) => left.identityHash.localeCompare(right.identityHash))
        };
    }
    async graphFromArborist(input, options) {
        const adapter = this.options.arborist
            ?? this.options.arboristFactory?.create(input.projectRoot, options)
            ?? new DefaultArboristAdapterFactory().create(input.projectRoot, options);
        const tree = await adapter.buildIdealTree(input, options);
        return graphFromTree(tree, input.packageManifest);
    }
    graphFromLockfile(input, _options) {
        const lockfile = input.lockfile;
        if (lockfile === undefined)
            return [];
        const graph = lockfile.packages.map((entry) => graphFromLockfilePackage(entry, input.packageManifest));
        if (!graph.some((node) => node.path === '')) {
            graph.unshift({
                path: '',
                name: input.packageManifest.name,
                version: input.packageManifest.version,
                package: input.packageManifest,
                dependencies: input.packageManifest.dependencies ?? {},
                optionalDependencies: input.packageManifest.optionalDependencies ?? {},
                peerDependencies: input.packageManifest.peerDependencies ?? {},
                peerDependenciesMeta: input.packageManifest.peerDependenciesMeta ?? {},
                dev: false,
                optional: false,
                devOptional: false
            });
        }
        return graph;
    }
    includeNode(node, options, projectRoot) {
        if (node.path === '')
            return true;
        if (options.includeDevDependencies === false && node.dev)
            return false;
        const platformMatch = matchesPlatform(node.os, process.platform)
            && matchesPlatform(node.cpu, process.arch);
        if (!platformMatch) {
            if (node.optional)
                return false;
            throw new ResolutionConflictError('Required package is incompatible with the current platform.', {
                packageName: node.name,
                graphPaths: [node.path],
                projectRoot,
                platform: process.platform,
                arch: process.arch
            });
        }
        return true;
    }
    async sourceForNode(node, input, options) {
        if (node.source !== undefined && this.options.sourceAdapter !== undefined) {
            const resolved = await this.options.sourceAdapter.resolve(node.source);
            return withManifest(resolved, node.package);
        }
        if (node.source !== undefined) {
            const resolvedLocator = sourceLocator(node.source, node.resolved);
            if (this.options.sourceAdapter !== undefined) {
                return withManifest(await this.options.sourceAdapter.resolve(node.source), node.package);
            }
            return {
                source: node.source,
                name: node.name,
                versionOrRevision: node.version ?? node.package.version,
                ...(node.integrity === undefined ? {} : { integrity: node.integrity }),
                resolvedLocator,
                sourceFingerprint: `${node.source.kind}:${resolvedLocator}`,
                manifest: node.package
            };
        }
        const source = sourceFromLocator(node.name, node.version ?? node.package.version, node.resolved, node.integrity, options.registry ?? DEFAULT_REGISTRY, input.projectRoot);
        if (this.options.sourceAdapter !== undefined && node.resolved === undefined) {
            return withManifest(await this.options.sourceAdapter.resolve(source.source), node.package);
        }
        return { ...source, manifest: node.package };
    }
    validateRootDependencies(root, activeNodes, selectedByPath, options, projectRoot) {
        const dependencies = mergeDependencies(root, options.includeDevDependencies !== false);
        for (const [name, range] of Object.entries(dependencies)) {
            const optional = Object.prototype.hasOwnProperty.call(root.optionalDependencies, name);
            const target = findTarget(root.path, name, activeNodes);
            if (target === undefined) {
                if (optional)
                    continue;
                throw conflict(name, range, root.path, projectRoot);
            }
            assertSatisfies(target, range, root.path, selectedByPath, projectRoot);
        }
    }
    validateDependencies(node, activeNodes, selectedByPath, options, projectRoot) {
        const dependencies = mergeDependencies(node, options.includeDevDependencies !== false);
        for (const [name, range] of Object.entries(dependencies)) {
            const optional = Object.prototype.hasOwnProperty.call(node.optionalDependencies, name);
            const target = findTarget(node.path, name, activeNodes);
            if (target === undefined) {
                if (optional)
                    continue;
                throw conflict(name, range, node.path, projectRoot);
            }
            assertSatisfies(target, range, node.path, selectedByPath, projectRoot);
        }
    }
    peerContext(node, activeNodes, selectedByPath, _options, projectRoot) {
        const peers = {};
        for (const [name, range] of Object.entries(node.peerDependencies)) {
            const target = findTarget(parentPath(node.path), name, activeNodes);
            const optional = node.peerDependenciesMeta[name]?.optional === true;
            if (target === undefined) {
                if (optional)
                    continue;
                throw conflict(name, range, node.path, projectRoot);
            }
            assertSatisfies(target, range, node.path, selectedByPath, projectRoot);
            peers[name] = target.version ?? target.package.version;
        }
        return Object.keys(peers).length === 0 ? undefined : peers;
    }
}
function graphFromTree(tree, rootManifest) {
    const entries = tree.inventory === undefined
        ? []
        : [...tree.inventory].map(([path, node]) => graphNodeFromArborist(path, node));
    if (!entries.some((node) => node.path === '')) {
        const root = tree.root;
        entries.push({
            path: '',
            name: root?.name ?? rootManifest.name,
            version: root?.version ?? rootManifest.version,
            package: mergeManifest(rootManifest, root?.package),
            dependencies: root?.package?.dependencies ?? rootManifest.dependencies ?? {},
            optionalDependencies: root?.package?.optionalDependencies ?? rootManifest.optionalDependencies ?? {},
            peerDependencies: root?.package?.peerDependencies ?? rootManifest.peerDependencies ?? {},
            peerDependenciesMeta: root?.package?.peerDependenciesMeta ?? rootManifest.peerDependenciesMeta ?? {},
            dev: false,
            optional: false,
            devOptional: false,
            ...(root === undefined ? {} : { arboristNode: root })
        });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}
function graphNodeFromArborist(path, node) {
    const packageData = (node.package ?? {});
    const name = node.name ?? packageData.name ?? packageNameFromPath(path) ?? '';
    const manifest = mergeManifest({ name, version: node.version ?? packageData.version ?? '0.0.0' }, packageData);
    const bin = normalizeBin(manifest.bin, name);
    return {
        path: normalizePlacementPath(path),
        name,
        ...(node.version ?? manifest.version ? { version: node.version ?? manifest.version } : {}),
        ...(node.resolved === undefined ? {} : { resolved: node.resolved }),
        ...(node.integrity === undefined ? {} : { integrity: node.integrity }),
        package: manifest,
        dependencies: edgeDependencies(node, 'prod', manifest.dependencies),
        optionalDependencies: edgeDependencies(node, 'optional', manifest.optionalDependencies),
        peerDependencies: manifest.peerDependencies ?? {},
        peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
        ...(bin === undefined ? {} : { bin }),
        ...(manifest.os === undefined ? {} : { os: manifest.os }),
        ...(manifest.cpu === undefined ? {} : { cpu: manifest.cpu }),
        dev: node.dev === true,
        optional: node.optional === true,
        devOptional: node.devOptional === true,
        ...(node.source === undefined ? {} : { source: node.source }),
        arboristNode: node
    };
}
function graphFromLockfilePackage(entry, rootManifest) {
    const packageData = mergeManifest({
        name: entry.name,
        version: entry.version ?? (entry.path === '' ? rootManifest.version : '0.0.0')
    }, {
        ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
        ...(entry.optionalDependencies === undefined ? {} : { optionalDependencies: entry.optionalDependencies }),
        ...(entry.peerDependencies === undefined ? {} : { peerDependencies: entry.peerDependencies }),
        ...(entry.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: entry.peerDependenciesMeta }),
        ...(entry.bin === undefined ? {} : { bin: entry.bin }),
        ...(entry.os === undefined ? {} : { os: entry.os }),
        ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
        ...(entry.engines === undefined ? {} : { engines: entry.engines })
    });
    return {
        path: normalizePlacementPath(entry.path),
        name: entry.name,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        ...(entry.resolved === undefined ? {} : { resolved: entry.resolved }),
        ...(entry.integrity === undefined ? {} : { integrity: entry.integrity }),
        package: packageData,
        dependencies: entry.dependencies ?? {},
        optionalDependencies: entry.optionalDependencies ?? {},
        peerDependencies: entry.peerDependencies ?? {},
        peerDependenciesMeta: entry.peerDependenciesMeta ?? {},
        ...(entry.bin === undefined ? {} : { bin: entry.bin }),
        ...(entry.os === undefined ? {} : { os: entry.os }),
        ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
        dev: entry.dev === true,
        optional: entry.optional === true,
        devOptional: entry.devOptional === true,
        ...(entry.source === undefined ? {} : { source: entry.source })
    };
}
function sourceLocator(source, resolved) {
    if (resolved !== undefined)
        return sanitizePersistedLocator(resolved);
    switch (source.kind) {
        case 'registry': return `${stripTrailingSlash(source.registry)}/${source.name}@${source.spec}`;
        case 'directory': return source.path;
        case 'git': return `${source.locator}${source.ref === undefined ? '' : `#${source.ref}`}`;
        case 'tarball': return source.url;
    }
}
function sourceFromLocator(name, version, locator, integrity, registry, projectRoot) {
    const resolvedLocator = sanitizePersistedLocator(locator ?? `${registry}/${name}@${version}`);
    const source = dependencySourceFromLocator(name, version, resolvedLocator, registry, projectRoot);
    const sourceFingerprint = source.kind === 'registry'
        ? `registry:${source.registry}/${name}@${version}`
        : `${source.kind}:${source.kind === 'directory' ? source.path : resolvedLocator}`;
    return {
        source,
        name,
        versionOrRevision: version,
        ...(integrity === undefined ? {} : { integrity }),
        resolvedLocator: source.kind === 'directory' ? source.path : resolvedLocator,
        sourceFingerprint
    };
}
function dependencySourceFromLocator(name, version, locator, registry, projectRoot) {
    if (locator.startsWith('file:')) {
        const filePath = locator.slice('file:'.length);
        return { kind: 'directory', path: isAbsolute(filePath) ? filePath : resolvePath(projectRoot, filePath) };
    }
    if (locator.startsWith('git+') || locator.startsWith('git://') || locator.startsWith('ssh://') || locator.startsWith('git@')) {
        const hash = locator.indexOf('#');
        return {
            kind: 'git',
            locator: hash < 0 ? locator : locator.slice(0, hash),
            ...(hash < 0 ? {} : { ref: locator.slice(hash + 1) })
        };
    }
    if (isHttpUrl(locator) && !sameRegistry(locator, registry))
        return { kind: 'tarball', url: locator };
    return { kind: 'registry', registry: stripTrailingSlash(registry), name, spec: version };
}
function edgeDependencies(node, type, fallback) {
    const dependencies = {};
    for (const edge of edges(node)) {
        const edgeType = edge.type ?? (edge.optional === true ? 'optional' : 'prod');
        if (type === 'optional' ? edgeType === 'optional' : edgeType !== 'optional' && edgeType !== 'peer') {
            dependencies[edge.name] = edge.spec;
        }
    }
    return Object.keys(dependencies).length > 0 ? dependencies : fallback ?? {};
}
function edges(node) {
    if (node.edgesOut === undefined)
        return [];
    return node.edgesOut instanceof Map ? [...node.edgesOut.values()] : [...node.edgesOut];
}
function mergeDependencies(node, includeDev) {
    const result = { ...node.dependencies, ...node.optionalDependencies };
    if (includeDev) {
        Object.assign(result, node.package.devDependencies ?? {});
    }
    return result;
}
function findTarget(parent, name, nodes) {
    let current = normalizePlacementPath(parent);
    while (true) {
        const candidatePath = current === '' ? `node_modules/${name}` : `${current}/node_modules/${name}`;
        const candidate = nodes.find((node) => node.path === candidatePath);
        if (candidate !== undefined)
            return candidate;
        if (current === '')
            return undefined;
        const slash = current.lastIndexOf('/node_modules/');
        current = slash < 0 ? '' : current.slice(0, slash);
    }
}
function assertSatisfies(target, range, graphPath, selectedByPath, projectRoot) {
    const version = target.version ?? target.package.version;
    if (isSatisfied(version, range))
        return;
    const selected = selectedByPath.get(target.path);
    throw conflict(target.name, range, graphPath, projectRoot, [
        graphPath,
        target.path,
        ...(selected === undefined ? [] : [selected.source.resolvedLocator])
    ]);
}
function isSatisfied(version, range) {
    const normalized = range.trim();
    if (normalized.startsWith('npm:') || normalized.startsWith('file:') || normalized.startsWith('git') || isHttpUrl(normalized))
        return true;
    return validRange(normalized) !== null && satisfies(version, normalized, { includePrerelease: true });
}
function conflict(name, range, graphPath, projectRoot, graphPaths = [graphPath]) {
    return new ResolutionConflictError(`Cannot satisfy dependency ${name}@${range} introduced at ${graphPath}.`, { packageName: name, range, graphPaths, projectRoot });
}
function parentPath(path) {
    const marker = path.lastIndexOf('/node_modules/');
    return marker < 0 ? '' : path.slice(0, marker);
}
function normalizePlacementPath(path) {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized === '.' ? '' : normalized;
}
function packageNameFromPath(path) {
    const segments = normalizePlacementPath(path).split('/');
    const marker = segments.lastIndexOf('node_modules');
    if (marker < 0 || segments[marker + 1] === undefined)
        return undefined;
    const first = segments[marker + 1];
    const second = segments[marker + 2];
    if (first === undefined)
        return undefined;
    return first.startsWith('@') && second !== undefined ? `${first}/${second}` : first;
}
function normalizeBin(bin, packageName) {
    if (bin === undefined)
        return undefined;
    if (typeof bin === 'string')
        return { [packageName.slice(packageName.lastIndexOf('/') + 1)]: bin };
    return bin;
}
function mergeManifest(base, extra) {
    return { ...base, ...(extra ?? {}), name: extra?.name ?? base.name, version: extra?.version ?? base.version };
}
function withManifest(source, manifest) {
    return { ...source, name: manifest.name, versionOrRevision: manifest.version, manifest };
}
function sameSource(left, right) {
    return left.name === right.name
        && left.versionOrRevision === right.versionOrRevision
        && left.sourceFingerprint === right.sourceFingerprint
        && left.integrity === right.integrity;
}
function compareSources(left, right) {
    return `${left.name}@${left.versionOrRevision}:${left.resolvedLocator}`.localeCompare(`${right.name}@${right.versionOrRevision}:${right.resolvedLocator}`);
}
function matchesPlatform(values, current) {
    if (values === undefined || values.length === 0)
        return true;
    if (values.some((value) => value === `!${current}`))
        return false;
    const positives = values.filter((value) => !value.startsWith('!'));
    return positives.length === 0 || positives.includes(current);
}
function isHttpUrl(value) {
    return /^https?:\/\//i.test(value);
}
function sameRegistry(locator, registry) {
    try {
        return new URL(locator).host === new URL(registry).host;
    }
    catch {
        return false;
    }
}
function stripTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}
//# sourceMappingURL=dependency-resolver.js.map