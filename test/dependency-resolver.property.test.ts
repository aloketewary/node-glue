import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { DependencyResolver } from '../src/dependency-resolver.js';
import type {
  NormalizedLockfilePackage,
  PackageManifest,
  ProjectInput,
  ResolvedProject
} from '../src/types.js';
import { propertyTag } from './fixtures/property-tags.js';

interface GraphCase {
  readonly id: number;
  readonly rootMinor: number;
  readonly nestedConflictMinor: number;
  readonly directConflictMinor: number;
  readonly peerHostMinor: number;
  readonly peerConsumerMinor: number;
}

const graphCaseArbitrary = fc.record({
  id: fc.integer({ min: 0, max: 999_999 }),
  rootMinor: fc.integer({ min: 0, max: 99 }),
  nestedConflictMinor: fc.integer({ min: 0, max: 99 }),
  directConflictMinor: fc.integer({ min: 0, max: 99 }),
  peerHostMinor: fc.integer({ min: 0, max: 99 }),
  peerConsumerMinor: fc.integer({ min: 0, max: 99 })
});

describe('DependencyResolver property coverage', () => {
  it(propertyTag(2, 'resolution preserves dependency graph identity and context'), async () => {
    await fc.assert(
      fc.asyncProperty(graphCaseArbitrary, async (graphCase) => {
        const input = projectInput(graphCase);
        const resolved = await new DependencyResolver({ now: () => '2025-01-01T00:00:00.000Z' }).resolve(input);

        assertCompletePlacements(resolved, graphCase);
        assertDistinctConflictingInstances(resolved, graphCase);
        assertScopedIdentity(resolved, graphCase);
        assertPeerContext(resolved, graphCase);
      }),
      { numRuns: 100 }
    );
  });
});

function projectInput(graphCase: GraphCase): ProjectInput {
  const names = packageNames(graphCase);
  const rootManifest: PackageManifest = {
    name: 'fixture-project',
    version: '1.0.0',
    dependencies: {
      [names.scopedRoot]: '^1.0.0',
      [names.conflict]: '^2.0.0',
      [names.peerConsumer]: '^1.0.0',
      [names.peerHost]: '^1.0.0'
    }
  };
  const rootPath = `/fixture/project-${graphCase.id}`;
  const packages: NormalizedLockfilePackage[] = [
    {
      path: '',
      name: rootManifest.name,
      version: rootManifest.version,
      dependencies: rootManifest.dependencies
    },
    registryPackage(`node_modules/${names.scopedRoot}`, names.scopedRoot, `1.${graphCase.rootMinor}.0`, {
      dependencies: { [names.conflict]: '^1.0.0' }
    }),
    registryPackage(
      `node_modules/${names.scopedRoot}/node_modules/${names.conflict}`,
      names.conflict,
      `1.${graphCase.nestedConflictMinor}.0`
    ),
    registryPackage(`node_modules/${names.conflict}`, names.conflict, `2.${graphCase.directConflictMinor}.0`),
    registryPackage(
      `node_modules/${names.peerConsumer}`,
      names.peerConsumer,
      `1.${graphCase.peerConsumerMinor}.0`,
      { peerDependencies: { [names.peerHost]: '^1.0.0' } }
    ),
    registryPackage(`node_modules/${names.peerHost}`, names.peerHost, `1.${graphCase.peerHostMinor}.0`)
  ];

  return {
    projectRoot: rootPath,
    packageJsonPath: `${rootPath}/package.json`,
    packageJsonHash: `package-hash-${graphCase.id}`,
    packageManifest: rootManifest,
    lockfilePath: `${rootPath}/package-lock.json`,
    lockfileHash: `lockfile-hash-${graphCase.id}`,
    lockfile: { lockfileVersion: 3, packages }
  };
}

function registryPackage(
  path: string,
  name: string,
  version: string,
  fields: Partial<NormalizedLockfilePackage> = {}
): NormalizedLockfilePackage {
  const packageSegment = name.replace('@fixture/', '');
  return {
    path,
    name,
    version,
    resolved: `https://registry.example.test/${packageSegment}/-/${packageSegment}-${version}.tgz`,
    integrity: `sha512-${packageSegment}-${version}`,
    ...fields
  };
}

function packageNames(graphCase: GraphCase): {
  scopedRoot: string;
  conflict: string;
  peerConsumer: string;
  peerHost: string;
} {
  return {
    scopedRoot: `@fixture/root-${graphCase.id}`,
    conflict: `conflict-${graphCase.id}`,
    peerConsumer: `peer-consumer-${graphCase.id}`,
    peerHost: `peer-host-${graphCase.id}`
  };
}

function assertCompletePlacements(resolved: ResolvedProject, graphCase: GraphCase): void {
  const names = packageNames(graphCase);
  const expected = new Map([
    [`node_modules/${names.scopedRoot}`, names.scopedRoot],
    [`node_modules/${names.scopedRoot}/node_modules/${names.conflict}`, names.conflict],
    [`node_modules/${names.conflict}`, names.conflict],
    [`node_modules/${names.peerConsumer}`, names.peerConsumer],
    [`node_modules/${names.peerHost}`, names.peerHost]
  ]);
  const actual = new Map(resolved.placements.map((placement) => [placement.relativePath, placement.packageName]));

  expect(actual).toEqual(expected);
  expect(new Set(resolved.placements.map((placement) => placement.packageIdentityHash))).toEqual(
    new Set(resolved.packages.map((pkg) => pkg.identityHash))
  );
  expect(new Set(resolved.sources.map((source) => source.name))).toEqual(new Set(expected.values()));
}

function assertDistinctConflictingInstances(resolved: ResolvedProject, graphCase: GraphCase): void {
  const conflictName = packageNames(graphCase).conflict;
  const conflictPackages = resolved.packages.filter((pkg) => pkg.identity.name === conflictName);

  expect(conflictPackages).toHaveLength(2);
  expect(new Set(conflictPackages.map((pkg) => pkg.identityHash))).toHaveLength(2);
  expect(new Set(conflictPackages.map((pkg) => pkg.identity.versionOrRevision))).toEqual(
    new Set([
      `1.${graphCase.nestedConflictMinor}.0`,
      `2.${graphCase.directConflictMinor}.0`
    ])
  );
}

function assertScopedIdentity(resolved: ResolvedProject, graphCase: GraphCase): void {
  const scopedName = packageNames(graphCase).scopedRoot;
  expect(resolved.placements.some((placement) => placement.packageName === scopedName)).toBe(true);
  expect(resolved.packages.some((pkg) => pkg.identity.name === scopedName)).toBe(true);
  expect(resolved.sources.some((source) => source.name === scopedName)).toBe(true);
}

function assertPeerContext(resolved: ResolvedProject, graphCase: GraphCase): void {
  const names = packageNames(graphCase);
  const peerConsumerVersion = `1.${graphCase.peerConsumerMinor}.0`;
  const peerHostVersion = `1.${graphCase.peerHostMinor}.0`;
  const peerPlacement = resolved.placements.find((placement) => placement.packageName === names.peerConsumer);

  expect(peerPlacement).toBeDefined();
  expect(peerPlacement?.peerContext).toEqual({ [names.peerHost]: peerHostVersion });
  expect(resolved.packages.some(
    (pkg) => pkg.identity.name === names.peerConsumer && pkg.identity.versionOrRevision === peerConsumerVersion
  )).toBe(true);
}
