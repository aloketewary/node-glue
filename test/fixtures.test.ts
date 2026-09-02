import { describe, expect, it } from 'vitest';
import {
  createFailureInjector,
  createFakeFileSystem,
  createPackageGraph,
  createLockfile,
  createPackageLock,
  createProjectMap,
  createGeneration,
  createProjectSymlink,
  seedGeneration,
  seedProjectSymlink,
  FakePackageStore,
  FakeSourceAdapter,
  generatedPropertyCase,
  propertyTag,
  withTemporaryProject
} from './fixtures/index.js';

describe('Node Glue fixture helpers', () => {
  it('provides an adapter-compatible in-memory filesystem and injected failures', async () => {
    const failures = createFailureInjector();
    const filesystem = createFakeFileSystem('/fixture', failures);
    await filesystem.mkdir('/fixture/project', { recursive: true });
    await filesystem.writeFile('/fixture/project/package.json', '{}');
    expect(await filesystem.readTextFile('/fixture/project/package.json')).toBe('{}');
    failures.failNext('filesystem.writeFile');
    await expect(filesystem.writeFile('/fixture/project/blocked', 'x')).rejects.toMatchObject({ point: 'filesystem.writeFile' });
    failures.clear('filesystem.writeFile');
    const generation = createGeneration();
    await seedGeneration(filesystem, generation);
    await seedProjectSymlink(filesystem, generation.projectRoot, generation.nodeModulesPath);
    expect(await filesystem.realpath(`${generation.projectRoot}/node_modules`)).toBe(generation.nodeModulesPath);
  });

  it('creates deterministic graphs, lockfiles, maps, generations, and symlink records', () => {
    const graph = createPackageGraph({ count: 2, scopedEvery: 2, includeBins: true });
    const lockfile = createLockfile(3, graph);
    const packageLock = createPackageLock(2, graph);
    const map = createProjectMap({ placements: graph.placements });
    const generation = createGeneration({ projectId: map.projectId });
    const symlink = createProjectSymlink(graph.projectRoot, generation.nodeModulesPath);

    expect(graph.packages).toHaveLength(2);
    expect(graph.placements[0]?.packageName).toBe('@fixture/package-0');
    expect(lockfile.lockfileVersion).toBe(3);
    expect(packageLock.lockfileVersion).toBe(2);
    expect(packageLock.dependencies).toHaveProperty('@fixture/package-0');
    expect(map.placements).toEqual(graph.placements);
    expect(symlink.target).toBe(generation.nodeModulesPath);
    expect(generation.markerPath).toContain('.node-glue-generation');
  });

  it('resolves fake sources and reuses matching fake store instances', async () => {
    const graph = createPackageGraph({ count: 1 });
    const sourceAdapter = new FakeSourceAdapter([{
      source: graph.sources[0]!.source,
      manifest: graph.packages[0]!.manifest,
      resolvedLocator: graph.sources[0]!.resolvedLocator,
      versionOrRevision: graph.sources[0]!.versionOrRevision,
      ...(graph.sources[0]!.integrity === undefined ? {} : { integrity: graph.sources[0]!.integrity })
    }]);
    const source = await sourceAdapter.resolve(graph.sources[0]!.source);
    const store = new FakePackageStore();
    const first = await store.ensure(source);
    const second = await store.ensure(source);

    expect(first).toBe(second);
    expect(store.list()).toHaveLength(1);
    expect(sourceAdapter.resolveCalls).toHaveLength(1);
  });

  it('cleans temporary projects and tags generated property cases', async () => {
    await withTemporaryProject({ dependencies: { fixture: '1.0.0' } }, async (project) => {
      expect(project.root).toContain('node-glue-project-');
      expect(project.hasLockfile).toBe(false);
    });

    const tagged = generatedPropertyCase(8, { valid: true }, 'staging');
    expect(tagged.label).toBe('Feature: node-glue-mvp, Property 8: staging');
    expect(propertyTag(1)).toBe('Feature: node-glue-mvp, Property 1');
  });
});
