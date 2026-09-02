import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { SourceAdapter, SourceArtifact, SourceTransport } from '../adapters/source.js';
import { NodeGlueError } from '../errors.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
import { extractPackageToDestination } from './archive.js';
import {
  archiveIntegrity,
  canonicalHttpUrl,
  currentEnvironment,
  readManifestFromFile,
  sourceFailure,
  unsupportedSource
} from './utils.js';

export interface TarballSourceAdapterOptions {
  transport: SourceTransport;
  filesystem: FileSystemAdapter;
}

export class TarballSourceAdapter implements SourceAdapter {
  private readonly transport: SourceTransport;
  private readonly filesystem: FileSystemAdapter;

  constructor(options: TarballSourceAdapterOptions) {
    this.transport = options.transport;
    this.filesystem = options.filesystem;
  }

  canHandle(source: DependencySource): boolean {
    return source.kind === 'tarball';
  }

  async resolve(source: DependencySource): Promise<ResolvedSource> {
    assertTarballSource(source);
    const url = canonicalHttpUrl(source.url, source);
    return {
      source,
      name: inferTarballName(url),
      versionOrRevision: 'tarball',
      resolvedLocator: url,
      sourceFingerprint: `tarball:${url}`,
      environment: currentEnvironment()
    };
  }

  async fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    assertResolvedTarballSource(source);
    let artifact: SourceArtifact;
    try {
      artifact = await this.transport.fetch(source.resolvedLocator);
    } catch (cause) {
      if (cause instanceof NodeGlueError) throw cause;
      return sourceFailure(`Cannot fetch tarball source ${source.resolvedLocator}.`, source.source, cause);
    }
    try {
      const extracted = await extractPackageToDestination(this.filesystem, artifact.data, destination, source.source);
      const manifest = await readManifestFromFile(this.filesystem, `${extracted.packageRoot}/package.json`, source.source);
      return {
        manifest,
        contentPath: extracted.packageRoot,
        contentDigest: archiveIntegrity(artifact.data),
        ...(artifact.digest === undefined ? {} : { integrity: artifact.digest })
      };
    } catch (cause) {
      await this.filesystem.remove(destination, { recursive: true, force: true }).catch(() => undefined);
      if (cause instanceof NodeGlueError) throw cause;
      return sourceFailure(`Cannot validate tarball source ${source.resolvedLocator}.`, source.source, cause);
    }
  }
}

function assertTarballSource(source: DependencySource): asserts source is Extract<DependencySource, { kind: 'tarball' }> {
  if (typeof source !== 'object' || source === null || source.kind !== 'tarball' || typeof source.url !== 'string') {
    return unsupportedSource('Source is not a tarball dependency.', source);
  }
}

function assertResolvedTarballSource(source: ResolvedSource): void {
  if (source.source.kind !== 'tarball') return unsupportedSource('Resolved source is not a tarball dependency.', source.source);
}

function inferTarballName(url: string): string {
  const path = new URL(url).pathname.split('/').pop() ?? 'tarball-package';
  return path.replace(/\.(?:tgz|tar\.gz|tar)$/i, '').replace(/-\d+(?:\.\d+)*(?:[-+].*)?$/, '') || 'tarball-package';
}
