import type { RegistryPackageMetadata, RegistryTransport, SourceAdapter, SourceArtifact, SourceTransport } from '../../src/adapters/source.js';
import { FailureInjector } from './failure-injection.js';
import type { DependencySource, FetchedPackage, PackageManifest, ResolvedSource } from '../../src/types.js';

export interface FakeSourcePackage {
  source: DependencySource;
  manifest: PackageManifest;
  resolvedLocator?: string;
  versionOrRevision?: string;
  integrity?: string;
  contentDigest?: string;
}

export class FakeSourceAdapter implements SourceAdapter {
  readonly failures: FailureInjector;
  readonly resolveCalls: ResolvedSource[] = [];
  readonly fetchCalls: string[] = [];
  private readonly packages = new Map<string, FakeSourcePackage>();

  constructor(packages: readonly FakeSourcePackage[] = [], failures = new FailureInjector()) {
    this.failures = failures;
    for (const item of packages) this.add(item);
  }

  add(item: FakeSourcePackage): this {
    this.packages.set(sourceKey(item.source), item);
    return this;
  }

  canHandle(source: DependencySource): boolean {
    return this.packages.has(sourceKey(source));
  }

  async resolve(source: DependencySource): Promise<ResolvedSource> {
    this.failures.check('source.resolve');
    const item = this.packages.get(sourceKey(source));
    if (item === undefined) throw new Error(`No fake source registered for ${sourceKey(source)}`);
    const resolved: ResolvedSource = {
      source,
      name: item.manifest.name,
      versionOrRevision: item.versionOrRevision ?? item.manifest.version,
      resolvedLocator: item.resolvedLocator ?? defaultLocator(source),
      ...(item.integrity === undefined ? {} : { integrity: item.integrity }),
      sourceFingerprint: `${source.kind}:${item.resolvedLocator ?? defaultLocator(source)}`,
      manifest: item.manifest
    };
    this.resolveCalls.push(resolved);
    return resolved;
  }

  async fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    this.failures.check('source.fetch');
    this.fetchCalls.push(source.resolvedLocator);
    const item = [...this.packages.values()].find((candidate) => {
      const locator = candidate.resolvedLocator ?? defaultLocator(candidate.source);
      return locator === source.resolvedLocator;
    });
    if (item === undefined) throw new Error(`No fake package for resolved locator ${source.resolvedLocator}`);
    return {
      manifest: item.manifest,
      contentPath: destination,
      ...(item.contentDigest === undefined ? {} : { contentDigest: item.contentDigest }),
      ...(item.integrity === undefined ? {} : { integrity: item.integrity })
    };
  }
}

export class FakeRegistryTransport implements RegistryTransport {
  readonly failures: FailureInjector;
  readonly metadataCalls: string[] = [];
  readonly tarballCalls: string[] = [];
  private readonly metadata = new Map<string, RegistryPackageMetadata>();
  private readonly tarballs = new Map<string, SourceArtifact>();

  constructor(failures = new FailureInjector()) {
    this.failures = failures;
  }

  addMetadata(registry: string, name: string, metadata: RegistryPackageMetadata): this {
    this.metadata.set(`${registry}|${name}`, metadata);
    return this;
  }

  addTarball(locator: string, artifact: SourceArtifact): this {
    this.tarballs.set(locator, artifact);
    return this;
  }

  async getMetadata(registry: string, name: string): Promise<RegistryPackageMetadata> {
    this.failures.check('registry.getMetadata');
    this.metadataCalls.push(`${registry}|${name}`);
    const value = this.metadata.get(`${registry}|${name}`);
    if (value === undefined) throw new Error(`No fake registry metadata for ${registry}|${name}`);
    return value;
  }

  async getTarball(locator: string): Promise<SourceArtifact> {
    this.failures.check('registry.getTarball');
    this.tarballCalls.push(locator);
    const value = this.tarballs.get(locator);
    if (value === undefined) throw new Error(`No fake registry tarball for ${locator}`);
    return { ...value, data: new Uint8Array(value.data) };
  }
}

export class FakeSourceTransport implements SourceTransport {
  readonly failures: FailureInjector;
  readonly fetchCalls: string[] = [];
  readonly gitResolveCalls: Array<{ locator: string; ref?: string }> = [];
  private readonly artifacts = new Map<string, SourceArtifact>();
  private readonly revisions = new Map<string, { resolvedLocator: string; revision: string }>();

  constructor(failures = new FailureInjector()) {
    this.failures = failures;
  }

  addArtifact(locator: string, artifact: SourceArtifact): this {
    this.artifacts.set(locator, artifact);
    return this;
  }

  addGitRevision(locator: string, ref: string | undefined, resolvedLocator: string, revision: string): this {
    this.revisions.set(`${locator}|${ref ?? ''}`, { resolvedLocator, revision });
    return this;
  }

  async fetch(locator: string): Promise<SourceArtifact> {
    this.failures.check('sourceTransport.fetch');
    this.fetchCalls.push(locator);
    const artifact = this.artifacts.get(locator);
    if (artifact === undefined) throw new Error(`No fake source artifact for ${locator}`);
    return { ...artifact, data: new Uint8Array(artifact.data) };
  }

  async resolveGit(locator: string, ref?: string): Promise<{ resolvedLocator: string; revision: string }> {
    this.failures.check('sourceTransport.resolveGit');
    this.gitResolveCalls.push({ locator, ...(ref === undefined ? {} : { ref }) });
    const revision = this.revisions.get(`${locator}|${ref ?? ''}`);
    if (revision === undefined) throw new Error(`No fake Git revision for ${locator}@${ref ?? 'HEAD'}`);
    return revision;
  }
}

function sourceKey(source: DependencySource): string {
  return JSON.stringify(source, Object.keys(source).sort());
}

function defaultLocator(source: DependencySource): string {
  switch (source.kind) {
    case 'registry': return `${source.registry}/${source.name}@${source.spec}`;
    case 'directory': return source.path;
    case 'git': return `${source.locator}#${source.ref ?? 'HEAD'}`;
    case 'tarball': return source.url;
  }
}
