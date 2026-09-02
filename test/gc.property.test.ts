import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { posix } from 'node:path';
import { GarbageCollector } from '../src/gc.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import type { LockAdapter, LockLease } from '../src/adapters/locks.js';
import type { PackageIdentity, PackageInstance, ProjectMap } from '../src/types.js';
import { createFakeFileSystem, createProjectMap, propertyTag, type FakeFileSystem } from './fixtures/index.js';

interface CollectionCase {
  readonly id: number;
  readonly referenced: readonly boolean[];
  readonly mapKind: 'valid' | 'invalid-json' | 'invalid-schema' | 'unresolved-reference';
}

class RecordingStoreLock implements LockAdapter {
  readonly acquiredKeys: string[] = [];
  releaseCount = 0;

  async acquire(key: string): Promise<LockLease> {
    this.acquiredKeys.push(key);
    return {
      key,
      token: 'fixture-lock-token',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      release: async () => {
        this.releaseCount += 1;
      }
    };
  }
}

const collectionCaseArbitrary = fc.record({
  id: fc.integer({ min: 0, max: 999_999 }),
  referenced: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
  mapKind: fc.constantFrom('valid', 'invalid-json', 'invalid-schema', 'unresolved-reference')
});

describe('GarbageCollector property coverage', () => {
  it(propertyTag(12, 'garbage collection is reference-preserving and fail-closed'), async () => {
    await fc.assert(
      fc.asyncProperty(collectionCaseArbitrary, async (collectionCase) => {
        const storeDir = `/fixture/store-${collectionCase.id}`;
        const filesystem = createFakeFileSystem();
        const locks = new RecordingStoreLock();
        const instances = collectionCase.referenced.map((_, index) => createPackageInstance(collectionCase.id, index, storeDir));

        for (const instance of instances) await seedPackageInstance(filesystem, instance);
        await seedMap(filesystem, storeDir, collectionCase, instances);

        const before = filesystem.snapshot();
        const collector = new GarbageCollector({ filesystem, locks, storeDir });

        if (collectionCase.mapKind === 'valid') {
          const result = await collector.collect();
          const referencedHashes = instances
            .filter((_, index) => collectionCase.referenced[index])
            .map((instance) => instance.identityHash)
            .sort();
          const unreferencedHashes = instances
            .filter((_, index) => !collectionCase.referenced[index])
            .map((instance) => instance.identityHash)
            .sort();

          expect(result.removedIdentityHashes).toEqual(unreferencedHashes);
          expect(result.retainedIdentityHashes).toEqual(referencedHashes);
          expect(result.scannedProjects).toBe(1);
          for (const [index, instance] of instances.entries()) {
            expect(await filesystem.exists(instanceDirectory(storeDir, instance))).toBe(collectionCase.referenced[index]);
          }
        } else {
          await expect(collector.collect()).rejects.toMatchObject({
            code: collectionCase.mapKind === 'unresolved-reference' ? 'UNRESOLVED_REFERENCE' : 'MAP_FAILURE'
          });
          expect(filesystem.snapshot()).toEqual(before);
        }

        expect(locks.acquiredKeys).toEqual(['store']);
        expect(locks.releaseCount).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});

function createPackageInstance(caseId: number, index: number, storeDir: string): PackageInstance {
  const identity: PackageIdentity = {
    name: `fixture-package-${caseId}-${index}`,
    versionOrRevision: `1.0.${index}`,
    source: `registry:https://registry.example.test/fixture-package-${caseId}-${index}`
  };
  const identityHash = hashPackageIdentity(identity);
  const directory = instanceDirectory(storeDir, { identity, identityHash } as PackageInstance);
  return {
    identity,
    identityHash,
    contentPath: posix.join(directory, 'content'),
    manifest: { name: identity.name, version: identity.versionOrRevision },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

async function seedPackageInstance(filesystem: FakeFileSystem, instance: PackageInstance): Promise<void> {
  const directory = instanceDirectoryFromIdentity(instance);
  filesystem.seedDirectory(posix.join(directory, 'content'));
  filesystem.seedFile(posix.join(directory, 'instance.json'), JSON.stringify(instance));
}

async function seedMap(
  filesystem: FakeFileSystem,
  storeDir: string,
  collectionCase: CollectionCase,
  instances: readonly PackageInstance[]
): Promise<void> {
  const projectId = `fixture-project-${collectionCase.id}`;
  const mapPath = posix.join(storeDir, 'projects', projectId, 'map.json');

  if (collectionCase.mapKind === 'invalid-json') {
    filesystem.seedFile(mapPath, '{not-json');
    return;
  }

  const placements = instances
    .filter((_, index) => collectionCase.referenced[index])
    .map((instance, index) => ({
      relativePath: `node_modules/${instance.identity.name}`,
      packageIdentityHash: instance.identityHash,
      packageName: instance.identity.name
    }));
  const map: ProjectMap = createProjectMap({
    projectId,
    projectRoot: `/fixture/projects/${collectionCase.id}`,
    placements
  });

  if (collectionCase.mapKind === 'invalid-schema') {
    filesystem.seedFile(mapPath, JSON.stringify({ ...map, schemaVersion: 2 }));
    return;
  }

  if (collectionCase.mapKind === 'unresolved-reference') {
    filesystem.seedFile(mapPath, JSON.stringify({
      ...map,
      placements: [...placements, {
        relativePath: 'node_modules/missing-reference',
        packageIdentityHash: 'missing-reference',
        packageName: 'missing-reference'
      }]
    }));
    return;
  }

  filesystem.seedFile(mapPath, JSON.stringify(map));
}

function instanceDirectory(storeDir: string, instance: PackageInstance): string {
  return posix.join(storeDir, 'packages', instance.identity.name, instance.identityHash);
}

function instanceDirectoryFromIdentity(instance: PackageInstance): string {
  return posix.dirname(instance.contentPath);
}
