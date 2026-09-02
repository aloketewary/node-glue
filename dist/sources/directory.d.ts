import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { SourceAdapter } from '../adapters/source.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
export interface LocalDirectorySourceAdapterOptions {
    filesystem: FileSystemAdapter;
}
export declare class LocalDirectorySourceAdapter implements SourceAdapter {
    private readonly filesystem;
    constructor(options: LocalDirectorySourceAdapterOptions);
    canHandle(source: DependencySource): boolean;
    resolve(source: DependencySource): Promise<ResolvedSource>;
    fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}
//# sourceMappingURL=directory.d.ts.map