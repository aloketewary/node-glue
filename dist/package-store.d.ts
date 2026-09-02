import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { LockAdapter } from './adapters/locks.js';
import type { SourceAdapter } from './adapters/source.js';
import type { Clock } from './adapters/time.js';
import type { PackageIdentity, PackageInstance, ResolvedSource, StoreOptions } from './types.js';
export interface PackageStoreOptions {
    filesystem: FileSystemAdapter;
    sourceAdapter: SourceAdapter;
    storeDir?: string;
    locks?: LockAdapter;
    clock?: Clock;
}
/**
 * Stores verified package content independently of project materialization.
 *
 * The source adapter owns transport and archive extraction. PackageStore owns
 * the prepare/verify/publish boundary: source content is fetched into a
 * temporary directory, metadata is recorded alongside it, and the complete
 * directory is atomically renamed into the immutable store.
 */
export declare class PackageStore {
    readonly storeDir: string;
    private readonly filesystem;
    private readonly sourceAdapter;
    private readonly locks;
    private readonly clock;
    private readonly inFlight;
    constructor(options: PackageStoreOptions);
    /**
     * Ensures one resolved source is present as a verified, immutable instance.
     * Concurrent callers for the same identity share one acquisition.
     */
    ensure(source: ResolvedSource, options?: StoreOptions): Promise<PackageInstance>;
    /** Returns a fully validated published instance, or undefined when absent. */
    get(identityHash: string): Promise<PackageInstance | undefined>;
    private acquire;
    private acquireLock;
    private createTemporaryRoot;
    private syncPreparedPublication;
    private instanceDirectory;
    private validateFetchedPackage;
    private readPublishedInstance;
}
export declare function packageStorePath(storeDir: string, identity: PackageIdentity): string;
//# sourceMappingURL=package-store.d.ts.map