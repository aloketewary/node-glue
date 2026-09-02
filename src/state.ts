import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import { ProjectMapError } from './errors.js';
import type { JsonValue, ProjectState } from './types.js';

const PROJECT_STATE_SCHEMA_VERSION = 1;
const DEFAULT_TOOL_VERSION = '0.1.0';
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
let temporaryFileCounter = 0;

export interface AtomicReplaceOptions {
  /** Prefix used for the same-directory temporary file. */
  temporaryPrefix?: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTERS.test(value)) {
    throw new ProjectMapError(`Project state field ${field} must be a non-empty string.`, { field });
  }
  return value;
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!SAFE_IDENTIFIER.test(value) || value === '.' || value === '..') {
    throw new ProjectMapError(`Project state field ${field} contains an unsafe identifier.`, { field });
  }
}

/** Validates advisory state without trusting it as authoritative installation state. */
export function validateProjectState(value: unknown): ProjectState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectMapError('Project state must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PROJECT_STATE_SCHEMA_VERSION) {
    throw new ProjectMapError(`Unsupported Project state schema version: ${String(record.schemaVersion)}.`, {
      schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : String(record.schemaVersion)
    });
  }
  const projectId = requiredString(record.projectId, 'projectId');
  assertSafeIdentifier(projectId, 'projectId');
  const projectRoot = requiredString(record.projectRoot, 'projectRoot');
  if (!isAbsolute(projectRoot)) {
    throw new ProjectMapError('Project state projectRoot must be absolute.', { projectRoot });
  }
  const updatedAt = requiredString(record.updatedAt, 'updatedAt');
  const status = record.status;
  if (status !== 'ready' && status !== 'incomplete' && status !== 'unknown') {
    throw new ProjectMapError('Project state status is invalid.', { status: String(status) });
  }
  const optionalStrings = ['lastSuccessfulMapGeneration', 'lastSuccessfulMaterializationGeneration', 'activeTarget', 'lastSuccessfulAt'] as const;
  for (const field of optionalStrings) {
    if (record[field] !== undefined) requiredString(record[field], field);
  }

  return {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    projectId,
    projectRoot: normalize(projectRoot),
    ...(record.lastSuccessfulMapGeneration === undefined ? {} : { lastSuccessfulMapGeneration: record.lastSuccessfulMapGeneration as string }),
    ...(record.lastSuccessfulMaterializationGeneration === undefined ? {} : { lastSuccessfulMaterializationGeneration: record.lastSuccessfulMaterializationGeneration as string }),
    ...(record.activeTarget === undefined ? {} : { activeTarget: record.activeTarget as string }),
    updatedAt,
    ...(record.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: record.lastSuccessfulAt as string }),
    status
  };
}

/** Stable state serialization; unknown fields are intentionally not persisted. */
export function serializeProjectState(state: ProjectState): string {
  return `${JSON.stringify(validateProjectState(state), null, 2)}\n`;
}

function parseProjectState(text: string, statePath: string): ProjectState {
  try {
    return validateProjectState(JSON.parse(text) as JsonValue);
  } catch (cause) {
    if (cause instanceof ProjectMapError) throw cause;
    throw new ProjectMapError('Project state JSON could not be parsed.', { statePath }, cause);
  }
}

/**
 * Replaces a file using a same-directory temporary file, flushes the prepared
 * file, and renames it into place. Failure cleanup never touches destination,
 * preserving its last readable contents.
 */
export async function atomicReplaceFile(
  filesystem: FileSystemAdapter,
  destination: string,
  data: Uint8Array | string,
  options: AtomicReplaceOptions = {}
): Promise<void> {
  const target = resolve(destination);
  const parent = dirname(target);
  const prefix = options.temporaryPrefix ?? '.node-glue-state';
  const temporary = join(
    parent,
    `${prefix}-${process.pid}-${Date.now()}-${temporaryFileCounter++}.tmp`
  );
  let published = false;
  try {
    await filesystem.writeFile(temporary, data);
    await filesystem.sync(temporary);
    await filesystem.rename(temporary, target);
    // The rename is the commit point. Do not perform fallible work after it:
    // callers must never observe an update failure after the new file is visible.
    published = true;
  } finally {
    if (!published) {
      await filesystem.remove(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export interface ProjectStateRepositoryOptions {
  filesystem: FileSystemAdapter;
  projectsDir?: string;
  storeDir?: string;
  toolVersion?: string;
}

/** Persists advisory state separately from the map and keeps failed updates non-destructive. */
export class ProjectStateRepository {
  readonly projectsDir: string;
  readonly toolVersion: string;
  private readonly filesystem: FileSystemAdapter;

  constructor(options: ProjectStateRepositoryOptions) {
    this.filesystem = options.filesystem;
    this.projectsDir = resolve(options.projectsDir ?? join(options.storeDir ?? join(homedir(), '.node_modules'), 'projects'));
    this.toolVersion = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  }

  statePath(projectId: string): string {
    assertSafeIdentifier(projectId, 'projectId');
    return join(this.projectsDir, projectId, 'state.json');
  }

  async read(projectId: string): Promise<ProjectState | undefined> {
    const statePath = this.statePath(projectId);
    if (!(await this.filesystem.exists(statePath))) return undefined;
    try {
      const state = parseProjectState(await this.filesystem.readTextFile(statePath), statePath);
      if (state.projectId !== projectId) {
        throw new ProjectMapError('Project state identifier does not match its path.', { statePath, projectId });
      }
      return state;
    } catch (cause) {
      if (cause instanceof ProjectMapError) throw cause;
      throw new ProjectMapError('Project state could not be read.', { statePath }, cause);
    }
  }

  async publish(state: ProjectState): Promise<ProjectState> {
    const validated = validateProjectState(state);
    const statePath = this.statePath(validated.projectId);
    await this.filesystem.mkdir(dirname(statePath), { recursive: true });
    await atomicReplaceFile(this.filesystem, statePath, serializeProjectState(validated), {
      temporaryPrefix: '.node-glue-state'
    });
    return validated;
  }
}

export type CleanupKind = 'temporary' | 'generations';

export interface CleanupOptions {
  kind: CleanupKind;
  /** Paths currently referenced by an active operation and therefore retained. */
  activePaths?: readonly string[];
}

export function isToolOwnedTemporaryName(name: string): boolean {
  return /^\.node-glue-[A-Za-z0-9._-]+$/.test(name);
}

export function isToolOwnedGenerationName(name: string): boolean {
  return /^(?:generation|\.node-glue-generation)-[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Removes only entries with Node Glue-generated names directly below an explicit
 * temporary or generations directory. User-named entries and active paths stay.
 */
export async function cleanupToolOwnedArtifacts(
  filesystem: FileSystemAdapter,
  directory: string,
  options: CleanupOptions
): Promise<readonly string[]> {
  const root = resolve(directory);
  if (!(await filesystem.exists(root))) return [];
  const active = new Set((options.activePaths ?? []).map((path) => normalize(resolve(path))));
  const entries = await filesystem.listDirectory(root);
  const removed: string[] = [];
  for (const entry of entries) {
    const owned = options.kind === 'temporary'
      ? isToolOwnedTemporaryName(entry.name)
      : isToolOwnedGenerationName(entry.name);
    if (!owned) continue;
    const path = normalize(join(root, entry.name));
    if (active.has(path) || entry.type === 'other') continue;
    await filesystem.remove(path, { recursive: entry.type === 'directory', force: true });
    removed.push(path);
  }
  return removed;
}

export const toolOwnedTemporaryPrefix = '.node-glue-';
export const toolOwnedGenerationPrefix = 'generation-';
