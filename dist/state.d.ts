import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { ProjectState } from './types.js';
export interface AtomicReplaceOptions {
    /** Prefix used for the same-directory temporary file. */
    temporaryPrefix?: string;
}
/** Validates advisory state without trusting it as authoritative installation state. */
export declare function validateProjectState(value: unknown): ProjectState;
/** Stable state serialization; unknown fields are intentionally not persisted. */
export declare function serializeProjectState(state: ProjectState): string;
/**
 * Replaces a file using a same-directory temporary file, flushes the prepared
 * file, and renames it into place. Failure cleanup never touches destination,
 * preserving its last readable contents.
 */
export declare function atomicReplaceFile(filesystem: FileSystemAdapter, destination: string, data: Uint8Array | string, options?: AtomicReplaceOptions): Promise<void>;
export interface ProjectStateRepositoryOptions {
    filesystem: FileSystemAdapter;
    projectsDir?: string;
    storeDir?: string;
    toolVersion?: string;
}
/** Persists advisory state separately from the map and keeps failed updates non-destructive. */
export declare class ProjectStateRepository {
    readonly projectsDir: string;
    readonly toolVersion: string;
    private readonly filesystem;
    constructor(options: ProjectStateRepositoryOptions);
    statePath(projectId: string): string;
    read(projectId: string): Promise<ProjectState | undefined>;
    remove(projectId: string): Promise<void>;
    publish(state: ProjectState): Promise<ProjectState>;
}
export type CleanupKind = 'temporary' | 'generations';
export interface CleanupOptions {
    kind: CleanupKind;
    /** Paths currently referenced by an active operation and therefore retained. */
    activePaths?: readonly string[];
}
export declare function isToolOwnedTemporaryName(name: string): boolean;
export declare function isToolOwnedGenerationName(name: string): boolean;
/**
 * Removes only entries with Node Glue-generated names directly below an explicit
 * temporary or generations directory. User-named entries and active paths stay.
 */
export declare function cleanupToolOwnedArtifacts(filesystem: FileSystemAdapter, directory: string, options: CleanupOptions): Promise<readonly string[]>;
export declare const toolOwnedTemporaryPrefix = ".node-glue-";
export declare const toolOwnedGenerationPrefix = "generation-";
//# sourceMappingURL=state.d.ts.map