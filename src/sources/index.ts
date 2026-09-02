import type { SourceAdapter, RegistryTransport, SourceTransport } from '../adapters/source.js';
import type { FileSystemAdapter } from '../adapters/filesystem.js';
import { UnsupportedSourceError } from '../errors.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
import { GitSourceAdapter } from './git.js';
import { LocalDirectorySourceAdapter } from './directory.js';
import { RegistrySourceAdapter } from './registry.js';
import { TarballSourceAdapter } from './tarball.js';

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

export function createDefaultSourceAdapters(options: SourceAdapterSetOptions): readonly SourceAdapter[] {
  return [
    new RegistrySourceAdapter({ transport: options.registry, filesystem: options.filesystem }),
    new LocalDirectorySourceAdapter({ filesystem: options.filesystem }),
    new GitSourceAdapter({ transport: options.sources, filesystem: options.filesystem }),
    new TarballSourceAdapter({ transport: options.sources, filesystem: options.filesystem })
  ];
}

/** Selects one source adapter and provides fail-closed unsupported-source diagnostics. */
export class SourceAdapterRegistry {
  private readonly adapters: readonly SourceAdapter[];

  constructor(adapters: readonly SourceAdapter[]) {
    this.adapters = adapters;
  }

  find(source: DependencySource): SourceAdapter {
    const adapter = this.adapters.find((candidate) => candidate.canHandle(source));
    if (adapter === undefined) {
      throw new UnsupportedSourceError('Dependency source format is not supported.', {
        source: typeof source === 'object' && source !== null ? String((source as { kind?: unknown }).kind ?? 'unknown') : String(source),
        supportedFormats: ['registry', 'directory', 'git', 'tarball']
      });
    }
    return adapter;
  }

  async resolve(source: DependencySource): Promise<ResolvedSource> {
    return this.find(source).resolve(source);
  }

  async fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    return this.find(source.source).fetch(source, destination);
  }
}

export * from './utils.js';
