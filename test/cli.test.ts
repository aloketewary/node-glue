import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { NodeGlueApi } from '../src/api.js';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import { SourceFailureError } from '../src/errors.js';
import type { GarbageCollectionResult, InstallResult, ProjectState } from '../src/types.js';

const installResult: InstallResult = {
  projectRoot: '/workspace/project',
  packagesAdded: 1,
  packagesReused: 2,
  packagesRemoved: 0,
  materializationGeneration: 'generation-1'
};
const readyState: ProjectState = {
  schemaVersion: 1,
  projectId: 'project-id',
  projectRoot: '/workspace/project',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: 'ready'
};
const gcResult: GarbageCollectionResult = {
  removedIdentityHashes: ['unused'],
  retainedIdentityHashes: ['used'],
  scannedProjects: 1
};

class RecordingProcesses implements ChildProcessAdapter {
  calls: ProcessSpec[] = [];
  result: ProcessResult = { exitCode: 0, stdout: 'child stdout\n', stderr: 'child stderr\n' };

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec);
    return this.result;
  }
}

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { output: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) }, stdout, stderr };
}

function apiFixture(events: string[] = []): NodeGlueApi {
  return {
    installProject: async (options) => { events.push(`install:${options.projectRoot}`); return installResult; },
    ensureProject: async (options) => { events.push(`ensure:${options.projectRoot}`); return installResult; },
    inspectProject: async (projectRoot) => { events.push(`inspect:${projectRoot}`); return readyState; },
    garbageCollect: async (storeDir) => { events.push(`gc:${storeDir ?? ''}`); return gcResult; }
  };
}

describe('CLI command dispatch', () => {
  it('dispatches install, ensure, doctor, and gc with structured output', async () => {
    const events: string[] = [];
    const captured = output();
    const api = apiFixture(events);

    expect(await runCli(['install', '--project-root', '/workspace/project'], { api, output: captured.output })).toBe(0);
    expect(await runCli(['ensure', '/workspace/project'], { api, output: captured.output })).toBe(0);
    expect(await runCli(['doctor', '--project-root', '/workspace/project'], { api, output: captured.output })).toBe(0);
    expect(await runCli(['gc', '--store-dir', '/workspace/store'], { api, output: captured.output })).toBe(0);

    expect(events).toEqual([
      'install:/workspace/project',
      'ensure:/workspace/project',
      'inspect:/workspace/project',
      'gc:/workspace/store'
    ]);
    expect(captured.stdout).toHaveLength(4);
    expect(captured.stdout[0]).toContain('"materializationGeneration":"generation-1"');
    expect(captured.stderr).toEqual([]);
  });

  it('ensures before exec and passes project context with separated command arguments', async () => {
    const events: string[] = [];
    const processes = new RecordingProcesses();
    const captured = output();
    const code = await runCli([
      'exec',
      '--project-root', '/workspace/project',
      '--store-dir', '/workspace/store',
      '--', 'node', '-e', 'console.log("safe")'
    ], {
      api: apiFixture(events),
      processes,
      env: { PATH: '/usr/bin', TEST_VALUE: 'present' },
      output: captured.output
    });

    expect(code).toBe(0);
    expect(events).toEqual(['ensure:/workspace/project']);
    expect(processes.calls).toEqual([{
      executable: 'node',
      args: ['-e', 'console.log("safe")'],
      cwd: '/workspace/project',
      env: {
        PATH: '/usr/bin',
        TEST_VALUE: 'present',
        NODE_GLUE_PROJECT_ROOT: '/workspace/project',
        INIT_CWD: '/workspace/project',
        NODE_GLUE_STORE_DIR: '/workspace/store'
      },
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe'
    }]);
    expect(captured.stdout).toEqual(['child stdout\n']);
    expect(captured.stderr).toEqual(['child stderr\n']);
  });

  it('renders sanitized stable diagnostics and rejects exec without a separator', async () => {
    const captured = output();
    const api: NodeGlueApi = {
      ...apiFixture(),
      ensureProject: async () => {
        throw new SourceFailureError('failed source https://user:password@example.test/pkg.tgz', {
          source: 'https://user:password@example.test/pkg.tgz',
          token: 'secret-token'
        });
      }
    };

    expect(await runCli(['exec', 'node'], { api, output: captured.output })).toBe(1);
    expect(await runCli(['ensure'], { api, output: captured.output })).toBe(1);
    expect(captured.stderr[0]).toContain('[INVALID_INPUT] exec requires "--" before the command.');
    expect(captured.stderr[1]).toContain('[SOURCE_FAILURE]');
    expect(captured.stderr[1]).not.toContain('password');
    expect(captured.stderr[1]).not.toContain('secret-token');
  });

  it('dispatches enable and disable through an injected reversible integration', async () => {
    const actions: string[] = [];
    const captured = output();
    const pathIntegration = {
      enable: async () => { actions.push('enable'); return '/home/user/.node-glue/bin'; },
      disable: async () => { actions.push('disable'); }
    };

    expect(await runCli(['enable'], { pathIntegration, output: captured.output })).toBe(0);
    expect(await runCli(['disable'], { pathIntegration, output: captured.output })).toBe(0);
    expect(actions).toEqual(['enable', 'disable']);
    expect(captured.stdout).toEqual([
      '{"command":"enable","message":"/home/user/.node-glue/bin"}\n',
      '{"command":"disable"}\n'
    ]);
  });
});
