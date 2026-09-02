import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FileLockAdapter, ProjectStoreLocks } from '../src/locks.js';
import { ProjectMapRepository } from '../src/project-map.js';
import { LockError, ProjectMapError } from '../src/errors.js';
import {
  ProjectStateRepository,
  cleanupToolOwnedArtifacts,
  serializeProjectState
} from '../src/state.js';
import type { FileSystemAdapter } from '../src/adapters/filesystem.js';
import type { ProjectMap, ProjectState } from '../src/types.js';
import { createFakeFileSystem } from './fixtures/index.js';

const projectState: ProjectState = {
  schemaVersion: 1,
  projectId: 'project-id',
  projectRoot: '/fixture/project',
  lastSuccessfulMapGeneration: 'map-1',
  lastSuccessfulMaterializationGeneration: 'generation-1',
  activeTarget: '/fixture/store/projects/project-id/generations/generation-1/node_modules',
  updatedAt: '2025-01-01T00:00:00.000Z',
  lastSuccessfulAt: '2025-01-01T00:00:00.000Z',
  status: 'ready'
};

function lockPath(locksDir: string, key: string): string {
  return `${locksDir}/${createHash('sha256').update(key).digest('hex')}.lock`;
}

describe('ProjectStateRepository and atomic persistence', () => {
  it('publishes state and preserves the prior readable state when rename fails', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const repository = new ProjectStateRepository({ filesystem, projectsDir: '/fixture/projects' });

    await repository.publish(projectState);
    filesystem.failures.failNext('filesystem.rename');
    await expect(repository.publish({ ...projectState, status: 'incomplete', updatedAt: '2025-01-02T00:00:00.000Z' }))
      .rejects.toBeDefined();

    expect(await repository.read(projectState.projectId)).toEqual(projectState);
    expect((await filesystem.listDirectory('/fixture/projects/project-id')).map((entry) => entry.name))
      .toEqual(['state.json']);
  });

  it('validates state and serializes only the advisory schema', () => {
    expect(() => serializeProjectState({ ...projectState, projectId: '../unsafe' })).toThrow(ProjectMapError);
    expect(() => serializeProjectState({ ...projectState, status: 'broken' as ProjectState['status'] })).toThrow(ProjectMapError);
    expect(JSON.parse(serializeProjectState(projectState))).toEqual(projectState);
  });
});

describe('FileLockAdapter', () => {
  it('provides namespaced project/store locks and releases only its own lease', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const locks = new ProjectStoreLocks({
      filesystem,
      locksDir: '/fixture/locks',
      pollIntervalMs: 1,
      token: () => 'token-1'
    });

    const projectLease = await locks.acquireProject('project-id', { timeoutMs: 0, owner: 'project-test' });
    await expect(locks.acquireProject('project-id', { timeoutMs: 0 })).rejects.toBeInstanceOf(LockError);
    const storeLease = await locks.acquireStore({ timeoutMs: 0 });
    expect(projectLease.key).toBe('project:project-id');
    expect(storeLease.key).toBe('store');

    await projectLease.release();
    await storeLease.release();
    await expect(locks.acquireProject('project-id', { timeoutMs: 0 })).resolves.toBeDefined();
  });

  it('detects and recovers stale locks while retaining structured diagnostics', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const locksDir = '/fixture/locks';
    const key = 'project:stale';
    const path = lockPath(locksDir, key);
    await filesystem.seedFile(path, JSON.stringify({
      schemaVersion: 1,
      key,
      token: 'old-token',
      owner: 'old-process',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      pid: 42
    }));
    const adapter = new FileLockAdapter({
      filesystem,
      locksDir,
      clock: { now: () => new Date('2025-01-01T00:00:00.000Z'), nowIso: () => '2025-01-01T00:00:00.000Z' },
      token: () => 'new-token'
    });

    const lease = await adapter.acquire(key, { timeoutMs: 0, staleAfterMs: 1 });
    expect(adapter.staleDiagnostics).toMatchObject([{
      key,
      lockPath: path,
      owner: 'old-process',
      staleAfterMs: 1
    }]);
    await lease.release();
    expect(await filesystem.exists(path)).toBe(false);
  });

  it('fails closed on malformed lock records', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const adapter = new FileLockAdapter({ filesystem, locksDir: '/fixture/locks' });
    const path = adapter.lockPath('store');
    await filesystem.seedFile(path, '{not-json');

    await expect(adapter.acquire('store', { timeoutMs: 0 })).rejects.toBeInstanceOf(LockError);
    expect(await filesystem.exists(path)).toBe(true);
  });
});

describe('tool-owned cleanup', () => {
  it('removes only generated temporary/generation entries and retains active paths', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    await filesystem.seedDirectory('/fixture/store/tmp');
    await filesystem.seedDirectory('/fixture/store/generations');
    await filesystem.seedDirectory('/fixture/store/tmp/.node-glue-package-1');
    await filesystem.seedFile('/fixture/store/tmp/user-work', 'keep');
    await filesystem.seedDirectory('/fixture/store/generations/generation-old');
    await filesystem.seedDirectory('/fixture/store/generations/generation-active');
    await filesystem.seedDirectory('/fixture/store/generations/user-generation');

    const temporary = await cleanupToolOwnedArtifacts(filesystem, '/fixture/store/tmp', { kind: 'temporary' });
    const generations = await cleanupToolOwnedArtifacts(filesystem, '/fixture/store/generations', {
      kind: 'generations',
      activePaths: ['/fixture/store/generations/generation-active']
    });

    expect(temporary).toEqual(['/fixture/store/tmp/.node-glue-package-1']);
    expect(generations).toEqual(['/fixture/store/generations/generation-old']);
    expect(await filesystem.exists('/fixture/store/tmp/user-work')).toBe(true);
    expect(await filesystem.exists('/fixture/store/generations/generation-active')).toBe(true);
    expect(await filesystem.exists('/fixture/store/generations/user-generation')).toBe(true);
  });
});


describe('atomic map replacement and lock capability safety', () => {
  it('preserves the previous readable map when temporary preparation or sync fails', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    await filesystem.mkdir('/fixture/project', { recursive: true });
    const repository = new ProjectMapRepository({ filesystem, projectsDir: '/fixture/projects' });
    const baseMap: ProjectMap = {
      schemaVersion: 1,
      projectId: 'project-id',
      projectRoot: '/fixture/project',
      lockfileHash: 'lock-1',
      placements: [],
      generatedAt: '2025-01-01T00:00:00.000Z',
      toolVersion: '0.1.0'
    };

    const published = await repository.publish(baseMap);
    filesystem.failures.failNext('filesystem.sync');
    await expect(repository.publish({ ...baseMap, lockfileHash: 'lock-2' })).rejects.toBeDefined();
    expect(await repository.read(published.projectId)).toEqual(published);
    expect((await filesystem.listDirectory(`/fixture/projects/${published.projectId}`)).map((entry) => entry.name))
      .toEqual(['map.json']);
  });

  it('fails closed when exclusive file creation is unavailable', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const withoutExclusive = new Proxy(filesystem, {
      get(target, property, receiver) {
        if (property === 'createFileExclusive') return undefined;
        return Reflect.get(target, property, receiver);
      }
    }) as unknown as FileSystemAdapter;
    const adapter = new FileLockAdapter({ filesystem: withoutExclusive, locksDir: '/fixture/locks' });

    await expect(adapter.acquire('store', { timeoutMs: 0 })).rejects.toMatchObject({
      code: 'LOCK_FAILURE',
      context: { capability: 'exclusive-file-create' }
    });
  });
});