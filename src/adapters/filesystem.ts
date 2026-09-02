export type FileType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileMetadata {
  path: string;
  type: FileType;
  size?: number;
  mode?: number;
  mtimeMs?: number;
}

export interface DirectoryEntry {
  name: string;
  type: FileType;
}

export interface RemoveOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface FileSystemAdapter {
  lstat(path: string): Promise<FileMetadata>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Create a file only when it does not already exist; required for race-free file locks. */
  createFileExclusive?(path: string, data: Uint8Array | string): Promise<boolean>;
  /** Write a complete file and atomically replace the destination. */
  writeFileAtomic(path: string, data: Uint8Array | string): Promise<void>;
  /** Flush file or directory data where the host supports it. */
  sync(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string, options?: RemoveOptions): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  listDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  createTemporaryDirectory(parent: string, prefix: string): Promise<string>;
}
