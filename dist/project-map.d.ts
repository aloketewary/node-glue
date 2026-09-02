import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { PackageInstance, ProjectMap, ProjectMapSummary } from './types.js';
export interface ProjectMapReferenceChecker {
    (identityHash: string): Promise<boolean> | boolean;
}
export interface ProjectMapStoreReference {
    get(identityHash: string): Promise<PackageInstance | undefined>;
}
export interface ProjectMapRepositoryOptions {
    filesystem: FileSystemAdapter;
    /** Directory containing one tool-owned directory per project. */
    projectsDir?: string;
    /** Convenience alternative to projectsDir; maps are stored below <storeDir>/projects. */
    storeDir?: string;
    toolVersion?: string;
    packageInstanceExists?: ProjectMapReferenceChecker;
    packageStore?: ProjectMapStoreReference;
}
/** Validates and returns only the supported, persistable Project Map fields. */
export declare function validateProjectMap(value: unknown): ProjectMap;
/** Serializes the validated map using a stable field order and no unknown fields. */
export declare function serializeProjectMap(map: ProjectMap): string;
/** Derives a readable, collision-resistant identifier from a canonical Project Root. */
export declare function deriveProjectId(projectRoot: string, hashLength?: 16): string;
export declare class ProjectMapRepository {
    private readonly filesystem;
    private readonly projectsDir;
    private readonly packageInstanceExists;
    constructor(options: ProjectMapRepositoryOptions);
    canonicalProjectRoot(projectRoot: string): Promise<string>;
    projectIdFor(projectRoot: string): Promise<string>;
    mapPath(projectId: string): string;
    read(projectId: string): Promise<ProjectMap | undefined>;
    publish(map: ProjectMap): Promise<ProjectMap>;
    remove(projectId: string): Promise<void>;
    list(): Promise<readonly ProjectMapSummary[]>;
    private validateReferences;
    private inspectCandidate;
    private selectProjectId;
}
export declare function createProjectMapRepository(options: ProjectMapRepositoryOptions): ProjectMapRepository;
//# sourceMappingURL=project-map.d.ts.map