import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { ProjectInput } from './types.js';
export type ProjectInputFileSystem = Pick<FileSystemAdapter, 'exists' | 'realpath' | 'readTextFile'>;
declare const nodeProjectInputFileSystem: ProjectInputFileSystem;
export declare const SUPPORTED_LOCKFILE_VERSIONS: readonly [2, 3];
export interface ReadProjectInputOptions {
    filesystem?: ProjectInputFileSystem;
    locator?: ProjectLocatorLike;
}
export interface ProjectLocatorLike {
    locate(requestedDirectory?: string): Promise<string>;
}
/** Reads project metadata and normalizes a supported lockfile dependency graph. */
export declare class InputReader {
    private readonly filesystem;
    private readonly locator;
    constructor(options?: ReadProjectInputOptions);
    read(requestedDirectory?: string): Promise<ProjectInput>;
    readRoot(projectRoot: string): Promise<ProjectInput>;
    private canonicalizeRoot;
    private readSource;
}
export declare function readProjectInput(requestedDirectory?: string, options?: ReadProjectInputOptions): Promise<ProjectInput>;
export declare function hashText(value: string): string;
export { nodeProjectInputFileSystem };
//# sourceMappingURL=input-reader.d.ts.map