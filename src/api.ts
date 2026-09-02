import { createRequire } from 'node:module';
import { execFile as nodeExecFile, spawn } from 'node:child_process';
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  mkdtemp,
  open,
  readFile as nodeReadFile,
  readlink as nodeReadlink,
  readdir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm,
  symlink as nodeSymlink,
  writeFile as nodeWriteFile
} from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FileSystemAdapter, FileMetadata, RemoveOptions } from './adapters/filesystem.js';
import type { LockAdapter, LockLease, LockOptions } from './adapters/locks.js';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from './adapters/process.js';
import type { RegistryTransport, SourceAdapter, SourceArtifact, SourceTransport } from './adapters/source.js';
import type { Clock } from './adapters/time.js';
import { DependencyResolver, type ArboristAdapter, type DependencyResolverOptions } from './dependency-resolver.js';
import { Doctor, type DoctorReport } from './doctor.js';
import { GarbageCollector } from './gc.js';
import { InvalidInputError, PublicationError } from './errors.js';
import { InputReader } from './input-reader.js';
import { LockfileWriter } from './lockfile.js';
import { Materializer } from './materializer.js';
import { ProjectMapRepository } from './project-map.js';
import { generationOwnershipMarkerPath, type ProjectGenerationRegistry } from './ownership.js';
import { PackageStore, type PackageStoreOptions } from './package-store.js';
import { LifecycleRunner } from './lifecycle.js';
import { ProjectStateRepository } from './state.js';
import { ProjectStoreLocks } from './locks.js';
import { SourceAdapterRegistry, createDefaultSourceAdapters } from './sources/index.js';
import { NodePlatformCapabilityAdapter } from './platform/index.js';
import { hashPackageIdentity, packageIdentityFromResolvedSource } from './package-identity.js';
import type {
  EnsureProjectOptions,
  GarbageCollectionResult,
  InstallResult,
  MaterializationResult,
  PackageInstance,
  ProjectInput,
  ProjectMap,
  ProjectState,
  ResolvedProject,
  ResolvedSource,
  StoreOptions
} from './types.js';
import { VERSION } from './index.js';

const execFile = promisify(nodeExecFile);
const require = createRequire(import.meta.url);

type InputReaderLike = Pick<InputReader, 'read' | 'readRoot'>;
type ResolverLike = Pick<DependencyResolver, 'resolve'>;
type MapRepositoryLike = Pick<ProjectMapRepository, 'projectIdFor' | 'read' | 'publish' | 'list'> & {
  /** Remove a newly published map when an operation has no prior successful map. */
  remove?: (projectId: string) => Promise<void>;
};
type StateRepositoryLike = Pick<ProjectStateRepository, 'read' | 'publish'> & {
  /** Remove state created by a failed operation when no prior state existed. */
  remove?: (projectId: string) => Promise<void>;
};
type ProjectLocksLike = Pick<ProjectStoreLocks, 'acquireProject'>;
type MaterializerLike = Pick<Materializer, 'materialize'> & {
  /** Revert a completed materialization to the prior active generation. */
  rollback?: (current: MaterializationResult, previous?: MaterializationResult) => Promise<void>;
};
type DoctorLike = Pick<Doctor, 'inspectProject'>;
type LifecycleRunnerLike = Pick<LifecycleRunner, 'run'>;
type StoreLike = Pick<PackageStore, 'ensure' | 'get'> & { storeDir?: string };

export interface GarbageCollectorLike {
  collect(storeDir?: string): Promise<GarbageCollectionResult>;
}

export interface NodeGlueApiOptions {
  filesystem?: FileSystemAdapter;
  inputReader?: InputReaderLike;
  resolver?: ResolverLike;
  resolverOptions?: Omit<DependencyResolverOptions, 'sourceAdapter'> & { arborist?: ArboristAdapter };
  sourceAdapter?: SourceAdapter;
  sourceAdapters?: readonly SourceAdapter[];
  registryTransport?: RegistryTransport;
  sourceTransport?: SourceTransport;
  packageStore?: StoreLike;
  packageStoreOptions?: Omit<PackageStoreOptions, 'filesystem' | 'sourceAdapter'>;
  mapRepository?: MapRepositoryLike;
  stateRepository?: StateRepositoryLike;
  materializer?: MaterializerLike;
  lifecycleRunner?: LifecycleRunnerLike;
  locks?: ProjectLocksLike;
  lockfileWriter?: LockfileWriter;
  clock?: Clock;
  processes?: ChildProcessAdapter;
  garbageCollector?: GarbageCollectorLike;
  doctor?: DoctorLike;
  toolVersion?: string;
}

export interface NodeGlueApi {
  installProject(options: EnsureProjectOptions): Promise<InstallResult>;
  ensureProject(options: EnsureProjectOptions): Promise<InstallResult>;
  inspectProject(projectRoot: string): Promise<ProjectState>;
  /** Structured, read-only diagnostics for the targeted project. */
  doctorProject?(projectRoot: string): Promise<DoctorReport>;
  garbageCollect(storeDir?: string): Promise<GarbageCollectionResult>;
}

interface ResolvedDependencies {
  filesystem: FileSystemAdapter;
  inputReader: InputReaderLike;
  resolver: ResolverLike;
  sourceAdapter: SourceAdapter;
  packageStore: StoreLike;
  mapRepository: MapRepositoryLike;
  stateRepository: StateRepositoryLike;
  materializer: MaterializerLike;
  lifecycleRunner: LifecycleRunnerLike;
  doctor: DoctorLike;
  locks: ProjectLocksLike;
  lockfileWriter?: LockfileWriter;
  clock: Clock;
  garbageCollector?: GarbageCollectorLike;
  toolVersion: string;
}

interface ExistingProjectState {
  map?: ProjectMap;
  state?: ProjectState;
}

/**
 * Public orchestration boundary. Every side-effecting collaborator is injectable
 * so callers can use the same workflow with test doubles or alternate stores.
 */
export class DefaultNodeGlueApi implements NodeGlueApi {
  private readonly dependencies: ResolvedDependencies;

  constructor(options: NodeGlueApiOptions = {}) {
    this.dependencies = resolveDependencies(options);
  }

  installProject(options: EnsureProjectOptions): Promise<InstallResult> {
    return this.ensureProject(options);
  }

  async ensureProject(options: EnsureProjectOptions): Promise<InstallResult> {
    const input = await this.dependencies.inputReader.read(options.projectRoot);
    const projectId = await this.dependencies.mapRepository.projectIdFor(input.projectRoot);
    const lease = await this.dependencies.locks.acquireProject(projectId, { owner: 'node-glue-api' });
    try {
      // Read again after acquiring the lock so the hash and graph describe the
      // same project state that this operation is about to publish.
      const lockedInput = await this.dependencies.inputReader.readRoot(input.projectRoot);
      const existing = await this.readExisting(lockedInput.projectRoot);
      const currentInputHash = inputHash(lockedInput);

      if (
        existing.map !== undefined
        && existing.map.projectRoot === lockedInput.projectRoot
        && existing.map.lockfileHash === currentInputHash
        && existing.state !== undefined
        && await this.isMaterializationHealthy(lockedInput, existing.map, existing.state)
      ) {
        return {
          projectRoot: lockedInput.projectRoot,
          packagesAdded: 0,
          packagesReused: existing.map.placements.length,
          packagesRemoved: 0,
          materializationGeneration: existing.state.lastSuccessfulMaterializationGeneration
            ?? generationFromTarget(existing.state.activeTarget)
            ?? 'unknown'
        };
      }

      const resolveOptions = {
        ...(options.registry === undefined ? {} : { registry: options.registry }),
        ...(options.lifecyclePolicy === undefined ? {} : { lifecyclePolicy: options.lifecyclePolicy }),
        includeDevDependencies: true
      };
      const resolved = await this.dependencies.resolver.resolve(lockedInput, resolveOptions);
      const acquisition = await this.acquirePackages(resolved, {
        ...(options.storeDir === undefined ? {} : { storeDir: options.storeDir })
      });
      let project = acquisition.project;
      let lockfileHash = project.lockfileHash;
      if (lockedInput.lockfile === undefined) {
        const writer = this.dependencies.lockfileWriter ?? new LockfileWriter({ filesystem: this.dependencies.filesystem });
        const publication = await writer.publish(project, lockedInput.packageManifest);
        lockfileHash = publication.lockfileHash;
        project = { ...project, lockfileHash };
      }

      const candidateMap: ProjectMap = {
        schemaVersion: 1,
        projectId,
        projectRoot: lockedInput.projectRoot,
        lockfileHash,
        placements: project.placements,
        generatedAt: this.dependencies.clock.nowIso(),
        toolVersion: this.dependencies.toolVersion
      };

      const publishedMap = await this.dependencies.mapRepository.publish(candidateMap);
      let materialization: MaterializationResult | undefined;
      try {
        // Lifecycle runs only after exact map publication and before the staged
        // generation becomes active. Store paths remain protected by runner.
        const lifecyclePolicy = options.lifecyclePolicy
          ?? { enabled: options.runScripts === true };
        await this.dependencies.lifecycleRunner.run(project, lifecyclePolicy);
        materialization = await this.dependencies.materializer.materialize(lockedInput.projectRoot, publishedMap);

        const now = this.dependencies.clock.nowIso();
        await this.dependencies.stateRepository.publish({
          schemaVersion: 1,
          projectId: publishedMap.projectId,
          projectRoot: publishedMap.projectRoot,
          lastSuccessfulMapGeneration: publishedMap.generatedAt,
          lastSuccessfulMaterializationGeneration: materialization.generation,
          activeTarget: materialization.activeTarget,
          updatedAt: now,
          lastSuccessfulAt: now,
          status: 'ready'
        });
      } catch (cause) {
        await this.rollbackFailedPublication(publishedMap, existing, materialization, cause);
        throw cause;
      }

      // Materialization and state publication both completed, so the result is
      // now safe to expose. The definite assignment is established by the
      // successful branch above.
      const successfulMaterialization = materialization!;
      const previousHashes = new Set(existing.map?.placements.map((placement) => placement.packageIdentityHash) ?? []);
      const currentHashes = new Set(publishedMap.placements.map((placement) => placement.packageIdentityHash));
      return {
        projectRoot: lockedInput.projectRoot,
        packagesAdded: acquisition.packagesAdded,
        packagesReused: acquisition.packagesReused,
        packagesRemoved: [...previousHashes].filter((hash) => !currentHashes.has(hash)).length,
        materializationGeneration: successfulMaterialization.generation
      };
    } finally {
      await lease.release();
    }
  }

  async inspectProject(projectRoot: string): Promise<ProjectState> {
    const input = await this.dependencies.inputReader.read(projectRoot);
    const projectId = await this.dependencies.mapRepository.projectIdFor(input.projectRoot);
    const lease = await this.dependencies.locks.acquireProject(projectId, { owner: 'node-glue-inspect' });
    try {
      const lockedInput = await this.dependencies.inputReader.readRoot(input.projectRoot);
      const existing = await this.readExisting(lockedInput.projectRoot);
      const advisory = existing.state;
      const base: ProjectState = advisory ?? {
        schemaVersion: 1,
        projectId: existing.map?.projectId ?? projectId,
        projectRoot: lockedInput.projectRoot,
        updatedAt: this.dependencies.clock.nowIso(),
        status: 'unknown'
      };
      if (existing.map === undefined) return { ...base, status: 'unknown' };
      const healthy = existing.state !== undefined
        && await this.isMaterializationHealthy(lockedInput, existing.map, existing.state);
      return { ...base, projectId: existing.map.projectId, projectRoot: existing.map.projectRoot, status: healthy ? 'ready' : 'incomplete' };
    } finally {
      await lease.release();
    }
  }

  async doctorProject(projectRoot: string): Promise<DoctorReport> {
    return this.dependencies.doctor.inspectProject(projectRoot);
  }

  async garbageCollect(storeDir = this.dependencies.packageStore.storeDir): Promise<GarbageCollectionResult> {
    if (this.dependencies.garbageCollector === undefined) {
      throw new InvalidInputError('Garbage collection is not configured for this API instance.', {
        operation: 'garbage-collect'
      });
    }
    return this.dependencies.garbageCollector.collect(storeDir);
  }

  private async readExisting(projectRoot: string): Promise<ExistingProjectState> {
    const projectId = await this.dependencies.mapRepository.projectIdFor(projectRoot);
    let map = await this.dependencies.mapRepository.read(projectId);
    if (map === undefined) {
      const candidates = await this.dependencies.mapRepository.list();
      const candidate = candidates.find((item) => normalize(resolve(item.projectRoot)) === normalize(resolve(projectRoot)));
      if (candidate !== undefined) {
        map = await this.dependencies.mapRepository.read(candidate.projectId);
      }
    }
    if (map === undefined) return {};
    let state: ProjectState | undefined;
    try {
      state = await this.dependencies.stateRepository.read(map.projectId);
    } catch {
      // Advisory state is never authoritative; malformed state makes the
      // project non-idempotent and inspect reports it as incomplete.
    }
    return { map, ...(state === undefined ? {} : { state }) };
  }

  private async isMaterializationHealthy(input: ProjectInput, map: ProjectMap, state: ProjectState): Promise<boolean> {
    if (state.status !== 'ready' || state.projectRoot !== input.projectRoot || state.projectId !== map.projectId) return false;
    if (map.lockfileHash !== inputHash(input) || state.activeTarget === undefined) return false;
    try {
      const targetMetadata = await this.dependencies.filesystem.lstat(state.activeTarget);
      if (targetMetadata.type !== 'directory') return false;
      const nodeModulesPath = join(input.projectRoot, 'node_modules');
      const rootMetadata = await this.dependencies.filesystem.lstat(nodeModulesPath);
      if (rootMetadata.type !== 'symlink') return false;
      const linkTarget = await this.dependencies.filesystem.readlink(nodeModulesPath);
      const absoluteTarget = resolve(dirname(nodeModulesPath), linkTarget);
      if (normalize(absoluteTarget) !== normalize(resolve(state.activeTarget))) return false;
      for (const placement of map.placements) {
        const instance = await this.dependencies.packageStore.get(placement.packageIdentityHash);
        if (instance === undefined) return false;
        const content = await this.dependencies.filesystem.lstat(instance.contentPath);
        if (content.type !== 'directory') return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async acquirePackages(
    resolved: ResolvedProject,
    options: StoreOptions
  ): Promise<{ project: ResolvedProject; packagesAdded: number; packagesReused: number }> {
    const ensuredByIdentity = new Map<string, PackageInstance>();
    let packagesAdded = 0;
    let packagesReused = 0;
    for (const source of resolved.sources) {
      const identityHash = hashPackageIdentity(packageIdentityFromResolvedSource(source));
      const existing = await this.dependencies.packageStore.get(identityHash);
      if (existing === undefined) packagesAdded += 1;
      else packagesReused += 1;
      const instance = await this.dependencies.packageStore.ensure(source, options);
      ensuredByIdentity.set(identityHash, instance);
    }

    const packageHashRemap = new Map<string, string>();
    const packages: PackageInstance[] = [];
    for (const packageInstance of resolved.packages) {
      const ensured = ensuredByIdentity.get(packageInstance.identityHash)
        ?? await this.dependencies.packageStore.get(packageInstance.identityHash);
      if (ensured === undefined) {
        throw new InvalidInputError('Resolved graph package was not acquired into the central store.', {
          packageName: packageInstance.identity.name,
          identityHash: packageInstance.identityHash
        });
      }
      packageHashRemap.set(packageInstance.identityHash, ensured.identityHash);
      if (!packages.some((candidate) => candidate.identityHash === ensured.identityHash)) packages.push(ensured);
    }
    return {
      project: {
        ...resolved,
        packages,
        placements: resolved.placements.map((placement) => ({
          ...placement,
          packageIdentityHash: packageHashRemap.get(placement.packageIdentityHash) ?? placement.packageIdentityHash
        }))
      },
      packagesAdded,
      packagesReused
    };
  }

  private async rollbackFailedPublication(
    publishedMap: ProjectMap,
    previous: ExistingProjectState,
    materialization: MaterializationResult | undefined,
    cause: unknown
  ): Promise<void> {
    const failures: unknown[] = [];
    if (materialization !== undefined) {
      if (this.dependencies.materializer.rollback === undefined) {
        failures.push(new Error('Materializer does not expose a rollback boundary.'));
      } else {
        try {
          await this.dependencies.materializer.rollback(
            materialization,
            previousMaterialization(previous)
          );
        } catch (rollbackCause) {
          failures.push(rollbackCause);
        }
      }
    }

    try {
      if (previous.map === undefined) {
        if (this.dependencies.mapRepository.remove === undefined) {
          failures.push(new Error('Project Map repository does not expose removal for failed first publication.'));
        } else {
          await this.dependencies.mapRepository.remove(publishedMap.projectId);
        }
      } else {
        await this.dependencies.mapRepository.publish(previous.map);
      }
    } catch (rollbackCause) {
      failures.push(rollbackCause);
    }

    try {
      if (previous.state === undefined) {
        if (this.dependencies.stateRepository.remove !== undefined) {
          await this.dependencies.stateRepository.remove(publishedMap.projectId);
        }
      } else {
        await this.dependencies.stateRepository.publish(previous.state);
      }
    } catch (rollbackCause) {
      failures.push(rollbackCause);
    }

    if (failures.length > 0) {
      throw new PublicationError(
        'Node Glue could not restore the last successful project state after publication failed.',
        {
          projectRoot: publishedMap.projectRoot,
          projectId: publishedMap.projectId,
          rollbackFailures: failures.map((failure) => failure instanceof Error ? failure.message : String(failure))
        },
        cause
      );
    }
  }
}

function previousMaterialization(existing: ExistingProjectState): MaterializationResult | undefined {
  const state = existing.state;
  if (state?.activeTarget === undefined || existing.map === undefined) return undefined;
  return {
    projectRoot: existing.map.projectRoot,
    projectId: existing.map.projectId,
    generation: state.lastSuccessfulMaterializationGeneration
      ?? generationFromTarget(state.activeTarget)
      ?? 'previous',
    activeTarget: state.activeTarget,
    packagesMaterialized: existing.map.placements.length
  };
}

export function createNodeGlueApi(options: NodeGlueApiOptions = {}): NodeGlueApi {
  return new DefaultNodeGlueApi(options);
}

const defaultApis = new Map<string, NodeGlueApi>();

export async function installProject(options: EnsureProjectOptions, api?: NodeGlueApi): Promise<InstallResult> {
  return (api ?? defaultApi(options.storeDir)).installProject(options);
}

export async function ensureProject(options: EnsureProjectOptions, api?: NodeGlueApi): Promise<InstallResult> {
  return (api ?? defaultApi(options.storeDir)).ensureProject(options);
}

export async function inspectProject(projectRoot: string, api?: NodeGlueApi): Promise<ProjectState> {
  return (api ?? defaultApi()).inspectProject(projectRoot);
}

export async function doctorProject(projectRoot: string, api?: NodeGlueApi): Promise<DoctorReport> {
  const candidate = api ?? defaultApi();
  if (candidate.doctorProject === undefined) {
    throw new InvalidInputError('Doctor diagnostics are not configured for this API instance.', {
      operation: 'doctor'
    });
  }
  return candidate.doctorProject(projectRoot);
}

export async function garbageCollect(storeDir?: string, api?: NodeGlueApi): Promise<GarbageCollectionResult> {
  return (api ?? defaultApi(storeDir)).garbageCollect(storeDir);
}

function defaultApi(storeDir?: string): NodeGlueApi {
  const key = resolve(storeDir ?? join(process.env.HOME ?? process.cwd(), '.node_modules'));
  const existing = defaultApis.get(key);
  if (existing !== undefined) return existing;
  const api = createNodeGlueApi({ packageStoreOptions: { storeDir: key } });
  defaultApis.set(key, api);
  return api;
}

function resolveDependencies(options: NodeGlueApiOptions): ResolvedDependencies {
  const filesystem = options.filesystem ?? new NodeFileSystemAdapter();
  const storeDir = options.packageStoreOptions?.storeDir ?? options.packageStore?.storeDir;
  const sourceRegistry = options.sourceAdapter === undefined
    ? new SourceAdapterRegistry(
      options.sourceAdapters ?? createDefaultSourceAdapters({
        filesystem,
        registry: options.registryTransport ?? new PacoteRegistryTransport(),
        sources: options.sourceTransport ?? new PacoteSourceTransport()
      })
    )
    : undefined;
  const sourceAdapter: SourceAdapter = options.sourceAdapter ?? {
    canHandle: (source) => {
      try {
        sourceRegistry!.find(source);
        return true;
      } catch {
        return false;
      }
    },
    resolve: (source) => sourceRegistry!.resolve(source),
    fetch: (source, destination) => sourceRegistry!.fetch(source, destination)
  };
  const lockOptions = {
    filesystem,
    ...(storeDir === undefined ? {} : { storeDir })
  };
  const locks = options.locks ?? new ProjectStoreLocks(lockOptions);
  const packageStore = options.packageStore ?? new PackageStore({
    filesystem,
    sourceAdapter,
    ...(storeDir === undefined ? {} : { storeDir }),
    ...(locks instanceof ProjectStoreLocks ? { locks: locks.adapter } : {}),
    ...(options.packageStoreOptions ?? {})
  });
  const effectiveStoreDir = storeDir ?? packageStore.storeDir;
  const mapRepository = options.mapRepository ?? new ProjectMapRepository({
    filesystem,
    ...(effectiveStoreDir === undefined ? {} : { storeDir: effectiveStoreDir }),
    packageStore
  });
  const stateRepository = options.stateRepository ?? new ProjectStateRepository({
    filesystem,
    ...(effectiveStoreDir === undefined ? {} : { storeDir: effectiveStoreDir })
  });
  const resolver = options.resolver ?? new DependencyResolver({
    ...options.resolverOptions,
    sourceAdapter: { resolve: (source) => sourceAdapter.resolve(source) }
  });
  const materializer = options.materializer ?? new Materializer({
    filesystem,
    packageStore,
    ...(effectiveStoreDir === undefined ? {} : {
      storeDir: effectiveStoreDir,
      generationRegistry: new FileSystemProjectGenerationRegistry(filesystem, join(effectiveStoreDir, 'projects'))
    })
  });
  const processes = options.processes ?? new NodeChildProcessAdapter();
  const lifecycleRunner = options.lifecycleRunner ?? new LifecycleRunner({
    filesystem,
    processes,
    platform: new NodePlatformCapabilityAdapter(filesystem),
    ...(effectiveStoreDir === undefined ? {} : { protectedStorePaths: [join(resolve(effectiveStoreDir), 'packages')] })
  });
  const doctor = options.doctor ?? new Doctor({
    filesystem,
    packageStore,
    ...(effectiveStoreDir === undefined ? {} : { storeDir: effectiveStoreDir }),
    ...(effectiveStoreDir === undefined ? {} : { projectsDir: join(effectiveStoreDir, 'projects') })
  });
  const garbageCollector = options.garbageCollector ?? (
    locks instanceof ProjectStoreLocks
      ? new GarbageCollector({
        filesystem,
        locks: locks.adapter,
        ...(effectiveStoreDir === undefined ? {} : { storeDir: effectiveStoreDir })
      })
      : undefined
  );
  return {
    filesystem,
    inputReader: options.inputReader ?? new InputReader({ filesystem }),
    resolver,
    sourceAdapter,
    packageStore,
    mapRepository,
    stateRepository,
    materializer,
    lifecycleRunner,
    doctor,
    locks,
    ...(options.lockfileWriter === undefined ? {} : { lockfileWriter: options.lockfileWriter }),
    clock: options.clock ?? systemClock,
    ...(garbageCollector === undefined ? {} : { garbageCollector }),
    toolVersion: options.toolVersion ?? VERSION
  };
}

function inputHash(input: ProjectInput): string {
  return input.lockfileHash ?? input.packageJsonHash;
}

function generationFromTarget(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  const marker = '/generations/';
  const index = target.lastIndexOf(marker);
  if (index < 0) return undefined;
  const generation = target.slice(index + marker.length).split('/')[0];
  return generation === undefined || generation.length === 0 ? undefined : generation;
}

const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString()
};

class FileSystemProjectGenerationRegistry implements ProjectGenerationRegistry {
  constructor(private readonly filesystem: FileSystemAdapter, private readonly projectsDir: string) {}

  async list(projectId?: string) {
    if (!(await this.filesystem.exists(this.projectsDir))) return [];
    const registrations: Array<{ projectId: string; generation: string; projectRoot: string; generationPath: string }> = [];
    for (const project of await this.filesystem.listDirectory(this.projectsDir)) {
      if (project.type !== 'directory' || (projectId !== undefined && project.name !== projectId)) continue;
      const generationsDir = join(this.projectsDir, project.name, 'generations');
      if (!(await this.filesystem.exists(generationsDir))) continue;
      for (const generation of await this.filesystem.listDirectory(generationsDir)) {
        if (generation.type !== 'directory') continue;
        const generationPath = join(generationsDir, generation.name, 'node_modules');
        try {
          const marker = JSON.parse(await this.filesystem.readTextFile(generationOwnershipMarkerPath(generationPath))) as Record<string, unknown>;
          if (
            marker.schemaVersion !== 1
            || marker.projectId !== project.name
            || marker.generation !== generation.name
            || typeof marker.projectRoot !== 'string'
            || !marker.projectRoot.startsWith('/')
          ) continue;
          registrations.push({
            projectId: project.name,
            generation: generation.name,
            projectRoot: normalize(resolve(marker.projectRoot)),
            generationPath: normalize(resolve(generationPath))
          });
        } catch {
          // Invalid or incomplete generations are intentionally not ownership proof.
        }
      }
    }
    return registrations;
  }
}

class NodeFileSystemAdapter implements FileSystemAdapter {
  async lstat(path: string): Promise<FileMetadata> {
    const metadata = await nodeLstat(path);
    const type = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : metadata.isSymbolicLink() ? 'symlink' : 'other';
    return {
      path: resolve(path),
      type,
      ...(metadata.size === undefined ? {} : { size: metadata.size }),
      ...(metadata.mode === undefined ? {} : { mode: metadata.mode }),
      ...(metadata.mtimeMs === undefined ? {} : { mtimeMs: metadata.mtimeMs })
    };
  }
  async exists(path: string): Promise<boolean> {
    try { await lstatNoFollow(path); return true; } catch { return false; }
  }
  async readFile(path: string): Promise<Uint8Array> { return nodeReadFile(path); }
  async readTextFile(path: string): Promise<string> { return nodeReadFile(path, 'utf8'); }
  async writeFile(path: string, data: Uint8Array | string): Promise<void> { await nodeWriteFile(path, data); }
  async createFileExclusive(path: string, data: Uint8Array | string): Promise<boolean> {
    try { const handle = await open(path, 'wx'); try { await handle.writeFile(data); } finally { await handle.close(); } return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false; throw cause; }
  }
  async writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> { await nodeWriteFile(path, data); }
  async sync(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> { await nodeMkdir(path, options); }
  async rename(source: string, destination: string): Promise<void> { await nodeRename(source, destination); }
  async remove(path: string, options?: RemoveOptions): Promise<void> { await rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false }); }
  async symlink(target: string, path: string): Promise<void> { await nodeSymlink(target, path); }
  async readlink(path: string): Promise<string> { return nodeReadlink(path, 'utf8'); }
  async realpath(path: string): Promise<string> { return nodeRealpath(path); }
  async listDirectory(path: string) { const entries = await readdir(path, { withFileTypes: true }); return entries.map((entry) => ({ name: entry.name, type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : entry.isSymbolicLink() ? 'symlink' as const : 'other' as const })); }
  async createTemporaryDirectory(parent: string, prefix: string): Promise<string> { return mkdtemp(join(parent, prefix)); }
}

async function lstatNoFollow(path: string): Promise<void> { await nodeLstat(path); }

class NodeChildProcessAdapter implements ChildProcessAdapter {
  async run(spec: ProcessSpec): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env as NodeJS.ProcessEnv | undefined,
        shell: false,
        stdio: [spec.stdin ?? 'ignore', spec.stdout ?? 'pipe', spec.stderr ?? 'pipe']
      });
      let stdout = ''; let stderr = '';
      if (child.stdout !== null) child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      if (child.stderr !== null) child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolveResult({
        exitCode,
        stdout,
        stderr,
        ...(signal === null ? {} : { signal })
      }));
    });
  }
}

class PacoteRegistryTransport implements RegistryTransport {
  async getMetadata(registry: string, name: string) { const pacote = getPacote(); return await pacote.packument(name, { registry }); }
  async getTarball(locator: string): Promise<SourceArtifact> { const pacote = getPacote(); return { data: new Uint8Array(await pacote.tarball(locator)) }; }
}

class PacoteSourceTransport implements SourceTransport {
  async fetch(locator: string): Promise<SourceArtifact> { const pacote = getPacote(); return { data: new Uint8Array(await pacote.tarball(locator)) }; }
  async resolveGit(locator: string, ref?: string): Promise<{ resolvedLocator: string; revision: string }> {
    const result = await execFile('git', ['ls-remote', locator, ref ?? 'HEAD']);
    const line = String(result.stdout).trim().split(/\r?\n/)[0] ?? '';
    const revision = line.split(/\s+/)[0];
    if (revision === undefined || !/^[a-f0-9]{7,64}$/i.test(revision)) throw new Error(`Git reference did not resolve: ${locator}`);
    return { resolvedLocator: `${locator}#${revision}`, revision };
  }
}

function getPacote(): { packument(name: string, options: Record<string, unknown>): Promise<any>; tarball(locator: string): Promise<Uint8Array> } {
  return require('pacote') as { packument(name: string, options: Record<string, unknown>): Promise<any>; tarball(locator: string): Promise<Uint8Array> };
}
