import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { JsonObject, NormalizedLockfile, PackageManifest, ResolvedProject } from './types.js';
export interface LockfileReaderOptions {
    projectRoot?: string;
    sourcePath?: string;
}
/**
 * Converts npm lockfile v2 and v3 documents to one package-path graph.
 * The normalized graph contains only persistence-safe locator values.
 */
export declare class LockfileReader {
    read(document: unknown, packageManifest: PackageManifest, options?: LockfileReaderOptions): NormalizedLockfile;
    readText(text: string, packageManifest: PackageManifest, options?: LockfileReaderOptions): NormalizedLockfile;
}
export declare function normalizeLockfile(document: unknown, packageManifest: PackageManifest, options?: LockfileReaderOptions): NormalizedLockfile;
/** Redacts URL userinfo before a locator can enter a normalized graph or map. */
export declare function sanitizePersistedLocator(locator: string): string;
export type LockfileDocument = JsonObject;
/** Options for deterministic package-lock generation and atomic publication. */
export interface LockfileWriterOptions {
    filesystem: FileSystemAdapter;
    lockfileVersion?: 2 | 3;
    lockfilePath?: string;
}
export interface LockfilePublication {
    lockfilePath: string;
    lockfileHash: string;
    document: LockfileDocument;
}
/**
 * Serializes resolved, source-aware graphs into a canonical package-lock document.
 * Publication is deliberately separate from serialization so callers can prepare
 * the lockfile before publishing a Project Map.
 */
export declare class LockfileWriter {
    private readonly filesystem;
    private readonly lockfileVersion;
    private readonly configuredPath;
    constructor(options: LockfileWriterOptions);
    serialize(project: ResolvedProject, packageManifest: PackageManifest): string;
    /**
     * Writes package-lock.json through a same-directory temporary file. The
     * returned hash is the value a caller must use when publishing its Project Map.
     */
    publish(project: ResolvedProject, packageManifest: PackageManifest): Promise<LockfilePublication>;
}
export declare function serializeResolvedLockfile(project: ResolvedProject, packageManifest: PackageManifest, lockfileVersion?: 2 | 3): string;
//# sourceMappingURL=lockfile.d.ts.map