import { resolve } from 'node:path';
import { createNodeGlueApi, type NodeGlueApi } from '../api.js';
import { NodeGlueError, sanitizeDiagnosticContext } from '../errors.js';
import type { ChildProcessAdapter, ProcessEnvironment, ProcessResult } from '../adapters/process.js';
import type { EnsureProjectOptions } from '../types.js';
import { NativeProcessAdapter, RealNpmRunner } from './real-npm.js';

const METADATA_COMMANDS = new Set(['install', 'i', 'uninstall', 'update']);
const ENSURE_COMMANDS = new Set(['run', 'test']);
const PASSTHROUGH_COMMANDS = new Set(['config', 'version']);

export interface NpmShimOptions {
  api?: Pick<NodeGlueApi, 'ensureProject'> & Partial<Pick<NodeGlueApi, 'inspectProject'>>;
  processes?: ChildProcessAdapter;
  realNpm?: string;
  npx?: string;
  cwd?: string;
  env?: ProcessEnvironment;
  projectRoot?: string;
  storeDir?: string;
  registry?: string;
  shimDirectory?: string;
  /** Hook for CI integrations to validate package.json/package-lock.json first. */
  validateLockfile?: (projectRoot: string) => Promise<void>;
  /** Hook for CI integrations that need to remove proven tool-owned links first. */
  cleanupToolOwnedLinks?: (projectRoot: string) => Promise<void>;
  /** Alias for cleanupToolOwnedLinks, retained for adapter-friendly callers. */
  prepareCi?: (projectRoot: string) => Promise<void>;
}

export interface NpmShimDispatchOptions {
  cwd?: string;
  env?: ProcessEnvironment;
  projectRoot?: string;
  storeDir?: string;
  registry?: string;
}

/**
 * npm-compatible command dispatcher. Node Glue owns acquisition and
 * materialization; Real npm remains responsible for npm's metadata semantics.
 */
export class NpmShim {
  private readonly options: NpmShimOptions;
  private readonly runner: RealNpmRunner;
  private readonly processes: ChildProcessAdapter;

  constructor(options: NpmShimOptions = {}) {
    this.options = options;
    this.processes = options.processes ?? new NativeProcessAdapter();
    this.runner = new RealNpmRunner({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.shimDirectory === undefined ? {} : { shimDirectory: options.shimDirectory }),
      processes: this.processes
    });
  }

  async dispatch(args: readonly string[] = [], options: NpmShimDispatchOptions = {}): Promise<ProcessResult> {
    const cwd = resolve(options.cwd ?? this.options.cwd ?? process.cwd());
    const env = options.env ?? this.options.env ?? process.env;
    const projectRoot = resolve(options.projectRoot ?? this.options.projectRoot ?? cwd);
    const command = args[0]?.toLowerCase();
    const repositoryOptions = this.repositoryOptions(projectRoot, options);

    if (command === 'ci') {
      await this.validateLockfile(projectRoot);
      await this.prepareCi(projectRoot);
      await this.ensure(repositoryOptions);
      // npm ci has no Real npm phase: normal npm reification is deliberately
      // bypassed so the resulting tree remains Node Glue's exact tree.
      return successResult();
    }

    if (command !== undefined && (METADATA_COMMANDS.has(command))) {
      const result = await this.delegateMetadata(args, cwd, env);
      if (result.exitCode !== 0) return result;
      await this.ensure(repositoryOptions);
      return result;
    }

    if (command !== undefined && ENSURE_COMMANDS.has(command)) {
      await this.ensure(repositoryOptions);
      return await this.delegateNpm(args, cwd, env);
    }

    if (command === 'npx') {
      await this.ensure(repositoryOptions);
      return await this.delegateNpx(args.slice(1), cwd, env);
    }

    // config, version, and unknown commands are passed through untouched. This
    // avoids silently changing commands whose npm semantics are not modeled.
    if (command === undefined || PASSTHROUGH_COMMANDS.has(command) || !METADATA_COMMANDS.has(command)) {
      return await this.delegateNpm(args, cwd, env);
    }

    return await this.delegateNpm(args, cwd, env);
  }

  async run(args: readonly string[] = [], options: NpmShimDispatchOptions = {}): Promise<ProcessResult> {
    return await this.dispatch(args, options);
  }

  private async delegateMetadata(
    args: readonly string[],
    cwd: string,
    env: ProcessEnvironment
  ): Promise<ProcessResult> {
    const metadataArgs = [...args];
    appendFlag(metadataArgs, '--package-lock-only');
    appendFlag(metadataArgs, '--ignore-scripts');
    return await this.delegateNpm(metadataArgs, cwd, env);
  }

  private async delegateNpm(
    args: readonly string[],
    cwd: string,
    env: ProcessEnvironment
  ): Promise<ProcessResult> {
    const executable = this.options.realNpm ?? await this.runner.executable({
      env,
      ...(this.options.shimDirectory === undefined ? {} : { shimDirectory: this.options.shimDirectory })
    });
    return await this.runner.run(args, { cwd, env, executablePath: executable, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
  }

  private async delegateNpx(
    args: readonly string[],
    cwd: string,
    env: ProcessEnvironment
  ): Promise<ProcessResult> {
    const executable = this.options.npx ?? await this.runner.executable({
      env,
      executableName: 'npx',
      ...(this.options.shimDirectory === undefined ? {} : { shimDirectory: this.options.shimDirectory })
    });
    return await this.runner.run(args, { cwd, env, executablePath: executable, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
  }

  private async ensure(options: EnsureProjectOptions): Promise<void> {
    const api = this.options.api ?? createNodeGlueApi(
      options.storeDir === undefined
        ? {}
        : { packageStoreOptions: { storeDir: options.storeDir } }
    );
    await api.ensureProject(options);
  }

  private async validateLockfile(projectRoot: string): Promise<void> {
    if (this.options.validateLockfile !== undefined) {
      await this.options.validateLockfile(projectRoot);
      return;
    }
    // The real API's read path parses and validates package-lock.json. This
    // read-only check happens before CI cleanup; ensure repeats it under its
    // project lock before acquisition and publication.
    if (this.options.api?.inspectProject !== undefined) {
      await this.options.api.inspectProject(projectRoot);
    }
  }

  private async prepareCi(projectRoot: string): Promise<void> {
    const cleanup = this.options.cleanupToolOwnedLinks ?? this.options.prepareCi;
    if (cleanup !== undefined) await cleanup(projectRoot);
  }

  private repositoryOptions(projectRoot: string, options: NpmShimDispatchOptions): EnsureProjectOptions {
    const storeDir = options.storeDir ?? this.options.storeDir;
    const registry = options.registry ?? this.options.registry;
    return {
      projectRoot,
      ...(storeDir === undefined ? {} : { storeDir }),
      ...(registry === undefined ? {} : { registry })
    };
  }
}

export async function dispatchNpmShim(
  args: readonly string[] = [],
  options: NpmShimOptions = {}
): Promise<ProcessResult> {
  return await new NpmShim(options).dispatch(args);
}

/** Convenience entry point for a bin wrapper; returns the delegated exit code. */
export async function runNpmShim(
  args: readonly string[] = process.argv.slice(2),
  options: NpmShimOptions = {}
): Promise<number> {
  try {
    const result = await dispatchNpmShim(args, options);
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    return result.exitCode ?? 1;
  } catch (cause) {
    process.stderr.write(`${formatShimDiagnostic(cause)}\n`);
    return 1;
  }
}

function formatShimDiagnostic(cause: unknown): string {
  if (cause instanceof NodeGlueError) {
    return formatShimDiagnosticRecord(cause.code, cause.message, cause.context);
  }
  if (cause instanceof Error) return formatShimDiagnosticRecord('INVALID_INPUT', cause.message, {});
  return formatShimDiagnosticRecord('INVALID_INPUT', String(cause), {});
}

function formatShimDiagnosticRecord(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>
): string {
  const safeContext = sanitizeDiagnosticContext(context as Record<string, string | number | boolean | readonly string[] | undefined>);
  const fields = Object.entries(safeContext)
    .filter((entry): entry is [string, string | number | boolean | readonly string[]] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`);
  return `[${code}] ${sanitizeShimMessage(message)}${fields.length === 0 ? '' : ` (${fields.join(' ')})`}`;
}

function sanitizeShimMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)([^\/@\s]+):([^\/@\s]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|secret|password|passwd|authorization|api[-_]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

function appendFlag(args: string[], flag: string): void {
  if (!args.some((argument) => argument === flag)) args.push(flag);
}

function successResult(): ProcessResult {
  return { exitCode: 0, stdout: '', stderr: '' };
}
