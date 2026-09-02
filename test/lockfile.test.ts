import { describe, expect, it } from 'vitest';
import { createFakeFileSystem } from './fixtures/index.js';
import { LockfileReader, LockfileWriter, normalizeLockfile } from '../src/lockfile.js';
import { hashText } from '../src/input-reader.js';
import { packageIdentityFromResolvedSource, packageIdentityHash } from '../src/package-identity.js';
import { ParseError } from '../src/errors.js';
import type { PackageManifest, ResolvedProject, ResolvedSource } from '../src/types.js';

const manifest: PackageManifest = {
  name: 'fixture-project',
  version: '1.0.0',
  dependencies: { '@scope/pkg': '^1.2.0' },
  devDependencies: { 'dev-tool': '^2.0.0' },
  optionalDependencies: { optional: '^3.0.0' },
  peerDependencies: { host: '^4.0.0' }
};

function lockfile(lockfileVersion: 2 | 3): Record<string, unknown> {
  return {
    name: 'fixture-project',
    version: '1.0.0',
    lockfileVersion,
    packages: {
      '': {
        name: 'fixture-project',
        version: '1.0.0',
        dependencies: { '@scope/pkg': '^1.2.0' },
        devDependencies: { 'dev-tool': '^2.0.0' },
        optionalDependencies: { optional: '^3.0.0' },
        peerDependencies: { host: '^4.0.0' }
      },
      'node_modules/@scope/pkg': {
        version: '1.2.3',
        resolved: 'https://user:password@registry.example.test/@scope/pkg/-/pkg-1.2.3.tgz',
        integrity: 'sha512-package-integrity',
        dependencies: { nested: '^1.0.0' },
        peerDependencies: { host: '^4.0.0' },
        peerDependenciesMeta: { host: { optional: true } },
        optional: true,
        dev: false,
        devOptional: true,
        link: false,
        bin: { 'scoped-cli': 'bin/cli.js' },
        os: ['darwin', 'linux'],
        cpu: ['arm64'],
        engines: { node: '>=20' }
      },
      'node_modules/@scope/pkg/node_modules/nested': {
        version: '1.0.1',
        resolved: 'https://registry.example.test/nested/-/nested-1.0.1.tgz'
      }
    }
  };
}

describe('LockfileReader', () => {
  it('normalizes v2 and v3 package graphs to the same representation', () => {
    const v2 = new LockfileReader().read(lockfile(2), manifest);
    const v3 = new LockfileReader().read(lockfile(3), manifest);

    expect(v2.lockfileVersion).toBe(2);
    expect(v3.lockfileVersion).toBe(3);
    expect(v2.packages).toEqual(v3.packages);
    expect(v2.packages.map((entry) => entry.path)).toEqual([
      '',
      'node_modules/@scope/pkg',
      'node_modules/@scope/pkg/node_modules/nested'
    ]);
  });

  it('preserves scoped names, dependency and peer context, flags, platform metadata, and bins', () => {
    const normalized = normalizeLockfile(lockfile(3), manifest);
    const scoped = normalized.packages.find((entry) => entry.path === 'node_modules/@scope/pkg');

    expect(scoped).toEqual({
      path: 'node_modules/@scope/pkg',
      name: '@scope/pkg',
      version: '1.2.3',
      resolved: 'https://[REDACTED]@registry.example.test/@scope/pkg/-/pkg-1.2.3.tgz',
      integrity: 'sha512-package-integrity',
      dependencies: { nested: '^1.0.0' },
      peerDependencies: { host: '^4.0.0' },
      peerDependenciesMeta: { host: { optional: true } },
      optional: true,
      dev: false,
      devOptional: true,
      link: false,
      bin: { 'scoped-cli': 'bin/cli.js' },
      os: ['darwin', 'linux'],
      cpu: ['arm64'],
      engines: { node: '>=20' }
    });
  });

  it('normalizes legacy dependency entries when a v2 document has no packages graph', () => {
    const normalized = normalizeLockfile({
      lockfileVersion: 2,
      dependencies: {
        parent: {
          version: '1.0.0',
          resolved: 'https://registry.example.test/parent.tgz',
          requires: { child: '^2.0.0' },
          dependencies: {
            child: {
              version: '2.0.1',
              resolved: 'https://registry.example.test/child.tgz'
            }
          }
        }
      }
    }, { name: 'fixture-project', version: '1.0.0' });

    expect(normalized.packages).toEqual([
      {
        path: 'node_modules/parent',
        name: 'parent',
        version: '1.0.0',
        resolved: 'https://registry.example.test/parent.tgz',
        dependencies: { child: '^2.0.0' }
      },
      {
        path: 'node_modules/parent/node_modules/child',
        name: 'child',
        version: '2.0.1',
        resolved: 'https://registry.example.test/child.tgz'
      }
    ]);
  });

  it('rejects package-lock metadata incompatible with package.json', () => {
    expect(() => normalizeLockfile({
      lockfileVersion: 3,
      name: 'different-project',
      packages: {}
    }, manifest)).toThrowError(ParseError);

    expect(() => normalizeLockfile({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture-project', version: '9.0.0' }
      }
    }, manifest)).toThrowError(ParseError);
  });

  it('never retains lockfile URL credentials in normalized persistence data', () => {
    const normalized = normalizeLockfile(lockfile(3), manifest);
    const serialized = JSON.stringify(normalized);

    expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('password');
    expect(serialized).toContain('[REDACTED]');
  });
});

function resolvedProjectForWriter(): { project: ResolvedProject; manifest: PackageManifest } {
  const packageSource: ResolvedSource = {
    source: {
      kind: 'registry',
      registry: 'https://registry.example.test',
      name: '@scope/pkg',
      spec: '^1.0.0'
    },
    name: '@scope/pkg',
    versionOrRevision: '1.2.3',
    resolvedLocator: 'https://user:password@registry.example.test/@scope/pkg/-/pkg-1.2.3.tgz',
    integrity: 'sha512-package-integrity',
    sourceFingerprint: 'registry:https://registry.example.test/@scope/pkg/-/pkg-1.2.3.tgz',
    manifest: {
      name: '@scope/pkg',
      version: '1.2.3',
      dependencies: { nested: '^2.0.0' },
      bin: { scoped: 'bin/cli.js' },
      engines: { node: '>=20' }
    }
  };
  const identity = packageIdentityFromResolvedSource(packageSource);
  const instance = {
    identity,
    identityHash: packageIdentityHash(identity),
    contentPath: '/store/content',
    manifest: packageSource.manifest!,
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
  const manifest: PackageManifest = {
    name: 'fixture-project',
    version: '1.0.0',
    dependencies: { '@scope/pkg': '^1.0.0' },
    devDependencies: { dev: '^1.0.0' }
  };
  return {
    manifest,
    project: {
      projectRoot: '/fixture/project',
      lockfileHash: 'package-json-hash',
      placements: [{
        relativePath: 'node_modules/@scope/pkg',
        packageIdentityHash: instance.identityHash,
        packageName: '@scope/pkg',
        binEntries: { scoped: 'bin/cli.js' }
      }],
      sources: [packageSource],
      packages: [instance]
    }
  };
}

describe('LockfileWriter', () => {
  it('serializes a no-lockfile resolved graph canonically and redacts locator credentials', () => {
    const { project, manifest } = resolvedProjectForWriter();
    const text = new LockfileWriter({ filesystem: createFakeFileSystem() }).serialize(project, manifest);
    const document = JSON.parse(text) as Record<string, any>;

    expect(document).toMatchObject({
      name: 'fixture-project',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true
    });
    expect(document.packages['']).toEqual({
      name: 'fixture-project',
      version: '1.0.0',
      dependencies: { '@scope/pkg': '^1.0.0' },
      devDependencies: { dev: '^1.0.0' }
    });
    expect(document.packages['node_modules/@scope/pkg']).toEqual({
      version: '1.2.3',
      resolved: 'https://[REDACTED]@registry.example.test/@scope/pkg/-/pkg-1.2.3.tgz',
      integrity: 'sha512-package-integrity',
      dependencies: { nested: '^2.0.0' },
      bin: { scoped: 'bin/cli.js' },
      engines: { node: '>=20' }
    });
    expect(text).not.toContain('password');
  });

  it('publishes generated package-lock before callers use its hash for a Project Map', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory('/fixture/project');
    const { project, manifest } = resolvedProjectForWriter();
    const publication = await new LockfileWriter({ filesystem }).publish(project, manifest);

    expect(publication.lockfilePath).toBe('/fixture/project/package-lock.json');
    const serialized = await filesystem.readTextFile(publication.lockfilePath);
    expect(publication.lockfileHash).toBe(hashText(serialized));
    expect(serialized).toBe(JSON.stringify(publication.document, null, 2) + '\n');
    expect(publication.document.lockfileVersion).toBe(3);
  });

  it('preserves an existing lockfile when atomic publication fails', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory('/fixture/project');
    filesystem.seedFile('/fixture/project/package-lock.json', '{"existing":true}\n');
    filesystem.failures.failNext('filesystem.rename');
    const { project, manifest } = resolvedProjectForWriter();

    await expect(new LockfileWriter({ filesystem }).publish(project, manifest)).rejects.toMatchObject({
      code: 'PUBLICATION_FAILURE',
      context: { projectRoot: '/fixture/project', sourcePath: '/fixture/project/package-lock.json' }
    });
    await expect(filesystem.readTextFile('/fixture/project/package-lock.json')).resolves.toBe('{"existing":true}\n');
    expect([...filesystem.snapshot().keys()].some((path) => path.includes('.node-glue-lockfile'))).toBe(false);
  });

  it('can emit the compatible v2 legacy dependency projection', () => {
    const { project, manifest } = resolvedProjectForWriter();
    const text = new LockfileWriter({
      filesystem: createFakeFileSystem(),
      lockfileVersion: 2
    }).serialize(project, manifest);
    const document = JSON.parse(text) as Record<string, any>;

    expect(document.lockfileVersion).toBe(2);
    expect(document.dependencies['@scope/pkg']).toMatchObject({
      version: '1.2.3',
      requires: { nested: '^2.0.0' }
    });
  });
});