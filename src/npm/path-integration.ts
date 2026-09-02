import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { FileMetadata, FileSystemAdapter } from '../adapters/filesystem.js';
import type { ProcessEnvironment } from '../adapters/process.js';
import { CapabilityUnavailableError } from '../errors.js';

export const DEFAULT_NODE_GLUE_BIN_DIRECTORY = join('.node_modules', 'bin');
export const PATH_INTEGRATION_START = '# >>> node-glue PATH integration >>>';
export const PATH_INTEGRATION_END = '# <<< node-glue PATH integration <<<';
const SHIM_OWNERSHIP_MARKER = '# node-glue npm shim (tool-owned)';
const DEFAULT_SHIM_MODULE_PATH = new URL('./shim.js', import.meta.url);

export type PathIntegrationFileSystem = Pick<
  FileSystemAdapter,
  'exists' | 'lstat' | 'mkdir' | 'readTextFile' | 'writeFileAtomic'
> & {
  chmod?: (path: string, mode: number) => Promise<void>;
};

export interface PathIntegrationOptions {
  /** Environment used to select the shell and home directory. */
  env?: ProcessEnvironment;
  /** Home directory override, primarily useful for tests. */
  homeDirectory?: string;
  /** Tool-owned bin directory. Defaults to ~/.node_modules/bin. */
  binDirectory?: string;
  /** Shell executable or shell name. Defaults to $SHELL or /bin/sh. */
  shell?: string;
  /** Shell startup file override. */
  shellRcPath?: string;
  /** Filesystem seam for deterministic tests and embedders. */
  filesystem?: PathIntegrationFileSystem;
  /** Compiled shim module imported by generated npm/npx wrappers. */
  shimModulePath?: string;
}

/**
 * Reversible, opt-in PATH integration for the npm shim.
 *
 * The implementation owns only its bin directory and a uniquely marked block
 * in the selected shell startup file. It never edits the system npm binary or
 * removes unmarked PATH entries.
 */
export class PathIntegration {
  readonly binDirectory: string;
  readonly shellRcPath: string;
  private readonly filesystem: PathIntegrationFileSystem;
  private readonly shellKind: ShellKind;
  private readonly shimModulePath: string;

  constructor(options: PathIntegrationOptions = {}) {
    const environment = options.env ?? process.env;
    const homeDirectory = resolve(options.homeDirectory ?? environment.HOME ?? homedir());
    this.binDirectory = resolve(options.binDirectory ?? join(homeDirectory, DEFAULT_NODE_GLUE_BIN_DIRECTORY));
    const shellPath = options.shell ?? environment.SHELL ?? '/bin/sh';
    this.shellKind = shellKind(shellPath);
    this.shellRcPath = resolve(options.shellRcPath ?? defaultShellRcPath(homeDirectory, this.shellKind, shellPath));
    this.filesystem = options.filesystem ?? nativePathIntegrationFileSystem;
    this.shimModulePath = resolve(options.shimModulePath ?? fileURLPath(DEFAULT_SHIM_MODULE_PATH));
  }

  /** Create/update tool-owned wrappers and add one marked PATH block. */
  async enable(): Promise<string> {
    await this.filesystem.mkdir(this.binDirectory, { recursive: true, mode: 0o755 });
    await this.assertShimWritable('npm');
    await this.assertShimWritable('npx');
    await this.writeShim('npm', false);
    await this.writeShim('npx', true);

    const existing = await this.readShellRc();
    const withoutIntegration = removePathIntegration(existing, this.shellRcPath);
    const block = this.pathBlock();
    const updated = appendPathBlock(withoutIntegration, block);
    await this.filesystem.mkdir(dirname(this.shellRcPath), { recursive: true, mode: 0o755 });
    await this.filesystem.writeFileAtomic(this.shellRcPath, updated);
    return this.binDirectory;
  }

  /** Remove only Node Glue's marked shell block; keep wrappers and npm intact. */
  async disable(): Promise<void> {
    if (!(await this.filesystem.exists(this.shellRcPath))) return;
    const metadata = await this.filesystem.lstat(this.shellRcPath);
    if (metadata.type !== 'file') {
      throw new CapabilityUnavailableError('Shell startup path is not a regular file.', {
        path: this.shellRcPath,
        operation: 'disable'
      });
    }
    const existing = await this.filesystem.readTextFile(this.shellRcPath);
    const updated = removePathIntegration(existing, this.shellRcPath);
    if (updated !== existing) await this.filesystem.writeFileAtomic(this.shellRcPath, updated);
  }

  private async readShellRc(): Promise<string> {
    if (!(await this.filesystem.exists(this.shellRcPath))) return '';
    const metadata = await this.filesystem.lstat(this.shellRcPath);
    if (metadata.type !== 'file') {
      throw new CapabilityUnavailableError('Shell startup path is not a regular file.', {
        path: this.shellRcPath,
        operation: 'enable'
      });
    }
    return await this.filesystem.readTextFile(this.shellRcPath);
  }

  private async assertShimWritable(name: 'npm' | 'npx'): Promise<void> {
    const shimPath = join(this.binDirectory, name);
    if (!(await this.filesystem.exists(shimPath))) return;
    const metadata = await this.filesystem.lstat(shimPath);
    if (metadata.type !== 'file') {
      throw new CapabilityUnavailableError('Refusing to replace a non-file in the tool-owned bin directory.', {
        path: shimPath,
        operation: 'enable',
        reason: 'unmanaged-bin-entry'
      });
    }
    const current = await this.filesystem.readTextFile(shimPath);
    if (!isOwnedShim(current)) {
      throw new CapabilityUnavailableError('Refusing to replace an unmanaged executable in the tool-owned bin directory.', {
        path: shimPath,
        operation: 'enable',
        reason: 'unmanaged-bin-entry'
      });
    }
  }

  private async writeShim(name: 'npm' | 'npx', npx: boolean): Promise<void> {
    const shimPath = join(this.binDirectory, name);
    const moduleUrl = pathToFileURL(this.shimModulePath).href;
    const argsExpression = npx
      ? "['npx', ...process.argv.slice(2)]"
      : 'process.argv.slice(2)';
    const script = [
      '#!/usr/bin/env node',
      SHIM_OWNERSHIP_MARKER,
      `import { runNpmShim } from ${JSON.stringify(moduleUrl)};`,
      `const exitCode = await runNpmShim(${argsExpression}, { shimDirectory: ${JSON.stringify(this.binDirectory)} });`,
      'process.exitCode = exitCode;',
      ''
    ].join('\n');
    await this.filesystem.writeFileAtomic(shimPath, script);
    if (this.filesystem.chmod !== undefined) await this.filesystem.chmod(shimPath, 0o755);
  }

  private pathBlock(): string {
    const quotedDirectory = shellQuote(this.binDirectory);
    if (this.shellKind === 'fish') {
      return [
        PATH_INTEGRATION_START,
        `set -gx PATH ${quotedDirectory} $PATH;`,
        PATH_INTEGRATION_END
      ].join('\n');
    }
    return [
      PATH_INTEGRATION_START,
      `export PATH=${quotedDirectory}${'${PATH:+:$PATH}'}`,
      PATH_INTEGRATION_END
    ].join('\n');
  }
}

/** Compatibility alias for callers that name the feature explicitly. */
export const NpmPathIntegration = PathIntegration;

export function createPathIntegration(options: PathIntegrationOptions = {}): PathIntegration {
  return new PathIntegration(options);
}

type ShellKind = 'posix' | 'fish';

function shellKind(shell: string): ShellKind {
  return basename(shell).toLowerCase() === 'fish' ? 'fish' : 'posix';
}

function defaultShellRcPath(homeDirectory: string, kind: ShellKind, shellPath: string): string {
  if (kind === 'fish') return join(homeDirectory, '.config', 'fish', 'config.fish');
  if (basename(shellPath).toLowerCase() === 'zsh') return join(homeDirectory, '.zshrc');
  if (basename(shellPath).toLowerCase() === 'bash') return join(homeDirectory, '.bashrc');
  return join(homeDirectory, '.profile');
}

function isOwnedShim(content: string): boolean {
  return content.split('\n').slice(0, 3).includes(SHIM_OWNERSHIP_MARKER);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendPathBlock(existing: string, block: string): string {
  if (existing.length === 0) return `${block}\n`;
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

function removePathIntegration(existing: string, shellRcPath: string): string {
  const lines = existing.split('\n');
  const result: string[] = [];
  let index = 0;
  let startCount = 0;
  let endCount = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line === PATH_INTEGRATION_START) {
      startCount += 1;
      const end = lines.indexOf(PATH_INTEGRATION_END, index + 1);
      if (end < 0) {
        throw new CapabilityUnavailableError('Shell startup file contains an incomplete Node Glue PATH block.', {
          path: shellRcPath,
          operation: 'path-integration',
          reason: 'missing-end-marker'
        });
      }
      endCount += 1;
      index = end + 1;
      continue;
    }
    if (line === PATH_INTEGRATION_END) {
      endCount += 1;
      throw new CapabilityUnavailableError('Shell startup file contains an unmatched Node Glue PATH end marker.', {
        path: shellRcPath,
        operation: 'path-integration',
        reason: 'unmatched-end-marker'
      });
    }
    result.push(line);
    index += 1;
  }
  if (startCount !== endCount) {
    throw new CapabilityUnavailableError('Shell startup file contains malformed Node Glue PATH integration.', {
      path: shellRcPath,
      operation: 'path-integration',
      reason: 'marker-mismatch'
    });
  }
  return result.join('\n');
}

function fileURLPath(url: URL): string {
  return fileURLToPath(url);
}

const nativePathIntegrationFileSystem: PathIntegrationFileSystem = {
  exists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
  lstat: async (path): Promise<FileMetadata> => {
    const metadata = await lstat(path);
    const type = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : metadata.isSymbolicLink() ? 'symlink' : 'other';
    return { path, type, size: metadata.size, mode: metadata.mode, mtimeMs: metadata.mtimeMs };
  },
  mkdir: async (path, options) => { await mkdir(path, options); },
  readTextFile: async (path) => await readFile(path, 'utf8'),
  writeFileAtomic: async (path, data) => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let mode: number | undefined;
    try {
      mode = (await lstat(path)).mode & 0o777;
    } catch {
      // New shell files use the process umask and are created below.
    }
    try {
      await writeFile(temporary, data, mode === undefined ? { mode: 0o600 } : { mode });
      if (mode !== undefined) await chmod(temporary, mode);
      await rename(temporary, path);
    } catch (cause) {
      try { await import('node:fs/promises').then(({ unlink }) => unlink(temporary)); } catch { /* best effort cleanup */ }
      throw cause;
    }
  },
  chmod: async (path, mode) => { await chmod(path, mode); }
};
