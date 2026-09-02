import { createHash } from 'node:crypto';
import { join, posix, resolve } from 'node:path';
import { IntegrityMismatchError, NodeGlueError, SourceFailureError, UnsupportedSourceError } from '../errors.js';
import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { EnvironmentFingerprint, PackageManifest } from '../types.js';

export const SUPPORTED_SOURCE_FORMATS = ['npm registry', 'absolute local directory', 'Git URL', 'HTTP(S) tarball URL'] as const;

export function currentEnvironment(): EnvironmentFingerprint {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules
  };
}

export function sourceDescription(source: unknown): string {
  if (typeof source !== 'object' || source === null) return String(source);
  const candidate = source as Record<string, unknown>;
  const locator = candidate.url ?? candidate.path ?? candidate.locator;
  if (typeof locator === 'string') return locator;
  if (candidate.kind === 'registry' && typeof candidate.name === 'string') {
    return `${candidate.name}@${String(candidate.spec ?? '')}`;
  }
  return String(candidate.kind ?? 'unknown source');
}

export function unsupportedSource(message: string, source: unknown): never {
  throw new UnsupportedSourceError(message, {
    source: sourceDescription(source),
    supportedFormats: [...SUPPORTED_SOURCE_FORMATS]
  });
}

export function sourceFailure(message: string, source: unknown, cause?: unknown): never {
  throw new SourceFailureError(message, { source: sourceDescription(source) }, cause);
}

export function preserveSourceError(error: unknown): never {
  if (error instanceof NodeGlueError) throw error;
  throw error;
}

export function canonicalHttpUrl(value: string, source: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    return sourceFailure(`Unsupported source URL: ${value}.`, source, cause);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return unsupportedSource(`Source URL must use HTTP or HTTPS: ${value}.`, source);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return unsupportedSource('Credential-bearing source URLs are not supported.', source);
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function validatePackageName(name: unknown, source: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214 || name.includes('\\') || /\s/.test(name)) {
    return sourceFailure('Source package metadata contains an invalid package name.', source);
  }
  const valid = name.startsWith('@')
    ? /^@[^/]+\/[^/]+$/.test(name)
    : /^[a-zA-Z0-9._~-]+$/.test(name);
  if (!valid) return sourceFailure(`Source package metadata contains an invalid package name: ${name}.`, source);
  return name;
}

export function readManifest(text: string, source: unknown, manifestPath: string): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    return sourceFailure(`Cannot parse package manifest: ${manifestPath}.`, source, cause);
  }
  if (!isRecord(value)) return sourceFailure(`Package manifest must be a JSON object: ${manifestPath}.`, source);
  const name = validatePackageName(value.name, source);
  if (typeof value.version !== 'string' || value.version.length === 0) {
    return sourceFailure(`Package manifest has no valid version: ${manifestPath}.`, source);
  }
  const manifest: PackageManifest = { ...value, name, version: value.version };
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencySet = manifest[field];
    if (dependencySet !== undefined && (!isRecord(dependencySet) || Object.values(dependencySet).some((range) => typeof range !== 'string'))) {
      return sourceFailure(`Package manifest has invalid ${field}: ${manifestPath}.`, source);
    }
  }
  return manifest;
}

export async function readManifestFromFile(
  filesystem: Pick<FileSystemAdapter, 'readTextFile'>,
  manifestPath: string,
  source: unknown
): Promise<PackageManifest> {
  try {
    return readManifest(await filesystem.readTextFile(manifestPath), source, manifestPath);
  } catch (cause) {
    if (cause instanceof NodeGlueError) throw cause;
    return sourceFailure(`Cannot read package manifest: ${manifestPath}.`, source, cause);
  }
}

export function archiveIntegrity(data: Uint8Array): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

export function verifyIntegrity(data: Uint8Array, integrity: string | undefined, source: unknown): void {
  if (integrity === undefined) return;
  const matches = integrity.split(/\s+/).some((entry) => {
    const separator = entry.indexOf('-');
    if (separator < 1) return false;
    const algorithm = entry.slice(0, separator);
    const expected = entry.slice(separator + 1);
    if (!['sha1', 'sha256', 'sha384', 'sha512'].includes(algorithm)) return false;
    return createHash(algorithm).update(data).digest('base64') === expected;
  });
  if (!matches) {
    throw new IntegrityMismatchError('Source integrity verification failed.', {
      source: sourceDescription(source),
      integrity
    });
  }
}

export async function copyDirectory(
  filesystem: FileSystemAdapter,
  sourceDirectory: string,
  destinationDirectory: string,
  source: unknown
): Promise<string> {
  const hash = createHash('sha512');
  try {
    await copyEntry(filesystem, sourceDirectory, destinationDirectory, sourceDirectory, hash, source);
    return `sha512-${hash.digest('base64')}`;
  } catch (cause) {
    await filesystem.remove(destinationDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof NodeGlueError) throw cause;
    return sourceFailure(`Cannot copy local package source: ${sourceDescription(source)}.`, source, cause);
  }
}

async function copyEntry(
  filesystem: FileSystemAdapter,
  sourcePath: string,
  destinationPath: string,
  sourceRoot: string,
  hash: ReturnType<typeof createHash>,
  source: unknown
): Promise<void> {
  const metadata = await filesystem.lstat(sourcePath);
  if (metadata.type === 'symlink') {
    return unsupportedSource('Symlinks inside local package sources are not supported.', source);
  }
  if (metadata.type === 'directory') {
    await filesystem.mkdir(destinationPath, { recursive: true });
    const entries = await filesystem.listDirectory(sourcePath);
    for (const entry of entries) {
      await copyEntry(filesystem, join(sourcePath, entry.name), join(destinationPath, entry.name), sourceRoot, hash, source);
    }
    return;
  }
  if (metadata.type !== 'file') return sourceFailure(`Unsupported local package entry: ${sourcePath}.`, source);
  const data = await filesystem.readFile(sourcePath);
  const relativePath = sourcePath.slice(resolve(sourceRoot).length).replace(/^[/\\]/, '');
  hash.update(relativePath);
  hash.update('\0');
  hash.update(data);
  await filesystem.mkdir(posix.dirname(destinationPath), { recursive: true });
  await filesystem.writeFile(destinationPath, data);
}

export function canonicalDirectoryPath(path: string, source: unknown): string {
  if (!path || !path.startsWith('/')) return unsupportedSource('Local directory sources must use an absolute path.', source);
  return resolve(path);
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pathWithin(path: string, parent: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedParent = resolve(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}
