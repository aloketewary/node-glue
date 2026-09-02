import { describe, expect, it } from 'vitest';
import { Doctor } from '../src/doctor.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import { serializeProjectMap } from '../src/project-map.js';
import { serializeProjectState } from '../src/state.js';
import { generationOwnershipMarkerPath, serializeGenerationOwnershipMarker } from '../src/ownership.js';
import type { PackageInstance, ProjectMap, ProjectState } from '../src/types.js';
import { createFakeFileSystem, FakePackageStore } from './fixtures/index.js';
import { hashText } from '../src/input-reader.js';

const projectRoot = '/fixture/project';
const storeDir = '/fixture/store';
const projectId = 'project-id';
const generation = 'generation-1';
const activeTarget = `${storeDir}/projects/${projectId}/generations/${generation}/node_modules`;

function packageInstance(): PackageInstance {
  const identity = { name: 'example', versionOrRevision: '1.0.0', source: 'registry:https://registry.example/example' };
  const identityHash = hashPackageIdentity(identity);
  return {
    identity,
    identityHash,
    contentPath: `${storeDir}/packages/example/${identityHash}/content`,
    manifest: { name: 'example', version: '1.0.0' },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

function projectMap(instance: PackageInstance, lockfileHash: string): ProjectMap {
  return {
    schemaVersion: 1,
    projectId,
    projectRoot,
    lockfileHash,
    placements: [{
      relativePath: 'node_modules/example',
      packageIdentityHash: instance.identityHash,
      packageName: instance.identity.name
    }],
    generatedAt: '2025-01-01T00:00:00.000Z',
    toolVersion: 'test'
  };
}

function projectState(): ProjectState {
  return {
    schemaVersion: 1,
    projectId,
    projectRoot,
    lastSuccessfulMapGeneration: '2025-01-01T00:00:00.000Z',
    lastSuccessfulMaterializationGeneration: generation,
    activeTarget,
    updatedAt: '2025-01-01T00:00:00.000Z',
    lastSuccessfulAt: '2025-01-01T00:00:00.000Z',
    status: 'ready'
  };
}

function seedHealthyProject() {
  const filesystem = createFakeFileSystem('/fixture');
  const store = new FakePackageStore({ storeDir });
  const instance = packageInstance();
  const packageJson = JSON.stringify({ name: 'fixture-project', version: '1.0.0', dependencies: { example: '1.0.0' } });
  const map = projectMap(instance, hashText(packageJson));
  filesystem
    .seedDirectory(projectRoot)
    .seedFile(`${projectRoot}/package.json`, packageJson)
    .seedDirectory(instance.contentPath)
    .seedDirectory(activeTarget)
    .seedFile(generationOwnershipMarkerPath(activeTarget), serializeGenerationOwnershipMarker({
      schemaVersion: 1,
      projectId,
      generation,
      projectRoot
    }))
    .seedSymlink(`${projectRoot}/node_modules`, activeTarget)
    .seedFile(`${storeDir}/projects/${projectId}/map.json`, serializeProjectMap(map))
    .seedFile(`${storeDir}/projects/${projectId}/state.json`, serializeProjectState(projectState()));
  store.seed(instance);
  return { filesystem, store, instance };
}

describe('Doctor diagnostics and structured state inspection', () => {
  it('exposes successful map, state, generation, and link state as ready', async () => {
    const fixture = seedHealthyProject();
    const report = await new Doctor({ filesystem: fixture.filesystem, packageStore: fixture.store }).inspectProject(projectRoot);

    expect(report.status).toBe('ready');
    expect(report.map?.projectId).toBe(projectId);
    expect(report.state?.lastSuccessfulMaterializationGeneration).toBe(generation);
    expect(report.materialization).toMatchObject({
      activeTarget,
      activeGeneration: generation,
      rootLinkTarget: activeTarget,
      completeGenerations: [generation],
      incompleteGenerations: []
    });
    expect(report.findings).toEqual([]);
  });

  it('reports missing store references and unknown ownership without changing state', async () => {
    const fixture = seedHealthyProject();
    fixture.store.remove(fixture.instance.identityHash);
    fixture.filesystem.seedSymlink(`${projectRoot}/node_modules`, '/fixture/missing-generation/node_modules');
    const before = fixture.filesystem.snapshot();

    const report = await new Doctor({ filesystem: fixture.filesystem, packageStore: fixture.store }).inspectProject(projectRoot);
    const codes = report.findings.map((finding) => finding.code);

    expect(report.status).toBe('incomplete');
    expect(codes).toContain('MISSING_STORE_INSTANCE');
    expect(codes).toContain('OWNERSHIP_UNKNOWN');
    expect(fixture.filesystem.snapshot()).toEqual(before);
  });

  it('reports stale input and incomplete generations with affected paths', async () => {
    const fixture = seedHealthyProject();
    fixture.filesystem.seedFile(`${projectRoot}/package.json`, JSON.stringify({ name: 'fixture-project', version: '2.0.0' }));
    fixture.filesystem.seedDirectory(`${storeDir}/projects/${projectId}/generations/generation-2`);

    const report = await new Doctor({ filesystem: fixture.filesystem, packageStore: fixture.store }).inspectProject(projectRoot);
    const stale = report.findings.find((finding) => finding.code === 'STALE_PROJECT_MAP');
    const incomplete = report.findings.find((finding) => finding.code === 'PUBLICATION_FAILURE');

    expect(report.status).toBe('incomplete');
    expect(stale?.path).toBe(projectRoot);
    expect(incomplete?.path).toBe(`${storeDir}/projects/${projectId}/generations/generation-2`);
  });

  it('reports unsupported host and disabled publication capabilities', async () => {
    const fixture = createFakeFileSystem('/fixture');
    const store = new FakePackageStore({ storeDir });
    const report = await new Doctor({
      filesystem: fixture,
      packageStore: store,
      platform: 'win32',
      capabilities: { symlinks: false, atomicRename: false, protectedPaths: false }
    }).inspectProject(projectRoot);
    const capabilityFindings = report.findings.filter((finding) => finding.code === 'CAPABILITY_UNAVAILABLE');

    expect(capabilityFindings).toHaveLength(4);
    expect(capabilityFindings.map((finding) => finding.context.capability)).toEqual([
      undefined,
      'symlinks',
      'atomic-rename',
      'protected-paths'
    ]);
  });
});
