import { describe, expect, it } from 'vitest';
import type { PackageInstance, ProjectMap } from '../src/types.js';
import { Materializer } from '../src/materializer.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import { createProjectGenerationRegistry } from '../src/ownership.js';
import { createFakeFileSystem, FakePackageStore } from './fixtures/index.js';

const projectRoot = '/fixture/project';
const storeDir = '/fixture/store';

function instance(name: string, version: string): PackageInstance {
  const identity = { name, versionOrRevision: version, source: `registry:https://registry.example/${name}` };
  const identityHash = hashPackageIdentity(identity);
  return {
    identity,
    identityHash,
    contentPath: `${storeDir}/packages/${name.replace('@', '').replace('/', '+')}/${identityHash}/content`,
    manifest: { name, version },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

function map(placements: ProjectMap['placements']): ProjectMap {
  return {
    schemaVersion: 1,
    projectId: 'project-id',
    projectRoot,
    lockfileHash: 'lock-hash',
    placements,
    generatedAt: '2025-01-01T00:00:00.000Z',
    toolVersion: '0.1.0'
  };
}

describe('Materializer staged dependency trees', () => {
  it('builds scoped root and nested placements plus project-local bin links', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const store = new FakePackageStore({ storeDir });
    const root = instance('@scope/root', '1.0.0');
    const nested = instance('dep', '2.0.0');
    store.seed(root).seed(nested);
    filesystem
      .seedFile(`${root.contentPath}/package.json`, '{}')
      .seedFile(`${root.contentPath}/cli.js`, '#!/usr/bin/env node')
      .seedFile(`${nested.contentPath}/package.json`, '{}')
      .seedFile(`${nested.contentPath}/bin.js`, '#!/usr/bin/env node');

    const materializer = new Materializer({ filesystem, packageStore: store, storeDir, generation: 'generation-1' });
    const staged = await materializer.stage(projectRoot, map([
      {
        relativePath: 'node_modules/@scope/root',
        packageIdentityHash: root.identityHash,
        packageName: root.identity.name,
        binEntries: { 'root-cli': 'cli.js' }
      },
      {
        relativePath: 'node_modules/@scope/root/node_modules/dep',
        packageIdentityHash: nested.identityHash,
        packageName: nested.identity.name,
        binEntries: { 'dep-cli': 'bin.js' }
      }
    ]));

    expect((await filesystem.lstat(`${staged.stagingNodeModulesPath}/@scope/root`)).type).toBe('directory');
    expect((await filesystem.lstat(`${staged.stagingNodeModulesPath}/@scope/root/package.json`)).type).toBe('symlink');
    expect((await filesystem.lstat(`${staged.stagingNodeModulesPath}/@scope/root/node_modules/dep`)).type).toBe('symlink');
    expect(await filesystem.readlink(`${staged.stagingNodeModulesPath}/.bin/root-cli`)).toBe('../@scope/root/cli.js');
    expect(await filesystem.readlink(`${staged.stagingNodeModulesPath}/@scope/root/node_modules/.bin/dep-cli`)).toBe('../dep/bin.js');
    expect(await filesystem.readlink(`${staged.stagingNodeModulesPath}/@scope/root/package.json`)).toBe(root.contentPath + '/package.json');
  });

  it('fails before staging when a map references missing verified content', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const store = new FakePackageStore({ storeDir });
    const missing = instance('missing', '1.0.0');
    const materializer = new Materializer({ filesystem, packageStore: store, storeDir, generation: 'generation-1' });

    await expect(materializer.stage(projectRoot, map([{
      relativePath: 'node_modules/missing',
      packageIdentityHash: missing.identityHash,
      packageName: missing.identity.name
    }]))).rejects.toMatchObject({ code: 'MISSING_STORE_INSTANCE' });
    expect(filesystem.snapshot().size).toBe(1);
  });

  it('publishes a complete generation and project-root symlink without touching neighboring content', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory(projectRoot).seedFile('/fixture/project/README.md', 'keep');
    const store = new FakePackageStore({ storeDir });
    const root = instance('root', '1.0.0');
    store.seed(root);
    filesystem.seedFile(`${root.contentPath}/package.json`, '{}');
    const materializer = new Materializer({ filesystem, packageStore: store, storeDir, generation: 'generation-1' });

    const result = await materializer.materialize(projectRoot, map([{
      relativePath: 'node_modules/root',
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }]));

    const expectedTarget = `${storeDir}/projects/project-id/generations/generation-1/node_modules`;
    expect(result.activeTarget).toBe(expectedTarget);
    expect(await filesystem.readlink(`${projectRoot}/node_modules`)).toBe(expectedTarget);
    expect((await filesystem.lstat(expectedTarget)).type).toBe('directory');
    expect(await filesystem.readTextFile('/fixture/project/README.md')).toBe('keep');
    expect((await filesystem.lstat(`${expectedTarget}/root`)).type).toBe('symlink');
  });

  it('replaces only a registered project-root symlink and retains the prior generation', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory(projectRoot).seedDirectory(`${storeDir}/projects/project-id/generations/generation-1/node_modules`)
      .seedFile(`${storeDir}/projects/project-id/generations/generation-1/node_modules/.node-glue-generation.json`, JSON.stringify({
        schemaVersion: 1,
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot
      }))
      .seedSymlink(`${projectRoot}/node_modules`, `${storeDir}/projects/project-id/generations/generation-1/node_modules`);
    const store = new FakePackageStore({ storeDir });
    const root = instance('root', '1.0.0');
    store.seed(root);
    filesystem.seedFile(`${root.contentPath}/package.json`, '{}');
    const materializer = new Materializer({
      filesystem,
      packageStore: store,
      storeDir,
      generation: 'generation-2',
      generationRegistry: createProjectGenerationRegistry([{
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot,
        generationPath: `${storeDir}/projects/project-id/generations/generation-1/node_modules`
      }])
    });

    await materializer.materialize(projectRoot, map([{
      relativePath: 'node_modules/root',
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }]));

    expect(await filesystem.readlink(`${projectRoot}/node_modules`)).toBe(
      `${storeDir}/projects/project-id/generations/generation-2/node_modules`
    );
    expect((await filesystem.lstat(`${storeDir}/projects/project-id/generations/generation-1/node_modules`)).type).toBe('directory');
  });

  it('preserves the prior root link when generation publication fails', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const failures = filesystem.failures;
    filesystem.seedDirectory(projectRoot).seedDirectory(`${storeDir}/projects/project-id/generations/generation-1/node_modules`)
      .seedFile(`${storeDir}/projects/project-id/generations/generation-1/node_modules/.node-glue-generation.json`, JSON.stringify({
        schemaVersion: 1,
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot
      }))
      .seedSymlink(`${projectRoot}/node_modules`, `${storeDir}/projects/project-id/generations/generation-1/node_modules`);
    const store = new FakePackageStore({ storeDir });
    const root = instance('root', '1.0.0');
    store.seed(root);
    filesystem.seedFile(`${root.contentPath}/package.json`, '{}');
    failures.failNext('filesystem.rename');
    const before = filesystem.snapshot();
    const materializer = new Materializer({
      filesystem,
      packageStore: store,
      storeDir,
      generation: 'generation-2',
      generationRegistry: createProjectGenerationRegistry([{
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot,
        generationPath: `${storeDir}/projects/project-id/generations/generation-1/node_modules`
      }])
    });

    await expect(materializer.materialize(projectRoot, map([{
      relativePath: 'node_modules/root',
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }]))).rejects.toMatchObject({ code: 'PUBLICATION_FAILURE' });
    expect(filesystem.snapshot()).toEqual(before);
    expect(await filesystem.readlink(`${projectRoot}/node_modules`)).toBe(
      `${storeDir}/projects/project-id/generations/generation-1/node_modules`
    );
  });

  it('rolls back a newly published generation when root-link rename fails', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory(projectRoot).seedDirectory(`${storeDir}/projects/project-id/generations/generation-1/node_modules`)
      .seedFile(`${storeDir}/projects/project-id/generations/generation-1/node_modules/.node-glue-generation.json`, JSON.stringify({
        schemaVersion: 1,
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot
      }))
      .seedSymlink(`${projectRoot}/node_modules`, `${storeDir}/projects/project-id/generations/generation-1/node_modules`);
    const originalRename = filesystem.rename.bind(filesystem);
    let renameCount = 0;
    filesystem.rename = async (source, destination) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('root-link rename unavailable');
      await originalRename(source, destination);
    };
    const store = new FakePackageStore({ storeDir });
    const root = instance('root', '1.0.0');
    store.seed(root);
    filesystem.seedFile(`${root.contentPath}/package.json`, '{}');
    const before = filesystem.snapshot();
    const materializer = new Materializer({
      filesystem,
      packageStore: store,
      storeDir,
      generation: 'generation-2',
      generationRegistry: createProjectGenerationRegistry([{
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot,
        generationPath: `${storeDir}/projects/project-id/generations/generation-1/node_modules`
      }])
    });

    await expect(materializer.materialize(projectRoot, map([{
      relativePath: 'node_modules/root',
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }]))).rejects.toMatchObject({ code: 'PUBLICATION_FAILURE' });
    expect(filesystem.snapshot()).toEqual(before);
    expect(await filesystem.readlink(`${projectRoot}/node_modules`)).toBe(
      `${storeDir}/projects/project-id/generations/generation-1/node_modules`
    );
    await expect(filesystem.lstat(`${storeDir}/projects/project-id/generations/generation-2`)).rejects.toThrow();
  });

  it('restores the previous generation after a later state publication failure', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const previousTarget = `${storeDir}/projects/project-id/generations/generation-1/node_modules`;
    filesystem.seedDirectory(projectRoot)
      .seedDirectory(previousTarget)
      .seedFile(`${previousTarget}/.node-glue-generation.json`, JSON.stringify({
        schemaVersion: 1,
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot
      }))
      .seedSymlink(`${projectRoot}/node_modules`, previousTarget);
    const store = new FakePackageStore({ storeDir });
    const root = instance('root', '1.0.0');
    store.seed(root);
    filesystem.seedFile(`${root.contentPath}/package.json`, '{}');
    const materializer = new Materializer({
      filesystem,
      packageStore: store,
      storeDir,
      generation: 'generation-2',
      generationRegistry: createProjectGenerationRegistry([{
        projectId: 'project-id',
        generation: 'generation-1',
        projectRoot,
        generationPath: previousTarget
      }])
    });

    const current = await materializer.materialize(projectRoot, map([{
      relativePath: 'node_modules/root',
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }]));
    await materializer.rollback(current, {
      projectRoot,
      projectId: 'project-id',
      generation: 'generation-1',
      activeTarget: previousTarget,
      packagesMaterialized: 1
    });

    expect(await filesystem.readlink(`${projectRoot}/node_modules`)).toBe(previousTarget);
    await expect(filesystem.lstat(`${storeDir}/projects/project-id/generations/generation-2`)).rejects.toThrow();
    expect((await filesystem.lstat(previousTarget)).type).toBe('directory');
  });
  it('fails before staging when publication capabilities are unavailable', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const store = new FakePackageStore({ storeDir });
    const root = instance('root', '1.0.0');
    store.seed(root);
    filesystem.seedFile(`${root.contentPath}/package.json`, '{}');
    const before = filesystem.snapshot();
    const materializer = new Materializer({
      filesystem,
      packageStore: store,
      storeDir,
      generation: 'generation-1',
      capabilities: { atomicRename: false }
    });

    await expect(materializer.materialize(projectRoot, map([{
      relativePath: 'node_modules/root',
      packageIdentityHash: root.identityHash,
      packageName: root.identity.name
    }]))).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(filesystem.snapshot()).toEqual(before);
  });
});
