import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakeFileSystem } from './fixtures/index.js';
import { ParseError, ProjectNotFoundError, UnsupportedLockfileError } from '../src/errors.js';
import { hashText, InputReader, SUPPORTED_LOCKFILE_VERSIONS } from '../src/input-reader.js';
import { ProjectLocator } from '../src/project.js';

function seedProject(filesystem: ReturnType<typeof createFakeFileSystem>, lockfile?: string): void {
  filesystem.seedDirectory('/fixture/project/src');
  filesystem.seedFile('/fixture/project/package.json', '{"name":"fixture-project","version":"1.0.0"}\n');
  if (lockfile !== undefined) filesystem.seedFile('/fixture/project/package-lock.json', lockfile);
}

describe('ProjectLocator', () => {
  it('finds the nearest ancestor package root and returns its canonical path', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    seedProject(filesystem);

    await expect(new ProjectLocator(filesystem).locate('/fixture/project/src')).resolves.toBe('/fixture/project');
  });

  it('reports requested directory when no project exists', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory('/fixture/other/nested');

    await expect(new ProjectLocator(filesystem).locate('/fixture/other/nested')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      context: { requestedDirectory: '/fixture/other/nested' }
    });
    await expect(new ProjectLocator(filesystem).locate('/fixture/other/nested')).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('InputReader', () => {
  it('reads and hashes package.json and an optional supported lockfile', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const packageJson = '{"name":"fixture-project","version":"1.0.0"}\n';
    const lockfile = '{"name":"fixture-project","lockfileVersion":3,"packages":{}}\n';
    seedProject(filesystem, lockfile);

    const input = await new InputReader({ filesystem }).read('/fixture/project/src');

    expect(input.projectRoot).toBe('/fixture/project');
    expect(input.packageJsonPath).toBe('/fixture/project/package.json');
    expect(input.packageJsonHash).toBe(createHash('sha256').update(packageJson).digest('hex'));
    expect(input.lockfilePath).toBe('/fixture/project/package-lock.json');
    expect(input.lockfileHash).toBe(createHash('sha256').update(lockfile).digest('hex'));
    expect(input.lockfileDocument).toEqual({ name: 'fixture-project', lockfileVersion: 3, packages: {} });
    expect(input.lockfile).toEqual({ lockfileVersion: 3, packages: [] });
  });

  it('reads package.json without requiring a lockfile', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    seedProject(filesystem);

    const input = await new InputReader({ filesystem }).read('/fixture/project');

    expect(input.packageManifest).toEqual({ name: 'fixture-project', version: '1.0.0' });
    expect(input.lockfilePath).toBeUndefined();
    expect(input.lockfileHash).toBeUndefined();
    expect(input.lockfileDocument).toBeUndefined();
  });

  it('returns project root and source path for malformed JSON', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory('/fixture/project');
    filesystem.seedFile('/fixture/project/package.json', '{"name":');

    const error = await new InputReader({ filesystem }).read('/fixture/project').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({
      code: 'PARSE_FAILURE',
      context: { projectRoot: '/fixture/project', sourcePath: '/fixture/project/package.json' }
    });
  });

  it('rejects unsupported lockfile versions with supported-version diagnostics', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    seedProject(filesystem, '{"lockfileVersion":1,"dependencies":{}}');

    const error = await new InputReader({ filesystem }).read('/fixture/project').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedLockfileError);
    expect(error).toMatchObject({
      code: 'UNSUPPORTED_LOCKFILE',
      context: {
        projectRoot: '/fixture/project',
        sourcePath: '/fixture/project/package-lock.json',
        lockfileVersion: '1',
        supportedVersions: ['2', '3']
      }
    });
  });

  it('uses deterministic SHA-256 text hashes and exposes supported lockfile versions', () => {
    expect(hashText('node-glue')).toBe(createHash('sha256').update('node-glue').digest('hex'));
    expect(SUPPORTED_LOCKFILE_VERSIONS).toEqual([2, 3]);
  });
});
