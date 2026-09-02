import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { SourceAdapter, SourceArtifact, SourceTransport } from '../adapters/source.js';
import { NodeGlueError } from '../errors.js';
import type { DependencySource, FetchedPackage, ResolvedSource } from '../types.js';
import { extractPackageToDestination } from './archive.js';
import {
  archiveIntegrity,
  currentEnvironment,
  readManifestFromFile,
  sourceFailure,
  unsupportedSource
} from './utils.js';

export interface GitSourceAdapterOptions {
  transport: SourceTransport;
  filesystem: FileSystemAdapter;
}

export class GitSourceAdapter implements SourceAdapter {
  private readonly transport: SourceTransport;
  private readonly filesystem: FileSystemAdapter;

  constructor(options: GitSourceAdapterOptions) {
    this.transport = options.transport;
    this.filesystem = options.filesystem;
  }

  canHandle(source: DependencySource): boolean {
    return source.kind === 'git';
  }

  async resolve(source: DependencySource): Promise<ResolvedSource> {
    assertGitSource(source);
    const locator = canonicalGitLocator(source.locator, source);
    let resolved: { resolvedLocator: string; revision: string };
    try {
      resolved = await this.transport.resolveGit(locator, source.ref);
    } catch (cause) {
      if (cause instanceof NodeGlueError) throw cause;
      return sourceFailure(`Cannot resolve Git source ${locator}.`, source, cause);
    }
    if (typeof resolved.revision !== 'string' || resolved.revision.length === 0 || typeof resolved.resolvedLocator !== 'string') {
      return sourceFailure(`Git transport returned invalid revision metadata for ${locator}.`, source);
    }
    const resolvedLocator = canonicalGitLocator(resolved.resolvedLocator, source, true);
    return {
      source,
      name: inferGitName(locator),
      versionOrRevision: resolved.revision,
      resolvedLocator,
      sourceFingerprint: `git:${locator}#${resolved.revision}`,
      environment: currentEnvironment()
    };
  }

  async fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    assertResolvedGitSource(source);
    let artifact: SourceArtifact;
    try {
      artifact = await this.transport.fetch(source.resolvedLocator);
    } catch (cause) {
      if (cause instanceof NodeGlueError) throw cause;
      return sourceFailure(`Cannot fetch Git source ${source.resolvedLocator}.`, source.source, cause);
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
      return sourceFailure(`Cannot validate Git source ${source.resolvedLocator}.`, source.source, cause);
    }
  }
}

function assertGitSource(source: DependencySource): asserts source is Extract<DependencySource, { kind: 'git' }> {
  if (typeof source !== 'object' || source === null || source.kind !== 'git' || typeof source.locator !== 'string') {
    return unsupportedSource('Source is not a Git dependency.', source);
  }
}

function assertResolvedGitSource(source: ResolvedSource): void {
  if (source.source.kind !== 'git') return unsupportedSource('Resolved source is not a Git dependency.', source.source);
}

function canonicalGitLocator(locator: string, source: unknown, preserveHash = false): string {
  if (/^git@[^:]+:.+/.test(locator)) return locator;
  if (/^(?:git\+)?(?:https?|ssh|git):\/\//.test(locator)) {
    const withoutGitScheme = locator.startsWith('git+') ? locator.slice(4) : locator;
    return canonicalHttpUrlIfApplicable(withoutGitScheme, source, preserveHash);
  }
  return unsupportedSource(`Unsupported Git source format: ${locator}.`, source);
}

function canonicalHttpUrlIfApplicable(locator: string, source: unknown, preserveHash: boolean): string {
  try {
    const parsed = new URL(locator);
    if (!preserveHash) parsed.hash = '';
    if (parsed.username !== '' || parsed.password !== '') return unsupportedSource('Credential-bearing Git URLs are not supported.', source);
    return parsed.toString().replace(/\/$/, '');
  } catch (cause) {
    return sourceFailure(`Invalid Git source URL: ${locator}.`, source, cause);
  }
}

function inferGitName(locator: string): string {
  const path = locator.split(/[/:]/).pop() ?? 'git-package';
  return path.replace(/\.git$/, '') || 'git-package';
}
