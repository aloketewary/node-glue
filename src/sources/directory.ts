import { join } from 'node:path';
import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { SourceAdapter } from '../adapters/source.js';
import { NodeGlueError } from '../errors.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
import {
  canonicalDirectoryPath,
  copyDirectory,
  currentEnvironment,
  readManifestFromFile,
  sourceFailure,
  unsupportedSource
} from './utils.js';

export interface LocalDirectorySourceAdapterOptions {
  filesystem: FileSystemAdapter;
}

export class LocalDirectorySourceAdapter implements SourceAdapter {
  private readonly filesystem: FileSystemAdapter;

  constructor(options: LocalDirectorySourceAdapterOptions) {
    this.filesystem = options.filesystem;
  }

  canHandle(source: DependencySource): boolean {
    return source.kind === 'directory';
  }

  async resolve(source: DependencySource): Promise<ResolvedSource> {
    assertDirectorySource(source);
    const requestedPath = canonicalDirectoryPath(source.path, source);
    let canonicalPath: string;
    try {
      canonicalPath = await this.filesystem.realpath(requestedPath);
      const metadata = await this.filesystem.lstat(canonicalPath);
      if (metadata.type !== 'directory') return sourceFailure(`Local dependency is not a directory: ${source.path}.`, source);
    } catch (cause) {
      if (cause instanceof NodeGlueError) throw cause;
      return sourceFailure(`Cannot reach local dependency directory: ${source.path}.`, source, cause);
    }
    const manifest = await readManifestFromFile(this.filesystem, join(canonicalPath, 'package.json'), source);
    return {
      source,
      name: manifest.name,
      versionOrRevision: manifest.version,
      resolvedLocator: canonicalPath,
      sourceFingerprint: `directory:${canonicalPath}`,
      environment: currentEnvironment(),
      manifest
    };
  }

  async fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    assertResolvedDirectorySource(source);
    let metadata;
    try {
      metadata = await this.filesystem.lstat(source.resolvedLocator);
      if (metadata.type !== 'directory') return sourceFailure(`Local dependency is not a directory: ${source.resolvedLocator}.`, source.source);
      const manifest = await readManifestFromFile(this.filesystem, join(source.resolvedLocator, 'package.json'), source.source);
      if (manifest.name !== source.name || manifest.version !== source.versionOrRevision) {
        return sourceFailure(`Local dependency metadata changed after resolution: ${source.resolvedLocator}.`, source.source);
      }
      const contentDigest = await copyDirectory(this.filesystem, source.resolvedLocator, destination, source.source);
      return { manifest, contentPath: destination, contentDigest };
    } catch (cause) {
      if (cause instanceof NodeGlueError) throw cause;
      await this.filesystem.remove(destination, { recursive: true, force: true }).catch(() => undefined);
      return sourceFailure(`Cannot fetch local dependency: ${source.resolvedLocator}.`, source.source, cause);
    }
  }
}

function assertDirectorySource(source: DependencySource): asserts source is Extract<DependencySource, { kind: 'directory' }> {
  if (typeof source !== 'object' || source === null || source.kind !== 'directory' || typeof source.path !== 'string') {
    return unsupportedSource('Source is not a local directory dependency.', source);
  }
}

function assertResolvedDirectorySource(source: ResolvedSource): void {
  if (source.source.kind !== 'directory') return unsupportedSource('Resolved source is not a local directory dependency.', source.source);
}
