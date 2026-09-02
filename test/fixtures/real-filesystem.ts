import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DirectoryEntry, FileMetadata, FileSystemAdapter, RemoveOptions } from '../../src/adapters/filesystem.js';

/** Real POSIX filesystem adapter restricted by tests to temporary fixture paths. */
export class TemporaryFileSystem implements FileSystemAdapter {
  async lstat(path: string): Promise<FileMetadata> {
    const metadata = await lstat(path);
    const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : 'other';
    return { path: resolve(path), type, size: metadata.size, mode: metadata.mode, mtimeMs: metadata.mtimeMs };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return await readFile(path);
  }

  async readTextFile(path: string): Promise<string> {
    return await readFile(path, 'utf8');
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await writeFile(path, data);
  }

  async createFileExclusive(path: string, data: Uint8Array | string): Promise<boolean> {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw cause;
    }
  }

  async writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, data);
    try {
      await rename(temporary, path);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  async sync(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await mkdir(path, options);
  }

  async rename(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }

  async remove(path: string, options: RemoveOptions = {}): Promise<void> {
    await rm(path, { recursive: options.recursive ?? false, force: options.force ?? false });
  }

  async symlink(target: string, path: string): Promise<void> {
    await symlink(target, path);
  }

  async readlink(path: string): Promise<string> {
    return await readlink(path, 'utf8');
  }

  async realpath(path: string): Promise<string> {
    return await realpath(path);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
    }));
  }

  async createTemporaryDirectory(parent: string, prefix: string): Promise<string> {
    return await mkdtemp(join(parent, prefix));
  }

  async makeExecutable(path: string): Promise<void> {
    await chmod(path, 0o755);
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
