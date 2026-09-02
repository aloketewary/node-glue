import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { RegistryTransport, SourceAdapter } from '../adapters/source.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
export interface RegistrySourceAdapterOptions {
    transport: RegistryTransport;
    filesystem: FileSystemAdapter;
}
export declare class RegistrySourceAdapter implements SourceAdapter {
    private readonly transport;
    private readonly filesystem;
    constructor(options: RegistrySourceAdapterOptions);
    canHandle(source: DependencySource): boolean;
    resolve(source: DependencySource): Promise<ResolvedSource>;
    fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}
//# sourceMappingURL=registry.d.ts.map