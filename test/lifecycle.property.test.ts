import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import { CapabilityUnavailableError } from '../src/errors.js';
import { LifecycleRunner } from '../src/lifecycle.js';
import type {
  PlatformCapabilityAdapter,
  PlatformPreparationOptions,
  ProtectedExecutionContext
} from '../src/platform/index.js';
import type { PackageInstance, ResolvedProject } from '../src/types.js';
import { createFakeFileSystem, propertyTag } from './fixtures/index.js';

const lifecycleScriptNames = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
type LifecycleScriptName = (typeof lifecycleScriptNames)[number];
type ScriptOutcome = 'success' | 'protected-write';

interface LifecycleCase {
  readonly id: number;
  readonly enabled: boolean;
  readonly allowedMask: number;
  readonly unsafeOutput: boolean;
  readonly outcomes: readonly ScriptOutcome[];
}

const lifecycleCaseArbitrary: fc.Arbitrary<LifecycleCase> = fc.record({
  id: fc.integer({ min: 0, max: 999_999 }),
  enabled: fc.boolean(),
  allowedMask: fc.integer({ min: 0, max: 15 }),
  unsafeOutput: fc.boolean(),
  outcomes: fc.array(fc.constantFrom<ScriptOutcome>('success', 'protected-write'), {
    minLength: lifecycleScriptNames.length,
    maxLength: lifecycleScriptNames.length
  })
});

class RecordingProcesses implements ChildProcessAdapter {
  readonly calls: ProcessSpec[] = [];

  constructor(private readonly outcomes: ReadonlyMap<string, ScriptOutcome>) {}

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec);
    const command = spec.args[1] ?? '';
    const outcome = this.outcomes.get(command);
    return {
      exitCode: 0,
      stdout: outcome === 'protected-write' ? `protected:${spec.protectedPaths?.[0] ?? ''}` : '',
      stderr: ''
    };
  }
}

class IsolationPlatform implements PlatformCapabilityAdapter {
  readonly supportsProtectedPaths = true;
  readonly calls: PlatformPreparationOptions[] = [];

  async prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext> {
    this.calls.push(options);
    const protectedOutput = options.protectedPaths.find((protectedPath) =>
      options.outputDirectory === protectedPath || options.outputDirectory.startsWith(`${protectedPath}/`)
    );
    if (protectedOutput !== undefined) {
      throw new CapabilityUnavailableError(
        'Lifecycle output cannot be inside an immutable package-store path.',
        { capability: 'isolated-output', operation: 'lifecycle', outputDirectory: options.outputDirectory }
      );
    }

    return {
      outputDirectory: options.outputDirectory,
      protectedPaths: options.protectedPaths,
      environment: options.environment ?? {}
    };
  }

  protectedPathAttempt(result: ProcessResult): string | undefined {
    return result.stdout.startsWith('protected:') ? result.stdout.slice('protected:'.length) : undefined;
  }
}

describe('LifecycleRunner property coverage', () => {
  it(propertyTag(11, 'Explicit lifecycle execution remains isolated'), async () => {
    await fc.assert(
      fc.asyncProperty(lifecycleCaseArbitrary, async (lifecycleCase) => {
        const projectRoot = `/fixture/project-${lifecycleCase.id}`;
        const storeContentPath = `/fixture/store/packages/example-package-${lifecycleCase.id}/identity-hash/content`;
        const scripts = new Map<LifecycleScriptName, string>(
          lifecycleScriptNames.map((scriptName) => [
            scriptName,
            `fixture-${lifecycleCase.id}-${scriptName}`
          ])
        );
        const outcomes = new Map(
          lifecycleScriptNames.map((scriptName, index) => [
            scripts.get(scriptName) as string,
            lifecycleCase.outcomes[index] as ScriptOutcome
          ])
        );
        const allowedScripts = lifecycleScriptNames.filter((_, index) =>
          (lifecycleCase.allowedMask & (1 << index)) !== 0
        );
        const outputDirectory = lifecycleCase.unsafeOutput
          ? storeContentPath
          : `${projectRoot}/.node-glue/lifecycle/output-${lifecycleCase.id}`;
        const processes = new RecordingProcesses(outcomes);
        const platform = new IsolationPlatform();
        const runner = new LifecycleRunner({
          processes,
          filesystem: createFakeFileSystem('/fixture'),
          platform,
          environment: { FIXTURE_ENVIRONMENT: 'present' }
        });
        const resolvedProject = lifecycleProject(
          projectRoot,
          storeContentPath,
          scripts
        );

        // Default and explicitly disabled policies never invoke lifecycle processes.
        await runner.run(resolvedProject);
        await runner.run(resolvedProject, { enabled: false, allowedScripts });
        expect(processes.calls).toHaveLength(0);
        expect(platform.calls).toHaveLength(0);

        const permitted = lifecycleScriptNames.filter((scriptName) => allowedScripts.includes(scriptName));
        if (!lifecycleCase.enabled || permitted.length === 0) {
          await runner.run(resolvedProject, {
            enabled: lifecycleCase.enabled,
            allowedScripts,
            outputDirectory
          });
          expect(processes.calls).toHaveLength(0);
          expect(platform.calls).toHaveLength(0);
          return;
        }

        const firstProtectedIndex = permitted.findIndex((scriptName) =>
          outcomes.get(scripts.get(scriptName) as string) === 'protected-write'
        );
        const expectedCalls = firstProtectedIndex === -1
          ? permitted
          : permitted.slice(0, firstProtectedIndex + 1);
        const run = runner.run(resolvedProject, {
          enabled: true,
          allowedScripts,
          outputDirectory
        });

        if (lifecycleCase.unsafeOutput) {
          await expect(run).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
          expect(processes.calls).toHaveLength(0);
          expect(platform.calls).toHaveLength(1);
          return;
        }

        if (firstProtectedIndex !== -1) {
          await expect(run).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
        } else {
          await run;
        }

        expect(processes.calls.map((call) => call.args[1])).toEqual(
          expectedCalls.map((scriptName) => scripts.get(scriptName))
        );
        expect(platform.calls).toHaveLength(1);
        expect(platform.calls[0]?.protectedPaths).toEqual([storeContentPath]);
        expect(platform.calls[0]?.outputDirectory).not.toBe(storeContentPath);
        expect(platform.calls[0]?.outputDirectory.startsWith(storeContentPath)).toBe(false);

        for (const call of processes.calls) {
          expect(call.cwd).toBe(projectRoot);
          expect(call.protectedPaths).toEqual([storeContentPath]);
          expect(call.env?.NODE_GLUE_PROJECT_ROOT).toBe(projectRoot);
          expect(call.env?.NODE_GLUE_LIFECYCLE_OUTPUT).toBe(outputDirectory);
          expect(call.env?.npm_config_node_glue_lifecycle_output).toBe(outputDirectory);
          expect(call.env?.INIT_CWD).toBe(projectRoot);
          expect(call.env?.npm_package_name).toBe(`example-package-${lifecycleCase.id}`);
        }
      }),
      { numRuns: 100 }
    );
  });
});

function lifecycleProject(
  projectRoot: string,
  contentPath: string,
  scripts: ReadonlyMap<LifecycleScriptName, string>
): ResolvedProject {
  const packageName = projectRoot.slice(projectRoot.lastIndexOf('/') + 1).replace('project-', 'example-package-');
  const manifestScripts: Record<string, string> = Object.fromEntries(scripts);
  manifestScripts.test = 'not-an-install-lifecycle-script';
  const packageInstance: PackageInstance = {
    identity: {
      name: packageName,
      versionOrRevision: '1.0.0',
      source: `registry:https://registry.example.test/${packageName}`
    },
    identityHash: 'identity-hash',
    contentPath,
    manifest: { name: packageName, version: '1.0.0', scripts: manifestScripts },
    verifiedAt: '2025-01-01T00:00:00.000Z'
  };

  return {
    projectRoot,
    lockfileHash: 'lock-hash',
    placements: [],
    sources: [],
    packages: [packageInstance]
  };
}
