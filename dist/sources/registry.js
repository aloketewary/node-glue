import { maxSatisfying, valid, validRange } from 'semver';
import { NodeGlueError } from '../errors.js';
import { extractPackageToDestination } from './archive.js';
import { archiveIntegrity, canonicalHttpUrl, currentEnvironment, readManifest, sourceDescription, sourceFailure, unsupportedSource, validatePackageName, verifyIntegrity } from './utils.js';
export class RegistrySourceAdapter {
    transport;
    filesystem;
    constructor(options) {
        this.transport = options.transport;
        this.filesystem = options.filesystem;
    }
    canHandle(source) {
        return source.kind === 'registry';
    }
    async resolve(source) {
        assertRegistrySource(source);
        const registry = canonicalHttpUrl(source.registry, source);
        const name = validatePackageName(source.name, source);
        if (source.spec.trim().length === 0 || /^[./]|^(?:file:|git:|https?:)/.test(source.spec)) {
            return unsupportedSource(`Unsupported npm registry package specifier: ${source.spec}.`, source);
        }
        let metadata;
        try {
            metadata = await this.transport.getMetadata(registry, name);
        }
        catch (cause) {
            if (cause instanceof NodeGlueError)
                throw cause;
            return sourceFailure(`Cannot reach npm registry metadata for ${name}.`, source, cause);
        }
        const version = selectVersion(metadata, source.spec, source);
        const manifest = metadata.versions[version];
        if (manifest === undefined)
            return sourceFailure(`Registry metadata has no manifest for ${name}@${version}.`, source);
        const validatedManifest = validateRegistryManifest(manifest, name, source);
        const distribution = metadata.dist?.[version];
        const resolvedLocator = distribution?.tarball === undefined
            ? `${registry}/${name}/-/${name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name}-${version}.tgz`
            : canonicalHttpUrl(distribution.tarball, source);
        return {
            source,
            name,
            versionOrRevision: version,
            ...(distribution?.integrity === undefined ? {} : { integrity: distribution.integrity }),
            resolvedLocator,
            sourceFingerprint: `registry:${registry}/${name}@${version}`,
            environment: currentEnvironment(),
            manifest: validatedManifest
        };
    }
    async fetch(source, destination) {
        assertResolvedRegistrySource(source);
        let artifact;
        try {
            artifact = await this.transport.getTarball(source.resolvedLocator);
        }
        catch (cause) {
            if (cause instanceof NodeGlueError)
                throw cause;
            return sourceFailure(`Cannot fetch registry package ${source.name}@${source.versionOrRevision}.`, source.source, cause);
        }
        verifyIntegrity(artifact.data, source.integrity, source.source);
        try {
            const extracted = await extractPackageToDestination(this.filesystem, artifact.data, destination, source.source, 'package');
            const manifest = await readManifestFromExtracted(this.filesystem, extracted.packageRoot, source.source);
            if (manifest.name !== source.name || manifest.version !== source.versionOrRevision) {
                return sourceFailure(`Registry archive metadata does not match ${source.name}@${source.versionOrRevision}.`, source.source);
            }
            return {
                manifest,
                contentPath: extracted.packageRoot,
                contentDigest: archiveIntegrity(artifact.data),
                ...(source.integrity === undefined && artifact.digest === undefined ? {} : { integrity: source.integrity ?? artifact.digest })
            };
        }
        catch (cause) {
            await this.filesystem.remove(destination, { recursive: true, force: true }).catch(() => undefined);
            if (cause instanceof NodeGlueError)
                throw cause;
            return sourceFailure(`Cannot validate registry package ${source.name}@${source.versionOrRevision}.`, source.source, cause);
        }
    }
}
function assertRegistrySource(source) {
    if (typeof source !== 'object' || source === null || source.kind !== 'registry') {
        return unsupportedSource('Source is not an npm registry dependency.', source);
    }
    if (typeof source.registry !== 'string' || typeof source.name !== 'string' || typeof source.spec !== 'string') {
        return unsupportedSource('Registry source requires registry, name, and spec fields.', source);
    }
}
function assertResolvedRegistrySource(source) {
    if (source.source.kind !== 'registry')
        return unsupportedSource('Resolved source is not an npm registry dependency.', source.source);
}
function selectVersion(metadata, spec, source) {
    const versions = Object.keys(metadata.versions);
    if (versions.length === 0)
        return sourceFailure('Registry metadata contains no package versions.', source);
    const exact = valid(spec) && metadata.versions[spec] !== undefined ? spec : undefined;
    if (exact !== undefined)
        return exact;
    const tag = metadata['dist-tags']?.[spec];
    if (tag !== undefined && metadata.versions[tag] !== undefined)
        return tag;
    const range = validRange(spec);
    if (range === null)
        return unsupportedSource(`Unsupported npm package version or tag: ${spec}.`, source);
    const selected = maxSatisfying(versions, range, { includePrerelease: true });
    if (selected === null)
        return sourceFailure(`No registry version satisfies ${spec}.`, source);
    return selected;
}
function validateRegistryManifest(manifest, expectedName, source) {
    const validated = readManifest(JSON.stringify(manifest), source, `registry:${expectedName}/package.json`);
    if (validated.name !== expectedName)
        return sourceFailure(`Registry metadata name ${validated.name} does not match ${expectedName}.`, source);
    return validated;
}
async function readManifestFromExtracted(filesystem, packageRoot, source) {
    try {
        return readManifest(await filesystem.readTextFile(`${packageRoot}/package.json`), source, `${packageRoot}/package.json`);
    }
    catch (cause) {
        if (cause instanceof NodeGlueError)
            throw cause;
        return sourceFailure(`Cannot read extracted package manifest for ${sourceDescription(source)}.`, source, cause);
    }
}
//# sourceMappingURL=registry.js.map