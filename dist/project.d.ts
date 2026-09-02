import type { FileSystemAdapter } from './adapters/filesystem.js';
export type ProjectDiscoveryFileSystem = Pick<FileSystemAdapter, 'exists' | 'realpath'>;
declare const nodeProjectDiscoveryFileSystem: ProjectDiscoveryFileSystem;
/** Locates the nearest project root and returns its canonical absolute path. */
export declare class ProjectLocator {
    private readonly filesystem;
    constructor(filesystem?: ProjectDiscoveryFileSystem);
    locate(requestedDirectory?: string): Promise<string>;
}
export declare function locateProjectRoot(requestedDirectory?: string, filesystem?: ProjectDiscoveryFileSystem): Promise<string>;
export { nodeProjectDiscoveryFileSystem };
//# sourceMappingURL=project.d.ts.map