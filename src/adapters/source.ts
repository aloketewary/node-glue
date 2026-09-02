import type { DependencySource, FetchedPackage, PackageManifest, ResolvedSource } from '../types';

export interface RegistryPackageMetadata {
  name: string;
  versions: Readonly<Record<string, PackageManifest>>;
  dist?: Readonly<Record<string, { tarball?: string; integrity?: string }>>;
  'dist-tags'?: Readonly<Record<string, string>>;
}

export interface SourceArtifact {
  data: Uint8Array;
  contentType?: string;
  digest?: string;
}

/** Registry/network seam. Implementations own authentication and must not persist credentials. */
export interface RegistryTransport {
  getMetadata(registry: string, name: string): Promise<RegistryPackageMetadata>;
  getTarball(locator: string): Promise<SourceArtifact>;
}

/** General source transport seam for Git and tarball acquisition. */
export interface SourceTransport {
  fetch(locator: string): Promise<SourceArtifact>;
  resolveGit(locator: string, ref?: string): Promise<{ resolvedLocator: string; revision: string }>;
}

export interface SourceAdapter {
  canHandle(source: DependencySource): boolean;
  resolve(source: DependencySource): Promise<ResolvedSource>;
  fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}
