import { describe, expect, it } from 'vitest';
import { UnmanagedNodeModulesError, OwnershipUnknownError } from '../src/errors.js';
import {
  GENERATION_OWNERSHIP_SCHEMA_VERSION,
  GENERATION_OWNERSHIP_MARKER,
  assertNodeModulesReplaceable,
  createProjectGenerationRegistry,
  generationOwnershipMarkerPath,
  inspectNodeModulesOwnership,
  serializeGenerationOwnershipMarker,
  type RegisteredProjectGeneration
} from '../src/ownership.js';
import { createFakeFileSystem } from './fixtures/index.js';

const projectRoot = '/fixture/project';
const generationPath = '/fixture/store/projects/project-id/generations/generation-1/node_modules';
const registration: RegisteredProjectGeneration = {
  projectId: 'project-id',
  generation: 'generation-1',
  projectRoot,
  generationPath
};

function marker(overrides: Partial<RegisteredProjectGeneration> = {}): string {
  const value = { ...registration, ...overrides };
  return serializeGenerationOwnershipMarker({
    schemaVersion: GENERATION_OWNERSHIP_SCHEMA_VERSION,
    projectId: value.projectId,
    generation: value.generation,
    projectRoot: value.projectRoot
  });
}

function options(filesystem: ReturnType<typeof createFakeFileSystem>, registrations = [registration]) {
  return {
    filesystem,
    registry: createProjectGenerationRegistry(registrations),
    projectId: registration.projectId,
    projectRoot
  };
}

describe('node_modules ownership inspection', () => {
  it('allows an absent path without touching the filesystem', async () => {
    const filesystem = createFakeFileSystem('/fixture');

    await expect(assertNodeModulesReplaceable('/fixture/project/node_modules', options(filesystem)))
      .resolves.toEqual({ kind: 'absent', path: '/fixture/project/node_modules' });
  });

  it('requires both registration and a matching marker for a tool-owned generation', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory(generationPath).seedFile(generationOwnershipMarkerPath(generationPath), marker());

    await expect(inspectNodeModulesOwnership(generationPath, options(filesystem))).resolves.toMatchObject({
      kind: 'tool-owned-generation',
      registration
    });
  });

  it('recognizes a project-root symlink only when its target generation is proven', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem
      .seedDirectory(generationPath)
      .seedFile(generationOwnershipMarkerPath(generationPath), marker())
      .seedSymlink('/fixture/project/node_modules', generationPath);

    await expect(inspectNodeModulesOwnership('/fixture/project/node_modules', options(filesystem)))
      .resolves.toMatchObject({ kind: 'tool-owned-symlink', target: generationPath, registration });
  });

  it('fails closed on unmanaged directories without attempting removal', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedFile('/fixture/project/node_modules/package.json', '{"name":"user-content"}');
    const before = filesystem.snapshot();

    await expect(assertNodeModulesReplaceable('/fixture/project/node_modules', options(filesystem)))
      .rejects.toMatchObject({
        code: 'UNMANAGED_NODE_MODULES',
        context: {
          path: '/fixture/project/node_modules',
          remediation: expect.stringContaining('Move or remove it manually')
        }
      });
    expect(filesystem.snapshot()).toEqual(before);
    expect(filesystem.failures.calls('filesystem.remove')).toBe(0);
    await expect(inspectNodeModulesOwnership('/fixture/project/node_modules', options(filesystem)))
      .resolves.toMatchObject({ kind: 'unmanaged' });
  });

  it('preserves broken symlinks and reports unknown ownership', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedSymlink('/fixture/project/node_modules', '/fixture/missing-generation/node_modules');
    const before = filesystem.snapshot();

    await expect(assertNodeModulesReplaceable('/fixture/project/node_modules', options(filesystem)))
      .rejects.toBeInstanceOf(OwnershipUnknownError);
    await expect(inspectNodeModulesOwnership('/fixture/project/node_modules', options(filesystem)))
      .resolves.toMatchObject({ kind: 'broken-link', target: '/fixture/missing-generation/node_modules' });
    expect(filesystem.snapshot()).toEqual(before);
    expect(filesystem.failures.calls('filesystem.remove')).toBe(0);
  });

  it('rejects valid-looking but unregistered markers', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const unregistered = '/fixture/store/projects/other-project/generations/generation-9/node_modules';
    filesystem.seedDirectory(unregistered).seedFile(generationOwnershipMarkerPath(unregistered), marker({
      projectId: 'other-project',
      generation: 'generation-9',
      projectRoot: '/fixture/other-project',
      generationPath: unregistered
    }));

    await expect(assertNodeModulesReplaceable(unregistered, options(filesystem)))
      .rejects.toBeInstanceOf(OwnershipUnknownError);
    await expect(inspectNodeModulesOwnership(unregistered, options(filesystem)))
      .resolves.toMatchObject({ kind: 'unknown-marker' });
  });

  it('rejects marker and registry disagreement as ambiguous', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory(generationPath).seedFile(
      `${generationPath}/${GENERATION_OWNERSHIP_MARKER}`,
      marker({ generation: 'generation-other' })
    );

    await expect(assertNodeModulesReplaceable(generationPath, options(filesystem)))
      .rejects.toBeInstanceOf(OwnershipUnknownError);
    await expect(inspectNodeModulesOwnership(generationPath, options(filesystem)))
      .resolves.toMatchObject({ kind: 'ambiguous' });
  });

  it('uses unmanaged diagnostics for a symlink to an unregistered ordinary directory', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedDirectory('/fixture/user/node_modules').seedSymlink(
      '/fixture/project/node_modules',
      '/fixture/user/node_modules'
    );

    await expect(assertNodeModulesReplaceable('/fixture/project/node_modules', options(filesystem)))
      .rejects.toBeInstanceOf(UnmanagedNodeModulesError);
  });
});
