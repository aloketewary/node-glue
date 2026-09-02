import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LockError } from './errors.js';
const DEFAULT_LOCKS_DIR = join(homedir(), '.node_modules', 'locks');
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const LOCK_SCHEMA_VERSION = 1;
const SAFE_KEY = /^[A-Za-z0-9._:/-]+$/;
function systemClock() {
    return {
        now: () => new Date(),
        nowIso: () => new Date().toISOString()
    };
}
function assertKey(key) {
    if (key.length === 0 || !SAFE_KEY.test(key)) {
        throw new LockError('Lock key contains unsafe characters.', { key });
    }
}
function lockFileName(key) {
    return `${createHash('sha256').update(key, 'utf8').digest('hex')}.lock`;
}
function lockRecord(value, lockPath) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new LockError('Lock record is malformed.', { lockPath, reason: 'not-an-object' });
    }
    const record = value;
    if (record.schemaVersion !== LOCK_SCHEMA_VERSION || typeof record.key !== 'string' ||
        typeof record.token !== 'string' || typeof record.acquiredAt !== 'string' ||
        typeof record.pid !== 'number' || !Number.isInteger(record.pid)) {
        throw new LockError('Lock record is malformed.', { lockPath, reason: 'invalid-fields' });
    }
    if (record.owner !== undefined && typeof record.owner !== 'string') {
        throw new LockError('Lock record owner is malformed.', { lockPath, reason: 'invalid-owner' });
    }
    if (Number.isNaN(Date.parse(record.acquiredAt))) {
        throw new LockError('Lock record timestamp is malformed.', { lockPath, reason: 'invalid-timestamp' });
    }
    return {
        schemaVersion: LOCK_SCHEMA_VERSION,
        key: record.key,
        token: record.token,
        acquiredAt: record.acquiredAt,
        pid: record.pid,
        ...(record.owner === undefined ? {} : { owner: record.owner })
    };
}
function serializeLockRecord(record) {
    return `${JSON.stringify(record, null, 2)}\n`;
}
function delay(milliseconds) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
/**
 * File-backed advisory locks. Lock files contain diagnostic metadata and are
 * created exclusively. Without an atomic create primitive, acquisition fails
 * closed rather than degrading to a racy existence-then-write sequence.
 */
export class FileLockAdapter {
    locksDir;
    staleDiagnostics = [];
    filesystem;
    clock;
    token;
    pollIntervalMs;
    onStaleLock;
    constructor(options) {
        this.filesystem = options.filesystem;
        this.locksDir = resolve(options.locksDir ?? join(options.storeDir ?? join(homedir(), '.node_modules'), 'locks'));
        this.clock = options.clock ?? systemClock();
        this.token = options.token ?? randomUUID;
        this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.onStaleLock = options.onStaleLock;
    }
    lockPath(key) {
        assertKey(key);
        return join(this.locksDir, lockFileName(key));
    }
    async acquire(key, options = {}) {
        assertKey(key);
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
            throw new LockError('Lock timeout and stale thresholds must be non-negative finite numbers.', {
                key,
                timeoutMs,
                staleAfterMs
            });
        }
        await this.filesystem.mkdir(this.locksDir, { recursive: true });
        const lockPath = this.lockPath(key);
        const token = this.token();
        const acquiredAt = this.clock.nowIso();
        const record = {
            schemaVersion: LOCK_SCHEMA_VERSION,
            key,
            token,
            acquiredAt,
            pid: process.pid,
            ...(options.owner === undefined ? {} : { owner: options.owner })
        };
        const deadline = this.clock.now().getTime() + timeoutMs;
        for (;;) {
            if (await this.tryCreate(lockPath, serializeLockRecord(record))) {
                let released = false;
                return {
                    key,
                    token,
                    acquiredAt,
                    release: async () => {
                        if (released)
                            return;
                        released = true;
                        await this.release(lockPath, record);
                    }
                };
            }
            const existing = await this.readRecord(lockPath, key);
            const now = this.clock.now().getTime();
            const ageMs = now - Date.parse(existing.acquiredAt);
            if (ageMs >= staleAfterMs) {
                const diagnostic = {
                    key,
                    lockPath,
                    acquiredAt: existing.acquiredAt,
                    ageMs,
                    staleAfterMs,
                    ...(existing.owner === undefined ? {} : { owner: existing.owner })
                };
                this.staleDiagnostics.push(diagnostic);
                this.onStaleLock?.(diagnostic);
                await this.filesystem.remove(lockPath, { force: true });
                continue;
            }
            if (now >= deadline) {
                throw new LockError('Lock is already held by another operation.', {
                    key,
                    lockPath,
                    owner: existing.owner,
                    acquiredAt: existing.acquiredAt,
                    stale: false
                });
            }
            await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - now)));
        }
    }
    async tryCreate(path, data) {
        if (this.filesystem.createFileExclusive === undefined) {
            throw new LockError('Filesystem cannot provide race-free lock acquisition.', {
                lockPath: path,
                capability: 'exclusive-file-create'
            });
        }
        return this.filesystem.createFileExclusive(path, data);
    }
    async readRecord(path, key) {
        let text;
        try {
            text = await this.filesystem.readTextFile(path);
        }
        catch (cause) {
            throw new LockError('Lock disappeared or could not be read while acquiring it.', { key, lockPath: path }, cause);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (cause) {
            throw new LockError('Lock record is malformed.', { key, lockPath: path, reason: 'invalid-json' }, cause);
        }
        const record = lockRecord(parsed, path);
        if (record.key !== key) {
            throw new LockError('Lock record key does not match requested lock.', { key, lockPath: path });
        }
        return record;
    }
    async release(path, expected) {
        if (!(await this.filesystem.exists(path)))
            return;
        const current = await this.readRecord(path, expected.key);
        if (current.token !== expected.token) {
            throw new LockError('Lock ownership changed before release; refusing to remove another operation lock.', {
                key: expected.key,
                lockPath: path,
                stale: false
            });
        }
        await this.filesystem.remove(path, { force: true });
    }
}
/** Namespaced project and store lock operations used by orchestration layers. */
export class ProjectStoreLocks {
    adapter;
    constructor(options) {
        this.adapter = options.adapter ?? new FileLockAdapter(options);
    }
    acquireProject(projectId, options) {
        assertKey(projectId);
        return this.adapter.acquire(`project:${projectId}`, options);
    }
    acquireStore(options) {
        return this.adapter.acquire('store', options);
    }
}
export function createProjectStoreLocks(options) {
    return new ProjectStoreLocks(options);
}
//# sourceMappingURL=locks.js.map