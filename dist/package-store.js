import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { IntegrityMismatchError, NodeGlueError, PublicationError, StoreError } from './errors.js';
import { hashPackageIdentity, normalizePackageIdentity, packageIdentityFromResolvedSource } from './package-identity.js';
import { pathWithin } from './sources/utils.js';
const DEFAULT_STORE_DIR = join(homedir(), '.node_modules');
const INSTANCE_FILE = 'instance.json';
/**
 * Stores verified package content independently of project materialization.
 *
 * The source adapter owns transport and archive extraction. PackageStore owns
 * the prepare/verify/publish boundary: source content is fetched into a
 * temporary directory, metadata is recorded alongside it, and the complete
 * directory is atomically renamed into the immutable store.
 */
export class PackageStore {
    storeDir;
    filesystem;
    sourceAdapter;
    locks;
    clock;
    inFlight = new Map();
    constructor(options) {
        this.filesystem = options.filesystem;
        this.sourceAdapter = options.sourceAdapter;
        this.storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
        this.locks = options.locks;
        this.clock = options.clock ?? systemClock;
    }
    /**
     * Ensures one resolved source is present as a verified, immutable instance.
     * Concurrent callers for the same identity share one acquisition.
     */
    async ensure(source, options = {}) {
        const identity = identityFor(source, options);
        const identityHash = hashPackageIdentity(identity);
        const existing = this.inFlight.get(identityHash);
        if (existing !== undefined)
            return existing;
        const operation = this.acquire(identity, identityHash, source);
        this.inFlight.set(identityHash, operation);
        try {
            return await operation;
        }
        finally {
            if (this.inFlight.get(identityHash) === operation)
                this.inFlight.delete(identityHash);
        }
    }
    /** Returns a fully validated published instance, or undefined when absent. */
    async get(identityHash) {
        if (!/^[a-f0-9]{64}$/.test(identityHash))
            return undefined;
        const packagesPath = join(this.storeDir, 'packages');
        if (!(await this.filesystem.exists(packagesPath)))
            return undefined;
        let names;
        try {
            names = await this.filesystem.listDirectory(packagesPath);
        }
        catch {
            return undefined;
        }
        for (const entry of names) {
            if (entry.type !== 'directory')
                continue;
            const candidate = await this.readPublishedInstance(join(packagesPath, entry.name, identityHash), identityHash);
            if (candidate !== undefined)
                return candidate;
        }
        return undefined;
    }
    async acquire(identity, identityHash, source) {
        const release = await this.acquireLock(identityHash);
        try {
            const finalDirectory = this.instanceDirectory(identity);
            const reusable = await this.readPublishedInstance(finalDirectory, identityHash);
            if (reusable !== undefined)
                return reusable;
            const finalParent = posix.dirname(finalDirectory);
            const temporaryRoot = await this.createTemporaryRoot();
            const temporaryContent = join(temporaryRoot, 'content');
            const temporaryInstance = join(temporaryRoot, INSTANCE_FILE);
            let published = false;
            try {
                await this.filesystem.mkdir(temporaryContent, { recursive: true });
                const fetched = await this.sourceAdapter.fetch(source, temporaryContent);
                this.validateFetchedPackage(fetched, source, identity, temporaryRoot, temporaryContent);
                const instance = {
                    identity,
                    identityHash,
                    contentPath: join(finalDirectory, 'content'),
                    manifest: fetched.manifest,
                    verifiedAt: this.clock.nowIso()
                };
                await this.filesystem.writeFile(temporaryInstance, serializeInstance(instance));
                await this.syncPreparedPublication(temporaryContent, temporaryInstance, temporaryRoot);
                await this.filesystem.mkdir(finalParent, { recursive: true });
                // A valid publication would have returned above. Refuse to replace an
                // ambiguous identity directory rather than risking loss of content.
                if (await this.filesystem.exists(finalDirectory)) {
                    throw new PublicationError('Package identity path exists but is not a valid published instance.', {
                        identityHash,
                        path: finalDirectory
                    });
                }
                await this.filesystem.rename(temporaryRoot, finalDirectory);
                published = true;
                await this.filesystem.sync(finalDirectory);
                await this.filesystem.sync(finalParent);
                return instance;
            }
            catch (cause) {
                if (cause instanceof NodeGlueError)
                    throw cause;
                throw new StoreError('Package instance acquisition or publication failed.', {
                    identityHash,
                    path: finalDirectory
                }, cause);
            }
            finally {
                if (!published) {
                    await this.filesystem.remove(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
                }
            }
        }
        finally {
            await release?.release();
        }
    }
    async acquireLock(identityHash) {
        if (this.locks === undefined)
            return undefined;
        try {
            return await this.locks.acquire(`package:${identityHash}`, { owner: 'node-glue-package-store' });
        }
        catch (cause) {
            throw new StoreError('Could not acquire package identity lock.', { identityHash }, cause);
        }
    }
    async createTemporaryRoot() {
        const temporaryParent = join(this.storeDir, 'tmp');
        await this.filesystem.mkdir(temporaryParent, { recursive: true });
        return this.filesystem.createTemporaryDirectory(temporaryParent, '.node-glue-package');
    }
    async syncPreparedPublication(contentPath, instancePath, temporaryRoot) {
        await this.filesystem.sync(contentPath);
        await this.filesystem.sync(instancePath);
        await this.filesystem.sync(temporaryRoot);
    }
    instanceDirectory(identity) {
        return join(this.storeDir, 'packages', encodePackageName(identity.name), hashPackageIdentity(identity));
    }
    validateFetchedPackage(fetched, source, identity, temporaryRoot, requestedContentPath) {
        if (!pathWithin(fetched.contentPath, temporaryRoot) || resolve(fetched.contentPath) !== resolve(requestedContentPath)) {
            throw new StoreError('Source adapter returned content outside its temporary acquisition path.', {
                source: source.resolvedLocator,
                contentPath: fetched.contentPath
            });
        }
        if (fetched.manifest.name !== identity.name || fetched.manifest.version !== identity.versionOrRevision) {
            throw new StoreError('Fetched package manifest does not match resolved package identity.', {
                source: source.resolvedLocator,
                packageName: identity.name,
                versionOrRevision: identity.versionOrRevision
            });
        }
        if (source.integrity !== undefined) {
            const observedIntegrity = fetched.integrity ?? fetched.contentDigest;
            if (observedIntegrity === undefined || observedIntegrity.trim().length === 0) {
                throw new IntegrityMismatchError('Source integrity was provided but the fetched package did not provide verification evidence.', {
                    source: source.resolvedLocator,
                    integrity: source.integrity
                });
            }
            if (!integritiesOverlap(source.integrity, observedIntegrity)) {
                throw new IntegrityMismatchError('Fetched source integrity does not match resolved source integrity.', {
                    source: source.resolvedLocator,
                    integrity: source.integrity
                });
            }
        }
        else if (fetched.integrity !== undefined && fetched.integrity.trim().length === 0) {
            throw new IntegrityMismatchError('Fetched package integrity is empty.', {
                source: source.resolvedLocator
            });
        }
        else if (fetched.contentDigest !== undefined && fetched.contentDigest.trim().length === 0) {
            throw new IntegrityMismatchError('Fetched package content digest is empty.', {
                source: source.resolvedLocator
            });
        }
    }
    async readPublishedInstance(instanceDirectory, expectedHash) {
        const instancePath = join(instanceDirectory, INSTANCE_FILE);
        if (!(await this.filesystem.exists(instancePath)))
            return undefined;
        try {
            const parsed = JSON.parse(await this.filesystem.readTextFile(instancePath));
            if (!isPackageInstance(parsed) || parsed.identityHash !== expectedHash)
                return undefined;
            const identity = normalizePackageIdentity(parsed.identity);
            if (hashPackageIdentity(identity) !== expectedHash)
                return undefined;
            const expectedContent = join(instanceDirectory, 'content');
            if (resolve(parsed.contentPath) !== resolve(expectedContent))
                return undefined;
            const content = await this.filesystem.lstat(expectedContent);
            if (content.type !== 'directory')
                return undefined;
            if (parsed.manifest.name !== identity.name || parsed.manifest.version !== identity.versionOrRevision)
                return undefined;
            return { ...parsed, identity, contentPath: expectedContent };
        }
        catch {
            return undefined;
        }
    }
}
function identityFor(source, options) {
    const base = packageIdentityFromResolvedSource(source);
    if (options.environment === undefined)
        return base;
    return normalizePackageIdentity({ ...base, environment: options.environment });
}
function encodePackageName(name) {
    // Keep scoped names readable while encoding separators and traversal tokens.
    const readable = name.startsWith('@') ? name.slice(1).replaceAll('/', '+') : name;
    const encoded = encodeURIComponent(readable).replaceAll('%2B', '+');
    return encoded === '.' || encoded === '..' ? `%${encoded}` : encoded;
}
function serializeInstance(instance) {
    return `${JSON.stringify(instance, null, 2)}\n`;
}
function integritiesOverlap(left, right) {
    const rightTokens = new Set(right.trim().split(/\s+/).filter(Boolean));
    return left.trim().split(/\s+/).filter(Boolean).some((token) => rightTokens.has(token));
}
function isPackageInstance(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    const identity = candidate.identity;
    const manifest = candidate.manifest;
    return typeof candidate.identityHash === 'string'
        && typeof candidate.contentPath === 'string'
        && typeof candidate.verifiedAt === 'string'
        && typeof identity === 'object'
        && identity !== null
        && typeof manifest === 'object'
        && manifest !== null
        && typeof manifest.name === 'string'
        && typeof manifest.version === 'string';
}
const systemClock = {
    now: () => new Date(),
    nowIso: () => new Date().toISOString()
};
export function packageStorePath(storeDir, identity) {
    return join(storeDir, 'packages', encodePackageName(identity.name), hashPackageIdentity(identity));
}
//# sourceMappingURL=package-store.js.map