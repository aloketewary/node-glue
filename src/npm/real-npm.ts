import { access, constants, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessAdapter, ProcessEnvironment, ProcessResult, ProcessSpec } from '../adapters/process.js';
import { InvalidInputError } from '../errors.js';

export interface RealNpmDiscoveryOptions {
  /** Environment used for PATH lookup. Defaults to process.env. */
  env?: ProcessEnvironment;
  /** The tool-owned bin directory that must never be selected. */
  shimDirectory?: string;
  /** Override the executable name for resolving npx or another npm companion. */
  executableName?: string;
  /** Explicit PATH value, primarily useful for tests. */
  pathValue?: string;
  /** Explicit executable path. It is still checked for shim recursion. */
  executablePath?: string;
}

export interface RealNpmRunOptions {
  cwd: string;
  env?: ProcessEnvironment;
  executablePath?: string;
  stdin?: ProcessSpec['stdin'];
  stdout?: ProcessSpec['stdout'];
  stderr?: ProcessSpec['stderr'];
}

/**
 * Finds an executable without invoking a shell. In particular, this does not
 * use `which`, because shell lookup can select the npm shim again.
 */
export class RealNpmResolver {
  private readonly defaults: RealNpmDiscoveryOptions;

  constructor(options: RealNpmDiscoveryOptions = {}) {
    this.defaults = options;
  }

  async resolve(options: RealNpmDiscoveryOptions = {}): Promise<string> {
    const merged = { ...this.defaults, ...options };
    const executableName = merged.executableName ?? 'npm';
    const shimDirectory = merged.shimDirectory ?? merged.env?.NODE_GLUE_NPM_SHIM_DIR
      ?? process.env.NODE_GLUE_NPM_SHIM_DIR;

    if (merged.executablePath !== undefined) {
      return await validateExecutable(merged.executablePath, executableName, shimDirectory);
    }

    const environment = merged.env ?? process.env;
    const pathValue = merged.pathValue ?? environment.PATH ?? '';
    const entries = pathValue.split(':');
    for (const entry of entries) {
      const directory = entry.length === 0 ? process.cwd() : entry;
      const candidate = resolve(directory, executableName);
      if (await isExecutable(candidate)) {
        try {
          return await validateExecutable(candidate, executableName, shimDirectory);
        } catch (cause) {
          if (cause instanceof InvalidInputError && cause.context.reason === 'shim-directory') continue;
          throw cause;
        }
      }
    }

    throw new InvalidInputError(`Unable to find Real ${executableName} on PATH.`, {
      executable: executableName,
      path: pathValue,
      ...(shimDirectory === undefined ? {} : { shimDirectory })
    });
  }
}

export async function resolveRealNpmExecutable(options: RealNpmDiscoveryOptions = {}): Promise<string> {
  return await new RealNpmResolver(options).resolve();
}

/** Alias useful to callers that prefer a verb-style discovery name. */
export const findRealNpm = resolveRealNpmExecutable;

/** Minimal native process adapter used by the npm shim when no adapter is injected. */
export class NativeProcessAdapter implements ChildProcessAdapter {
  async run(spec: ProcessSpec): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolveResult, reject) => {
      const child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env as NodeJS.ProcessEnv | undefined,
        shell: false,
        stdio: [spec.stdin ?? 'ignore', spec.stdout ?? 'pipe', spec.stderr ?? 'pipe']
      });
      let stdout = '';
      let stderr = '';
      if (child.stdout !== null) child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      if (child.stderr !== null) child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolveResult({
        exitCode,
        stdout,
        stderr,
        ...(signal === null ? {} : { signal })
      }));
    });
  }
}

export interface RealNpmRunnerOptions extends RealNpmDiscoveryOptions {
  processes?: ChildProcessAdapter;
}

/** Runs an already-discovered npm executable through the injected process seam. */
export class RealNpmRunner {
  readonly resolver: RealNpmResolver;
  private readonly processes: ChildProcessAdapter;

  constructor(options: RealNpmRunnerOptions = {}) {
    this.resolver = new RealNpmResolver(options);
    this.processes = options.processes ?? new NativeProcessAdapter();
  }

  async executable(options: RealNpmDiscoveryOptions = {}): Promise<string> {
    return await this.resolver.resolve(options);
  }

  async run(args: readonly string[], options: RealNpmRunOptions): Promise<ProcessResult> {
    const executable = options.executablePath === undefined
      ? await this.executable()
      : resolve(options.executablePath);
    return await this.processes.run({
      executable,
      args,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
      ...(options.stderr === undefined ? {} : { stderr: options.stderr })
    });
  }
}

async function validateExecutable(
  executablePath: string,
  executableName: string,
  shimDirectory: string | undefined
): Promise<string> {
  const candidate = resolve(executablePath);
  if (!(await isExecutable(candidate))) {
    throw new InvalidInputError(`Real ${executableName} executable is not executable.`, {
      executable: candidate
    });
  }

  const canonicalCandidate = await realpath(candidate).catch(() => candidate);
  if (shimDirectory !== undefined && (isInside(candidate, shimDirectory) || isInside(canonicalCandidate, shimDirectory))) {
    throw new InvalidInputError(`Refusing to invoke ${executableName} from the npm shim directory.`, {
      executable: candidate,
      reason: 'shim-directory',
      shimDirectory: resolve(shimDirectory)
    });
  }
  return canonicalCandidate;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isInside(candidate: string, directory: string): boolean {
  const candidatePath = resolve(candidate);
  const directoryPath = resolve(directory);
  const descendant = relative(directoryPath, candidatePath);
  return descendant === '' || (!descendant.startsWith('..') && !isAbsolute(descendant));
}
