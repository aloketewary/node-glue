import { createHash } from 'node:crypto';
import { readFile as nodeReadFile, realpath as nodeRealpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import { ParseError, UnsupportedLockfileError } from './errors.js';
import { locateProjectRoot, type ProjectDiscoveryFileSystem } from './project.js';
import { LockfileReader } from './lockfile.js';
import type { JsonObject, PackageManifest, ProjectInput } from './types.js';

export type ProjectInputFileSystem = Pick<FileSystemAdapter, 'exists' | 'realpath' | 'readTextFile'>;

const nodeProjectInputFileSystem: ProjectInputFileSystem = {
  async exists(path: string): Promise<boolean> {
    try {
      await nodeRealpath(path);
      return true;
    } catch {
      return false;
    }
  },
  realpath: nodeRealpath,
  async readTextFile(path: string): Promise<string> {
    return nodeReadFile(path, 'utf8');
  }
};

export const SUPPORTED_LOCKFILE_VERSIONS = [2, 3] as const;

export interface ReadProjectInputOptions {
  filesystem?: ProjectInputFileSystem;
  locator?: ProjectLocatorLike;
}

export interface ProjectLocatorLike {
  locate(requestedDirectory?: string): Promise<string>;
}

/** Reads project metadata and normalizes a supported lockfile dependency graph. */
export class InputReader {
  private readonly filesystem: ProjectInputFileSystem;
  private readonly locator: ProjectLocatorLike;

  constructor(options: ReadProjectInputOptions = {}) {
    this.filesystem = options.filesystem ?? nodeProjectInputFileSystem;
    this.locator = options.locator ?? {
      locate: (requestedDirectory?: string) =>
        locateProjectRoot(requestedDirectory, this.filesystem satisfies ProjectDiscoveryFileSystem)
    };
  }

  async read(requestedDirectory = process.cwd()): Promise<ProjectInput> {
    const projectRoot = await this.locator.locate(requestedDirectory);
    return this.readRoot(projectRoot);
  }

  async readRoot(projectRoot: string): Promise<ProjectInput> {
    const canonicalRoot = await this.canonicalizeRoot(projectRoot);
    const packageJsonPath = join(canonicalRoot, 'package.json');
    const packageJsonText = await this.readSource(canonicalRoot, packageJsonPath);
    const packageJsonHash = hashText(packageJsonText);
    const packageManifest = parseJsonObject<PackageManifest>(packageJsonText, canonicalRoot, packageJsonPath, 'package.json');

    const lockfilePath = join(canonicalRoot, 'package-lock.json');
    if (!(await this.filesystem.exists(lockfilePath))) {
      return {
        projectRoot: canonicalRoot,
        packageJsonPath,
        packageJsonHash,
        packageManifest
      };
    }

    const lockfileText = await this.readSource(canonicalRoot, lockfilePath);
    const lockfileHash = hashText(lockfileText);
    const lockfileDocument = parseJsonObject<JsonObject>(lockfileText, canonicalRoot, lockfilePath, 'package-lock.json');
    validateLockfileVersion(lockfileDocument, canonicalRoot, lockfilePath);

    const lockfile = new LockfileReader().read(lockfileDocument, packageManifest, {
      projectRoot: canonicalRoot,
      sourcePath: lockfilePath
    });

    return {
      projectRoot: canonicalRoot,
      packageJsonPath,
      packageJsonHash,
      packageManifest,
      lockfilePath,
      lockfileHash,
      lockfileDocument,
      lockfile
    };
  }

  private async canonicalizeRoot(projectRoot: string): Promise<string> {
    try {
      return await this.filesystem.realpath(resolve(projectRoot));
    } catch (cause) {
      throw new ParseError(
        `Cannot read project input because Project Root cannot be canonicalized: ${projectRoot}.`,
        { projectRoot, sourcePath: projectRoot },
        cause
      );
    }
  }

  private async readSource(projectRoot: string, sourcePath: string): Promise<string> {
    try {
      return await this.filesystem.readTextFile(sourcePath);
    } catch (cause) {
      throw new ParseError(
        `Cannot read project input source: ${sourcePath}.`,
        { projectRoot, sourcePath },
        cause
      );
    }
  }
}

export async function readProjectInput(
  requestedDirectory = process.cwd(),
  options: ReadProjectInputOptions = {}
): Promise<ProjectInput> {
  return new InputReader(options).read(requestedDirectory);
}

export function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJsonObject<T>(
  text: string,
  projectRoot: string,
  sourcePath: string,
  sourceName: string
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ParseError(
      `Cannot parse ${sourceName} for Project Root ${projectRoot}.`,
      { projectRoot, sourcePath },
      cause
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ParseError(
      `${sourceName} must contain a JSON object for Project Root ${projectRoot}.`,
      { projectRoot, sourcePath }
    );
  }

  return parsed as T;
}

function validateLockfileVersion(lockfile: JsonObject, projectRoot: string, sourcePath: string): void {
  const version = lockfile.lockfileVersion;
  if (version === 2 || version === 3) return;

  const renderedVersion = typeof version === 'string' || typeof version === 'number' ? String(version) : 'missing';
  throw new UnsupportedLockfileError(
    `Unsupported package-lock.json version ${renderedVersion}. Supported versions: ${SUPPORTED_LOCKFILE_VERSIONS.join(', ')}.`,
    {
      projectRoot,
      sourcePath,
      lockfileVersion: renderedVersion,
      supportedVersions: SUPPORTED_LOCKFILE_VERSIONS.map(String)
    }
  );
}

export { nodeProjectInputFileSystem };
