import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ParseError, InvalidInputError, PublicationError } from './errors.js';
import { packageIdentityFromResolvedSource, normalizeIntegrity } from './package-identity.js';
import { atomicReplaceFile } from './state.js';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import type {
  DependencyPlacement,
  JsonObject,
  NormalizedLockfile,
  NormalizedLockfilePackage,
  PackageManifest,
  PackageInstance,
  ResolvedProject,
  ResolvedSource
} from './types.js';

export interface LockfileReaderOptions {
  projectRoot?: string;
  sourcePath?: string;
}

const LOCKFILE_VERSIONS = [2, 3] as const;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/**
 * Converts npm lockfile v2 and v3 documents to one package-path graph.
 * The normalized graph contains only persistence-safe locator values.
 */
export class LockfileReader {
  read(
    document: unknown,
    packageManifest: PackageManifest,
    options: LockfileReaderOptions = {}
  ): NormalizedLockfile {
    return normalizeLockfile(document, packageManifest, options);
  }

  readText(
    text: string,
    packageManifest: PackageManifest,
    options: LockfileReaderOptions = {}
  ): NormalizedLockfile {
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new ParseError('Cannot parse package-lock.json.', contextFor(options), cause);
    }
    return this.read(document, packageManifest, options);
  }
}

export function normalizeLockfile(
  document: unknown,
  packageManifest: PackageManifest,
  options: LockfileReaderOptions = {}
): NormalizedLockfile {
  const lockfile = asRecord(document, 'package-lock.json', options);
  const lockfileVersion = readLockfileVersion(lockfile, options);
  validateRootCompatibility(lockfile, packageManifest, options);

  const packages = asOptionalRecord(lockfile.packages, 'packages', options);
  const normalizedPackages = packages !== undefined && Object.keys(packages).length > 0
    ? normalizePackages(packages, packageManifest, options)
    : normalizeLegacyDependencies(lockfile.dependencies, packageManifest, options);

  return {
    lockfileVersion,
    packages: normalizedPackages
  };
}

/** Redacts URL userinfo before a locator can enter a normalized graph or map. */
export function sanitizePersistedLocator(locator: string): string {
  const userInfo = /([a-z][a-z\d+.-]*:\/\/)([^/@\s]+)@/gi;
  return locator.replace(userInfo, '$1[REDACTED]@');
}

function readLockfileVersion(lockfile: Record<string, unknown>, options: LockfileReaderOptions): 2 | 3 {
  if (lockfile.lockfileVersion === 2 || lockfile.lockfileVersion === 3) {
    return lockfile.lockfileVersion;
  }
  throw new ParseError('package-lock.json uses an unsupported lockfile version.', {
    ...contextFor(options),
    lockfileVersion: typeof lockfile.lockfileVersion === 'string' || typeof lockfile.lockfileVersion === 'number'
      ? String(lockfile.lockfileVersion)
      : 'missing',
    supportedVersions: ['2', '3']
  });
}

function validateRootCompatibility(
  lockfile: Record<string, unknown>,
  packageManifest: PackageManifest,
  options: LockfileReaderOptions
): void {
  validateMatchingString(lockfile, 'name', packageManifest.name, options);
  validateMatchingString(lockfile, 'version', packageManifest.version, options);

  const packages = asOptionalRecord(lockfile.packages, 'packages', options);
  const root = packages?.[''];
  if (root === undefined) return;
  const rootRecord = asRecord(root, 'packages[""].', options);

  validateMatchingString(rootRecord, 'name', packageManifest.name, options, '');
  validateMatchingString(rootRecord, 'version', packageManifest.version, options, '');

  for (const field of DEPENDENCY_FIELDS) {
    const expected = dependencyRecord(packageManifest[field], `package.json.${field}`, options);
    const actualValue = rootRecord[field];
    if (actualValue === undefined) continue;
    const actual = dependencyRecord(actualValue, `packages[""].${field}`, options) ?? {};
    if (expected === undefined) {
      if (Object.keys(actual).length > 0) {
        throwCompatibilityError(`package.json is incompatible with package-lock.json root ${field}.`, options, field);
      }
      continue;
    }
    for (const [name, range] of Object.entries(expected)) {
      if (actual[name] !== range) {
        throwCompatibilityError(`package.json is incompatible with package-lock.json root ${field}.`, options, field);
      }
    }
  }
}

function normalizePackages(
  packages: Record<string, unknown>,
  packageManifest: PackageManifest,
  options: LockfileReaderOptions
): NormalizedLockfilePackage[] {
  return Object.entries(packages)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => normalizePackage(path, value, packageManifest, options));
}

function normalizePackage(
  path: string,
  value: unknown,
  packageManifest: PackageManifest,
  options: LockfileReaderOptions
): NormalizedLockfilePackage {
  validatePackagePath(path, options);
  const entry = asRecord(value, `packages[${JSON.stringify(path)}]`, options);
  const derivedName = path === '' ? packageManifest.name : packageNameFromPath(path);
  const nameValue = entry.name;
  if (nameValue !== undefined && typeof nameValue !== 'string') {
    throwParseError('Lockfile package name must be a string.', options, path, 'name');
  }
  const name = nameValue ?? derivedName;
  if (name === undefined) {
    throwParseError('Lockfile package path does not identify a package name.', options, path, 'name');
  }
  if (path !== '' && derivedName !== undefined && name !== derivedName) {
    throwParseError('Lockfile package name does not match its package path.', options, path, 'name');
  }

  const version = stringField(entry, 'version', options, path);
  const resolvedValue = stringField(entry, 'resolved', options, path);
  const integrity = stringField(entry, 'integrity', options, path);
  const dependencies = dependencyRecord(entry.dependencies, `packages[${JSON.stringify(path)}].dependencies`, options);
  const devDependencies = dependencyRecord(entry.devDependencies, `packages[${JSON.stringify(path)}].devDependencies`, options);
  const optionalDependencies = dependencyRecord(
    entry.optionalDependencies,
    `packages[${JSON.stringify(path)}].optionalDependencies`,
    options
  );
  const peerDependencies = dependencyRecord(
    entry.peerDependencies,
    `packages[${JSON.stringify(path)}].peerDependencies`,
    options
  );
  const peerDependenciesMeta = peerMetadata(entry.peerDependenciesMeta, options, path);
  const bin = binEntries(entry.bin, name, options, path);
  const os = stringArray(entry.os, 'os', options, path);
  const cpu = stringArray(entry.cpu, 'cpu', options, path);
  const engines = dependencyRecord(entry.engines, `packages[${JSON.stringify(path)}].engines`, options);

  return {
    path,
    name,
    ...(version === undefined ? {} : { version }),
    ...(resolvedValue === undefined ? {} : { resolved: sanitizePersistedLocator(resolvedValue) }),
    ...(integrity === undefined ? {} : { integrity }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta }),
    ...optionalBooleanField(entry, 'optional', options, path),
    ...optionalBooleanField(entry, 'dev', options, path),
    ...optionalBooleanField(entry, 'devOptional', options, path),
    ...optionalBooleanField(entry, 'link', options, path),
    ...(bin === undefined ? {} : { bin }),
    ...(os === undefined ? {} : { os }),
    ...(cpu === undefined ? {} : { cpu }),
    ...(engines === undefined ? {} : { engines })
  };
}

function normalizeLegacyDependencies(
  dependenciesValue: unknown,
  packageManifest: PackageManifest,
  options: LockfileReaderOptions
): NormalizedLockfilePackage[] {
  if (dependenciesValue === undefined) return [];
  const dependencies = asRecord(dependenciesValue, 'dependencies', options);
  const result: NormalizedLockfilePackage[] = [];
  for (const [name, value] of Object.entries(dependencies)) {
    normalizeLegacyDependency(name, value, '', result, packageManifest, options);
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeLegacyDependency(
  name: string,
  value: unknown,
  parentPath: string,
  result: NormalizedLockfilePackage[],
  packageManifest: PackageManifest,
  options: LockfileReaderOptions
): void {
  const entry = asRecord(value, `dependencies.${name}`, options);
  const path = parentPath ? `${parentPath}/node_modules/${name}` : `node_modules/${name}`;
  const version = stringField(entry, 'version', options, path);
  if (version === undefined) {
    throwParseError('Legacy lockfile dependency is missing its version.', options, path, 'version');
  }
  const resolved = stringField(entry, 'resolved', options, path);
  const integrity = stringField(entry, 'integrity', options, path);
  const requires = dependencyRecord(entry.requires, `dependencies.${name}.requires`, options);
  const optionalDependencies = dependencyRecord(
    entry.optionalDependencies,
    `dependencies.${name}.optionalDependencies`,
    options
  );
  const peerDependencies = dependencyRecord(entry.peerDependencies, `dependencies.${name}.peerDependencies`, options);
  const bin = binEntries(entry.bin, name, options, path);
  const os = stringArray(entry.os, 'os', options, path);
  const cpu = stringArray(entry.cpu, 'cpu', options, path);
  const packageEntry: NormalizedLockfilePackage = {
    path,
    name,
    version,
    ...(resolved === undefined ? {} : { resolved: sanitizePersistedLocator(resolved) }),
    ...(integrity === undefined ? {} : { integrity }),
    ...(requires === undefined ? {} : { dependencies: requires }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...optionalBooleanField(entry, 'optional', options, path),
    ...optionalBooleanField(entry, 'dev', options, path),
    ...optionalBooleanField(entry, 'devOptional', options, path),
    ...(bin === undefined ? {} : { bin }),
    ...(os === undefined ? {} : { os }),
    ...(cpu === undefined ? {} : { cpu })
  };
  result.push(packageEntry);

  const nested = entry.dependencies;
  if (nested === undefined) return;
  const nestedDependencies = asRecord(nested, `dependencies.${name}.dependencies`, options);
  for (const [nestedName, nestedValue] of Object.entries(nestedDependencies)) {
    normalizeLegacyDependency(nestedName, nestedValue, path, result, packageManifest, options);
  }
}

function packageNameFromPath(path: string): string | undefined {
  const segments = path.split('/');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] !== 'node_modules') continue;
    const first = segments[index + 1];
    if (first === undefined) return undefined;
    if (first.startsWith('@')) {
      const second = segments[index + 2];
      return second === undefined ? undefined : `${first}/${second}`;
    }
    return first;
  }
  return undefined;
}

function dependencyRecord(
  value: unknown,
  field: string,
  options: LockfileReaderOptions
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, field, options);
  const normalized: Record<string, string> = {};
  for (const [name, range] of Object.entries(record)) {
    if (typeof range !== 'string') {
      throwParseError('Lockfile dependency ranges must be strings.', options, undefined, field);
    }
    normalized[name] = range;
  }
  return normalized;
}

function peerMetadata(
  value: unknown,
  options: LockfileReaderOptions,
  packagePath: string
): Readonly<Record<string, { optional?: boolean }>> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'peerDependenciesMeta', options, packagePath);
  const normalized: Record<string, { optional?: boolean }> = {};
  for (const [name, metadata] of Object.entries(record)) {
    const item = asRecord(metadata, `peerDependenciesMeta.${name}`, options, packagePath);
    const optional = item.optional;
    if (optional !== undefined && typeof optional !== 'boolean') {
      throwParseError('Peer dependency metadata optional flag must be boolean.', options, packagePath, 'peerDependenciesMeta');
    }
    normalized[name] = optional === undefined ? {} : { optional };
  }
  return normalized;
}

function binEntries(
  value: unknown,
  packageName: string,
  options: LockfileReaderOptions,
  packagePath: string
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return { [packageName.slice(packageName.lastIndexOf('/') + 1)]: value };
  }
  const record = asRecord(value, 'bin', options, packagePath);
  const normalized: Record<string, string> = {};
  for (const [name, target] of Object.entries(record)) {
    if (typeof target !== 'string') {
      throwParseError('Lockfile bin targets must be strings.', options, packagePath, 'bin');
    }
    normalized[name] = target;
  }
  return normalized;
}

function stringArray(
  value: unknown,
  field: string,
  options: LockfileReaderOptions,
  packagePath: string
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throwParseError(`Lockfile ${field} metadata must be an array of strings.`, options, packagePath, field);
  }
  return [...value] as string[];
}

function stringField(
  record: Record<string, unknown>,
  field: string,
  options: LockfileReaderOptions,
  packagePath: string
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throwParseError(`Lockfile ${field} must be a string.`, options, packagePath, field);
  return value;
}

function optionalBooleanField(
  record: Record<string, unknown>,
  field: string,
  options: LockfileReaderOptions,
  packagePath: string
): { [key: string]: boolean } {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    throwParseError(`Lockfile ${field} flag must be boolean.`, options, packagePath, field);
  }
  return { [field]: value };
}

function validatePackagePath(path: string, options: LockfileReaderOptions): void {
  if (path === '') return;
  if (path.includes('\\') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') || !path.startsWith('node_modules/')) {
    throwParseError('Lockfile package path is not a supported relative node_modules path.', options, path, 'path');
  }
}

function validateMatchingString(
  record: Record<string, unknown>,
  field: string,
  expected: string,
  options: LockfileReaderOptions,
  packagePath?: string
): void {
  const actual = record[field];
  if (actual !== undefined && (typeof actual !== 'string' || actual !== expected)) {
    throwCompatibilityError('package.json is incompatible with package-lock.json.', options, field, packagePath);
  }
}

function asRecord(value: unknown, field: string, options: LockfileReaderOptions, packagePath?: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throwParseError('Lockfile metadata must be a JSON object.', options, packagePath, field);
}

function asOptionalRecord(value: unknown, field: string, options: LockfileReaderOptions): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asRecord(value, field, options);
}

function contextFor(options: LockfileReaderOptions): { projectRoot?: string; sourcePath?: string } {
  return {
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath })
  };
}

function throwParseError(
  message: string,
  options: LockfileReaderOptions,
  packagePath?: string,
  field?: string
): never {
  throw new ParseError(message, {
    ...contextFor(options),
    ...(packagePath === undefined ? {} : { packagePath }),
    ...(field === undefined ? {} : { field })
  });
}

function throwCompatibilityError(
  message: string,
  options: LockfileReaderOptions,
  field: string,
  packagePath?: string
): never {
  throw new ParseError(message, {
    ...contextFor(options),
    field,
    ...(packagePath === undefined ? {} : { packagePath })
  });
}

export type LockfileDocument = JsonObject;
/** Options for deterministic package-lock generation and atomic publication. */
export interface LockfileWriterOptions {
  filesystem: FileSystemAdapter;
  lockfileVersion?: 2 | 3;
  lockfilePath?: string;
}

export interface LockfilePublication {
  lockfilePath: string;
  lockfileHash: string;
  document: LockfileDocument;
}

/**
 * Serializes resolved, source-aware graphs into a canonical package-lock document.
 * Publication is deliberately separate from serialization so callers can prepare
 * the lockfile before publishing a Project Map.
 */
export class LockfileWriter {
  private readonly filesystem: FileSystemAdapter;
  private readonly lockfileVersion: 2 | 3;
  private readonly configuredPath: string | undefined;

  constructor(options: LockfileWriterOptions) {
    this.filesystem = options.filesystem;
    this.lockfileVersion = options.lockfileVersion ?? 3;
    this.configuredPath = options.lockfilePath;
  }

  serialize(project: ResolvedProject, packageManifest: PackageManifest): string {
    return serializeResolvedLockfile(project, packageManifest, this.lockfileVersion);
  }

  /**
   * Writes package-lock.json through a same-directory temporary file. The
   * returned hash is the value a caller must use when publishing its Project Map.
   */
  async publish(project: ResolvedProject, packageManifest: PackageManifest): Promise<LockfilePublication> {
    const lockfilePath = this.configuredPath ?? join(project.projectRoot, 'package-lock.json');
    const text = this.serialize(project, packageManifest);
    const document = JSON.parse(text) as LockfileDocument;

    try {
      await this.filesystem.mkdir(dirname(lockfilePath), { recursive: true });
      await atomicReplaceFile(this.filesystem, lockfilePath, text, {
        temporaryPrefix: '.node-glue-lockfile'
      });
    } catch (cause) {
      throw new PublicationError('Generated package-lock.json could not be published atomically.', {
        projectRoot: project.projectRoot,
        sourcePath: lockfilePath
      }, cause);
    }

    return {
      lockfilePath,
      lockfileHash: hashLockfileText(text),
      document
    };
  }
}

export function serializeResolvedLockfile(
  project: ResolvedProject,
  packageManifest: PackageManifest,
  lockfileVersion: 2 | 3 = 3
): string {
  const packages: Record<string, Record<string, unknown>> = {
    '': rootPackageEntry(packageManifest)
  };
  const instances = new Map(project.packages.map((instance) => [instance.identityHash, instance]));
  const sources = project.sources;

  for (const placement of [...project.placements].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    assertPlacementPath(placement);
    const instance = instances.get(placement.packageIdentityHash);
    if (instance === undefined) {
      throw new InvalidInputError('Resolved graph placement references an unknown Package Instance.', {
        projectRoot: project.projectRoot,
        packageName: placement.packageName,
        identityHash: placement.packageIdentityHash,
        relativePath: placement.relativePath
      });
    }
    if (instance.identity.name !== placement.packageName) {
      throw new InvalidInputError('Resolved graph placement package name does not match its Package Instance.', {
        projectRoot: project.projectRoot,
        packageName: placement.packageName,
        identityHash: placement.packageIdentityHash,
        relativePath: placement.relativePath
      });
    }

    const source = sourceForInstance(instance, sources);
    if (source === undefined) {
      throw new InvalidInputError('Resolved Package Instance has no matching source metadata.', {
        projectRoot: project.projectRoot,
        packageName: placement.packageName,
        identityHash: placement.packageIdentityHash
      });
    }
    packages[placement.relativePath] = packageEntry(instance, source);
  }

  const document: Record<string, unknown> = {
    name: packageManifest.name,
    version: packageManifest.version,
    lockfileVersion,
    requires: true,
    packages
  };
  if (lockfileVersion === 2) {
    document.dependencies = legacyDependencies(project.placements, packages);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

function rootPackageEntry(manifest: PackageManifest): Record<string, unknown> {
  return packageManifestFields(manifest, manifest.name, true);
}

function packageEntry(instance: PackageInstance, source: ResolvedSource): Record<string, unknown> {
  const fields = packageManifestFields(instance.manifest, instance.identity.name, false);
  const resolved = sanitizePersistedLocator(source.resolvedLocator);
  fields.version = instance.manifest.version;
  if (resolved.length > 0) fields.resolved = resolved;
  const integrity = normalizeIntegrity(source.integrity ?? instance.identity.integrity);
  if (integrity !== undefined) fields.integrity = integrity;
  return fields;
}

function packageManifestFields(
  manifest: PackageManifest,
  packageName: string,
  root: boolean
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (root) {
    fields.name = manifest.name;
    fields.version = manifest.version;
  } else {
    fields.version = manifest.version;
  }
  addStringRecord(fields, 'dependencies', manifest.dependencies);
  addStringRecord(fields, 'devDependencies', manifest.devDependencies);
  addStringRecord(fields, 'optionalDependencies', manifest.optionalDependencies);
  addStringRecord(fields, 'peerDependencies', manifest.peerDependencies);
  addPeerMetadata(fields, manifest.peerDependenciesMeta);
  addBin(fields, manifest.bin, packageName);
  addStringArray(fields, 'os', manifest.os);
  addStringArray(fields, 'cpu', manifest.cpu);
  addStringRecord(fields, 'engines', manifest.engines);
  return fields;
}

function addStringRecord(
  target: Record<string, unknown>,
  field: string,
  value: Readonly<Record<string, string>> | undefined
): void {
  if (value === undefined || Object.keys(value).length === 0) return;
  target[field] = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function addPeerMetadata(
  target: Record<string, unknown>,
  value: Readonly<Record<string, { optional?: boolean }>> | undefined
): void {
  if (value === undefined || Object.keys(value).length === 0) return;
  const metadata: Record<string, { optional?: boolean }> = {};
  for (const name of Object.keys(value).sort()) {
    const optional = value[name]?.optional;
    metadata[name] = optional === undefined ? {} : { optional };
  }
  target.peerDependenciesMeta = metadata;
}

function addBin(target: Record<string, unknown>, value: PackageManifest['bin'], packageName: string): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    target.bin = { [packageName.slice(packageName.lastIndexOf('/') + 1)]: value };
    return;
  }
  target.bin = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function addStringArray(target: Record<string, unknown>, field: string, value: readonly string[] | undefined): void {
  if (value === undefined || value.length === 0) return;
  target[field] = [...value].sort();
}

function sourceForInstance(instance: PackageInstance, sources: readonly ResolvedSource[]): ResolvedSource | undefined {
  return sources.find((source) => {
    const identity = packageIdentityFromResolvedSource(source);
    return identity.name === instance.identity.name
      && identity.versionOrRevision === instance.identity.versionOrRevision
      && identity.source === instance.identity.source
      && normalizeIntegrity(identity.integrity) === normalizeIntegrity(instance.identity.integrity);
  });
}

function assertPlacementPath(placement: DependencyPlacement): void {
  const path = placement.relativePath;
  if (
    !path.startsWith('node_modules/')
    || path.includes('\\')
    || path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new InvalidInputError('Resolved graph contains an invalid dependency placement path.', {
      relativePath: path,
      packageName: placement.packageName
    });
  }
}

function legacyDependencies(
  placements: readonly DependencyPlacement[],
  packages: Readonly<Record<string, Record<string, unknown>>>
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const placement of [...placements].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const names = packagePathNames(placement.relativePath);
    if (names.length === 0) continue;
    let cursor = root;
    for (let index = 0; index < names.length - 1; index += 1) {
      const parent = cursor[names[index]!];
      if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) break;
      const nested = (parent as Record<string, unknown>).dependencies;
      if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) break;
      cursor = nested as Record<string, unknown>;
    }
    const entry = packages[placement.relativePath];
    if (entry === undefined) continue;
    const legacyEntry: Record<string, unknown> = {};
    for (const field of ['version', 'resolved', 'integrity', 'optional', 'dev', 'devOptional', 'peer', 'bin', 'os', 'cpu', 'engines'] as const) {
      if (entry[field] !== undefined) legacyEntry[field] = entry[field];
    }
    const dependencies = entry.dependencies;
    if (dependencies !== undefined) legacyEntry.requires = dependencies;
    const optionalDependencies = entry.optionalDependencies;
    if (optionalDependencies !== undefined) legacyEntry.optionalDependencies = optionalDependencies;
    const peerDependencies = entry.peerDependencies;
    if (peerDependencies !== undefined) legacyEntry.peerDependencies = peerDependencies;
    const name = names[names.length - 1]!;
    cursor[name] = legacyEntry;
    if (legacyEntry.requires !== undefined) legacyEntry.dependencies = {};
  }
  return root;
}

function packagePathNames(path: string): string[] {
  const segments = path.split('/');
  const names: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== 'node_modules') continue;
    const first = segments[++index];
    if (first === undefined) break;
    if (first.startsWith('@')) {
      const second = segments[++index];
      if (second === undefined) break;
      names.push(`${first}/${second}`);
    } else {
      names.push(first);
    }
  }
  return names;
}

function hashLockfileText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
