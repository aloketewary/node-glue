import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { LockAdapter, LockLease, LockOptions } from './adapters/locks.js';
import type { Clock } from './adapters/time.js';
export interface StaleLockDiagnostic {
    key: string;
    lockPath: string;
    acquiredAt: string;
    ageMs: number;
    staleAfterMs: number;
    owner?: string;
}
export interface FileLockAdapterOptions {
    filesystem: FileSystemAdapter;
    locksDir?: string;
    storeDir?: string;
    clock?: Clock;
    token?: () => string;
    pollIntervalMs?: number;
    onStaleLock?: (diagnostic: StaleLockDiagnostic) => void;
}
/**
 * File-backed advisory locks. Lock files contain diagnostic metadata and are
 * created exclusively. Without an atomic create primitive, acquisition fails
 * closed rather than degrading to a racy existence-then-write sequence.
 */
export declare class FileLockAdapter implements LockAdapter {
    readonly locksDir: string;
    readonly staleDiagnostics: StaleLockDiagnostic[];
    private readonly filesystem;
    private readonly clock;
    private readonly token;
    private readonly pollIntervalMs;
    private readonly onStaleLock;
    constructor(options: FileLockAdapterOptions);
    lockPath(key: string): string;
    acquire(key: string, options?: LockOptions): Promise<LockLease>;
    private tryCreate;
    private readRecord;
    private release;
}
export interface ProjectStoreLocksOptions extends FileLockAdapterOptions {
    adapter?: LockAdapter;
}
/** Namespaced project and store lock operations used by orchestration layers. */
export declare class ProjectStoreLocks {
    readonly adapter: LockAdapter;
    constructor(options: ProjectStoreLocksOptions);
    acquireProject(projectId: string, options?: LockOptions): Promise<LockLease>;
    acquireStore(options?: LockOptions): Promise<LockLease>;
}
export declare function createProjectStoreLocks(options: ProjectStoreLocksOptions): ProjectStoreLocks;
//# sourceMappingURL=locks.d.ts.map