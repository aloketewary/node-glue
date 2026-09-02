import { describe, expect, it } from 'vitest';
import {
  deriveProjectId,
  ProjectMapRepository,
  serializeProjectMap
} from '../src/project-map.js';
import { MissingStoreInstanceError, ProjectMapError } from '../src/errors.js';
import type { ProjectMap } from '../src/types.js';
import { createFakeFileSystem } from './fixtures/index.js';

const packageHash = 'a'.repeat(64);

function createMap(projectRoot = '/fixture/project'): ProjectMap {
  return {
    schemaVersion: 1,
    projectId: 'caller-supplied-id',
    projectRoot,
    lockfileHash: 'lock-hash',
    placements: [{
      relativePath: 'node_modules/example',
      packageIdentityHash: packageHash,
      packageName: 'example',
      peerContext: { react: '18.3.1' },
      binEntries: { example: 'bin/cli.js' }
    }],
    generatedAt: '2025-01-01T00:00:00.000Z',
    toolVersion: '0.1.0'
  };
}

describe('ProjectMapRepository', () => {
  it('derives readable stable identifiers from canonical roots', () => {
    const first = deriveProjectId('/fixture/My Project');
    const equivalent = deriveProjectId('/fixture/./My Project');

    expect(first).toBe(equivalent);
    expect(first).toMatch(/^My-Project-[a-f0-9]{16}$/);
  });

  it('publishes exact placements atomically and reads validated maps', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    await filesystem.mkdir('/fixture/project', { recursive: true });
    const repository = new ProjectMapRepository({
      filesystem,
      projectsDir: '/fixture/store/projects',
      packageInstanceExists: (identityHash) => identityHash === packageHash
    });

    const published = await repository.publish(createMap());
    expect(published.projectId).toBe(deriveProjectId('/fixture/project'));
    expect(published.placements[0]).toMatchObject({
      relativePath: 'node_modules/example',
      packageIdentityHash: packageHash,
      peerContext: { react: '18.3.1' },
      binEntries: { example: 'bin/cli.js' }
    });
    expect(await repository.read(published.projectId)).toEqual(published);

    const raw = await filesystem.readTextFile(repository.mapPath(published.projectId));
    expect(JSON.parse(raw)).toEqual(published);
  });

  it('uses a different identifier instead of overwriting an unrelated map', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    await filesystem.mkdir('/fixture/project', { recursive: true });
    const repository = new ProjectMapRepository({ filesystem, projectsDir: '/fixture/store/projects' });
    const expectedId = deriveProjectId('/fixture/project');
    const unrelated = createMap('/fixture/unrelated');
    const occupiedPath = repository.mapPath(expectedId);
    await filesystem.mkdir('/fixture/store/projects', { recursive: true });
    await filesystem.mkdir('/fixture/store/projects/' + expectedId, { recursive: true });
    await filesystem.writeFileAtomic(occupiedPath, serializeProjectMap({ ...unrelated, projectId: expectedId }));

    const published = await repository.publish({ ...createMap(), placements: [] });

    expect(published.projectId).not.toBe(expectedId);
    expect(await repository.read(expectedId)).toMatchObject({ projectRoot: '/fixture/unrelated' });
    expect(await repository.read(published.projectId)).toMatchObject({ projectRoot: '/fixture/project' });
  });

  it('rejects secrets and unresolved package references before writing', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    await filesystem.mkdir('/fixture/project', { recursive: true });
    const repository = new ProjectMapRepository({
      filesystem,
      projectsDir: '/fixture/store/projects',
      packageInstanceExists: () => false
    });

    await expect(repository.publish(createMap())).rejects.toBeInstanceOf(MissingStoreInstanceError);
    expect(await filesystem.exists('/fixture/store')).toBe(false);

    const secretMap = {
      ...createMap(),
      placements: [{
        ...createMap().placements[0]!,
        peerContext: { authToken: 'do-not-persist' }
      }]
    } satisfies ProjectMap;
    await expect(repository.publish(secretMap)).rejects.toBeInstanceOf(ProjectMapError);
    expect(await filesystem.exists('/fixture/store')).toBe(false);
  });

  it('rejects malformed placement paths and duplicate placements', () => {
    expect(() => serializeProjectMap({
      ...createMap(),
      placements: [{ ...createMap().placements[0]!, relativePath: '../node_modules/example' }]
    })).toThrow(ProjectMapError);
    expect(() => serializeProjectMap({
      ...createMap(),
      placements: [createMap().placements[0]!, createMap().placements[0]!]
    })).toThrow(ProjectMapError);
  });
});
