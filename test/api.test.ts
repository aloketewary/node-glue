import { describe, expect, it } from 'vitest';
import { createNodeGlueApi, type GarbageCollectorLike } from '../src/api.js';
import { LockfileWriter } from '../src/lockfile.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import type { LockLease } from '../src/adapters/locks.js';
import type {
  EnsureProjectOptions,
  MaterializationResult,
  PackageInstance,
  ProjectInput,
  ProjectMap,
  ProjectState,
  ResolvedProject,
  ResolvedSource
} from '../src/types.js';
import { createFakeFileSystem, FakePackageStore } from './fixtures/index.js';

const projectRoot = '/fixture/project';
const storeDir = '/fixture/store';
const source: ResolvedSource = {
  source: { kind: 'registry', registry: 'https://registry.example.test', name: 'example', spec: '1.0.0' },
  name: 'example',
  versionOrRevision: '1.0.0',
  resolvedLocator: 'https://registry.example.test/example/-/example-1.0.0.tgz',
  sourceFingerprint: 'registry:https://registry.example.test/example@1.0.0',
  manifest: { name: 'example', version: '1.0.0' }
};
const identity = {
  name: source.name,
  versionOrRevision: source.versionOrRevision,
  source: source.sourceFingerprint!
};
const packageInstance: PackageInstance = {
  identity,
  identityHash: hashPackageIdentity(identity),
  contentPath: `${storeDir}/packages/example/${hashPackageIdentity(identity)}/content`,
  manifest: source.manifest!,
  verifiedAt: '2025-01-01T00:00:00.000Z'
};

class RecordingLocks {
  readonly calls: string[] = [];
  async acquireProject(projectId: string): Promise<LockLease> {
    this.calls.push(projectId);
    return { key: projectId, token: 'token', acquiredAt: '2025-01-01T00:00:00.000Z', release: async () => undefined };
  }
}

class MemoryMapRepository {
  map?: ProjectMap;
  readonly published: ProjectMap[] = [];
  async projectIdFor(): Promise<string> { return 'project-id'; }
  async read(projectId: string): Promise<ProjectMap | undefined> {
    return this.map?.projectId === projectId ? this.map : undefined;
  }
  async publish(map: ProjectMap): Promise<ProjectMap> {
    const published = { ...map, projectId: 'project-id' };
    this.map = published;
    this.published.push(published);
    return published;
  }
  async remove(projectId: string): Promise<void> {
    if (this.map?.projectId === projectId) this.map = undefined;
  }
  async list() { return this.map === undefined ? [] : [{ projectId: this.map.projectId, projectRoot: this.map.projectRoot, lockfileHash: this.map.lockfileHash, generatedAt: this.map.generatedAt }]; }
}

class MemoryStateRepository {
  state?: ProjectState;
  async read(projectId: string): Promise<ProjectState | undefined> { return this.state?.projectId === projectId ? this.state : undefined; }
  async remove(projectId: string): Promise<void> {
    if (this.state?.projectId === projectId) this.state = undefined;
  }
  async publish(state: ProjectState): Promise<ProjectState> { this.state = state; return state; }
}

class RecordingMaterializer {
  calls = 0;
  async materialize(): Promise<MaterializationResult> {
    this.calls += 1;
    return { projectRoot, projectId: 'project-id', generation: 'generation-1', activeTarget: `${storeDir}/projects/project-id/generations/generation-1/node_modules`, packagesMaterialized: 1 };
  }
}

class RecordingLifecycle {
  calls: unknown[] = [];
  async run(project: ResolvedProject, policy: { enabled: boolean }): Promise<void> { this.calls.push({ project, policy }); }
}

function input(lockfileHash?: string): ProjectInput {
  return {
    projectRoot,
    packageJsonPath: `${projectRoot}/package.json`,
    packageJsonHash: 'package-hash',
    packageManifest: { name: 'fixture-project', version: '1.0.0', dependencies: { example: '1.0.0' } },
    ...(lockfileHash === undefined ? {} : {
      lockfilePath: `${projectRoot}/package-lock.json`,
      lockfileHash,
      lockfile: { lockfileVersion: 3 as const, packages: [] }
    })
  };
}

function resolved(lockfileHash: string): ResolvedProject {
  return {
    projectRoot,
    lockfileHash,
    sources: [source],
    packages: [packageInstance],
    placements: [{ relativePath: 'node_modules/example', packageIdentityHash: packageInstance.identityHash, packageName: 'example' }]
  };
}

function apiFixture(projectInput: ProjectInput, events: string[] = []) {
  const filesystem = createFakeFileSystem('/fixture').seedDirectory(projectRoot).seedDirectory(packageInstance.contentPath);
  const store = new FakePackageStore({ storeDir });
  store.seed(packageInstance);
  const maps = new MemoryMapRepository();
  const states = new MemoryStateRepository();
  const locks = new RecordingLocks();
  const materializer = new RecordingMaterializer();
  const lifecycle = new RecordingLifecycle();
  const reader = { read: async () => projectInput, readRoot: async () => projectInput };
  const resolver = { resolve: async () => resolved(projectInput.lockfileHash ?? projectInput.packageJsonHash) };
  const writer = {
    publish: async (project: ResolvedProject) => {
      events.push('lockfile');
      return { lockfilePath: `${projectRoot}/package-lock.json`, lockfileHash: 'generated-lock-hash', document: {} };
    }
  } as unknown as LockfileWriter;
  const api = createNodeGlueApi({
    filesystem,
    inputReader: reader,
    resolver,
    packageStore: store,
    mapRepository: maps,
    stateRepository: states,
    locks,
    materializer,
    lifecycleRunner: {
      run: async (project, policy) => {
        events.push('lifecycle');
        return lifecycle.run(project, policy);
      }
    },
    lockfileWriter: writer,
    clock: { now: () => new Date('2025-01-01T00:00:00.000Z'), nowIso: () => '2025-01-01T00:00:00.000Z' },
    toolVersion: 'test'
  });
  const originalPublish = maps.publish.bind(maps);
  maps.publish = async (map) => {
    events.push('map');
    return originalPublish(map);
  };
  return { api, filesystem, store, maps, states, locks, materializer, lifecycle };
}

describe('public API orchestration', () => {
  it('publishes a generated lockfile before the exact project map and materializes afterward', async () => {
    const events: string[] = [];
    const fixture = apiFixture(input(), events);
    const result = await fixture.api.ensureProject({ projectRoot });

    expect(events).toEqual(['lockfile', 'map', 'lifecycle']);
    expect(fixture.maps.map).toMatchObject({ lockfileHash: 'generated-lock-hash', placements: [{ packageName: 'example' }] });
    expect(fixture.states.state).toMatchObject({ status: 'ready', lastSuccessfulMaterializationGeneration: 'generation-1' });
    expect(result).toMatchObject({ projectRoot, packagesAdded: 0, packagesReused: 1, materializationGeneration: 'generation-1' });
    expect(fixture.materializer.calls).toBe(1);
  });

  it('short-circuits unchanged projects only after revalidating map, store, and active symlink state', async () => {
    const fixture = apiFixture(input('lock-hash'));
    fixture.maps.map = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot,
      lockfileHash: 'lock-hash',
      placements: [{ relativePath: 'node_modules/example', packageIdentityHash: packageInstance.identityHash, packageName: 'example' }],
      generatedAt: '2025-01-01T00:00:00.000Z',
      toolVersion: 'test'
    };
    fixture.states.state = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot,
      lastSuccessfulMapGeneration: '2025-01-01T00:00:00.000Z',
      lastSuccessfulMaterializationGeneration: 'generation-1',
      activeTarget: `${storeDir}/projects/project-id/generations/generation-1/node_modules`,
      updatedAt: '2025-01-01T00:00:00.000Z',
      lastSuccessfulAt: '2025-01-01T00:00:00.000Z',
      status: 'ready'
    };
    fixture.filesystem.seedDirectory(fixture.states.state.activeTarget).seedSymlink(`${projectRoot}/node_modules`, fixture.states.state.activeTarget);

    const result = await fixture.api.ensureProject({ projectRoot });

    expect(result).toMatchObject({ packagesAdded: 0, packagesReused: 1, materializationGeneration: 'generation-1' });
    expect(fixture.materializer.calls).toBe(0);
  });

  it('inspectProject revalidates current input and filesystem instead of trusting ready advisory state', async () => {
    const fixture = apiFixture(input('lock-hash'));
    fixture.maps.map = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot,
      lockfileHash: 'lock-hash',
      placements: [],
      generatedAt: '2025-01-01T00:00:00.000Z',
      toolVersion: 'test'
    };
    fixture.states.state = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot,
      activeTarget: `${storeDir}/projects/project-id/generations/generation-1/node_modules`,
      lastSuccessfulMaterializationGeneration: 'generation-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
      status: 'ready'
    };

    const state = await fixture.api.inspectProject(projectRoot);

    expect(state.status).toBe('incomplete');
  });

  it('removes a newly published map when first materialization cannot complete', async () => {
    const fixture = apiFixture(input('new-lock'));
    fixture.lifecycle.run = async () => { throw new Error('lifecycle failed'); };

    await expect(fixture.api.ensureProject({ projectRoot })).rejects.toThrow('lifecycle failed');
    expect(fixture.maps.map).toBeUndefined();
    expect(fixture.states.state).toBeUndefined();
  });
  it('restores map, materialization, and advisory state when state publication fails after activation', async () => {
    const fixture = apiFixture(input('new-lock'));
    const previousMap: ProjectMap = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot,
      lockfileHash: 'old-lock',
      placements: [{ relativePath: 'node_modules/example', packageIdentityHash: packageInstance.identityHash, packageName: 'example' }],
      generatedAt: '2024-12-31T00:00:00.000Z',
      toolVersion: 'test'
    };
    const previousState: ProjectState = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot,
      lastSuccessfulMapGeneration: previousMap.generatedAt,
      lastSuccessfulMaterializationGeneration: 'generation-previous',
      activeTarget: `${storeDir}/projects/project-id/generations/generation-previous/node_modules`,
      updatedAt: '2024-12-31T00:00:00.000Z',
      lastSuccessfulAt: '2024-12-31T00:00:00.000Z',
      status: 'ready'
    };
    fixture.maps.map = previousMap;
    fixture.states.state = previousState;
    fixture.filesystem.seedDirectory(previousState.activeTarget).seedSymlink(`${projectRoot}/node_modules`, previousState.activeTarget);

    const rollbackCalls: MaterializationResult[] = [];
    const materializerWithRollback = fixture.materializer as RecordingMaterializer & {
      rollback: (current: MaterializationResult, previous?: MaterializationResult) => Promise<void>;
    };
    materializerWithRollback.rollback = async (current, previous) => {
      rollbackCalls.push(current);
      expect(previous).toMatchObject({ activeTarget: previousState.activeTarget, generation: 'generation-previous' });
    };
    const publishState = fixture.states.publish.bind(fixture.states);
    let statePublishAttempts = 0;
    fixture.states.publish = async (state) => {
      statePublishAttempts += 1;
      if (statePublishAttempts === 1) throw new Error('state publication failed');
      return publishState(state);
    };

    await expect(fixture.api.ensureProject({ projectRoot })).rejects.toThrow('state publication failed');
    expect(fixture.maps.map).toEqual(previousMap);
    expect(fixture.states.state).toEqual(previousState);
    expect(rollbackCalls).toHaveLength(1);
  });
  it('delegates garbage collection through the public API seam', async () => {
    const calls: Array<string | undefined> = [];
    const collector: GarbageCollectorLike = {
      async collect(store) {
        calls.push(store);
        return { removedIdentityHashes: ['removed'], retainedIdentityHashes: ['retained'], scannedProjects: 1 };
      }
    };
    const fixture = apiFixture(input('lock-hash'));
    const api = createNodeGlueApi({
      filesystem: fixture.filesystem,
      inputReader: { read: async () => input('lock-hash'), readRoot: async () => input('lock-hash') },
      resolver: { resolve: async () => resolved('lock-hash') },
      packageStore: fixture.store,
      mapRepository: fixture.maps,
      stateRepository: fixture.states,
      locks: fixture.locks,
      materializer: fixture.materializer,
      lifecycleRunner: fixture.lifecycle,
      garbageCollector: collector
    });

    await expect(api.garbageCollect('/fixture/custom-store')).resolves.toMatchObject({ scannedProjects: 1 });
    expect(calls).toEqual(['/fixture/custom-store']);
  });
});
