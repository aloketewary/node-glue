import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { ProcessEnvironment, ProcessResult } from '../adapters/process.js';
import { CapabilityUnavailableError } from '../errors.js';

export interface PlatformPreparationOptions {
  projectRoot: string;
  outputDirectory: string;
  protectedPaths: readonly string[];
  environment?: ProcessEnvironment;
}

/**
 * Execution context prepared outside the immutable package store.
 * Child-process adapters must enforce protectedPaths as read-only boundaries.
 */
export interface ProtectedExecutionContext {
  readonly outputDirectory: string;
  readonly protectedPaths: readonly string[];
  readonly environment: ProcessEnvironment;
}

/** Platform seam for protection and project-context output preparation. */
export interface PlatformCapabilityAdapter {
  /** Whether the child-process boundary can enforce protectedPaths. */
  readonly supportsProtectedPaths: boolean;
  prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext>;
  /** Optional process-result inspection for adapters that report protected writes. */
  protectedPathAttempt?(result: ProcessResult): string | undefined;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function normalizePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => normalize(resolve(path))))];
}

/**
 * macOS/Linux capability implementation. Read-only enforcement is delegated to
 * the injected child-process adapter through ProcessSpec.protectedPaths; this
 * adapter refuses execution when that boundary is unavailable.
 */
export class PosixPlatformCapabilities implements PlatformCapabilityAdapter {
  readonly supportsProtectedPaths = true;

  constructor(private readonly filesystem: FileSystemAdapter) {}

  async prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new CapabilityUnavailableError(
        'Lifecycle execution requires macOS or Linux protected-path support.',
        { capability: 'protected-paths', operation: 'lifecycle', platform: process.platform }
      );
    }

    const projectRoot = normalize(resolve(options.projectRoot));
    const outputDirectory = normalize(resolve(options.outputDirectory));
    const protectedPaths = normalizePaths(options.protectedPaths);

    if (!isAbsolute(projectRoot) || !isAbsolute(outputDirectory)) {
      throw new CapabilityUnavailableError(
        'Lifecycle project and output paths must be absolute.',
        { capability: 'absolute-project-context', operation: 'lifecycle' }
      );
    }

    const protectedStorePath = protectedPaths.find((path) => isWithin(path, outputDirectory));
    if (protectedStorePath !== undefined) {
      throw new CapabilityUnavailableError(
        'Lifecycle output cannot be inside an immutable package-store path.',
        { capability: 'isolated-output', operation: 'lifecycle', outputDirectory, protectedPath: protectedStorePath }
      );
    }

    await this.filesystem.mkdir(outputDirectory, { recursive: true });
    return {
      outputDirectory,
      protectedPaths,
      environment: {
        ...options.environment,
        NODE_GLUE_PROJECT_ROOT: projectRoot,
        NODE_GLUE_LIFECYCLE_OUTPUT: outputDirectory,
        npm_config_node_glue_lifecycle_output: outputDirectory
      }
    };
  }
}

/** Compatibility name for callers that prefer an adapter-oriented name. */
export class NodePlatformCapabilityAdapter extends PosixPlatformCapabilities {}
