import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { SourceAdapter, SourceTransport } from '../adapters/source.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
export interface GitSourceAdapterOptions {
    transport: SourceTransport;
    filesystem: FileSystemAdapter;
}
export declare class GitSourceAdapter implements SourceAdapter {
    private readonly transport;
    private readonly filesystem;
    constructor(options: GitSourceAdapterOptions);
    canHandle(source: DependencySource): boolean;
    resolve(source: DependencySource): Promise<ResolvedSource>;
    fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}
//# sourceMappingURL=git.d.ts.map