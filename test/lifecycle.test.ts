import { describe, expect, it } from 'vitest';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import type {
  PlatformCapabilityAdapter,
  PlatformPreparationOptions,
  ProtectedExecutionContext
} from '../src/platform/index.js';
import { LifecycleRunner } from '../src/lifecycle.js';
import { CapabilityUnavailableError, ProtectedPathError } from '../src/errors.js';
import type { PackageInstance, ResolvedProject } from '../src/types.js';
import { createFakeFileSystem } from './fixtures/index.js';

class RecordingProcesses implements ChildProcessAdapter {
  readonly calls: ProcessSpec[] = [];
  result: ProcessResult = { exitCode: 0, stdout: '', stderr: '' };
  error?: Error;

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec);
    if (this.error !== undefined) throw this.error;
    return this.result;
  }
}

class RecordingPlatform implements PlatformCapabilityAdapter {
  readonly supportsProtectedPaths: boolean;
  readonly calls: PlatformPreparationOptions[] = [];
  readonly execution: ProtectedExecutionContext;
  protectedPath?: string;

  constructor(supportsProtectedPaths = true) {
    this.supportsProtectedPaths = supportsProtectedPaths;
    this.execution = {
      outputDirectory: '/fixture/project/.node-glue/lifecycle',
      protectedPaths: ['/fixture/store/packages/pkg/hash/content'],
      environment: { BASE_ENV: 'present' }
    };
  }

  async prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext> {
    this.calls.push(options);
    return {
      ...this.execution,
      outputDirectory: options.outputDirectory,
      protectedPaths: options.protectedPaths,
      environment: { ...this.execution.environment, ...options.environment }
    };
  }

  protectedPathAttempt(): string | undefined {
    return this.protectedPath;
  }
}

function packageInstance(scripts: Record<string, string>): PackageInstance {
  return {
    identity: {
      name: 'example-package',
      versionOrRevision: '1.0.0',
      source: 'registry:https://registry.example/example-package'
    },
    identityHash: 'identity-hash',
    contentPath: '/fixture/store/packages/example-package/identity-hash/content',
    manifest: { name: 'example-package', version: '1.0.0', scripts },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };
}

function project(scripts: Record<string, string>): ResolvedProject {
  return {
    projectRoot: '/fixture/project',
    lockfileHash: 'lock-hash',
    placements: [],
    sources: [],
    packages: [packageInstance(scripts)]
  };
}

describe('LifecycleRunner', () => {
  it('keeps lifecycle execution disabled by default and without an explicit allowlist', async () => {
    const processes = new RecordingProcesses();
    const platform = new RecordingPlatform();
    const filesystem = createFakeFileSystem('/fixture');
    const runner = new LifecycleRunner({ processes, filesystem, platform });

    await runner.run(project({ postinstall: 'touch generated' }));
    await runner.run(project({ postinstall: 'touch generated' }), { enabled: true });

    expect(processes.calls).toHaveLength(0);
    expect(platform.calls).toHaveLength(0);
  });

  it('runs only explicitly allowed scripts from project context with protected store paths and isolated output', async () => {
    const processes = new RecordingProcesses();
    const platform = new RecordingPlatform();
    const filesystem = createFakeFileSystem('/fixture');
    const runner = new LifecycleRunner({
      processes,
      filesystem,
      platform,
      environment: { BASE_ENV: 'present' }
    });

    await runner.run(project({ preinstall: 'before', postinstall: 'after', test: 'not lifecycle' }), {
      enabled: true,
      allowedScripts: ['example-package:postinstall'],
      outputDirectory: '/fixture/project/.node-glue/output'
    });

    expect(platform.calls).toHaveLength(1);
    expect(platform.calls[0]).toMatchObject({
      projectRoot: '/fixture/project',
      outputDirectory: '/fixture/project/.node-glue/output',
      protectedPaths: ['/fixture/store/packages/example-package/identity-hash/content']
    });
    expect(processes.calls).toHaveLength(1);
    expect(processes.calls[0]).toMatchObject({
      executable: '/bin/sh',
      args: ['-c', 'after'],
      cwd: '/fixture/project',
      protectedPaths: ['/fixture/store/packages/example-package/identity-hash/content'],
      env: {
        BASE_ENV: 'present',
        NODE_GLUE_PROJECT_ROOT: '/fixture/project',
        NODE_GLUE_LIFECYCLE_OUTPUT: '/fixture/project/.node-glue/output',
        npm_config_node_glue_lifecycle_output: '/fixture/project/.node-glue/output',
        INIT_CWD: '/fixture/project',
        npm_lifecycle_event: 'postinstall',
        npm_package_name: 'example-package'
      }
    });
  });

  it('stops before execution when protected-path capability is unavailable', async () => {
    const processes = new RecordingProcesses();
    const platform = new RecordingPlatform(false);
    const runner = new LifecycleRunner({ processes, filesystem: createFakeFileSystem('/fixture'), platform });

    await expect(runner.run(project({ postinstall: 'build' }), {
      enabled: true,
      allowedScripts: ['postinstall']
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(processes.calls).toHaveLength(0);
  });

  it('reports package, script, status, and project root when a script fails', async () => {
    const processes = new RecordingProcesses();
    processes.result = { exitCode: 17, stdout: '', stderr: 'failure' };
    const runner = new LifecycleRunner({
      processes,
      filesystem: createFakeFileSystem('/fixture'),
      platform: new RecordingPlatform()
    });

    await expect(runner.run(project({ postinstall: 'build' }), {
      enabled: true,
      allowedScripts: ['postinstall']
    })).rejects.toMatchObject({
      code: 'LIFECYCLE_FAILURE',
      context: {
        package: 'example-package',
        packageIdentityHash: 'identity-hash',
        script: 'postinstall',
        exitStatus: '17',
        projectRoot: '/fixture/project'
      }
    });
  });

  it('reports protected path attempts without treating the immutable store as project context', async () => {
    const processes = new RecordingProcesses();
    const platform = new RecordingPlatform();
    platform.protectedPath = '/fixture/store/packages/example-package/identity-hash/content';
    const runner = new LifecycleRunner({
      processes,
      filesystem: createFakeFileSystem('/fixture'),
      platform
    });

    await expect(runner.run(project({ postinstall: 'build' }), {
      enabled: true,
      allowedScripts: ['postinstall']
    })).rejects.toBeInstanceOf(ProtectedPathError);
  });

  it('wraps unexpected platform preparation failures as capability diagnostics', async () => {
    const processes = new RecordingProcesses();
    const platform: PlatformCapabilityAdapter = {
      supportsProtectedPaths: true,
      prepare: async () => {
        throw new Error('unsupported sandbox');
      }
    };
    const runner = new LifecycleRunner({ processes, filesystem: createFakeFileSystem('/fixture'), platform });

    await expect(runner.run(project({ postinstall: 'build' }), {
      enabled: true,
      allowedScripts: ['postinstall']
    })).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });
});
