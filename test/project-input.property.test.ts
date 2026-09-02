import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DependencyResolver, type ArboristAdapter, type ResolverTree } from '../src/dependency-resolver.js';
import { InputReader } from '../src/input-reader.js';
import { LockfileWriter, type LockfilePublication } from '../src/lockfile.js';
import { ProjectMapRepository } from '../src/project-map.js';
import type {
  PackageManifest,
  ProjectInput,
  ResolvedProject
} from '../src/types.js';
import { createFakeFileSystem, propertyTag } from './fixtures/index.js';

interface InputCase {
  readonly id: number;
  readonly dependencyMinor: number;
  readonly packageMinor: number;
}

type InputKind = 'v2' | 'v3' | 'no-lock';

const inputCaseArbitrary = fc.record({
  id: fc.integer({ min: 1, max: 999_999 }),
  dependencyMinor: fc.integer({ min: 0, max: 99 }),
  packageMinor: fc.integer({ min: 0, max: 99 })
});

describe('project input normalization property coverage', () => {
  it(propertyTag(1, 'supported project inputs normalize consistently'), async () => {
    await fc.assert(
      fc.asyncProperty(inputCaseArbitrary, async (inputCase) => {
        const fingerprints: string[] = [];
        for (const kind of ['v2', 'v3', 'no-lock'] as const) {
          const { input, resolved } = await readAndResolve(inputCase, kind);
          expectCompleteInput(input, kind);
          expectCompleteResolvedGraph(resolved, inputCase);
          fingerprints.push(graphFingerprint(resolved));
        }

        expect(fingerprints[0]).toBe(fingerprints[1]);
        expect(fingerprints[1]).toBe(fingerprints[2]);
      }),
      { numRuns: 100 }
    );
  });

  it('publishes generated lockfile before publishing its Project Map', async () => {
    const inputCase: InputCase = { id: 42, dependencyMinor: 7, packageMinor: 3 };
    const { input, resolved, filesystem } = await readAndResolve(inputCase, 'no-lock');
    const renameDestinations: string[] = [];
    const originalRename = filesystem.rename.bind(filesystem);
    filesystem.rename = async (source, destination) => {
      renameDestinations.push(destination);
      await originalRename(source, destination);
    };

    let publication: LockfilePublication;
    publication = await new LockfileWriter({ filesystem }).publish(resolved, input.packageManifest);
    const repository = new ProjectMapRepository({
      filesystem,
      projectsDir: '/fixture/store/projects',
      packageInstanceExists: (identityHash) => resolved.packages.some((pkg) => pkg.identityHash === identityHash)
    });
    const publishedMap = await repository.publish({
      schemaVersion: 1,
      projectId: 'caller-supplied-id',
      projectRoot: resolved.projectRoot,
      lockfileHash: publication.lockfileHash,
      placements: resolved.placements,
      generatedAt: '2025-01-01T00:00:00.000Z',
      toolVersion: '0.1.0'
    });

    expect(renameDestinations[0]).toBe(publication.lockfilePath);
    expect(renameDestinations.at(-1)).toBe(repository.mapPath(publishedMap.projectId));
    expect(await filesystem.readTextFile(publication.lockfilePath)).toContain('"lockfileVersion": 3');
    expect((await repository.read(publishedMap.projectId))?.lockfileHash).toBe(publication.lockfileHash);
  });
});

async function readAndResolve(
  inputCase: InputCase,
  kind: InputKind
): Promise<{
  input: ProjectInput;
  resolved: ResolvedProject;
  filesystem: ReturnType<typeof createFakeFileSystem>;
}> {
  const dependencyName = `dependency-${inputCase.id}`;
  const projectRoot = `/fixture/project-${inputCase.id}-${kind}`;
  const dependencyVersion = `1.${inputCase.dependencyMinor}.0`;
  const manifest: PackageManifest = {
    name: `fixture-project-${inputCase.id}`,
    version: `1.${inputCase.packageMinor}.0`,
    dependencies: { [dependencyName]: '^1.0.0' }
  };
  const resolvedLocator = `https://user:password@registry.example.test/${dependencyName}/-/${dependencyName}-${dependencyVersion}.tgz`;
  const filesystem = createFakeFileSystem('/fixture');
  filesystem.seedDirectory(projectRoot);
  filesystem.seedFile(`${projectRoot}/package.json`, `${JSON.stringify(manifest)}\n`);

  if (kind !== 'no-lock') {
    filesystem.seedFile(
      `${projectRoot}/package-lock.json`,
      `${JSON.stringify(packageLock(kind === 'v2' ? 2 : 3, manifest, dependencyName, dependencyVersion, resolvedLocator))}\n`
    );
  }

  const input = await new InputReader({ filesystem }).read(projectRoot);
  const resolverOptions = kind === 'no-lock'
    ? { arborist: noLockArborist(manifest, dependencyName, dependencyVersion, resolvedLocator) }
    : {};
  const resolved = await new DependencyResolver(resolverOptions).resolve(input);
  return { input, resolved, filesystem };
}

function noLockArborist(
  manifest: PackageManifest,
  dependencyName: string,
  dependencyVersion: string,
  resolvedLocator: string
): ArboristAdapter {
  const dependencyNode = {
    name: dependencyName,
    version: dependencyVersion,
    path: `node_modules/${dependencyName}`,
    resolved: resolvedLocator,
    integrity: `sha512-${dependencyName}-${dependencyVersion}`,
    package: {
      name: dependencyName,
      version: dependencyVersion
    }
  };
  const tree: ResolverTree = {
    inventory: new Map([
      ['', { name: manifest.name, version: manifest.version, path: '', package: manifest }],
      [dependencyNode.path, dependencyNode]
    ])
  };
  return {
    async loadVirtual() {
      return tree;
    },
    async buildIdealTree() {
      return tree;
    }
  };
}

function packageLock(
  version: 2 | 3,
  manifest: PackageManifest,
  dependencyName: string,
  dependencyVersion: string,
  resolvedLocator: string
): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: version,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies
      },
      [`node_modules/${dependencyName}`]: {
        name: dependencyName,
        version: dependencyVersion,
        resolved: resolvedLocator,
        integrity: `sha512-${dependencyName}-${dependencyVersion}`
      }
    }
  };
}

function expectCompleteInput(input: ProjectInput, kind: InputKind): void {
  expect(input.projectRoot).toContain(`/project-`);
  expect(input.packageManifest.dependencies).toBeDefined();
  if (kind === 'no-lock') {
    expect(input.lockfile).toBeUndefined();
    expect(input.lockfileHash).toBeUndefined();
  } else {
    expect(input.lockfile).toEqual(expect.objectContaining({
      lockfileVersion: Number(kind.slice(1)) as 2 | 3,
      packages: expect.arrayContaining([
        expect.objectContaining({ path: '' }),
        expect.objectContaining({ path: expect.stringContaining('node_modules/') })
      ])
    }));
    expect(JSON.stringify(input.lockfile)).not.toContain('user:password');
  }
}

function expectCompleteResolvedGraph(resolved: ResolvedProject, inputCase: InputCase): void {
  const dependencyName = `dependency-${inputCase.id}`;
  expect(resolved.placements).toHaveLength(1);
  expect(resolved.placements[0]).toMatchObject({
    relativePath: `node_modules/${dependencyName}`,
    packageName: dependencyName
  });
  expect(resolved.packages).toHaveLength(1);
  expect(resolved.sources).toHaveLength(1);
  expect(resolved.packages[0]?.identity.name).toBe(dependencyName);
  expect(resolved.packages[0]?.identity.integrity).toBe(`sha512-${dependencyName}-1.${inputCase.dependencyMinor}.0`);
  expect(resolved.sources[0]?.resolvedLocator).toBe(
    `https://[REDACTED]@registry.example.test/${dependencyName}/-/${dependencyName}-1.${inputCase.dependencyMinor}.0.tgz`
  );
}

function graphFingerprint(resolved: ResolvedProject): string {
  return JSON.stringify({
    placements: resolved.placements,
    sources: resolved.sources.map((source) => ({
      name: source.name,
      versionOrRevision: source.versionOrRevision,
      integrity: source.integrity,
      resolvedLocator: source.resolvedLocator,
      sourceFingerprint: source.sourceFingerprint
    })),
    packages: resolved.packages.map((pkg) => ({
      identity: pkg.identity,
      identityHash: pkg.identityHash,
      manifest: pkg.manifest
    }))
  });
}
