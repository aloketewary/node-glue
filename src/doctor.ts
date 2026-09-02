import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import { InputReader } from './input-reader.js';
import {
  DiagnosticCode,
  NodeGlueError,
  sanitizeDiagnosticContext,
  type DiagnosticContext
} from './errors.js';
import {
  GENERATION_OWNERSHIP_MARKER,
  inspectNodeModulesOwnership,
  type GenerationOwnershipMarker,
  type NodeModulesOwnership,
  type ProjectGenerationRegistry,
  type RegisteredProjectGeneration
} from './ownership.js';
import { deriveProjectId, validateProjectMap } from './project-map.js';
import { validateProjectState } from './state.js';
import { hashPackageIdentity } from './package-identity.js';
import type {
  PackageInstance,
  ProjectMap,
  ProjectState,
  NodePlatform
} from './types.js';
import type { PackageStoreReference } from './materializer.js';

export type DoctorSeverity = 'error' | 'warning' | 'info';

export interface DoctorFinding {
  code: DiagnosticCode;
  severity: DoctorSeverity;
  message: string;
  /** Primary affected filesystem path, when the finding has one. */
  path?: string;
  /** Safe, actionable explanation of the observed state. */
  reason: string;
  context: DiagnosticContext;
}

export interface DoctorMaterialization {
  rootNodeModulesPath: string;
  ownership: NodeModulesOwnership;
  activeTarget?: string;
  activeGeneration?: string;
  rootLinkTarget?: string;
  completeGenerations: readonly string[];
  incompleteGenerations: readonly string[];
}

export interface DoctorReport {
  projectRoot: string;
  projectId?: string;
  status: ProjectState['status'];
  /** Validated persisted map, exposed so successful state is discoverable. */
  map?: ProjectMap;
  /** Validated advisory state, exposed alongside the map. */
  state?: ProjectState;
  materialization?: DoctorMaterialization;
  findings: readonly DoctorFinding[];
}

export interface DoctorCapabilities {
  symlinks?: boolean;
  atomicRename?: boolean;
  protectedPaths?: boolean;
}

export interface DoctorOptions {
  filesystem: FileSystemAdapter;
  packageStore: PackageStoreReference;
  storeDir?: string;
  projectsDir?: string;
  inputReader?: Pick<InputReader, 'readRoot'>;
  generationRegistry?: ProjectGenerationRegistry;
  capabilities?: DoctorCapabilities;
  platform?: NodePlatform;
}

interface LoadedMap {
  map?: ProjectMap;
  mapPath: string;
  finding?: DoctorFinding;
}

interface LoadedState {
  state?: ProjectState;
  statePath: string;
  finding?: DoctorFinding;
}

interface GenerationScan {
  complete: string[];
  incomplete: string[];
}

/**
 * Read-only inspection of the persisted project map, advisory state, store
 * references, generations, and project-root node_modules ownership. Doctor
 * never repairs or removes anything; ambiguous state is reported instead.
 */
export class Doctor {
  readonly projectsDir: string;
  readonly storeDir: string;

  private readonly filesystem: FileSystemAdapter;
  private readonly packageStore: PackageStoreReference;
  private readonly inputReader: Pick<InputReader, 'readRoot'>;
  private readonly generationRegistry: ProjectGenerationRegistry;
  private readonly capabilities: DoctorCapabilities;
  private readonly platform: NodePlatform;

  constructor(options: DoctorOptions) {
    this.filesystem = options.filesystem;
    this.packageStore = options.packageStore;
    this.storeDir = resolve(options.storeDir ?? options.packageStore.storeDir ?? join(homedir(), '.node_modules'));
    this.projectsDir = resolve(options.projectsDir ?? join(this.storeDir, 'projects'));
    this.inputReader = options.inputReader ?? new InputReader({ filesystem: options.filesystem });
    this.generationRegistry = options.generationRegistry ?? new FileSystemGenerationRegistry(
      this.filesystem,
      this.projectsDir
    );
    this.capabilities = options.capabilities ?? {};
    this.platform = options.platform ?? process.platform;
  }

  /** Inspect the map belonging to one project root, including collision-safe IDs. */
  async inspectProject(projectRoot: string): Promise<DoctorReport> {
    const requestedRoot = normalize(resolve(projectRoot));
    const findings: DoctorFinding[] = [];
    this.addCapabilityFindings(findings);

    const candidates = await this.findMapCandidates(requestedRoot, findings);
    const candidate = candidates.find((item) => item.map?.projectRoot === requestedRoot);
    const expectedId = deriveProjectId(requestedRoot);
    const loaded = candidate ?? await this.loadMap(expectedId);
    if (loaded.finding !== undefined) findings.push(loaded.finding);

    if (loaded.map === undefined) {
      const state = await this.loadState(expectedId);
      if (state.finding !== undefined) findings.push(state.finding);
      if (state.state !== undefined) {
        findings.push(this.finding('STALE_PROJECT_MAP', 'error', state.statePath,
          'Project state exists without a readable Project Map.', { projectId: expectedId }));
      }
      return {
        projectRoot: requestedRoot,
        ...(state.state?.projectId === expectedId ? { projectId: expectedId, state: state.state } : {}),
        status: 'unknown',
        findings: this.uniqueFindings(findings)
      };
    }

    return this.inspectLoadedMap(loaded.map, loaded.mapPath, requestedRoot, findings);
  }

  /** Inspect every readable Project Map under the configured store. */
  async inspectAll(): Promise<readonly DoctorReport[]> {
    const findings: DoctorFinding[] = [];
    this.addCapabilityFindings(findings);
    if (!(await this.filesystem.exists(this.projectsDir))) return [];

    const reports: DoctorReport[] = [];
    for (const entry of await this.filesystem.listDirectory(this.projectsDir)) {
      if (entry.type !== 'directory') continue;
      const loaded = await this.loadMap(entry.name);
      if (loaded.map === undefined) {
        if (loaded.finding !== undefined) {
          reports.push({
            projectRoot: '',
            projectId: entry.name,
            status: 'unknown',
            findings: this.uniqueFindings([...findings, loaded.finding])
          });
        }
        continue;
      }
      reports.push(await this.inspectLoadedMap(loaded.map, loaded.mapPath, loaded.map.projectRoot, [...findings, ...(loaded.finding === undefined ? [] : [loaded.finding])]));
    }
    return reports;
  }

  private async inspectLoadedMap(
    map: ProjectMap,
    mapPath: string,
    requestedRoot: string,
    initialFindings: readonly DoctorFinding[]
  ): Promise<DoctorReport> {
    const findings = [...initialFindings];
    const projectRoot = normalize(resolve(map.projectRoot));
    if (projectRoot !== requestedRoot) {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', mapPath,
        'Project Map belongs to a different Project Root than the requested project.', {
          projectId: map.projectId,
          projectRoot,
          requestedRoot
        }));
    }

    const state = await this.loadState(map.projectId);
    if (state.finding !== undefined) findings.push(state.finding);
    if (state.state === undefined) {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', state.statePath,
        'Project Map has no successful advisory state.', { projectId: map.projectId }));
    } else {
      this.checkState(map, state.state, state.statePath, findings);
    }

    await this.checkCurrentInput(map, findings);
    await this.checkMapReferences(map, mapPath, findings);

    const generations = await this.scanGenerations(map, findings);
    const rootNodeModulesPath = join(projectRoot, 'node_modules');
    let ownership: NodeModulesOwnership;
    try {
      ownership = await inspectNodeModulesOwnership(rootNodeModulesPath, {
        filesystem: this.filesystem,
        registry: this.generationRegistry,
        projectId: map.projectId,
        projectRoot
      });
    } catch (cause) {
      ownership = {
        kind: 'unknown-marker',
        path: rootNodeModulesPath,
        reason: 'Unable to inspect node_modules ownership safely.'
      };
      findings.push(this.findingFromCause('OWNERSHIP_UNKNOWN', 'error', rootNodeModulesPath,
        'Node Glue could not determine node_modules ownership safely.', cause));
    }

    const materialization = await this.inspectMaterialization(
      map,
      state.state,
      ownership,
      generations,
      rootNodeModulesPath,
      findings
    );
    const uniqueFindings = this.uniqueFindings(findings);
    const hasErrors = uniqueFindings.some((finding) => finding.severity === 'error');
    const status: ProjectState['status'] = hasErrors
      ? 'incomplete'
      : state.state !== undefined && state.state.status === 'ready'
        ? 'ready'
        : 'incomplete';

    return {
      projectRoot,
      projectId: map.projectId,
      status,
      map,
      ...(state.state === undefined ? {} : { state: state.state }),
      materialization,
      findings: uniqueFindings
    };
  }

  private async findMapCandidates(projectRoot: string, findings: DoctorFinding[]): Promise<LoadedMap[]> {
    const candidates: LoadedMap[] = [];
    if (await this.filesystem.exists(this.projectsDir)) {
      let entries;
      try {
        entries = await this.filesystem.listDirectory(this.projectsDir);
      } catch (cause) {
        findings.push(this.findingFromCause('MAP_FAILURE', 'error', this.projectsDir,
          'Project Map directory could not be inspected.', cause));
        return candidates;
      }
      for (const entry of entries) {
        if (entry.type !== 'directory') continue;
        const loaded = await this.loadMap(entry.name);
        candidates.push(loaded);
      }
    }
    return candidates;
  }

  private async loadMap(projectId: string): Promise<LoadedMap> {
    const mapPath = join(this.projectsDir, projectId, 'map.json');
    if (!(await this.filesystem.exists(mapPath))) return { mapPath };
    try {
      const parsed: unknown = JSON.parse(await this.filesystem.readTextFile(mapPath));
      const map = validateProjectMap(parsed);
      if (map.projectId !== projectId) {
        return {
          mapPath,
          finding: this.finding('MAP_FAILURE', 'error', mapPath,
            'Project Map identifier does not match its directory.', { projectId, mapProjectId: map.projectId })
        };
      }
      return { map, mapPath };
    } catch (cause) {
      return {
        mapPath,
        finding: this.findingFromCause('MAP_FAILURE', 'error', mapPath,
          'Project Map is unreadable, malformed, or unsupported.', cause, { projectId })
      };
    }
  }

  private async loadState(projectId: string): Promise<LoadedState> {
    const statePath = join(this.projectsDir, projectId, 'state.json');
    if (!(await this.filesystem.exists(statePath))) return { statePath };
    try {
      const state = validateProjectState(JSON.parse(await this.filesystem.readTextFile(statePath)));
      if (state.projectId !== projectId) {
        return {
          statePath,
          finding: this.finding('MAP_FAILURE', 'error', statePath,
            'Project state identifier does not match its directory.', { projectId, stateProjectId: state.projectId })
        };
      }
      return { state, statePath };
    } catch (cause) {
      return {
        statePath,
        finding: this.findingFromCause('MAP_FAILURE', 'error', statePath,
          'Project state is unreadable, malformed, or unsupported.', cause, { projectId })
      };
    }
  }

  private checkState(
    map: ProjectMap,
    state: ProjectState,
    statePath: string,
    findings: DoctorFinding[]
  ): void {
    if (state.projectRoot !== map.projectRoot || state.projectId !== map.projectId) {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', statePath,
        'Project state does not describe the current Project Map.', {
          projectId: map.projectId,
          mapGeneration: map.generatedAt,
          stateMapGeneration: state.lastSuccessfulMapGeneration
        }));
    }
    if (state.status !== 'ready') {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', statePath,
        `Project state is marked ${state.status}, not ready.`, { projectId: map.projectId }));
    }
    if (state.lastSuccessfulMapGeneration !== undefined && state.lastSuccessfulMapGeneration !== map.generatedAt) {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', statePath,
        'Advisory state points to a different Project Map generation.', {
          projectId: map.projectId,
          mapGeneration: map.generatedAt,
          stateMapGeneration: state.lastSuccessfulMapGeneration
        }));
    }
  }

  private async checkCurrentInput(map: ProjectMap, findings: DoctorFinding[]): Promise<void> {
    const packageJsonPath = join(map.projectRoot, 'package.json');
    if (!(await this.filesystem.exists(packageJsonPath))) return;
    try {
      const input = await this.inputReader.readRoot(map.projectRoot);
      const currentHash = input.lockfileHash ?? input.packageJsonHash;
      if (currentHash !== map.lockfileHash) {
        findings.push(this.finding('STALE_PROJECT_MAP', 'error', map.projectRoot,
          'Project input changed since the Project Map was published.', {
            projectId: map.projectId,
            mapLockfileHash: map.lockfileHash,
            currentInputHash: currentHash
          }));
      }
    } catch (cause) {
      const code = cause instanceof NodeGlueError ? cause.code : 'PARSE_FAILURE';
      findings.push(this.findingFromCause(code, 'error', packageJsonPath,
        'Current project input could not be revalidated.', cause, { projectRoot: map.projectRoot }));
    }
  }

  private async checkMapReferences(
    map: ProjectMap,
    mapPath: string,
    findings: DoctorFinding[]
  ): Promise<void> {
    for (const placement of map.placements) {
      const context = {
        projectId: map.projectId,
        identityHash: placement.packageIdentityHash,
        packageName: placement.packageName,
        relativePath: placement.relativePath
      } as const;
      if (!/^[a-f0-9]{64}$/.test(placement.packageIdentityHash)) {
        findings.push(this.finding('UNRESOLVED_REFERENCE', 'error', mapPath,
          'Placement references an invalid Package Instance identity hash.', context));
        continue;
      }
      let instance: PackageInstance | undefined;
      try {
        instance = await this.packageStore.get(placement.packageIdentityHash);
      } catch (cause) {
        findings.push(this.findingFromCause('UNRESOLVED_REFERENCE', 'error', mapPath,
          'Package Instance reference could not be read.', cause, context));
        continue;
      }
      if (instance === undefined) {
        findings.push(this.finding('MISSING_STORE_INSTANCE', 'error', mapPath,
          'Project Map references a Package Instance missing from the central store.', context));
        continue;
      }
      if (!this.instanceMatchesPlacement(instance, placement.packageIdentityHash, placement.packageName)) {
        findings.push(this.finding('UNRESOLVED_REFERENCE', 'error', mapPath,
          'Package Instance metadata does not match its Project Map placement.', context));
        continue;
      }
      try {
        const metadata = await this.filesystem.lstat(instance.contentPath);
        if (metadata.type !== 'directory') {
          findings.push(this.finding('MISSING_STORE_INSTANCE', 'error', instance.contentPath,
            'Package Instance content is not a directory.', context));
        }
      } catch (cause) {
        findings.push(this.findingFromCause('MISSING_STORE_INSTANCE', 'error', instance.contentPath,
          'Verified Package Instance content is missing.', cause, context));
      }
    }
  }

  private async scanGenerations(map: ProjectMap, findings: DoctorFinding[]): Promise<GenerationScan> {
    const complete: string[] = [];
    const incomplete: string[] = [];
    const generationsDir = join(this.projectsDir, map.projectId, 'generations');
    if (!(await this.filesystem.exists(generationsDir))) return { complete, incomplete };

    let entries;
    try {
      entries = await this.filesystem.listDirectory(generationsDir);
    } catch (cause) {
      findings.push(this.findingFromCause('PUBLICATION_FAILURE', 'error', generationsDir,
        'Project generations directory could not be inspected.', cause, { projectId: map.projectId }));
      return { complete, incomplete };
    }
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;
      const generationPath = join(generationsDir, entry.name);
      const nodeModulesPath = join(generationPath, 'node_modules');
      const markerPath = join(nodeModulesPath, GENERATION_OWNERSHIP_MARKER);
      let valid = true;
      try {
        const nodeModulesMetadata = await this.filesystem.lstat(nodeModulesPath);
        if (nodeModulesMetadata.type !== 'directory') valid = false;
        const marker = JSON.parse(await this.filesystem.readTextFile(markerPath)) as unknown;
        if (!valid || !validMarker(marker, map.projectId, entry.name, map.projectRoot)) valid = false;
      } catch {
        valid = false;
      }
      if (valid) {
        complete.push(entry.name);
      } else {
        incomplete.push(entry.name);
        findings.push(this.finding('PUBLICATION_FAILURE', 'error', generationPath,
          'Project generation is incomplete or has an invalid ownership marker.', {
            projectId: map.projectId,
            generation: entry.name
          }));
      }
    }
    return { complete, incomplete };
  }

  private async inspectMaterialization(
    map: ProjectMap,
    state: ProjectState | undefined,
    ownership: NodeModulesOwnership,
    generations: GenerationScan,
    rootNodeModulesPath: string,
    findings: DoctorFinding[]
  ): Promise<DoctorMaterialization> {
    const activeTarget = state?.activeTarget === undefined ? undefined : normalize(resolve(state.activeTarget));
    const activeGeneration = state?.lastSuccessfulMaterializationGeneration;
    let rootLinkTarget: string | undefined;
    if (ownership.kind === 'tool-owned-symlink') {
      rootLinkTarget = normalize(resolve(ownership.path, '..', ownership.target));
      if (activeTarget !== undefined && rootLinkTarget !== activeTarget) {
        findings.push(this.finding('STALE_PROJECT_MAP', 'error', rootNodeModulesPath,
          'Project-root node_modules symlink does not target the active materialization.', {
            projectId: map.projectId,
            activeTarget,
            rootLinkTarget
          }));
      }
    } else if (ownership.kind !== 'absent') {
      const code: DiagnosticCode = ownership.kind === 'unmanaged' ? 'UNMANAGED_NODE_MODULES' : 'OWNERSHIP_UNKNOWN';
      const reason = 'reason' in ownership
        ? ownership.reason
        : 'Project-root node_modules is a tool-owned generation directory rather than the expected symlink.';
      findings.push(this.finding(code, 'error', ownership.path,
        reason, { projectId: map.projectId }));
    } else if (state?.status === 'ready') {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', rootNodeModulesPath,
        'Ready project state has no project-root node_modules link.', { projectId: map.projectId }));
    }

    if (activeTarget !== undefined) {
      const expectedGenerationPath = join(this.projectsDir, map.projectId, 'generations', activeGeneration ?? '', 'node_modules');
      if (activeGeneration === undefined || activeTarget !== normalize(resolve(expectedGenerationPath)) || !generations.complete.includes(activeGeneration)) {
        findings.push(this.finding('STALE_PROJECT_MAP', 'error', activeTarget,
          'Advisory state references a missing or incomplete active generation.', {
            projectId: map.projectId,
            generation: activeGeneration ?? '(missing)'
          }));
      }
    }
    if (state?.status === 'ready' && activeTarget === undefined) {
      findings.push(this.finding('STALE_PROJECT_MAP', 'error', rootNodeModulesPath,
        'Ready project state has no active materialization target.', { projectId: map.projectId }));
    }

    return {
      rootNodeModulesPath,
      ownership,
      ...(activeTarget === undefined ? {} : { activeTarget }),
      ...(activeGeneration === undefined ? {} : { activeGeneration }),
      ...(rootLinkTarget === undefined ? {} : { rootLinkTarget }),
      completeGenerations: generations.complete,
      incompleteGenerations: generations.incomplete
    };
  }

  private addCapabilityFindings(findings: DoctorFinding[]): void {
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      findings.push(this.finding('CAPABILITY_UNAVAILABLE', 'error', undefined,
        'Node Glue MVP installation and materialization require macOS or Linux.', { platform: this.platform }));
    }
    if (this.capabilities.symlinks === false) {
      findings.push(this.finding('CAPABILITY_UNAVAILABLE', 'error', undefined,
        'Symbolic links are unavailable for project-wide node_modules materialization.', { capability: 'symlinks' }));
    }
    if (this.capabilities.atomicRename === false) {
      findings.push(this.finding('CAPABILITY_UNAVAILABLE', 'error', undefined,
        'Atomic same-filesystem rename is unavailable for publication.', { capability: 'atomic-rename' }));
    }
    if (this.capabilities.protectedPaths === false) {
      findings.push(this.finding('CAPABILITY_UNAVAILABLE', 'error', undefined,
        'Protected central-store paths are unavailable for lifecycle execution.', { capability: 'protected-paths' }));
    }
  }

  private instanceMatchesPlacement(instance: PackageInstance, identityHash: string, packageName: string): boolean {
    try {
      return instance.identityHash === identityHash
        && hashPackageIdentity(instance.identity) === identityHash
        && instance.identity.name === packageName
        && instance.manifest.name === packageName
        && instance.manifest.version === instance.identity.versionOrRevision
        && resolve(instance.contentPath).startsWith(resolve(this.storeDir, 'packages') + '/');
    } catch {
      return false;
    }
  }

  private finding(
    code: DiagnosticCode,
    severity: DoctorSeverity,
    path: string | undefined,
    reason: string,
    context: DiagnosticContext = {}
  ): DoctorFinding {
    const safeContext = sanitizeDiagnosticContext(context);
    return {
      code,
      severity,
      message: reason,
      ...(path === undefined ? {} : { path }),
      reason,
      context: safeContext
    };
  }

  private findingFromCause(
    code: DiagnosticCode,
    severity: DoctorSeverity,
    path: string | undefined,
    reason: string,
    cause: unknown,
    context: DiagnosticContext = {}
  ): DoctorFinding {
    const causeContext = cause instanceof NodeGlueError ? cause.context : {};
    return this.finding(code, severity, path, reason, { ...causeContext, ...context });
  }

  private uniqueFindings(findings: readonly DoctorFinding[]): readonly DoctorFinding[] {
    const seen = new Set<string>();
    return findings.filter((finding) => {
      const key = `${finding.code}|${finding.path ?? ''}|${finding.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export function createDoctor(options: DoctorOptions): Doctor {
  return new Doctor(options);
}

class FileSystemGenerationRegistry implements ProjectGenerationRegistry {
  constructor(
    private readonly filesystem: FileSystemAdapter,
    private readonly projectsDir: string
  ) {}

  async list(projectId?: string): Promise<readonly RegisteredProjectGeneration[]> {
    if (!(await this.filesystem.exists(this.projectsDir))) return [];
    const registrations: RegisteredProjectGeneration[] = [];
    for (const project of await this.filesystem.listDirectory(this.projectsDir)) {
      if (project.type !== 'directory' || (projectId !== undefined && project.name !== projectId)) continue;
      const generationsDir = join(this.projectsDir, project.name, 'generations');
      if (!(await this.filesystem.exists(generationsDir))) continue;
      for (const generation of await this.filesystem.listDirectory(generationsDir)) {
        if (generation.type !== 'directory') continue;
        const generationPath = join(generationsDir, generation.name, 'node_modules');
        try {
          const marker = JSON.parse(await this.filesystem.readTextFile(join(generationPath, GENERATION_OWNERSHIP_MARKER))) as Record<string, unknown>;
          if (!validMarker(marker, project.name, generation.name)) continue;
          registrations.push({
            projectId: project.name,
            generation: generation.name,
            projectRoot: normalize(resolve(marker.projectRoot)),
            generationPath: normalize(resolve(generationPath))
          });
        } catch {
          // Incomplete generations cannot prove ownership and are not registered.
        }
      }
    }
    return registrations;
  }
}

function validMarker(
  value: unknown,
  projectId: string,
  generation: string,
  projectRoot?: string
): value is GenerationOwnershipMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === 1
    && marker.projectId === projectId
    && marker.generation === generation
    && typeof marker.projectRoot === 'string'
    && marker.projectRoot.startsWith('/')
    && (projectRoot === undefined || normalize(resolve(marker.projectRoot)) === normalize(resolve(projectRoot)));
}
