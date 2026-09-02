export type NodePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | (string & {});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type DependencySource =
  | {
      kind: 'registry';
      registry: string;
      name: string;
      spec: string;
    }
  | {
      kind: 'directory';
      path: string;
    }
  | {
      kind: 'git';
      locator: string;
      ref?: string;
    }
  | {
      kind: 'tarball';
      url: string;
    };

export interface EnvironmentFingerprint {
  platform?: NodePlatform;
  arch?: string;
  nodeAbi?: string;
}

export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean }>>;
  bin?: string | Readonly<Record<string, string>>;
  scripts?: Readonly<Record<string, string>>;
  os?: readonly string[];
  cpu?: readonly string[];
  engines?: Readonly<Record<string, string>>;
  /** Additional package.json fields are retained without making the boundary depend on npm internals. */
  [key: string]: unknown;
}

export interface ResolvedSource {
  source: DependencySource;
  name: string;
  versionOrRevision: string;
  integrity?: string;
  resolvedLocator: string;
  sourceFingerprint?: string;
  environment?: EnvironmentFingerprint;
  manifest?: PackageManifest;
}

export interface FetchedPackage {
  manifest: PackageManifest;
  contentPath: string;
  contentDigest?: string;
  integrity?: string;
}

export interface PackageIdentity {
  name: string;
  versionOrRevision: string;
  /** Canonical source kind and locator fingerprint; never a credential-bearing locator. */
  source: string;
  integrity?: string;
  environment?: EnvironmentFingerprint;
}

export interface PackageInstance {
  identity: PackageIdentity;
  identityHash: string;
  contentPath: string;
  manifest: PackageManifest;
  verifiedAt: string;
}

export interface DependencyPlacement {
  relativePath: string;
  packageIdentityHash: string;
  packageName: string;
  peerContext?: Readonly<Record<string, string>>;
  binEntries?: Readonly<Record<string, string>>;
}

export interface ProjectMap {
  schemaVersion: 1;
  projectId: string;
  projectRoot: string;
  lockfileHash: string;
  placements: readonly DependencyPlacement[];
  generatedAt: string;
  toolVersion: string;
}

export interface ProjectMapSummary {
  projectId: string;
  projectRoot: string;
  lockfileHash: string;
  generatedAt: string;
}

export type ProjectStateStatus = 'ready' | 'incomplete' | 'unknown';

export interface ProjectState {
  schemaVersion: 1;
  projectId: string;
  projectRoot: string;
  lastSuccessfulMapGeneration?: string;
  lastSuccessfulMaterializationGeneration?: string;
  activeTarget?: string;
  updatedAt: string;
  lastSuccessfulAt?: string;
  status: ProjectStateStatus;
}

export interface LifecyclePolicy {
  enabled: boolean;
  /** Explicit package/script allowlist. Empty or absent means no scripts are permitted. */
  allowedScripts?: readonly string[];
  allowedPackages?: readonly string[];
  outputDirectory?: string;
}

export interface LifecycleScript {
  packageName: string;
  packageIdentityHash: string;
  scriptName: string;
  command: string;
}

export interface ProjectInput {
  projectRoot: string;
  packageJsonPath: string;
  packageJsonHash: string;
  packageManifest: PackageManifest;
  lockfilePath?: string;
  lockfileHash?: string;
  /** Parsed lockfile document retained for normalization by the lockfile reader. */
  lockfileDocument?: JsonObject;
  lockfile?: NormalizedLockfile;
}

export interface NormalizedLockfile {
  lockfileVersion: 2 | 3;
  packages: readonly NormalizedLockfilePackage[];
}

export interface NormalizedLockfilePackage {
  path: string;
  name: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean }>>;
  optional?: boolean;
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
  bin?: Readonly<Record<string, string>>;
  os?: readonly string[];
  cpu?: readonly string[];
  engines?: Readonly<Record<string, string>>;
  source?: DependencySource;
}

export interface ResolveOptions {
  registry?: string;
  includeDevDependencies?: boolean;
  lifecyclePolicy?: LifecyclePolicy;
}

export interface ResolvedProject {
  projectRoot: string;
  lockfileHash: string;
  placements: readonly DependencyPlacement[];
  sources: readonly ResolvedSource[];
  packages: readonly PackageInstance[];
}

export interface StoreOptions {
  storeDir?: string;
  environment?: EnvironmentFingerprint;
}

export interface MaterializationResult {
  projectRoot: string;
  projectId: string;
  generation: string;
  activeTarget: string;
  packagesMaterialized: number;
}

export interface GarbageCollectionResult {
  removedIdentityHashes: readonly string[];
  retainedIdentityHashes: readonly string[];
  scannedProjects: number;
}

export interface EnsureProjectOptions {
  projectRoot: string;
  storeDir?: string;
  registry?: string;
  runScripts?: boolean;
  lifecyclePolicy?: LifecyclePolicy;
}

export interface InstallResult {
  projectRoot: string;
  packagesAdded: number;
  packagesReused: number;
  packagesRemoved: number;
  materializationGeneration: string;
}

export interface CapabilityRequirement {
  capability: string;
  operation: string;
  details?: string;
}
