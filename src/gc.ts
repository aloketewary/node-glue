import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { LockAdapter } from './adapters/locks.js';
import { ProjectMapError, StoreError, UnresolvedReferenceError } from './errors.js';
import { hashPackageIdentity, normalizePackageIdentity } from './package-identity.js';
import { validateProjectMap } from './project-map.js';
import type {
  GarbageCollectionResult,
  PackageIdentity,
  PackageInstance,
  PackageManifest,
  ProjectMap
} from './types.js';

const DEFAULT_STORE_DIR = join(homedir(), '.node_modules');
const IDENTITY_HASH = /^[a-f0-9]{64}$/;
const INSTANCE_FILE = 'instance.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface GarbageCollectorOptions {
  filesystem: FileSystemAdapter;
  locks: Pick<LockAdapter, 'acquire'>;
  storeDir?: string;
}

interface PackageCandidate {
  identityHash: string;
  directory: string;
  instance: PackageInstance;
}

/**
 * Removes only verified, unreferenced package instances. Map validation and
 * reference resolution complete before the first deletion, so uncertainty
 * leaves the store unchanged. Transport cache is intentionally never scanned.
 */
export class GarbageCollector {
  readonly storeDir: string;
  private readonly filesystem: FileSystemAdapter;
  private readonly locks: Pick<LockAdapter, 'acquire'>;

  constructor(options: GarbageCollectorOptions) {
    this.filesystem = options.filesystem;
    this.locks = options.locks;
    this.storeDir = resolve(options.storeDir ?? DEFAULT_STORE_DIR);
  }

  async collect(storeDir = this.storeDir): Promise<GarbageCollectionResult> {
    const targetStoreDir = resolve(storeDir);
    const lease = await this.locks.acquire('store', { owner: 'node-glue-garbage-collector' });
    try {
      const maps = await this.readCurrentMaps(targetStoreDir);
      const candidates = await this.readPackageCandidates(targetStoreDir);
      const available = new Map(candidates.map((candidate) => [candidate.identityHash, candidate]));
      const referenced = new Set<string>();

      for (const map of maps) {
        for (const placement of map.placements) referenced.add(placement.packageIdentityHash);
      }
      for (const identityHash of referenced) {
        if (!available.has(identityHash)) {
          throw new UnresolvedReferenceError('Garbage collection found a Project Map reference without a valid Package Instance.', {
            projectId: maps.find((map) => map.placements.some((placement) => placement.packageIdentityHash === identityHash))?.projectId,
            identityHash
          });
        }
      }

      const removedIdentityHashes: string[] = [];
      const retainedIdentityHashes: string[] = [];
      for (const candidate of candidates) {
        if (referenced.has(candidate.identityHash)) {
          retainedIdentityHashes.push(candidate.identityHash);
          continue;
        }
        await this.removeCandidate(candidate);
        removedIdentityHashes.push(candidate.identityHash);
      }

      return {
        removedIdentityHashes: removedIdentityHashes.sort(),
        retainedIdentityHashes: retainedIdentityHashes.sort(),
        scannedProjects: maps.length
      };
    } finally {
      await lease.release();
    }
  }

  private async readCurrentMaps(storeDir: string): Promise<ProjectMap[]> {
    const projectsDir = join(storeDir, 'projects');
    if (!(await this.filesystem.exists(projectsDir))) return [];

    let projects;
    try {
      projects = await this.filesystem.listDirectory(projectsDir);
    } catch (cause) {
      throw new ProjectMapError('Garbage collection could not enumerate Project Maps.', { projectsDir }, cause);
    }

    const maps: ProjectMap[] = [];
    for (const project of projects) {
      if (project.type !== 'directory') continue;
      const mapPath = join(projectsDir, project.name, 'map.json');
      if (!(await this.filesystem.exists(mapPath))) continue;
      let text: string;
      try {
        text = await this.filesystem.readTextFile(mapPath);
      } catch (cause) {
        throw new ProjectMapError('Garbage collection could not read a Project Map.', { mapPath }, cause);
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch (cause) {
        throw new ProjectMapError('Garbage collection found malformed Project Map JSON.', { mapPath }, cause);
      }
      let map: ProjectMap;
      try {
        map = validateProjectMap(value);
      } catch (cause) {
        if (cause instanceof ProjectMapError) {
          throw new ProjectMapError('Garbage collection found an invalid Project Map.', { mapPath }, cause);
        }
        throw cause;
      }
      if (map.projectId !== project.name) {
        throw new ProjectMapError('Project Map identifier does not match its directory.', {
          mapPath,
          projectId: map.projectId,
          directory: project.name
        });
      }
      maps.push(map);
    }
    return maps;
  }

  private async readPackageCandidates(storeDir: string): Promise<PackageCandidate[]> {
    const packagesDir = join(storeDir, 'packages');
    if (!(await this.filesystem.exists(packagesDir))) return [];

    let packageDirectories;
    try {
      packageDirectories = await this.filesystem.listDirectory(packagesDir);
    } catch (cause) {
      throw new StoreError('Garbage collection could not enumerate Package Instances.', { packagesDir }, cause);
    }

    const candidates: PackageCandidate[] = [];
    for (const packageDirectory of packageDirectories) {
      if (packageDirectory.type !== 'directory') continue;
      const packagePath = join(packagesDir, packageDirectory.name);
      let identities;
      try {
        identities = await this.filesystem.listDirectory(packagePath);
      } catch {
        // Unknown or incomplete store entries are retained, never swept.
        continue;
      }
      for (const identityDirectory of identities) {
        if (identityDirectory.type !== 'directory' || !IDENTITY_HASH.test(identityDirectory.name)) continue;
        const directory = join(packagePath, identityDirectory.name);
        const instance = await this.readPackageInstance(directory, identityDirectory.name);
        if (instance !== undefined) candidates.push({
          identityHash: identityDirectory.name,
          directory,
          instance
        });
      }
    }
    return candidates;
  }

  private async readPackageInstance(directory: string, expectedHash: string): Promise<PackageInstance | undefined> {
    const instancePath = join(directory, INSTANCE_FILE);
    if (!(await this.filesystem.exists(instancePath))) return undefined;

    try {
      const value: unknown = JSON.parse(await this.filesystem.readTextFile(instancePath));
      if (!isRecord(value) || typeof value.identityHash !== 'string' || value.identityHash !== expectedHash
        || typeof value.contentPath !== 'string' || typeof value.verifiedAt !== 'string'
        || !isRecord(value.identity) || !isRecord(value.manifest)) return undefined;

      const identityValue = value.identity;
      if (typeof identityValue.name !== 'string' || typeof identityValue.versionOrRevision !== 'string'
        || typeof identityValue.source !== 'string') return undefined;
      const identity = normalizePackageIdentity(identityValue as unknown as PackageIdentity);
      if (hashPackageIdentity(identity) !== expectedHash) return undefined;

      const manifestValue = value.manifest;
      if (typeof manifestValue.name !== 'string' || typeof manifestValue.version !== 'string') return undefined;
      const contentPath = join(directory, 'content');
      if (resolve(value.contentPath) !== resolve(contentPath)
        || manifestValue.name !== identity.name
        || manifestValue.version !== identity.versionOrRevision) return undefined;
      if ((await this.filesystem.lstat(contentPath)).type !== 'directory') return undefined;

      return {
        identity,
        identityHash: expectedHash,
        contentPath,
        manifest: manifestValue as PackageManifest,
        verifiedAt: value.verifiedAt
      };
    } catch {
      // Invalid package entries are retained; a referenced invalid entry is
      // reported as unresolved by the validation pass before sweeping.
      return undefined;
    }
  }

  private async removeCandidate(candidate: PackageCandidate): Promise<void> {
    try {
      await this.filesystem.remove(candidate.directory, { recursive: true });
    } catch (cause) {
      throw new StoreError('Garbage collection could not remove an unreferenced Package Instance.', {
        identityHash: candidate.identityHash,
        path: candidate.directory
      }, cause);
    }
  }
}

export function createGarbageCollector(options: GarbageCollectorOptions): GarbageCollector {
  return new GarbageCollector(options);
}
