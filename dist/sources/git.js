import { NodeGlueError } from '../errors.js';
import { extractPackageToDestination } from './archive.js';
import { archiveIntegrity, currentEnvironment, readManifestFromFile, sourceFailure, unsupportedSource } from './utils.js';
export class GitSourceAdapter {
    transport;
    filesystem;
    constructor(options) {
        this.transport = options.transport;
        this.filesystem = options.filesystem;
    }
    canHandle(source) {
        return source.kind === 'git';
    }
    async resolve(source) {
        assertGitSource(source);
        const locator = canonicalGitLocator(source.locator, source);
        let resolved;
        try {
            resolved = await this.transport.resolveGit(locator, source.ref);
        }
        catch (cause) {
            if (cause instanceof NodeGlueError)
                throw cause;
            return sourceFailure(`Cannot resolve Git source ${locator}.`, source, cause);
        }
        if (typeof resolved.revision !== 'string' || resolved.revision.length === 0 || typeof resolved.resolvedLocator !== 'string') {
            return sourceFailure(`Git transport returned invalid revision metadata for ${locator}.`, source);
        }
        const resolvedLocator = canonicalGitLocator(resolved.resolvedLocator, source, true);
        return {
            source,
            name: inferGitName(locator),
            versionOrRevision: resolved.revision,
            resolvedLocator,
            sourceFingerprint: `git:${locator}#${resolved.revision}`,
            environment: currentEnvironment()
        };
    }
    async fetch(source, destination) {
        assertResolvedGitSource(source);
        let artifact;
        try {
            artifact = await this.transport.fetch(source.resolvedLocator);
        }
        catch (cause) {
            if (cause instanceof NodeGlueError)
                throw cause;
            return sourceFailure(`Cannot fetch Git source ${source.resolvedLocator}.`, source.source, cause);
        }
        try {
            const extracted = await extractPackageToDestination(this.filesystem, artifact.data, destination, source.source);
            const manifest = await readManifestFromFile(this.filesystem, `${extracted.packageRoot}/package.json`, source.source);
            return {
                manifest,
                contentPath: extracted.packageRoot,
                contentDigest: archiveIntegrity(artifact.data),
                ...(artifact.digest === undefined ? {} : { integrity: artifact.digest })
            };
        }
        catch (cause) {
            await this.filesystem.remove(destination, { recursive: true, force: true }).catch(() => undefined);
            if (cause instanceof NodeGlueError)
                throw cause;
            return sourceFailure(`Cannot validate Git source ${source.resolvedLocator}.`, source.source, cause);
        }
    }
}
function assertGitSource(source) {
    if (typeof source !== 'object' || source === null || source.kind !== 'git' || typeof source.locator !== 'string') {
        return unsupportedSource('Source is not a Git dependency.', source);
    }
}
function assertResolvedGitSource(source) {
    if (source.source.kind !== 'git')
        return unsupportedSource('Resolved source is not a Git dependency.', source.source);
}
function canonicalGitLocator(locator, source, preserveHash = false) {
    if (/^git@[^:]+:.+/.test(locator))
        return locator;
    if (/^(?:git\+)?(?:https?|ssh|git):\/\//.test(locator)) {
        const withoutGitScheme = locator.startsWith('git+') ? locator.slice(4) : locator;
        return canonicalHttpUrlIfApplicable(withoutGitScheme, source, preserveHash);
    }
    return unsupportedSource(`Unsupported Git source format: ${locator}.`, source);
}
function canonicalHttpUrlIfApplicable(locator, source, preserveHash) {
    try {
        const parsed = new URL(locator);
        if (!preserveHash)
            parsed.hash = '';
        if (parsed.username !== '' || parsed.password !== '')
            return unsupportedSource('Credential-bearing Git URLs are not supported.', source);
        return parsed.toString().replace(/\/$/, '');
    }
    catch (cause) {
        return sourceFailure(`Invalid Git source URL: ${locator}.`, source, cause);
    }
}
function inferGitName(locator) {
    const path = locator.split(/[/:]/).pop() ?? 'git-package';
    return path.replace(/\.git$/, '') || 'git-package';
}
//# sourceMappingURL=git.js.map