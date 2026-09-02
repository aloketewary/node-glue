import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import { NpmShim } from '../src/npm/shim.js';
import { resolveRealNpmExecutable } from '../src/npm/real-npm.js';

class RecordingProcesses implements ChildProcessAdapter {
  calls: ProcessSpec[] = [];
  result: ProcessResult = { exitCode: 0, stdout: 'delegated\n', stderr: '' };

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec);
    return this.result;
  }
}

async function fakeNpmPath(): Promise<{
  root: string;
  shimDirectory: string;
  realDirectory: string;
  npm: string;
  npx: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'node-glue-npm-integration-'));
  const shimDirectory = join(root, 'shim');
  const realDirectory = join(root, 'real');
  await mkdir(shimDirectory);
  await mkdir(realDirectory);
  const npm = join(realDirectory, 'npm');
  const npx = join(realDirectory, 'npx');
  await writeFile(join(shimDirectory, 'npm'), '# fake npm shim\n');
  await writeFile(join(shimDirectory, 'npx'), '# fake npx shim\n');
  await writeFile(npm, '# fake real npm\n');
  await writeFile(npx, '# fake real npx\n');
  for (const executable of [join(shimDirectory, 'npm'), join(shimDirectory, 'npx'), npm, npx]) {
    await chmod(executable, 0o755);
  }
  return { root, shimDirectory, realDirectory, npm, npx };
}

describe('NpmShim PATH integration', () => {
  it('discovers fake Real npm and npx outside the shim directory while preserving context and arguments', async () => {
    const paths = await fakeNpmPath();
    try {
      const processes = new RecordingProcesses();
      const events: string[] = [];
      const projectRoot = join(paths.root, 'project');
      await mkdir(projectRoot);
      const env = {
        PATH: `${paths.shimDirectory}:${paths.realDirectory}`,
        NODE_GLUE_NPM_SHIM_DIR: paths.shimDirectory,
        NODE_GLUE_TEST_VALUE: 'preserve-me'
      };
      const shim = new NpmShim({
        processes,
        shimDirectory: paths.shimDirectory,
        env,
        api: { ensureProject: async (options) => {
          events.push(`ensure:${options.projectRoot}`);
          return {
            projectRoot: options.projectRoot,
            packagesAdded: 0,
            packagesReused: 1,
            packagesRemoved: 0,
            materializationGeneration: 'generation-1'
          };
        } }
      });

      await shim.dispatch(['run', 'build', '--', '--mode', 'production value'], {
        cwd: projectRoot,
        env,
        storeDir: join(paths.root, 'store'),
        registry: 'https://registry.example.test'
      });
      await shim.dispatch(['npx', '--yes', '@scope/tool', '--flag=value'], {
        cwd: projectRoot,
        env
      });

      expect(events).toEqual([`ensure:${projectRoot}`, `ensure:${projectRoot}`]);
      expect(processes.calls).toHaveLength(2);
      expect(processes.calls[0]).toMatchObject({
        executable: await realpath(paths.npm),
        args: ['run', 'build', '--', '--mode', 'production value'],
        cwd: projectRoot,
        env,
        stdin: 'inherit',
        stdout: 'pipe',
        stderr: 'pipe'
      });
      expect(processes.calls[1]).toMatchObject({
        executable: await realpath(paths.npx),
        args: ['--yes', '@scope/tool', '--flag=value'],
        cwd: projectRoot,
        env
      });
      expect(processes.calls.map((call) => call.executable)).not.toContain(join(paths.shimDirectory, 'npm'));
      expect(processes.calls.map((call) => call.executable)).not.toContain(join(paths.shimDirectory, 'npx'));
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});

describe('Real npm discovery', () => {
  it('skips executable candidates in the shim directory and returns an absolute realpath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-glue-npm-'));
    const shimBin = join(root, 'shim');
    const realBin = join(root, 'real');
    await mkdir(shimBin);
    await mkdir(realBin);
    const shimNpm = join(shimBin, 'npm');
    const realNpm = join(realBin, 'npm');
    await writeFile(shimNpm, '#!/bin/sh\n');
    await writeFile(realNpm, '#!/bin/sh\n');
    await chmod(shimNpm, 0o755);
    await chmod(realNpm, 0o755);

    await expect(resolveRealNpmExecutable({
      pathValue: `${shimBin}:${realBin}`,
      shimDirectory: shimBin,
      env: { PATH: `${shimBin}:${realBin}` }
    })).resolves.toBe(await realpath(realNpm));
  });
});

describe('NpmShim dispatch', () => {
  it('uses lockfile-only metadata npm and ensures after a successful operation', async () => {
    const processes = new RecordingProcesses();
    const events: string[] = [];
    const shim = new NpmShim({
      processes,
      realNpm: '/real/npm',
      api: { ensureProject: async (options) => { events.push(`ensure:${options.projectRoot}`); return {
        projectRoot: options.projectRoot,
        packagesAdded: 0,
        packagesReused: 0,
        packagesRemoved: 0,
        materializationGeneration: 'generation-1'
      }; } }
    });

    const result = await shim.dispatch(['install', 'express', '--save-exact'], {
      cwd: '/workspace/project',
      storeDir: '/workspace/store',
      registry: 'https://registry.example.test'
    });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual(['ensure:/workspace/project']);
    expect(processes.calls[0]?.executable).toBe('/real/npm');
    expect(processes.calls[0]?.args).toEqual([
      'install', 'express', '--save-exact', '--package-lock-only', '--ignore-scripts'
    ]);
    expect(processes.calls[0]?.cwd).toBe('/workspace/project');
    expect(processes.calls[0]?.env).toBe(process.env);
  });

  it.each(['i', 'uninstall', 'update'])('uses lockfile-only metadata mode for %s', async (command) => {
    const processes = new RecordingProcesses();
    const events: string[] = [];
    const shim = new NpmShim({
      processes,
      realNpm: '/real/npm',
      api: { ensureProject: async (options) => { events.push(options.projectRoot); return {
        projectRoot: options.projectRoot,
        packagesAdded: 0,
        packagesReused: 0,
        packagesRemoved: 0,
        materializationGeneration: 'generation-1'
      }; } }
    });

    const result = await shim.dispatch([command, '--save-exact'], { cwd: '/workspace/project' });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual(['/workspace/project']);
    expect(processes.calls[0]?.args).toEqual([command, '--save-exact', '--package-lock-only', '--ignore-scripts']);
  });

  it('preserves a failed Real npm metadata result and does not materialize after failure', async () => {
    const processes = new RecordingProcesses();
    processes.result = { exitCode: 17, stdout: '', stderr: 'metadata failed' };
    const ensured: string[] = [];
    const shim = new NpmShim({
      processes,
      realNpm: '/real/npm',
      api: { ensureProject: async (options) => {
        ensured.push(options.projectRoot);
        return {
          projectRoot: options.projectRoot,
          packagesAdded: 0,
          packagesReused: 0,
          packagesRemoved: 0,
          materializationGeneration: 'generation-1'
        };
      } }
    });

    await expect(shim.dispatch(['install', '--dry-run'], { cwd: '/workspace/project' })).resolves.toEqual(processes.result);
    expect(ensured).toEqual([]);
    expect(processes.calls[0]?.args).toEqual(['install', '--dry-run', '--package-lock-only', '--ignore-scripts']);
  });


  it('handles ci without invoking normal npm reification and runs the cleanup hook first', async () => {
    const processes = new RecordingProcesses();
    const events: string[] = [];
    const shim = new NpmShim({
      processes,
      realNpm: '/real/npm',
      validateLockfile: async (projectRoot) => { events.push(`validate:${projectRoot}`); },
      cleanupToolOwnedLinks: async (projectRoot) => { events.push(`cleanup:${projectRoot}`); },
      api: { ensureProject: async (options) => { events.push(`ensure:${options.projectRoot}`); return {
        projectRoot: options.projectRoot,
        packagesAdded: 0,
        packagesReused: 1,
        packagesRemoved: 0,
        materializationGeneration: 'generation-2'
      }; } }
    });

    const result = await shim.dispatch(['ci'], { cwd: '/workspace/project' });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(events).toEqual(['validate:/workspace/project', 'cleanup:/workspace/project', 'ensure:/workspace/project']);
    expect(processes.calls).toEqual([]);
  });

  it('ensures before run, test, and npx while passing config/version and unknown commands unchanged', async () => {
    const processes = new RecordingProcesses();
    const events: string[] = [];
    const shim = new NpmShim({
      processes,
      realNpm: '/real/npm',
      npx: '/real/npx',
      api: { ensureProject: async (options) => { events.push(`ensure:${options.projectRoot}`); return {
        projectRoot: options.projectRoot,
        packagesAdded: 0,
        packagesReused: 0,
        packagesRemoved: 0,
        materializationGeneration: 'generation-1'
      }; } }
    });

    await shim.dispatch(['run', 'build', '--', '--mode', 'production'], { cwd: '/workspace/project' });
    await shim.dispatch(['test', '--watch'], { cwd: '/workspace/project' });
    await shim.dispatch(['npx', '--yes', 'typescript'], { cwd: '/workspace/project' });
    await shim.dispatch(['config', 'get', 'registry'], { cwd: '/workspace/project' });
    await shim.dispatch(['version', '--json'], { cwd: '/workspace/project' });
    await shim.dispatch(['help', 'install'], { cwd: '/workspace/project' });

    expect(events).toEqual([
      'ensure:/workspace/project',
      'ensure:/workspace/project',
      'ensure:/workspace/project'
    ]);
    expect(processes.calls.map((call) => [call.executable, ...call.args])).toEqual([
      ['/real/npm', 'run', 'build', '--', '--mode', 'production'],
      ['/real/npm', 'test', '--watch'],
      ['/real/npx', '--yes', 'typescript'],
      ['/real/npm', 'config', 'get', 'registry'],
      ['/real/npm', 'version', '--json'],
      ['/real/npm', 'help', 'install']
    ]);
  });
});
