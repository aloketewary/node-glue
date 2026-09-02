import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, posix, resolve } from 'node:path';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import {
  InvalidInputError,
  MissingStoreInstanceError,
  ProjectMapError
} from './errors.js';
import { atomicReplaceFile } from './state.js';
import type {
  DependencyPlacement,
  PackageInstance,
  ProjectMap,
  ProjectMapSummary
} from './types.js';

const PROJECT_MAP_SCHEMA_VERSION = 1;
const DEFAULT_TOOL_VERSION = '0.1.0';
const PROJECT_ID_HASH_LENGTHS = [16, 24, 32, 40, 64] as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|credential|cookie|api[-_]?key)/i;
const AUTHORITY_CREDENTIALS = /https?:\/\/[^/@\s]+:[^/@\s]+@/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface ProjectMapReferenceChecker {
  (identityHash: string): Promise<boolean> | boolean;
}

export interface ProjectMapStoreReference {
  get(identityHash: string): Promise<PackageInstance | undefined>;
}

export interface ProjectMapRepositoryOptions {
  filesystem: FileSystemAdapter;
  /** Directory containing one tool-owned directory per project. */
  projectsDir?: string;
  /** Convenience alternative to projectsDir; maps are stored below <storeDir>/projects. */
  storeDir?: string;
  toolVersion?: string;
  packageInstanceExists?: ProjectMapReferenceChecker;
  packageStore?: ProjectMapStoreReference;
}

interface StoredCandidate {
  state: 'available' | 'same-project' | 'occupied';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTERS.test(value)) {
    throw new ProjectMapError(`Project Map field ${field} must be a non-empty string.`, { field });
  }
  return value;
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!SAFE_IDENTIFIER.test(value) || value === '.' || value === '..') {
    throw new ProjectMapError(`Project Map field ${field} contains an unsafe identifier.`, { field });
  }
}

function assertSecretFree(value: unknown, path: string, inspectKeys = true): void {
  if (typeof value === 'string') {
    if (AUTHORITY_CREDENTIALS.test(value)) {
      throw new ProjectMapError('Project Map contains a credential-bearing URL.', { field: path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${path}[${index}]`, inspectKeys));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && (inspectKeys || /[A-Z]|auth|secret|password|credential|authorization/i.test(key))) {
      throw new ProjectMapError('Project Map contains a credential or secret field.', { field: `${path}.${key}` });
    }
    // These dictionaries use package/bin names as keys, so names such as
    // "token" remain valid names rather than being mistaken for secrets.
    const inspectChildKeys = key !== 'peerContext' && key !== 'binEntries';
    assertSecretFree(child, `${path}.${key}`, inspectChildKeys);
  }
}

function validateStringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new ProjectMapError(`Project Map field ${field} must be an object of strings.`, { field });
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    requiredString(key, `${field}.${key}`);
    const itemValue = requiredString(item, `${field}.${key}`);
    result[key] = itemValue;
  }
  return result;
}

function validatePlacement(value: unknown, index: number): DependencyPlacement {
  const field = `placements[${index}]`;
  if (!isRecord(value)) {
    throw new ProjectMapError(`Project Map ${field} must be an object.`, { field });
  }

  const relativePath = requiredString(value.relativePath, `${field}.relativePath`);
  const normalizedPath = posix.normalize(relativePath.replaceAll('\\\\', '/'));
  if (
    isAbsolute(relativePath) ||
    normalizedPath !== relativePath.replaceAll('\\\\', '/') ||
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    !normalizedPath.startsWith('node_modules/')
  ) {
    throw new ProjectMapError(`Project Map placement path is unsafe: ${relativePath}.`, { field: `${field}.relativePath` });
  }

  const packageIdentityHash = requiredString(value.packageIdentityHash, `${field}.packageIdentityHash`);
  assertSafeIdentifier(packageIdentityHash, `${field}.packageIdentityHash`);
  const packageName = requiredString(value.packageName, `${field}.packageName`);
  if (packageName.includes('\\') || packageName.includes('..') || packageName.startsWith('/')) {
    throw new ProjectMapError(`Project Map package name is unsafe: ${packageName}.`, { field: `${field}.packageName` });
  }

  const peerContext = value.peerContext === undefined
    ? undefined
    : validateStringRecord(value.peerContext, `${field}.peerContext`);
  const binEntries = value.binEntries === undefined
    ? undefined
    : validateStringRecord(value.binEntries, `${field}.binEntries`);

  return {
    relativePath: normalizedPath,
    packageIdentityHash,
    packageName,
    ...(peerContext === undefined ? {} : { peerContext }),
    ...(binEntries === undefined ? {} : { binEntries })
  };
}

/** Validates and returns only the supported, persistable Project Map fields. */
export function validateProjectMap(value: unknown): ProjectMap {
  assertSecretFree(value, 'map');
  if (!isRecord(value)) throw new ProjectMapError('Project Map must be a JSON object.');

  if (value.schemaVersion !== PROJECT_MAP_SCHEMA_VERSION) {
    throw new ProjectMapError(`Unsupported Project Map schema version: ${String(value.schemaVersion)}.`, {
      schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : String(value.schemaVersion)
    });
  }

  const projectId = requiredString(value.projectId, 'projectId');
  assertSafeIdentifier(projectId, 'projectId');
  const projectRoot = requiredString(value.projectRoot, 'projectRoot');
  if (!isAbsolute(projectRoot)) {
    throw new ProjectMapError('Project Map projectRoot must be absolute.', { projectRoot });
  }
  const lockfileHash = requiredString(value.lockfileHash, 'lockfileHash');
  const generatedAt = requiredString(value.generatedAt, 'generatedAt');
  const toolVersion = requiredString(value.toolVersion, 'toolVersion');
  if (!Array.isArray(value.placements)) {
    throw new ProjectMapError('Project Map placements must be an array.', { field: 'placements' });
  }

  const placements = value.placements.map((placement, index) => validatePlacement(placement, index));
  const placementKeys = new Set<string>();
  for (const placement of placements) {
    if (placementKeys.has(placement.relativePath)) {
      throw new ProjectMapError(`Project Map contains duplicate placement: ${placement.relativePath}.`, {
        field: 'placements'
      });
    }
    placementKeys.add(placement.relativePath);
  }

  return {
    schemaVersion: PROJECT_MAP_SCHEMA_VERSION,
    projectId,
    projectRoot: normalize(projectRoot),
    lockfileHash,
    placements,
    generatedAt,
    toolVersion
  };
}

/** Serializes the validated map using a stable field order and no unknown fields. */
export function serializeProjectMap(map: ProjectMap): string {
  return `${JSON.stringify(validateProjectMap(map), null, 2)}\n`;
}

function parseProjectMap(text: string, mapPath: string): ProjectMap {
  try {
    return validateProjectMap(JSON.parse(text) as unknown);
  } catch (cause) {
    if (cause instanceof ProjectMapError) throw cause;
    throw new ProjectMapError('Project Map JSON could not be parsed.', { mapPath }, cause);
  }
}

function projectRootHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot, 'utf8').digest('hex');
}

function readableProjectBasename(projectRoot: string): string {
  const value = basename(projectRoot) || 'project';
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length === 0 ? 'project' : safe;
}

/** Derives a readable, collision-resistant identifier from a canonical Project Root. */
export function deriveProjectId(projectRoot: string, hashLength = PROJECT_ID_HASH_LENGTHS[0]): string {
  const canonicalRoot = normalize(resolve(projectRoot));
  if (!isAbsolute(canonicalRoot)) throw new InvalidInputError('Project Root must be absolute.', { projectRoot });
  if (!PROJECT_ID_HASH_LENGTHS.includes(hashLength as (typeof PROJECT_ID_HASH_LENGTHS)[number])) {
    throw new InvalidInputError('Unsupported Project Map identifier hash length.', { hashLength });
  }
  return `${readableProjectBasename(canonicalRoot)}-${projectRootHash(canonicalRoot).slice(0, hashLength)}`;
}

export class ProjectMapRepository {
  private readonly filesystem: FileSystemAdapter;
  private readonly projectsDir: string;
  private readonly packageInstanceExists: ProjectMapReferenceChecker | undefined;

  constructor(options: ProjectMapRepositoryOptions) {
    this.filesystem = options.filesystem;
    this.projectsDir = resolve(
      options.projectsDir ?? join(options.storeDir ?? join(homedir(), '.node_modules'), 'projects')
    );
    this.packageInstanceExists = options.packageInstanceExists ?? (
      options.packageStore === undefined
        ? undefined
        : async (identityHash) => (await options.packageStore!.get(identityHash)) !== undefined
    );
  }

  async canonicalProjectRoot(projectRoot: string): Promise<string> {
    const lexicalRoot = resolve(projectRoot);
    if (await this.filesystem.exists(lexicalRoot)) {
      try {
        return normalize(await this.filesystem.realpath(lexicalRoot));
      } catch {
        // A partially-created or fake filesystem may not support realpath yet.
      }
    }
    return normalize(lexicalRoot);
  }

  async projectIdFor(projectRoot: string): Promise<string> {
    return deriveProjectId(await this.canonicalProjectRoot(projectRoot));
  }

  mapPath(projectId: string): string {
    assertSafeIdentifier(projectId, 'projectId');
    return join(this.projectsDir, projectId, 'map.json');
  }

  async read(projectId: string): Promise<ProjectMap | undefined> {
    const mapPath = this.mapPath(projectId);
    if (!(await this.filesystem.exists(mapPath))) return undefined;
    let parsed: ProjectMap;
    try {
      parsed = parseProjectMap(await this.filesystem.readTextFile(mapPath), mapPath);
    } catch (cause) {
      if (cause instanceof ProjectMapError) throw cause;
      throw new ProjectMapError('Project Map could not be read.', { mapPath }, cause);
    }
    if (parsed.projectId !== projectId) {
      throw new ProjectMapError('Project Map identifier does not match its path.', { mapPath, projectId });
    }
    await this.validateReferences(parsed);
    return parsed;
  }

  async publish(map: ProjectMap): Promise<ProjectMap> {
    const validated = validateProjectMap(map);
    const canonicalRoot = await this.canonicalProjectRoot(validated.projectRoot);
    const projectId = await this.selectProjectId(canonicalRoot);
    const published: ProjectMap = {
      ...validated,
      projectId,
      projectRoot: canonicalRoot
    };
    await this.validateReferences(published);

    const mapPath = this.mapPath(projectId);
    await this.filesystem.mkdir(join(this.projectsDir, projectId), { recursive: true });
    await atomicReplaceFile(this.filesystem, mapPath, serializeProjectMap(published), {
      temporaryPrefix: '.node-glue-map'
    });
    return published;
  }

  async remove(projectId: string): Promise<void> {
    const mapPath = this.mapPath(projectId);
    await this.filesystem.remove(mapPath, { force: true });
  }

  async list(): Promise<readonly ProjectMapSummary[]> {
    if (!(await this.filesystem.exists(this.projectsDir))) return [];
    const entries = await this.filesystem.listDirectory(this.projectsDir);
    const summaries: ProjectMapSummary[] = [];
    for (const entry of entries) {
      if (entry.type !== 'directory' || !SAFE_IDENTIFIER.test(entry.name)) continue;
      const map = await this.read(entry.name);
      if (map === undefined) continue;
      summaries.push({
        projectId: map.projectId,
        projectRoot: map.projectRoot,
        lockfileHash: map.lockfileHash,
        generatedAt: map.generatedAt
      });
    }
    return summaries;
  }

  private async validateReferences(map: ProjectMap): Promise<void> {
    if (this.packageInstanceExists === undefined) return;
    const identityHashes = new Set(map.placements.map((placement) => placement.packageIdentityHash));
    for (const identityHash of identityHashes) {
      if (!(await this.packageInstanceExists(identityHash))) {
        throw new MissingStoreInstanceError('Project Map references a missing Package Instance.', {
          projectId: map.projectId,
          identityHash
        });
      }
    }
  }

  private async inspectCandidate(projectId: string, canonicalRoot: string): Promise<StoredCandidate> {
    const projectDirectory = join(this.projectsDir, projectId);
    const mapPath = join(projectDirectory, 'map.json');
    if (!(await this.filesystem.exists(projectDirectory))) return { state: 'available' };
    if (!(await this.filesystem.exists(mapPath))) return { state: 'occupied' };

    try {
      const existing = parseProjectMap(await this.filesystem.readTextFile(mapPath), mapPath);
      if (existing.projectId !== projectId) return { state: 'occupied' };
      return {
        state: normalize(resolve(existing.projectRoot)) === canonicalRoot ? 'same-project' : 'occupied'
      };
    } catch {
      // Never replace an unreadable map or partially-written project directory.
      return { state: 'occupied' };
    }
  }

  private async selectProjectId(canonicalRoot: string): Promise<string> {
    const hash = projectRootHash(canonicalRoot);
    const readable = readableProjectBasename(canonicalRoot);
    for (const length of PROJECT_ID_HASH_LENGTHS) {
      const candidate = `${readable}-${hash.slice(0, length)}`;
      const status = await this.inspectCandidate(candidate, canonicalRoot);
      if (status.state !== 'occupied') return candidate;
    }

    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${readable}-${hash}-${suffix}`;
      const status = await this.inspectCandidate(candidate, canonicalRoot);
      if (status.state !== 'occupied') return candidate;
    }
  }
}

export function createProjectMapRepository(options: ProjectMapRepositoryOptions): ProjectMapRepository {
  return new ProjectMapRepository(options);
}
