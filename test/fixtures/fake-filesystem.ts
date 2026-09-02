import { posix } from 'node:path';
import type {
  DirectoryEntry,
  FileMetadata,
  FileSystemAdapter,
  RemoveOptions
} from '../../src/adapters/filesystem.js';
import { FailureInjector } from './failure-injection.js';

type MemoryEntry =
  | { type: 'file'; data: Uint8Array; mode?: number }
  | { type: 'directory'; mode?: number }
  | { type: 'symlink'; target: string };

function cloneBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}

/** In-memory filesystem implementing the production filesystem seam. */
export class FakeFileSystem implements FileSystemAdapter {
  readonly failures: FailureInjector;
  private readonly entries = new Map<string, MemoryEntry>();
  private temporaryCounter = 0;
  readonly root: string;

  constructor(root = '/fixture', failures = new FailureInjector()) {
    this.root = this.normalize(root);
    this.failures = failures;
    this.entries.set(this.root, { type: 'directory' });
  }

  async lstat(path: string): Promise<FileMetadata> {
    this.failures.check('filesystem.lstat');
    const normalized = this.normalize(path);
    const entry = this.requireEntry(normalized);
    return {
      path: normalized,
      type: entry.type,
      ...(entry.type === 'file' ? { size: entry.data.byteLength } : {})
    };
  }

  async exists(path: string): Promise<boolean> {
    this.failures.check('filesystem.exists');
    return this.entries.has(this.normalize(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.failures.check('filesystem.readFile');
    const entry = this.resolveFile(this.normalize(path));
    return new Uint8Array(entry.data);
  }

  async readTextFile(path: string): Promise<string> {
    this.failures.check('filesystem.readTextFile');
    const entry = this.resolveFile(this.normalize(path));
    return new TextDecoder().decode(entry.data);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.failures.check('filesystem.writeFile');
    const normalized = this.normalize(path);
    this.requireParent(normalized);
    this.entries.set(normalized, { type: 'file', data: cloneBytes(data) });
  }

  async createFileExclusive(path: string, data: Uint8Array | string): Promise<boolean> {
    this.failures.check('filesystem.createFileExclusive');
    const normalized = this.normalize(path);
    this.requireParent(normalized);
    if (this.entries.has(normalized)) return false;
    this.entries.set(normalized, { type: 'file', data: cloneBytes(data) });
    return true;
  }

  async writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
    this.failures.check('filesystem.writeFileAtomic');
    const normalized = this.normalize(path);
    this.requireParent(normalized);
    this.entries.set(normalized, { type: 'file', data: cloneBytes(data) });
  }

  async sync(path: string): Promise<void> {
    this.failures.check('filesystem.sync');
    this.requireEntry(this.normalize(path));
  }

  async mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): Promise<void> {
    this.failures.check('filesystem.mkdir');
    const normalized = this.normalize(path);
    if (this.entries.has(normalized)) {
      if (this.entries.get(normalized)?.type !== 'directory') {
        throw new Error(`Path is not a directory: ${normalized}`);
      }
      return;
    }
    if (!options.recursive) {
      this.requireParent(normalized);
      this.entries.set(normalized, { type: 'directory', ...(options.mode === undefined ? {} : { mode: options.mode }) });
      return;
    }
    const segments = normalized.split('/').filter(Boolean);
    let current = normalized.startsWith('/') ? '' : this.root;
    for (const segment of segments) {
      current = `${current}/${segment}` || '/';
      if (!this.entries.has(current)) {
        this.entries.set(current, { type: 'directory', ...(options.mode === undefined ? {} : { mode: options.mode }) });
      } else if (this.entries.get(current)?.type !== 'directory') {
        throw new Error(`Path is not a directory: ${current}`);
      }
    }
  }

  async rename(source: string, destination: string): Promise<void> {
    this.failures.check('filesystem.rename');
    const from = this.normalize(source);
    const to = this.normalize(destination);
    this.requireEntry(from);
    this.requireParent(to);
    this.removeEntry(to, true);
    const moved = [...this.entries.entries()]
      .filter(([path]) => path === from || path.startsWith(`${from}/`))
      .map(([path, entry]) => [path, entry] as const);
    for (const [path] of moved) {
      this.entries.delete(path);
    }
    for (const [path, entry] of moved) {
      this.entries.set(`${to}${path.slice(from.length)}`, entry);
    }
  }

  async remove(path: string, options: RemoveOptions = {}): Promise<void> {
    this.failures.check('filesystem.remove');
    const normalized = this.normalize(path);
    if (!this.entries.has(normalized)) {
      if (options.force) return;
      throw new Error(`Path does not exist: ${normalized}`);
    }
    this.removeEntry(normalized, options.recursive ?? false);
  }

  async symlink(target: string, path: string): Promise<void> {
    this.failures.check('filesystem.symlink');
    const normalized = this.normalize(path);
    this.requireParent(normalized);
    if (this.entries.has(normalized)) {
      throw new Error(`Path already exists: ${normalized}`);
    }
    this.entries.set(normalized, { type: 'symlink', target });
  }

  async readlink(path: string): Promise<string> {
    this.failures.check('filesystem.readlink');
    const entry = this.requireEntry(this.normalize(path));
    if (entry.type !== 'symlink') {
      throw new Error(`Path is not a symlink: ${this.normalize(path)}`);
    }
    return entry.target;
  }

  async realpath(path: string): Promise<string> {
    this.failures.check('filesystem.realpath');
    return this.resolvePath(this.normalize(path), new Set());
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    this.failures.check('filesystem.listDirectory');
    const normalized = this.normalize(path);
    const entry = this.requireEntry(normalized);
    if (entry.type !== 'directory') {
      throw new Error(`Path is not a directory: ${normalized}`);
    }
    const prefix = `${normalized}/`;
    const names = new Map<string, DirectoryEntry>();
    for (const [candidate, candidateEntry] of this.entries) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      if (remainder.length === 0 || remainder.includes('/')) continue;
      names.set(remainder, { name: remainder, type: candidateEntry.type });
    }
    return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async createTemporaryDirectory(parent: string, prefix: string): Promise<string> {
    this.failures.check('filesystem.createTemporaryDirectory');
    const normalizedParent = this.normalize(parent);
    this.requireDirectory(normalizedParent);
    const directory = this.normalize(posix.join(normalizedParent, `${prefix}-${this.temporaryCounter++}`));
    this.entries.set(directory, { type: 'directory' });
    return directory;
  }

  seedDirectory(path: string): this {
    this.addDirectory(path);
    return this;
  }

  seedFile(path: string, data: Uint8Array | string): this {
    const normalized = this.normalize(path);
    this.addDirectory(posix.dirname(normalized));
    this.entries.set(normalized, { type: 'file', data: cloneBytes(data) });
    return this;
  }

  seedSymlink(path: string, target: string): this {
    const normalized = this.normalize(path);
    this.addDirectory(posix.dirname(normalized));
    this.entries.set(normalized, { type: 'symlink', target });
    return this;
  }

  snapshot(): ReadonlyMap<string, FileMetadata> {
    return new Map([...this.entries].map(([path, entry]) => [path, {
      path,
      type: entry.type,
      ...(entry.type === 'file' ? { size: entry.data.byteLength } : {})
    }]));
  }

  private normalize(path: string): string {
    return posix.normalize(posix.isAbsolute(path) ? path : posix.join(this.root, path));
  }

  private requireEntry(path: string): MemoryEntry {
    const entry = this.entries.get(path);
    if (entry === undefined) throw new Error(`Path does not exist: ${path}`);
    return entry;
  }

  private requireDirectory(path: string): void {
    if (this.requireEntry(path).type !== 'directory') throw new Error(`Path is not a directory: ${path}`);
  }

  private requireParent(path: string): void {
    this.requireDirectory(posix.dirname(path));
  }

  private resolveFile(path: string): Extract<MemoryEntry, { type: 'file' }> {
    const resolved = this.resolvePath(path, new Set());
    const entry = this.requireEntry(resolved);
    if (entry.type !== 'file') throw new Error(`Path is not a file: ${path}`);
    return entry;
  }

  private resolvePath(path: string, seen: Set<string>): string {
    const entry = this.requireEntry(path);
    if (entry.type !== 'symlink') return path;
    if (seen.has(path)) throw new Error(`Symlink loop: ${path}`);
    seen.add(path);
    return this.resolvePath(this.normalize(posix.isAbsolute(entry.target) ? entry.target : posix.join(posix.dirname(path), entry.target)), seen);
  }

  private addDirectory(path: string): void {
    const normalized = this.normalize(path);
    if (normalized === '/') return;
    const parent = posix.dirname(normalized);
    if (parent !== normalized && !this.entries.has(parent)) this.addDirectory(parent);
    const existing = this.entries.get(normalized);
    if (existing !== undefined && existing.type !== 'directory') throw new Error(`Path is not a directory: ${normalized}`);
    this.entries.set(normalized, { type: 'directory' });
  }

  private removeEntry(path: string, recursive: boolean): void {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    if (entry.type === 'directory') {
      const descendants = [...this.entries.keys()].filter((candidate) => candidate.startsWith(`${path}/`));
      if (descendants.length > 0 && !recursive) throw new Error(`Directory is not empty: ${path}`);
      for (const descendant of descendants) this.entries.delete(descendant);
    }
    this.entries.delete(path);
  }
}

export function createFakeFileSystem(root?: string, failures?: FailureInjector): FakeFileSystem {
  return new FakeFileSystem(root, failures);
}
