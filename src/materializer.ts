import { dirname, join, normalize, relative, resolve } from 'node:path';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import { CapabilityUnavailableError, InvalidInputError, MissingStoreInstanceError, PublicationError } from './errors.js';
import {
  GENERATION_OWNERSHIP_SCHEMA_VERSION,
  assertNodeModulesReplaceable,
  createProjectGenerationRegistry,
  generationOwnershipMarkerPath,
  serializeGenerationOwnershipMarker,
  type ProjectGenerationRegistry,
  type RegisteredProjectGeneration
} from './ownership.js';
import { hashPackageIdentity } from './package-identity.js';
import { validateProjectMap } from './project-map.js';
import { pathWithin } from './sources/utils.js';
import type {
  DependencyPlacement,
  MaterializationResult,
  PackageInstance,
  ProjectMap
} from './types.js';
import {
  createBinLinks,
  planBinLinks,
  validateBinLinkPlans,
  type BinLinkPlan
} from './bin-links.js';

export interface PackageStoreReference {
  get(identityHash: string): Promise<PackageInstance | undefined>;
  storeDir?: string;
}

export interface MaterializerCapabilities {
  /** Whether the host can create symbolic links. Defaults to true. */
  symlinks?: boolean;
  /** Whether same-filesystem rename provides the atomic publication boundary. Defaults to true. */
  atomicRename?: boolean;
}

export interface MaterializerOptions {
  filesystem: FileSystemAdapter;
  packageStore: PackageStoreReference;
  /** Convenience root; defaults to packageStore.storeDir when available. */
  storeDir?: string;
  projectsDir?: string;
  /** Explicit generation IDs make publication and tests deterministic. */
  generation?: string;
  /** Registered generations used to prove ownership of an existing root node_modules path. */
  generationRegistry?: ProjectGenerationRegistry;
  /** Host capability overrides. Unsupported capabilities fail before any publication mutation. */
  capabilities?: MaterializerCapabilities;
}

export interface StagedMaterialization {
  projectRoot: string;
  projectId: string;
  generation: string;
  /** Temporary generation directory, retained for the publication phase. */
  stagingPath: string;
  stagingNodeModulesPath: string;
  /** Final path to which the publication phase will rename stagingPath. */
  generationPath: string;
  packagesMaterialized: number;
  binLinks: readonly BinLinkPlan[];
  cleanup(): Promise<void>;
}

interface ResolvedPlacement {
  placement: DependencyPlacement;
  instance: PackageInstance;
  packagePath: string;
  usePackageView: boolean;
}

interface ExpectedLink {
  target: string;
  /** Canonical target used for type/existence validation. */
  validationTarget: string;
  targetType: 'directory' | 'file';
}

let generationCounter = 0;
let temporaryLinkCounter = 0;

/**
 * Builds a complete dependency tree away from the project's node_modules path.
 * This class intentionally stops at staging; generation/root-link publication is
 * owned by the following materialization phase.
 */
export class Materializer {
  private readonly filesystem: FileSystemAdapter;
  private readonly packageStore: PackageStoreReference;
  private readonly projectsDir: string;
  private readonly storeDir: string | undefined;
  private readonly configuredGeneration: string | undefined;
  private readonly generationRegistry: ProjectGenerationRegistry;
  private readonly publishedGenerations: RegisteredProjectGeneration[] = [];
  private readonly capabilities: MaterializerCapabilities;

  constructor(options: MaterializerOptions) {
    this.filesystem = options.filesystem;
    this.packageStore = options.packageStore;
    const storeDir = options.storeDir ?? options.packageStore.storeDir;
    this.storeDir = storeDir === undefined ? undefined : resolve(storeDir);
    if (options.projectsDir === undefined && storeDir === undefined) {
      throw new InvalidInputError('Materializer requires projectsDir or packageStore.storeDir.');
    }
    this.projectsDir = resolve(options.projectsDir ?? join(storeDir!, 'projects'));
    this.configuredGeneration = options.generation;
    const configuredRegistry = options.generationRegistry ?? createProjectGenerationRegistry([]);
    this.generationRegistry = {
      list: async (projectId?: string) => {
        const configured = await configuredRegistry.list(projectId);
        const published = this.publishedGenerations.filter(
          (registration) => projectId === undefined || registration.projectId === projectId
        );
        return [...configured, ...published];
      }
    };
    this.capabilities = options.capabilities ?? {};
  }

  /** Construct and validate one complete temporary generation. */
  async stage(
    projectRoot: string,
    map: ProjectMap,
    generation = this.configuredGeneration ?? nextGeneration()
  ): Promise<StagedMaterialization> {
    const validatedMap = validateProjectMap(map);
    const canonicalRoot = normalize(resolve(projectRoot));
    if (validatedMap.projectRoot !== canonicalRoot) {
      throw new InvalidInputError('Project Map projectRoot does not match the requested Project Root.', {
        projectRoot: canonicalRoot,
        mapProjectRoot: validatedMap.projectRoot,
        projectId: validatedMap.projectId
      });
    }
    validateGeneration(generation);

    // Resolve and validate all references before creating any staging state.
    const placements = await resolvePlacements(
      validatedMap,
      this.filesystem,
      this.packageStore,
      this.storeDir
    );
    const plannedGenerationPath = join(this.projectsDir, validatedMap.projectId, 'generations', generation);
    const nodeModulesForPlanning = join(plannedGenerationPath, 'node_modules');
    const resolvedPlacements = placements.map(({ placement, instance }) => ({
      placement,
      instance,
      packagePath: join(plannedGenerationPath, ...placement.relativePath.split('/')),
      usePackageView: false
    }));
    for (const item of resolvedPlacements) {
      item.usePackageView = resolvedPlacements.some(
        (other) => other.packagePath !== item.packagePath && other.packagePath.startsWith(`${item.packagePath}/`)
      );
    }
    const binPlans = planBinLinks(
      nodeModulesForPlanning,
      resolvedPlacements.map(({ placement, instance, packagePath }) => ({ placement, instance, packagePath }))
    );
    await validateBinLinkPlans(this.filesystem, binPlans);

    const generationsDir = join(this.projectsDir, validatedMap.projectId, 'generations');
    await this.filesystem.mkdir(generationsDir, { recursive: true });
    const stagingPath = await this.filesystem.createTemporaryDirectory(generationsDir, '.node-glue-generation');
    const stagingNodeModulesPath = join(stagingPath, 'node_modules');
    const generationPath = join(generationsDir, generation);
    const expectedLinks = new Map<string, ExpectedLink>();
    let retained = false;

    try {
      await this.filesystem.mkdir(stagingNodeModulesPath, { recursive: true });
      await this.filesystem.writeFile(
        generationOwnershipMarkerPath(stagingNodeModulesPath),
        serializeGenerationOwnershipMarker({
          schemaVersion: GENERATION_OWNERSHIP_SCHEMA_VERSION,
          projectId: validatedMap.projectId,
          generation,
          projectRoot: canonicalRoot
        })
      );

      const stagedPlacements = resolvedPlacements.map((item) => ({
        ...item,
        packagePath: join(stagingPath, ...item.placement.relativePath.split('/'))
      }));
      for (const item of stagedPlacements) {
        await this.filesystem.mkdir(dirname(item.packagePath), { recursive: true });
        if (item.usePackageView) {
          await mirrorPackageContent(this.filesystem, item.instance.contentPath, item.packagePath, expectedLinks);
        } else {
          await this.filesystem.symlink(item.instance.contentPath, item.packagePath);
          expectedLinks.set(resolve(item.packagePath), {
            target: resolve(item.instance.contentPath),
            validationTarget: resolve(item.instance.contentPath),
            targetType: 'directory'
          });
        }
      }

      const stagedBinPlans = binPlans.map((plan) => ({
        ...plan,
        linkPath: remapStagedPath(plan.linkPath, nodeModulesForPlanning, stagingNodeModulesPath),
        packagePath: remapStagedPath(plan.packagePath, nodeModulesForPlanning, stagingNodeModulesPath)
      }));
      for (const plan of stagedBinPlans) {
        await createBinLinks(this.filesystem, [plan]);
        expectedLinks.set(resolve(plan.linkPath), { target: plan.target, validationTarget: plan.sourcePath, targetType: 'file' });
      }

      await validateStagedTree(
        this.filesystem,
        stagingNodeModulesPath,
        expectedLinks,
        generationOwnershipMarkerPath(stagingNodeModulesPath)
      );
      retained = true;
      const result: StagedMaterialization = {
        projectRoot: canonicalRoot,
        projectId: validatedMap.projectId,
        generation,
        stagingPath,
        stagingNodeModulesPath,
        generationPath,
        packagesMaterialized: stagedPlacements.length,
        binLinks: stagedBinPlans,
        cleanup: async () => {
          if (retained) {
            retained = false;
            await this.filesystem.remove(stagingPath, { recursive: true, force: true });
          }
        }
      };
      return result;
    } catch (cause) {
      await this.filesystem.remove(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (cause instanceof PublicationError || cause instanceof InvalidInputError || cause instanceof MissingStoreInstanceError) {
        throw cause;
      }
      throw new PublicationError('Dependency tree staging failed.', {
        projectId: validatedMap.projectId,
        generation,
        path: stagingNodeModulesPath
      }, cause);
    }
  }

  /**
   * Stage, publish, and atomically activate one complete generation.
   *
   * The existing project-root link is inspected before staging and again immediately
   * before publication. Only an absent path or a registered tool-owned path may be
   * replaced. The old generation is never removed as part of the commit; failed
   * publication removes only the newly-created generation and restores any moved
   * tool-owned directory.
   */
  async materialize(projectRoot: string, map: ProjectMap): Promise<MaterializationResult> {
    const canonicalRoot = normalize(resolve(projectRoot));
    const nodeModulesPath = join(canonicalRoot, 'node_modules');
    this.assertCapabilities('materialize');
    await assertNodeModulesReplaceable(nodeModulesPath, {
      filesystem: this.filesystem,
      registry: this.generationRegistry,
      projectId: map.projectId,
      projectRoot: canonicalRoot
    });

    const staged = await this.stage(canonicalRoot, map);
    try {
      await assertNodeModulesReplaceable(nodeModulesPath, {
        filesystem: this.filesystem,
        registry: this.generationRegistry,
        projectId: map.projectId,
        projectRoot: canonicalRoot
      });
      return await this.publish(staged);
    } catch (cause) {
      await staged.cleanup().catch(() => undefined);
      throw cause;
    }
  }

  /** Restore the previous successful root link after a later publication step fails. */
  async rollback(current: MaterializationResult, previous?: MaterializationResult): Promise<void> {
    this.assertCapabilities('rollback');
    const nodeModulesPath = join(current.projectRoot, 'node_modules');
    const ownership = await assertNodeModulesReplaceable(nodeModulesPath, {
      filesystem: this.filesystem,
      registry: this.generationRegistry,
      projectId: current.projectId,
      projectRoot: current.projectRoot
    });
    if (ownership.kind !== 'tool-owned-symlink' && ownership.kind !== 'tool-owned-generation') {
      throw new PublicationError('Cannot roll back materialization because current node_modules ownership is unproven.', {
        projectId: current.projectId,
        path: nodeModulesPath
      });
    }

    const currentGenerationPath = dirname(resolve(current.activeTarget));
    const generationsRoot = join(this.projectsDir, current.projectId, 'generations');
    if (!pathWithin(currentGenerationPath, generationsRoot)) {
      throw new PublicationError('Cannot roll back a generation outside the project generation directory.', {
        projectId: current.projectId,
        generationPath: currentGenerationPath
      });
    }

    let previousTarget: string | undefined;
    if (previous !== undefined) {
      previousTarget = resolve(previous.activeTarget);
      if (!pathWithin(previousTarget, generationsRoot)) {
        throw new PublicationError('Cannot restore a previous generation outside the project generation directory.', {
          projectId: current.projectId,
          activeTarget: previous.activeTarget
        });
      }
      try {
        if ((await this.filesystem.lstat(previousTarget)).type !== 'directory') {
          throw new Error('Previous generation target is not a directory.');
        }
      } catch (cause) {
        throw new PublicationError('Previous materialization generation is unavailable for rollback.', {
          projectId: current.projectId,
          activeTarget: previous.activeTarget
        }, cause);
      }
    }

    const temporaryRootLinkPath = await this.createTemporaryRootLinkPath(nodeModulesPath);
    let movedRootPath: string | undefined;
    let rootRestored = false;
    try {
      if (previousTarget !== undefined) {
        await this.filesystem.symlink(previousTarget, temporaryRootLinkPath);
        movedRootPath = await this.moveOwnedRootDirectory(nodeModulesPath);
        await this.filesystem.rename(temporaryRootLinkPath, nodeModulesPath);
        rootRestored = true;
      } else {
        await this.filesystem.remove(nodeModulesPath, { force: true });
        rootRestored = true;
      }
    } catch (cause) {
      if (movedRootPath !== undefined && !rootRestored) {
        await this.filesystem.rename(movedRootPath, nodeModulesPath).catch(() => undefined);
      }
      throw new PublicationError('Materialization rollback could not restore the previous project link.', {
        projectId: current.projectId,
        path: nodeModulesPath
      }, cause);
    } finally {
      await this.filesystem.remove(temporaryRootLinkPath, { force: true }).catch(() => undefined);
    }

    // Cleanup is never allowed to turn a successfully restored prior state into
    // a failed rollback. The generation is unreferenced once root link points
    // at the prior target and can be reclaimed by later tool-owned cleanup.
    await this.filesystem.remove(currentGenerationPath, { recursive: true, force: true }).catch(() => undefined);
    if (movedRootPath !== undefined) {
      await this.filesystem.remove(movedRootPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Publish a previously validated stage and activate its project-root link. */
  async publish(staged: StagedMaterialization): Promise<MaterializationResult> {
    this.assertCapabilities('publish');
    const nodeModulesPath = join(staged.projectRoot, 'node_modules');
    const ownership = await assertNodeModulesReplaceable(nodeModulesPath, {
      filesystem: this.filesystem,
      registry: this.generationRegistry,
      projectId: staged.projectId,
      projectRoot: staged.projectRoot
    });

    let generationPublished = false;
    let movedDirectoryPath: string | undefined;
    let rootLinkPublished = false;
    const rootLinkTemporaryPath = await this.createTemporaryRootLinkPath(nodeModulesPath);
    try {
      if (await this.filesystem.exists(staged.generationPath)) {
        throw new PublicationError('Materialization generation already exists; refusing to replace it.', {
          projectId: staged.projectId,
          generation: staged.generation,
          generationPath: staged.generationPath
        });
      }
      await this.filesystem.rename(staged.stagingPath, staged.generationPath);
      generationPublished = true;
      await this.filesystem.sync(staged.generationPath);
      await this.filesystem.sync(dirname(staged.generationPath));

      await this.filesystem.symlink(join(staged.generationPath, 'node_modules'), rootLinkTemporaryPath);
      await this.filesystem.sync(dirname(rootLinkTemporaryPath));
      if (ownership.kind === 'tool-owned-generation') {
        movedDirectoryPath = await this.moveOwnedRootDirectory(nodeModulesPath);
      }
      await this.filesystem.rename(rootLinkTemporaryPath, nodeModulesPath);
      rootLinkPublished = true;
      this.publishedGenerations.push({
        projectId: staged.projectId,
        generation: staged.generation,
        projectRoot: staged.projectRoot,
        generationPath: join(staged.generationPath, 'node_modules')
      });

      // The rename above is the root-link commit point. Do not make success
      // depend on cleanup of the old generation or temporary artifacts.
      if (movedDirectoryPath !== undefined) {
        await this.filesystem.remove(movedDirectoryPath, { recursive: true, force: true }).catch(() => undefined);
      }
      return {
        projectRoot: staged.projectRoot,
        projectId: staged.projectId,
        generation: staged.generation,
        activeTarget: join(staged.generationPath, 'node_modules'),
        packagesMaterialized: staged.packagesMaterialized
      };
    } catch (cause) {
      await this.filesystem.remove(rootLinkTemporaryPath, { force: true }).catch(() => undefined);
      if (movedDirectoryPath !== undefined && !rootLinkPublished) {
        await this.filesystem.rename(movedDirectoryPath, nodeModulesPath).catch(() => undefined);
      }
      if (generationPublished) {
        await this.filesystem.remove(staged.generationPath, { recursive: true, force: true }).catch(() => undefined);
      }
      if (cause instanceof CapabilityUnavailableError || cause instanceof PublicationError) throw cause;
      throw new PublicationError('Materialization publication failed; prior project state was retained.', {
        projectId: staged.projectId,
        generation: staged.generation,
        path: nodeModulesPath
      }, cause);
    }
  }

  private assertCapabilities(operation: string): void {
    if (this.capabilities.symlinks === false) {
      throw new CapabilityUnavailableError('Symbolic links are required for dependency materialization.', {
        capability: 'symlinks',
        operation
      });
    }
    if (this.capabilities.atomicRename === false) {
      throw new CapabilityUnavailableError('Atomic same-filesystem rename is required for materialization publication.', {
        capability: 'atomic-rename',
        operation
      });
    }
  }

  private async createTemporaryRootLinkPath(nodeModulesPath: string): Promise<string> {
    const parent = dirname(nodeModulesPath);
    for (;;) {
      const candidate = join(parent, `.node-glue-node-modules-${process.pid}-${temporaryLinkCounter++}`);
      if (!(await this.filesystem.exists(candidate))) return candidate;
    }
  }

  private async moveOwnedRootDirectory(nodeModulesPath: string): Promise<string> {
    const parent = dirname(nodeModulesPath);
    for (;;) {
      const candidate = join(parent, `.node-glue-previous-node-modules-${process.pid}-${temporaryLinkCounter++}`);
      if (await this.filesystem.exists(candidate)) continue;
      await this.filesystem.rename(nodeModulesPath, candidate);
      return candidate;
    }
  }
}

export function createMaterializer(options: MaterializerOptions): Materializer {
  return new Materializer(options);
}

/** Validate a map reference and its immutable store target. */
async function validateInstance(
  filesystem: FileSystemAdapter,
  packageStore: PackageStoreReference,
  placement: DependencyPlacement,
  storeDir: string | undefined
): Promise<PackageInstance> {
  if (!/^[a-f0-9]{64}$/.test(placement.packageIdentityHash)) {
    throw new MissingStoreInstanceError('Project Map references an invalid Package Instance identity.', {
      identityHash: placement.packageIdentityHash,
      packageName: placement.packageName
    });
  }
  let instance: PackageInstance | undefined;
  try {
    instance = await packageStore.get(placement.packageIdentityHash);
  } catch (cause) {
    throw new PublicationError('Package Instance reference could not be validated.', {
      identityHash: placement.packageIdentityHash,
      packageName: placement.packageName
    }, cause);
  }
  if (instance === undefined) {
    throw new MissingStoreInstanceError('Project Map references a missing Package Instance.', {
      identityHash: placement.packageIdentityHash,
      packageName: placement.packageName
    });
  }
  let identityMatches = false;
  try {
    identityMatches = hashPackageIdentity(instance.identity) === placement.packageIdentityHash;
  } catch {
    identityMatches = false;
  }
  if (
    instance.identityHash !== placement.packageIdentityHash ||
    !identityMatches ||
    instance.identity.name !== placement.packageName ||
    instance.manifest.name !== placement.packageName ||
    instance.manifest.version !== instance.identity.versionOrRevision
  ) {
    throw new PublicationError('Project Map Package Instance metadata does not match its placement.', {
      identityHash: placement.packageIdentityHash,
      packageName: placement.packageName
    });
  }
  if (!instance.contentPath.startsWith('/')) {
    throw new PublicationError('Package link target must be an absolute verified store path.', {
      identityHash: placement.packageIdentityHash,
      path: instance.contentPath
    });
  }
  const contentPath = resolve(instance.contentPath);
  if (storeDir !== undefined && !pathWithin(contentPath, join(storeDir, 'packages'))) {
    throw new PublicationError('Package link target is outside the verified central package store.', {
      identityHash: placement.packageIdentityHash,
      path: contentPath
    });
  }
  let metadata;
  try {
    metadata = await filesystem.lstat(contentPath);
  } catch (cause) {
    throw new MissingStoreInstanceError('Verified Package Instance content is missing.', {
      identityHash: placement.packageIdentityHash,
      path: contentPath
    });
  }
  if (metadata.type !== 'directory') {
    throw new PublicationError('Verified Package Instance content is not a directory.', {
      identityHash: placement.packageIdentityHash,
      path: contentPath
    });
  }
  return instance;
}

async function resolvePlacements(map: ProjectMap, filesystem: FileSystemAdapter, packageStore: PackageStoreReference, storeDir?: string): Promise<ResolvedPlacement[]> {
  const result: ResolvedPlacement[] = [];
  for (const placement of map.placements) {
    validatePlacementPackagePath(placement);
    const instance = await validateInstance(filesystem, packageStore, placement, storeDir);
    result.push({ placement, instance, packagePath: '', usePackageView: false });
  }
  return result;
}

function validatePlacementPackagePath(placement: DependencyPlacement): void {
  const path = placement.relativePath.replaceAll('\\', '/');
  const segments = path.split('/').filter(Boolean);
  const marker = segments.lastIndexOf('node_modules');
  const packageSegments = placement.packageName.split('/');
  if (marker < 0 || marker === segments.length - 1 || !segments.slice(marker + 1).every(Boolean)) {
    throw new InvalidInputError('Project Map placement is not a package path below node_modules.', {
      relativePath: placement.relativePath,
      packageName: placement.packageName
    });
  }
  const actual = segments.slice(marker + 1);
  if (actual.length !== packageSegments.length || actual.some((value, index) => value !== packageSegments[index])) {
    throw new InvalidInputError('Project Map placement path does not match its package name.', {
      relativePath: placement.relativePath,
      packageName: placement.packageName
    });
  }
}

async function mirrorPackageContent(
  filesystem: FileSystemAdapter,
  source: string,
  destination: string,
  expectedLinks: Map<string, ExpectedLink>
): Promise<void> {
  const metadata = await filesystem.lstat(source);
  if (metadata.type !== 'directory') throw new PublicationError('Package content root is not a directory.', { path: source });
  await filesystem.mkdir(destination, { recursive: true });
  for (const entry of await filesystem.listDirectory(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.type === 'directory') {
      await mirrorPackageContent(filesystem, sourcePath, destinationPath, expectedLinks);
    } else if (entry.type === 'file') {
      await filesystem.symlink(sourcePath, destinationPath);
      expectedLinks.set(resolve(destinationPath), { target: resolve(sourcePath), validationTarget: resolve(sourcePath), targetType: 'file' });
    } else {
      throw new PublicationError('Verified package content contains an unsupported symlink or filesystem entry.', {
        path: sourcePath
      });
    }
  }
}

async function validateStagedTree(
  filesystem: FileSystemAdapter,
  root: string,
  expectedLinks: ReadonlyMap<string, ExpectedLink>,
  markerPath: string
): Promise<void> {
  const seen = new Set<string>();
  await validateTreeEntry(filesystem, root, expectedLinks, markerPath, seen);
  for (const path of expectedLinks.keys()) {
    if (!seen.has(path)) throw new PublicationError('Staged dependency tree is missing an expected link.', { path });
  }
}

async function validateTreeEntry(
  filesystem: FileSystemAdapter,
  path: string,
  expectedLinks: ReadonlyMap<string, ExpectedLink>,
  markerPath: string,
  seen: Set<string>
): Promise<void> {
  const normalizedPath = resolve(path);
  const metadata = await filesystem.lstat(normalizedPath);
  if (metadata.type === 'symlink') {
    const expected = expectedLinks.get(normalizedPath);
    if (expected === undefined) throw new PublicationError('Staged tree contains an unexpected symlink.', { path: normalizedPath });
    const target = await filesystem.readlink(normalizedPath);
    const targetPath = resolve(dirname(normalizedPath), target);
    if (expected.targetType === 'directory') {
      if (targetPath !== resolve(expected.target)) throw new PublicationError('Package link target changed during staging.', { path: normalizedPath });
    } else if (target !== expected.target) {
      throw new PublicationError('Executable link target changed during staging.', { path: normalizedPath });
    }
    const targetMetadata = await filesystem.lstat(resolve(expected.validationTarget));
    if (targetMetadata.type !== expected.targetType) {
      throw new PublicationError('Staged symlink target has an unexpected type.', { path: normalizedPath, target: expected.validationTarget });
    }
    seen.add(normalizedPath);
    return;
  }
  if (metadata.type === 'file') {
    if (normalizedPath !== resolve(markerPath)) throw new PublicationError('Staged tree contains an unexpected file.', { path: normalizedPath });
    seen.add(normalizedPath);
    return;
  }
  if (metadata.type !== 'directory') throw new PublicationError('Staged tree contains an unsupported filesystem entry.', { path: normalizedPath });
  for (const entry of await filesystem.listDirectory(normalizedPath)) {
    await validateTreeEntry(filesystem, join(normalizedPath, entry.name), expectedLinks, markerPath, seen);
  }
}

function remapStagedPath(path: string, plannedRoot: string, stagedRoot: string): string {
  const suffix = relative(resolve(plannedRoot), resolve(path));
  if (suffix.startsWith('..') || resolve(plannedRoot, suffix) !== resolve(path)) {
    throw new InvalidInputError('Materialization path escaped the planned node_modules root.', { path });
  }
  return join(stagedRoot, suffix);
}

function validateGeneration(generation: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(generation) || generation === '.' || generation === '..') {
    throw new InvalidInputError('Materialization generation contains unsafe path characters.', { generation });
  }
}

function nextGeneration(): string {
  generationCounter += 1;
  return `generation-${Date.now()}-${generationCounter}`;
}
