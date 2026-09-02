import type { FileSystemAdapter, FileType } from './adapters/filesystem.js';
/** Marker stored inside a published generation's node_modules directory. */
export declare const GENERATION_OWNERSHIP_MARKER = ".node-glue-generation.json";
export declare const GENERATION_OWNERSHIP_SCHEMA_VERSION = 1;
export interface GenerationOwnershipMarker {
    schemaVersion: 1;
    projectId: string;
    generation: string;
    projectRoot: string;
}
/** A generation registered by the project state/materialization layer. */
export interface RegisteredProjectGeneration {
    projectId: string;
    generation: string;
    projectRoot: string;
    /** Absolute path to the generation's node_modules directory. */
    generationPath: string;
}
export interface ProjectGenerationRegistry {
    list(projectId?: string): Promise<readonly RegisteredProjectGeneration[]>;
}
export type NodeModulesOwnership = {
    kind: 'absent';
    path: string;
} | {
    kind: 'tool-owned-symlink';
    path: string;
    target: string;
    registration: RegisteredProjectGeneration;
} | {
    kind: 'tool-owned-generation';
    path: string;
    registration: RegisteredProjectGeneration;
} | {
    kind: 'unmanaged';
    path: string;
    reason: string;
    target?: string;
    fileType?: FileType;
} | {
    kind: 'broken-link';
    path: string;
    target?: string;
    reason: string;
} | {
    kind: 'unknown-marker';
    path: string;
    reason: string;
} | {
    kind: 'ambiguous';
    path: string;
    reason: string;
};
export interface OwnershipInspectionOptions {
    filesystem: FileSystemAdapter;
    registry: ProjectGenerationRegistry;
    /** Restrict proof to a particular project when replacing its project-root link. */
    projectId?: string;
    projectRoot?: string;
}
export interface StaticProjectGenerationRegistry extends ProjectGenerationRegistry {
    readonly registrations: readonly RegisteredProjectGeneration[];
}
export declare function createProjectGenerationRegistry(registrations: readonly RegisteredProjectGeneration[]): StaticProjectGenerationRegistry;
export declare function generationOwnershipMarkerPath(generationPath: string): string;
export declare function serializeGenerationOwnershipMarker(marker: GenerationOwnershipMarker): string;
/**
 * Inspect without changing the filesystem. This function deliberately treats
 * every unproven state as unsafe; callers may replace only the two tool-owned
 * classifications returned by this function.
 */
export declare function inspectNodeModulesOwnership(nodeModulesPath: string, options: OwnershipInspectionOptions): Promise<NodeModulesOwnership>;
/**
 * Prove that replacement is safe. No unlink/rmdir/remove operation is used by
 * this guard, including when ownership cannot be proven.
 */
export declare function assertNodeModulesReplaceable(nodeModulesPath: string, options: OwnershipInspectionOptions): Promise<Extract<NodeModulesOwnership, {
    kind: 'absent' | 'tool-owned-symlink' | 'tool-owned-generation';
}>>;
//# sourceMappingURL=ownership.d.ts.map