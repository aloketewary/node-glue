import { describe, expect, it } from 'vitest';
import { DependencyResolver, type ArboristAdapter, type ResolverTree } from '../src/dependency-resolver.js';
import type { NormalizedLockfilePackage, PackageManifest, ProjectInput } from '../src/types.js';

const projectManifest: PackageManifest = {
  name: 'fixture-project',
  version: '1.0.0',
  dependencies: {
    '@fixture/root': '^1.0.0',
    dep: '^2.0.0',
    'peer-consumer': '^1.0.0',
    'peer-host': '^1.0.0'
  },
  optionalDependencies: { 'optional-native': '*' }
};

function input(lockfilePackages?: readonly NormalizedLockfilePackage[]): ProjectInput {
  return {
    projectRoot: '/fixture/project',
    packageJsonPath: '/fixture/project/package.json',
    packageJsonHash: 'package-hash',
    packageManifest: projectManifest,
    ...(lockfilePackages === undefined ? {} : {
      lockfilePath: '/fixture/project/package-lock.json',
      lockfileHash: 'lockfile-hash',
      lockfile: { lockfileVersion: 3 as const, packages: lockfilePackages }
    })
  };
}

function registryPackage(
  path: string,
  name: string,
  version: string,
  fields: Partial<NormalizedLockfilePackage> = {}
): NormalizedLockfilePackage {
  return {
    path,
    name,
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.replace('@fixture/', '')}-${version}.tgz`,
    ...fields
  };
}

function lockfileGraph(): readonly NormalizedLockfilePackage[] {
  return [
    {
      path: '',
      name: projectManifest.name,
      version: projectManifest.version,
      dependencies: projectManifest.dependencies,
      optionalDependencies: projectManifest.optionalDependencies
    },
    registryPackage('node_modules/@fixture/root', '@fixture/root', '1.2.0', {
      dependencies: { dep: '^1.0.0' }
    }),
    registryPackage('node_modules/@fixture/root/node_modules/dep', 'dep', '1.4.0'),
    registryPackage('node_modules/dep', 'dep', '2.3.0'),
    registryPackage('node_modules/peer-host', 'peer-host', '1.5.0'),
    registryPackage('node_modules/peer-consumer', 'peer-consumer', '1.0.0', {
      peerDependencies: { 'peer-host': '^1.0.0' }
    }),
    registryPackage('node_modules/optional-native', 'optional-native', '1.0.0', {
      optional: true,
      os: ['win32']
    })
  ];
}

describe('DependencyResolver', () => {
  it('preserves complete lockfile placements, scoped names, multiple versions, and peer context', async () => {
    const resolved = await new DependencyResolver({ now: () => '2025-01-01T00:00:00.000Z' }).resolve(input(lockfileGraph()));

    expect(resolved.lockfileHash).toBe('lockfile-hash');
    expect(resolved.placements.map((placement) => placement.relativePath)).toEqual([
      'node_modules/@fixture/root',
      'node_modules/@fixture/root/node_modules/dep',
      'node_modules/dep',
      'node_modules/peer-consumer',
      'node_modules/peer-host'
    ]);
    expect(resolved.placements.find((placement) => placement.packageName === 'peer-consumer')?.peerContext)
      .toEqual({ 'peer-host': '1.5.0' });
    expect(resolved.packages.filter((pkg) => pkg.identity.name === 'dep')).toHaveLength(2);
    expect(resolved.placements.some((placement) => placement.packageName === 'optional-native')).toBe(false);
    expect(resolved.sources.every((source) => source.manifest !== undefined)).toBe(true);
    expect(resolved.sources.find((source) => source.name === '@fixture/root')?.source.kind).toBe('registry');
  });

  it('uses Arborist only through the injected ideal-tree adapter for no-lockfile projects', async () => {
    let buildCalls = 0;
    let loadCalls = 0;
    const child: ResolverTree['root'] = {
      name: 'direct',
      version: '1.0.0',
      location: 'node_modules/direct',
      resolved: 'https://registry.npmjs.org/direct/-/direct-1.0.0.tgz',
      package: { name: 'direct', version: '1.0.0' }
    };
    const adapter: ArboristAdapter = {
      async loadVirtual() {
        loadCalls += 1;
        return { inventory: [] };
      },
      async buildIdealTree() {
        buildCalls += 1;
        return {
          root: {
            name: 'fixture-project',
            version: '1.0.0',
            location: '',
            package: { ...projectManifest },
            edgesOut: new Map([['direct', { name: 'direct', spec: '^1.0.0', type: 'prod', to: child }]])
          },
          inventory: new Map([
            ['', {
              name: 'fixture-project',
              version: '1.0.0',
              location: '',
              package: { ...projectManifest },
              edgesOut: new Map([['direct', { name: 'direct', spec: '^1.0.0', type: 'prod', to: child }]])
            }],
            ['node_modules/direct', child]
          ])
        };
      }
    };

    const resolved = await new DependencyResolver({ arborist: adapter }).resolve(input());

    expect(buildCalls).toBe(1);
    expect(loadCalls).toBe(0);
    expect(resolved.lockfileHash).toBe('package-hash');
    expect(resolved.placements).toMatchObject([{ relativePath: 'node_modules/direct', packageName: 'direct' }]);
  });

  it('reports unsatisfied constraints with package, range, and graph path context', async () => {
    const packages = [
      {
        path: '',
        name: projectManifest.name,
        version: projectManifest.version,
        dependencies: { dep: '^2.0.0' }
      },
      registryPackage('node_modules/dep', 'dep', '1.0.0')
    ] as const;

    await expect(new DependencyResolver().resolve(input(packages))).rejects.toMatchObject({
      code: 'RESOLUTION_CONFLICT',
      context: {
        packageName: 'dep',
        range: '^2.0.0',
        graphPaths: expect.arrayContaining([''])
      }
    });
  });
});
