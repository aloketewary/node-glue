import { describe, expect, it } from 'vitest';
import { GarbageCollector } from '../src/gc.js';
import { ProjectMapError, UnresolvedReferenceError } from '../src/errors.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import { serializeProjectMap } from '../src/project-map.js';
import type { PackageIdentity, PackageInstance, ProjectMap } from '../src/types.js';
import { createFakeFileSystem } from './fixtures/index.js';

const storeDir = '/fixture/store';

class RecordingLock {
  acquired = 0;
  released = 0;

  async acquire() {
    this.acquired += 1;
    return {
      key: 'store',
      token: 'test-token',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      release: async () => { this.released += 1; }
    };
  }
}

function instance(name: string, version: string): PackageInstance {
  const identity: PackageIdentity = {
    name,
    versionOrRevision: version,
    source: `registry:https://registry.example.test/${name}@${version}`
  };
  const identityHash = hashPackageIdentity(identity);
  return {
    identity,
    identityHash,
    contentPath: `${storeDir}/packages/${name}/${identityHash}/content`,
    manifest: { name, version },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

function map(projectId: string, identityHashes: readonly string[]): ProjectMap {
  return {
    schemaVersion: 1,
    projectId,
    projectRoot: `/fixture/${projectId}`,
    lockfileHash: `lock-${projectId}`,
    placements: identityHashes.map((packageIdentityHash, index) => ({
      relativePath: `node_modules/package-${index}`,
      packageIdentityHash,
      packageName: `package-${index}`
    })),
    generatedAt: '2025-01-01T00:00:00.000Z',
    toolVersion: '0.1.0'
  };
}

async function seedInstance(
  filesystem: ReturnType<typeof createFakeFileSystem>,
  packageInstance: PackageInstance
): Promise<void> {
  const instanceDirectory = packageInstance.contentPath.slice(0, -'/content'.length);
  await filesystem.seedDirectory(packageInstance.contentPath).seedFile(
    `${instanceDirectory}/instance.json`,
    JSON.stringify(packageInstance)
  );
}

async function seedMap(
  filesystem: ReturnType<typeof createFakeFileSystem>,
  projectMap: ProjectMap
): Promise<void> {
  await filesystem.seedFile(
    `${storeDir}/projects/${projectMap.projectId}/map.json`,
    serializeProjectMap(projectMap)
  );
}

describe('GarbageCollector', () => {
  it('locks the store, preserves referenced instances, and removes only valid unreferenced instances', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const lock = new RecordingLock();
    const used = instance('used', '1.0.0');
    const unused = instance('unused', '1.0.0');
    await seedInstance(filesystem, used);
    await seedInstance(filesystem, unused);
    await seedMap(filesystem, map('project-one', [used.identityHash]));
    await filesystem.seedFile(`${storeDir}/cache/transport-entry`, 'retain');

    const result = await new GarbageCollector({ filesystem, locks: lock, storeDir }).collect();

    expect(result).toEqual({
      removedIdentityHashes: [unused.identityHash],
      retainedIdentityHashes: [used.identityHash],
      scannedProjects: 1
    });
    expect(await filesystem.exists(used.contentPath)).toBe(true);
    expect(await filesystem.exists(unused.contentPath)).toBe(false);
    expect(await filesystem.exists(`${storeDir}/cache/transport-entry`)).toBe(true);
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(1);
  });

  it('fails closed on malformed maps before deleting any package instance', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const lock = new RecordingLock();
    const unused = instance('unused', '1.0.0');
    await seedInstance(filesystem, unused);
    await filesystem.seedFile(`${storeDir}/projects/broken/map.json`, '{not-json');

    await expect(new GarbageCollector({ filesystem, locks: lock, storeDir }).collect())
      .rejects.toBeInstanceOf(ProjectMapError);

    expect(await filesystem.exists(unused.contentPath)).toBe(true);
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(1);
  });

  it('fails closed when a map references an unresolved package instance', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const lock = new RecordingLock();
    const unused = instance('unused', '1.0.0');
    await seedInstance(filesystem, unused);
    await seedMap(filesystem, map('project-one', ['f'.repeat(64)]));

    await expect(new GarbageCollector({ filesystem, locks: lock, storeDir }).collect())
      .rejects.toBeInstanceOf(UnresolvedReferenceError);

    expect(await filesystem.exists(unused.contentPath)).toBe(true);
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(1);
  });
});
