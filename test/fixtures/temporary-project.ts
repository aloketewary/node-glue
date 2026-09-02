import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackageManifest } from '../../src/types.js';

export interface TemporaryProjectOptions {
  parent?: string;
  prefix?: string;
  name?: string;
  version?: string;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  packageJson?: Readonly<Record<string, unknown>>;
  lockfile?: Readonly<Record<string, unknown>>;
}

export interface TemporaryProject {
  readonly root: string;
  readonly packageJsonPath: string;
  readonly lockfilePath: string;
  readonly hasLockfile: boolean;
  cleanup(): Promise<void>;
}

/** Creates an isolated real project directory and removes it through an explicit cleanup handle. */
export async function createTemporaryProject(options: TemporaryProjectOptions = {}): Promise<TemporaryProject> {
  const parent = options.parent ?? tmpdir();
  const root = await mkdtemp(join(parent, options.prefix ?? 'node-glue-project-'));
  const packageJson: Record<string, unknown> = {
    name: options.name ?? 'fixture-project',
    version: options.version ?? '1.0.0',
    private: true,
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    ...(options.devDependencies === undefined ? {} : { devDependencies: options.devDependencies }),
    ...(options.optionalDependencies === undefined ? {} : { optionalDependencies: options.optionalDependencies }),
    ...options.packageJson
  };
  await writeJson(join(root, 'package.json'), packageJson);
  const lockfilePath = join(root, 'package-lock.json');
  if (options.lockfile !== undefined) await writeJson(lockfilePath, options.lockfile);

  let cleaned = false;
  return {
    root,
    packageJsonPath: join(root, 'package.json'),
    lockfilePath,
    hasLockfile: options.lockfile !== undefined,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function withTemporaryProject<T>(
  options: TemporaryProjectOptions,
  operation: (project: TemporaryProject) => Promise<T>
): Promise<T> {
  const project = await createTemporaryProject(options);
  try {
    return await operation(project);
  } finally {
    await project.cleanup();
  }
}

export function packageManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    name: 'fixture-package',
    version: '1.0.0',
    ...overrides
  };
}

async function writeJson(path: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
