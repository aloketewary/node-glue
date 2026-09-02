export interface LockOptions {
    timeoutMs?: number;
    staleAfterMs?: number;
    owner?: string;
}
export interface LockLease {
    key: string;
    token: string;
    acquiredAt: string;
    release(): Promise<void>;
}
/** Injectable lock boundary; implementations may use files, OS locks, or test doubles. */
export interface LockAdapter {
    acquire(key: string, options?: LockOptions): Promise<LockLease>;
}
//# sourceMappingURL=locks.d.ts.map