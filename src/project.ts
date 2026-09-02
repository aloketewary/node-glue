import { realpath as nodeRealpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import { ProjectNotFoundError } from './errors.js';

export type ProjectDiscoveryFileSystem = Pick<FileSystemAdapter, 'exists' | 'realpath'>;

const nodeProjectDiscoveryFileSystem: ProjectDiscoveryFileSystem = {
  async exists(path: string): Promise<boolean> {
    try {
      await nodeRealpath(path);
      return true;
    } catch {
      return false;
    }
  },
  realpath: nodeRealpath
};

/** Locates the nearest project root and returns its canonical absolute path. */
export class ProjectLocator {
  constructor(private readonly filesystem: ProjectDiscoveryFileSystem = nodeProjectDiscoveryFileSystem) {}

  async locate(requestedDirectory = process.cwd()): Promise<string> {
    const requestedPath = isAbsolute(requestedDirectory) ? requestedDirectory : resolve(requestedDirectory);
    let current: string;

    try {
      current = await this.filesystem.realpath(requestedPath);
    } catch (cause) {
      throw new ProjectNotFoundError(
        `Cannot locate a project from requested directory: ${requestedPath}.`,
        { requestedDirectory: requestedPath }
      );
    }

    while (true) {
      const packageJsonPath = `${current}/package.json`;
      if (await this.filesystem.exists(packageJsonPath)) {
        return current;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    throw new ProjectNotFoundError(
      `No package.json found at or above requested directory: ${requestedPath}.`,
      { requestedDirectory: requestedPath }
    );
  }
}

export async function locateProjectRoot(
  requestedDirectory = process.cwd(),
  filesystem: ProjectDiscoveryFileSystem = nodeProjectDiscoveryFileSystem
): Promise<string> {
  return new ProjectLocator(filesystem).locate(requestedDirectory);
}

export { nodeProjectDiscoveryFileSystem };
