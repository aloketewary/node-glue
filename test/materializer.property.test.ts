import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import { binDirectoryFor } from '../src/bin-links.js';
import { LifecycleRunner } from '../src/lifecycle.js';
import { Materializer } from '../src/materializer.js';
import {
  GENERATION_OWNERSHIP_SCHEMA_VERSION,
  createProjectGenerationRegistry,
  generationOwnershipMarkerPath,
  serializeGenerationOwnershipMarker,
  type RegisteredProjectGeneration
} from '../src/ownership.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import { ProjectMapRepository, deriveProjectId } from '../src/project-map.js';
import { ProjectStateRepository } from '../src/state.js';
import type {
  DependencyPlacement,
  PackageInstance,
  ProjectMap,
  ResolvedProject
} from '../src/types.js';
import type {
  PlatformCapabilityAdapter,
  PlatformPreparationOptions,
  ProtectedExecutionContext
} from '../src/platform/index.js';
import {
  createFakeFileSystem,
  createFailureInjector,
  FakePackageStore,
  propertyTag
} from './fixtures/index.js';

interface MaterializationCase {
  readonly id: number;
  readonly packageCount: number;
  readonly nestedCount: number;
  readonly scopedParent: boolean;
  readonly scopedNested: boolean;
}

const materializationCaseArbitrary: fc.Arbitrary<MaterializationCase> = fc.integer({ min: 0, max: 999_999 }).chain((id) =>
  fc.integer({ min: 2, max: 6 }).chain((packageCount) =>
    fc.record({
      id: fc.constant(id),
      packageCount: fc.constant(packageCount),
      nestedCount: fc.integer({ min: 1, max: packageCount - 1 }),
      scopedParent: fc.boolean(),
      scopedNested: fc.boolean()
    })
  )
);

describe('Materializer property coverage', () => {
  it(propertyTag(8, 'materialization stages a complete tree before publication'), async () => {
    await fc.assert(
      fc.asyncProperty(materializationCaseArbitrary, async (materializationCase) => {
        const storeDir = `/fixture/store-${materializationCase.id}`;
        const projectRoot = `/fixture/project-${materializationCase.id}`;
        const projectId = `project-${materializationCase.id}`;
        const generation = `generation-${materializationCase.id}`;
        const filesystem = createFakeFileSystem('/fixture');
        const store = new FakePackageStore({ storeDir });
        const packages: PackageInstance[] = [];
        const placements: DependencyPlacement[] = [];

        for (let index = 0; index < materializationCase.packageCount; index += 1) {
          const isNested = index > 0 && index <= materializationCase.nestedCount;
          const name = isNested
            ? packageName('nested', materializationCase.id, index, materializationCase.scopedNested)
            : index === 0
              ? packageName('root', materializationCase.id, index, materializationCase.scopedParent)
              : packageName('direct', materializationCase.id, index, index % 2 === 0);
          const version = `1.0.${index}`;
          const binName = `${name.replace('@fixture/', '').replaceAll('/', '-')}-cli`;
          const identity = {
            name,
            versionOrRevision: version,
            source: `registry:https://registry.example.test/${name}`
          };
          const identityHash = hashPackageIdentity(identity);
          const contentPath = join(storeDir, 'packages', encodePackageName(name), identityHash, 'content');
          const instance: PackageInstance = {
            identity,
            identityHash,
            contentPath,
            manifest: {
              name,
              version,
              bin: { [binName]: 'bin/cli.js' }
            },
            verifiedAt: '2025-01-01T00:00:00.000Z'
          };
          store.seed(instance);
          filesystem
            .seedFile(join(contentPath, 'package.json'), JSON.stringify({ name, version }))
            .seedFile(join(contentPath, 'bin/cli.js'), '#!/usr/bin/env node');
          packages.push(instance);

          const packagePath = isNested
            ? `node_modules/${packages[0]!.identity.name}/node_modules/${name}`
            : `node_modules/${name}`;
          placements.push({
            relativePath: packagePath,
            packageIdentityHash: identityHash,
            packageName: name,
            binEntries: { [binName]: 'bin/cli.js' }
          });
        }

        const map: ProjectMap = {
          schemaVersion: 1,
          projectId,
          projectRoot,
          lockfileHash: `lock-${materializationCase.id}`,
          placements,
          generatedAt: '2025-01-01T00:00:00.000Z',
          toolVersion: '0.1.0'
        };
        filesystem.seedDirectory(projectRoot);

        const generationPath = join(
          storeDir,
          'projects',
          projectId,
          'generations',
          generation
        );
        const generationNodeModulesPath = join(generationPath, 'node_modules');
        const rootNodeModulesPath = join(projectRoot, 'node_modules');
        let rootPublicationObserved = false;
        const originalRename = filesystem.rename.bind(filesystem);
        filesystem.rename = async (source, destination) => {
          if (destination === rootNodeModulesPath) {
            rootPublicationObserved = true;
            expect(await filesystem.exists(rootNodeModulesPath)).toBe(false);
            await expectCompleteStagedTree(
              filesystem,
              generationPath,
              placements,
              packages
            );
            expect((await filesystem.lstat(source)).type).toBe('symlink');
          }
          await originalRename(source, destination);
        };

        const materializer = new Materializer({
          filesystem,
          packageStore: store,
          storeDir,
          generation
        });
        const result = await materializer.materialize(projectRoot, map);

        expect(rootPublicationObserved).toBe(true);
        expect(result.activeTarget).toBe(generationNodeModulesPath);
        expect(await filesystem.readlink(rootNodeModulesPath)).toBe(generationNodeModulesPath);
        await expectCompleteStagedTree(filesystem, generationPath, placements, packages);
      }),
      { numRuns: 100 }
    );
  });
  it(propertyTag(9, 'tool-owned materialization replacement is ownership-bound'), async () => {
    await fc.assert(
      fc.asyncProperty(ownershipCaseArbitrary, async ({ id, state }) => {
        const storeDir = `/fixture/ownership-store-${id}`;
        const projectRoot = `/fixture/ownership-project-${id}`;
        const projectId = `ownership-project-${id}`;
        const nextGeneration = `next-generation-${id}`;
        const rootNodeModulesPath = join(projectRoot, 'node_modules');
        const priorGenerationPath = join(
          storeDir,
          'projects',
          projectId,
          'generations',
          `prior-generation-${id}`,
          'node_modules'
        );
        const filesystem = createFakeFileSystem('/fixture');
        const store = new FakePackageStore({ storeDir });
        const root = ownershipPackage(storeDir, id);
        store.seed(root);
        filesystem
          .seedDirectory(projectRoot)
          .seedFile(join(root.contentPath, 'package.json'), JSON.stringify({
            name: root.identity.name,
            version: root.identity.versionOrRevision
          }));

        const registration: RegisteredProjectGeneration = {
          projectId,
          generation: `prior-generation-${id}`,
          projectRoot,
          generationPath: priorGenerationPath
        };
        let registrations: readonly RegisteredProjectGeneration[] = [];
        if (state === 'owned-symlink') {
          filesystem
            .seedDirectory(priorGenerationPath)
            .seedFile(generationOwnershipMarkerPath(priorGenerationPath), ownershipMarker(registration))
            .seedSymlink(rootNodeModulesPath, priorGenerationPath);
          registrations = [registration];
        } else if (state === 'owned-generation') {
          const ownedGeneration = { ...registration, generationPath: rootNodeModulesPath };
          filesystem
            .seedDirectory(rootNodeModulesPath)
            .seedFile(generationOwnershipMarkerPath(rootNodeModulesPath), ownershipMarker(ownedGeneration));
          registrations = [ownedGeneration];
        } else if (state === 'unmanaged') {
          filesystem.seedFile(join(rootNodeModulesPath, 'user-content.txt'), 'developer content');
        } else if (state === 'broken-link') {
          filesystem.seedSymlink(rootNodeModulesPath, join(storeDir, 'missing-generation', 'node_modules'));
        } else if (state === 'unknown-marker') {
          filesystem
            .seedDirectory(rootNodeModulesPath)
            .seedFile(generationOwnershipMarkerPath(rootNodeModulesPath), ownershipMarker(registration));
        } else {
          const conflictingRegistration: RegisteredProjectGeneration = {
            ...registration,
            generation: `conflicting-generation-${id}`,
            generationPath: rootNodeModulesPath
          };
          filesystem
            .seedDirectory(rootNodeModulesPath)
            .seedFile(generationOwnershipMarkerPath(rootNodeModulesPath), ownershipMarker(registration));
          registrations = [
            { ...registration, generationPath: rootNodeModulesPath },
            conflictingRegistration
          ];
        }

        const before = await captureState(filesystem, rootNodeModulesPath);
        const materializer = new Materializer({
          filesystem,
          packageStore: store,
          storeDir,
          generation: nextGeneration,
          generationRegistry: createProjectGenerationRegistry(registrations)
        });
        const mapValue = ownershipMap(projectRoot, projectId, root);

        if (state === 'owned-symlink' || state === 'owned-generation') {
          const result = await materializer.materialize(projectRoot, mapValue);
          expect(result.activeTarget).toBe(join(
            storeDir,
            'projects',
            projectId,
            'generations',
            nextGeneration,
            'node_modules'
          ));
          expect(await filesystem.readlink(rootNodeModulesPath)).toBe(result.activeTarget);
          expect(filesystem.failures.calls('filesystem.rename')).toBeGreaterThan(0);
        } else {
          await expect(materializer.materialize(projectRoot, mapValue)).rejects.toMatchObject({
            code: state === 'unmanaged' ? 'UNMANAGED_NODE_MODULES' : 'OWNERSHIP_UNKNOWN'
          });
          expect(await captureState(filesystem, rootNodeModulesPath)).toEqual(before);
          expect(filesystem.failures.calls('filesystem.rename')).toBe(0);
          expect(filesystem.failures.calls('filesystem.remove')).toBe(0);
        }
      }),
      { numRuns: 100 }
    );
  });
  it(propertyTag(10, 'Failed publication preserves the last successful state'), async () => {
    await fc.assert(
      fc.asyncProperty(publicationFailureCaseArbitrary, async ({ id, boundary }) => {
        const fixture = await createPublicationRecoveryFixture(id);
        injectPublicationFailure(fixture, boundary);

        if (boundary === 'lifecycle') {
          const lifecycle = new LifecycleRunner({
            processes: new FailingLifecycleProcess(fixture.failures),
            filesystem: fixture.filesystem,
            platform: new NoopLifecyclePlatform()
          });
          await expect(lifecycle.run(fixture.lifecycleProject, {
            enabled: true,
            allowedScripts: ['install'],
            outputDirectory: `${fixture.projectRoot}/.node-glue/lifecycle`
          })).rejects.toMatchObject({ code: 'LIFECYCLE_FAILURE' });
        } else {
          const materializer = new Materializer({
            filesystem: fixture.filesystem,
            packageStore: fixture.store,
            storeDir: fixture.storeDir,
            generation: fixture.nextGeneration,
            generationRegistry: createProjectGenerationRegistry([fixture.previousRegistration])
          });
          await expect(materializer.materialize(fixture.projectRoot, fixture.nextMap))
            .rejects.toMatchObject({ code: 'PUBLICATION_FAILURE' });
        }

        // Failed work may not alter any byte or filesystem entry belonging to
        // the last successful install, including state consumed by Doctor.
        expect(fixture.filesystem.snapshot()).toEqual(fixture.beforeSnapshot);
        expect(await fixture.mapRepository.read(fixture.projectId)).toEqual(fixture.previousMap);
        expect(await fixture.stateRepository.read(fixture.projectId)).toEqual(fixture.previousState);
        expect(await fixture.filesystem.readTextFile(fixture.mapPath)).toBe(fixture.beforeMapText);
        expect(await fixture.filesystem.readTextFile(fixture.statePath)).toBe(fixture.beforeStateText);
        expect(await fixture.filesystem.readlink(fixture.rootNodeModulesPath))
          .toBe(fixture.previousRegistration.generationPath);
        expect(await fixture.filesystem.realpath(fixture.rootNodeModulesPath))
          .toBe(fixture.previousRegistration.generationPath);
        expect((await fixture.filesystem.lstat(fixture.previousRegistration.generationPath)).type)
          .toBe('directory');
      }),
      { numRuns: 100 }
    );
  });
});

type PublicationFailureBoundary = 'staging' | 'validation' | 'publication' | 'symlink' | 'lifecycle';

const publicationFailureCaseArbitrary: fc.Arbitrary<{
  id: number;
  boundary: PublicationFailureBoundary;
}> = fc.record({
  id: fc.integer({ min: 0, max: 999_999 }),
  boundary: fc.constantFrom<PublicationFailureBoundary>(
    'staging',
    'validation',
    'publication',
    'symlink',
    'lifecycle'
  )
});

interface PublicationRecoveryFixture {
  readonly failures: ReturnType<typeof createFailureInjector>;
  readonly filesystem: ReturnType<typeof createFakeFileSystem>;
  readonly store: FakePackageStore;
  readonly storeDir: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly nextGeneration: string;
  readonly rootNodeModulesPath: string;
  readonly previousRegistration: RegisteredProjectGeneration;
  readonly previousMap: ProjectMap;
  readonly nextMap: ProjectMap;
  readonly previousState: {
    schemaVersion: 1;
    projectId: string;
    projectRoot: string;
    lastSuccessfulMapGeneration: string;
    lastSuccessfulMaterializationGeneration: string;
    activeTarget: string;
    updatedAt: string;
    lastSuccessfulAt: string;
    status: 'ready';
  };
  readonly mapRepository: ProjectMapRepository;
  readonly stateRepository: ProjectStateRepository;
  readonly mapPath: string;
  readonly statePath: string;
  readonly beforeSnapshot: ReadonlyMap<string, { path: string; type: string; size?: number }>;
  readonly beforeMapText: string;
  readonly beforeStateText: string;
  readonly lifecycleProject: ResolvedProject;
}

async function createPublicationRecoveryFixture(id: number): Promise<PublicationRecoveryFixture> {
  const failures = createFailureInjector();
  const filesystem = createFakeFileSystem('/fixture', failures);
  const storeDir = `/fixture/recovery-store-${id}`;
  const projectRoot = `/fixture/recovery-project-${id}`;
  const projectId = deriveProjectId(projectRoot);
  const previousGeneration = `previous-generation-${id}`;
  const nextGeneration = `next-generation-${id}`;
  const rootNodeModulesPath = join(projectRoot, 'node_modules');
  const store = new FakePackageStore({ storeDir });
  const previousPackage = recoveryPackage(storeDir, 'previous', id);
  const nextPackage = recoveryPackage(storeDir, 'next', id);
  store.seed(previousPackage).seed(nextPackage);
  filesystem
    .seedDirectory(projectRoot)
    .seedFile(join(previousPackage.contentPath, 'package.json'), '{}')
    .seedFile(join(nextPackage.contentPath, 'package.json'), '{}');

  const previousMap = recoveryMap(projectRoot, projectId, previousPackage, 'previous-lock');
  const nextMap = recoveryMap(projectRoot, projectId, nextPackage, 'next-lock');
  const mapRepository = new ProjectMapRepository({
    filesystem,
    projectsDir: join(storeDir, 'projects')
  });
  const stateRepository = new ProjectStateRepository({
    filesystem,
    projectsDir: join(storeDir, 'projects')
  });
  // Publish baseline map before materializer creates its generations directory;
  // this models normal map-then-materialize ordering and keeps its ID stable.
  await mapRepository.publish(previousMap);
  const initialMaterializer = new Materializer({
    filesystem,
    packageStore: store,
    storeDir,
    generation: previousGeneration
  });
  const previousResult = await initialMaterializer.materialize(projectRoot, previousMap);
  const previousRegistration: RegisteredProjectGeneration = {
    projectId,
    generation: previousGeneration,
    projectRoot,
    generationPath: previousResult.activeTarget
  };

  const previousState = {
    schemaVersion: 1 as const,
    projectId,
    projectRoot,
    lastSuccessfulMapGeneration: 'map-previous',
    lastSuccessfulMaterializationGeneration: previousGeneration,
    activeTarget: previousResult.activeTarget,
    updatedAt: '2025-01-01T00:00:00.000Z',
    lastSuccessfulAt: '2025-01-01T00:00:00.000Z',
    status: 'ready' as const
  };
  await stateRepository.publish(previousState);

  const mapPath = mapRepository.mapPath(projectId);
  const statePath = stateRepository.statePath(projectId);
  return {
    failures,
    filesystem,
    store,
    storeDir,
    projectRoot,
    projectId,
    nextGeneration,
    rootNodeModulesPath,
    previousRegistration,
    previousMap,
    nextMap,
    previousState,
    mapRepository,
    stateRepository,
    mapPath,
    statePath,
    beforeSnapshot: filesystem.snapshot(),
    beforeMapText: await filesystem.readTextFile(mapPath),
    beforeStateText: await filesystem.readTextFile(statePath),
    lifecycleProject: {
      projectRoot,
      lockfileHash: nextMap.lockfileHash,
      placements: [],
      sources: [],
      packages: [{
        ...nextPackage,
        manifest: {
          ...nextPackage.manifest,
          scripts: { install: 'fixture lifecycle failure' }
        }
      }]
    }
  };
}

function injectPublicationFailure(
  fixture: PublicationRecoveryFixture,
  boundary: PublicationFailureBoundary
): void {
  if (boundary === 'staging') {
    fixture.failures.failNext('filesystem.writeFile');
    return;
  }
  if (boundary === 'publication') {
    fixture.failures.failNext('filesystem.rename');
    return;
  }
  if (boundary === 'lifecycle') {
    fixture.failures.failNext('lifecycle.run');
    return;
  }

  if (boundary === 'validation') {
    fixture.failures.failNext('filesystem.lstat.staged');
    const originalLstat = fixture.filesystem.lstat.bind(fixture.filesystem);
    fixture.filesystem.lstat = async (path) => {
      if (path.includes('/.node-glue-generation-')) {
        fixture.failures.check('filesystem.lstat.staged');
      }
      return originalLstat(path);
    };
    return;
  }

  fixture.failures.failNext('filesystem.symlink.root');
  const originalSymlink = fixture.filesystem.symlink.bind(fixture.filesystem);
  fixture.filesystem.symlink = async (target, path) => {
    if (path.startsWith(`${fixture.projectRoot}/.node-glue-node-modules-`)) {
      fixture.failures.check('filesystem.symlink.root');
    }
    return originalSymlink(target, path);
  };
}

function recoveryPackage(storeDir: string, kind: string, id: number): PackageInstance {
  const name = `recovery-${kind}-${id}`;
  const version = '1.0.0';
  const identity = {
    name,
    versionOrRevision: version,
    source: `registry:https://registry.example.test/${name}`
  };
  const identityHash = hashPackageIdentity(identity);
  return {
    identity,
    identityHash,
    contentPath: join(storeDir, 'packages', name, identityHash, 'content'),
    manifest: { name, version },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

function recoveryMap(
  projectRoot: string,
  projectId: string,
  instance: PackageInstance,
  lockfileHash: string
): ProjectMap {
  return {
    schemaVersion: 1,
    projectId,
    projectRoot,
    lockfileHash,
    placements: [{
      relativePath: `node_modules/${instance.identity.name}`,
      packageIdentityHash: instance.identityHash,
      packageName: instance.identity.name
    }],
    generatedAt: '2025-01-01T00:00:00.000Z',
    toolVersion: '0.1.0'
  };
}

class FailingLifecycleProcess implements ChildProcessAdapter {
  constructor(private readonly failures: ReturnType<typeof createFailureInjector>) {}

  async run(_spec: ProcessSpec): Promise<ProcessResult> {
    this.failures.check('lifecycle.run');
    return { exitCode: 1, stdout: '', stderr: 'fixture failure' };
  }
}

class NoopLifecyclePlatform implements PlatformCapabilityAdapter {
  readonly supportsProtectedPaths = true;

  async prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext> {
    return {
      outputDirectory: options.outputDirectory,
      protectedPaths: options.protectedPaths,
      environment: options.environment ?? {}
    };
  }
}

type OwnershipState = 'owned-symlink' | 'owned-generation' | 'unmanaged' | 'broken-link' | 'unknown-marker' | 'ambiguous';

const ownershipCaseArbitrary: fc.Arbitrary<{ id: number; state: OwnershipState }> = fc.record({
  id: fc.integer({ min: 0, max: 999_999 }),
  state: fc.constantFrom<OwnershipState>(
    'owned-symlink',
    'owned-generation',
    'unmanaged',
    'broken-link',
    'unknown-marker',
    'ambiguous'
  )
});

function ownershipPackage(storeDir: string, id: number): PackageInstance {
  const name = `ownership-root-${id}`;
  const version = '1.0.0';
  const identity = {
    name,
    versionOrRevision: version,
    source: `registry:https://registry.example.test/${name}`
  };
  const identityHash = hashPackageIdentity(identity);
  return {
    identity,
    identityHash,
    contentPath: join(storeDir, 'packages', name, identityHash, 'content'),
    manifest: { name, version },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

function ownershipMarker(registration: RegisteredProjectGeneration): string {
  return serializeGenerationOwnershipMarker({
    schemaVersion: GENERATION_OWNERSHIP_SCHEMA_VERSION,
    projectId: registration.projectId,
    generation: registration.generation,
    projectRoot: registration.projectRoot
  });
}

function ownershipMap(projectRoot: string, projectId: string, root: PackageInstance): ProjectMap {
  return {
    schemaVersion: 1,
    projectId,
    projectRoot,
    lockfileHash: `ownership-lock-${projectId}`,
    placements: [{
      relativePath: `node_modules/${root.identity.name}`,
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }],
    generatedAt: '2025-01-01T00:00:00.000Z',
    toolVersion: '0.1.0'
  };
}

async function captureState(
  filesystem: ReturnType<typeof createFakeFileSystem>,
  root: string
): Promise<{
  metadata: readonly [string, unknown][];
  contents: readonly [string, number[]][];
  links: readonly [string, string][];
}> {
  const entries = [...filesystem.snapshot().entries()]
    .filter(([path]) => path === root || path.startsWith(`${root}/`))
    .sort(([left], [right]) => left.localeCompare(right));
  const contents: [string, number[]][] = [];
  const links: [string, string][] = [];
  for (const [path, metadata] of entries) {
    if (metadata.type === 'file') contents.push([path, [...await filesystem.readFile(path)]]);
    if (metadata.type === 'symlink') links.push([path, await filesystem.readlink(path)]);
  }
  return {
    metadata: entries,
    contents,
    links
  };
}

async function expectCompleteStagedTree(
  filesystem: ReturnType<typeof createFakeFileSystem>,
  generationPath: string,
  placements: readonly DependencyPlacement[],
  packages: readonly PackageInstance[]
): Promise<void> {
  const generationNodeModulesPath = join(generationPath, 'node_modules');
  const instances = new Map(packages.map((instance) => [instance.identityHash, instance]));
  for (const placement of placements) {
    const instance = instances.get(placement.packageIdentityHash);
    expect(instance).toBeDefined();
    const packagePath = join(generationPath, ...placement.relativePath.split('/'));
    const packageMetadata = await filesystem.lstat(packagePath);
    const hasNestedPlacement = placements.some(
      (candidate) => candidate.relativePath !== placement.relativePath &&
        candidate.relativePath.startsWith(`${placement.relativePath}/`)
    );

    if (hasNestedPlacement) {
      expect(packageMetadata.type).toBe('directory');
      expect(await filesystem.readlink(join(packagePath, 'package.json'))).toBe(
        join(instance!.contentPath, 'package.json')
      );
    } else {
      expect(packageMetadata.type).toBe('symlink');
      expect(await filesystem.readlink(packagePath)).toBe(instance!.contentPath);
    }

    const binEntries = placement.binEntries ?? {};
    for (const [binName, binPath] of Object.entries(binEntries)) {
      const binDirectory = binDirectoryFor(generationNodeModulesPath, packagePath);
      const linkPath = join(binDirectory, binName);
      expect((await filesystem.lstat(linkPath)).type).toBe('symlink');
      const packageTarget = join(packagePath, ...binPath.split('/'));
      expect(await filesystem.readlink(linkPath)).toBe(relative(dirname(linkPath), packageTarget));
      expect(await filesystem.lstat(join(instance!.contentPath, ...binPath.split('/')))).toMatchObject({ type: 'file' });
    }
  }
}

function packageName(kind: string, id: number, index: number, scoped: boolean): string {
  const base = `${kind}-${id}-${index}`;
  return scoped ? `@fixture/${base}` : `fixture-${base}`;
}

function encodePackageName(name: string): string {
  return name.startsWith('@') ? name.slice(1).replace('/', '+') : name;
}
