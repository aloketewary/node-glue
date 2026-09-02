import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { SourceAdapter, SourceTransport } from '../adapters/source.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
export interface TarballSourceAdapterOptions {
    transport: SourceTransport;
    filesystem: FileSystemAdapter;
}
export declare class TarballSourceAdapter implements SourceAdapter {
    private readonly transport;
    private readonly filesystem;
    constructor(options: TarballSourceAdapterOptions);
    canHandle(source: DependencySource): boolean;
    resolve(source: DependencySource): Promise<ResolvedSource>;
    fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}
//# sourceMappingURL=tarball.d.ts.map