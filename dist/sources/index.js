import { UnsupportedSourceError } from '../errors.js';
import { GitSourceAdapter } from './git.js';
import { LocalDirectorySourceAdapter } from './directory.js';
import { RegistrySourceAdapter } from './registry.js';
import { TarballSourceAdapter } from './tarball.js';
export { GitSourceAdapter } from './git.js';
export { LocalDirectorySourceAdapter } from './directory.js';
export { RegistrySourceAdapter } from './registry.js';
export { TarballSourceAdapter } from './tarball.js';
export * from './archive.js';
export function createDefaultSourceAdapters(options) {
    return [
        new RegistrySourceAdapter({ transport: options.registry, filesystem: options.filesystem }),
        new LocalDirectorySourceAdapter({ filesystem: options.filesystem }),
        new GitSourceAdapter({ transport: options.sources, filesystem: options.filesystem }),
        new TarballSourceAdapter({ transport: options.sources, filesystem: options.filesystem })
    ];
}
/** Selects one source adapter and provides fail-closed unsupported-source diagnostics. */
export class SourceAdapterRegistry {
    adapters;
    constructor(adapters) {
        this.adapters = adapters;
    }
    find(source) {
        const adapter = this.adapters.find((candidate) => candidate.canHandle(source));
        if (adapter === undefined) {
            throw new UnsupportedSourceError('Dependency source format is not supported.', {
                source: typeof source === 'object' && source !== null ? String(source.kind ?? 'unknown') : String(source),
                supportedFormats: ['registry', 'directory', 'git', 'tarball']
            });
        }
        return adapter;
    }
    async resolve(source) {
        return this.find(source).resolve(source);
    }
    async fetch(source, destination) {
        return this.find(source.source).fetch(source, destination);
    }
}
export * from './utils.js';
//# sourceMappingURL=index.js.map