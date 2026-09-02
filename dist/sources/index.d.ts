import type { SourceAdapter, RegistryTransport, SourceTransport } from '../adapters/source.js';
import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
export type { SourceAdapter } from './source-adapter.js';
export { GitSourceAdapter } from './git.js';
export { LocalDirectorySourceAdapter } from './directory.js';
export { RegistrySourceAdapter } from './registry.js';
export { TarballSourceAdapter } from './tarball.js';
export * from './archive.js';
export interface SourceAdapterSetOptions {
    filesystem: FileSystemAdapter;
    registry: RegistryTransport;
    sources: SourceTransport;
}
export declare function createDefaultSourceAdapters(options: SourceAdapterSetOptions): readonly SourceAdapter[];
/** Selects one source adapter and provides fail-closed unsupported-source diagnostics. */
export declare class SourceAdapterRegistry {
    private readonly adapters;
    constructor(adapters: readonly SourceAdapter[]);
    find(source: DependencySource): SourceAdapter;
    resolve(source: DependencySource): Promise<ResolvedSource>;
    fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}
export * from './utils.js';
//# sourceMappingURL=index.d.ts.map