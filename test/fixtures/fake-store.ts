import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { PackageIdentity, PackageInstance, ResolvedSource, StoreOptions } from '../../src/types.js';
import { FailureInjector } from './failure-injection.js';

export interface FakeStoreOptions {
  storeDir?: string;
  verifiedAt?: string;
  failures?: FailureInjector;
}

/** Deterministic in-memory PackageStore double with reuse and publication accounting. */
export class FakePackageStore {
  readonly storeDir: string;
  readonly failures: FailureInjector;
  readonly ensureCalls: ResolvedSource[] = [];
  readonly getCalls: string[] = [];
  private readonly instances = new Map<string, PackageInstance>();
  private readonly verifiedAt: string;

  constructor(options: FakeStoreOptions = {}) {
    this.storeDir = options.storeDir ?? '/fake-store';
    this.verifiedAt = options.verifiedAt ?? '2025-01-01T00:00:00.000Z';
    this.failures = options.failures ?? new FailureInjector();
  }

  async ensure(source: ResolvedSource, _options?: StoreOptions): Promise<PackageInstance> {
    this.failures.check('store.ensure');
    this.ensureCalls.push(source);
    const identity: PackageIdentity = {
      name: source.name,
      versionOrRevision: source.versionOrRevision,
      source: source.sourceFingerprint ?? source.resolvedLocator,
      ...(source.integrity === undefined ? {} : { integrity: source.integrity }),
      ...(source.environment === undefined ? {} : { environment: source.environment })
    };
    const identityHash = packageIdentityHash(identity);
    const existing = this.instances.get(identityHash);
    if (existing !== undefined) return existing;
    const instance: PackageInstance = {
      identity,
      identityHash,
      contentPath: posix.join(this.storeDir, 'packages', encodeName(identity.name), identityHash, 'content'),
      manifest: source.manifest ?? { name: source.name, version: source.versionOrRevision },
      verifiedAt: this.verifiedAt
    };
    this.instances.set(identityHash, instance);
    return instance;
  }

  async get(identityHash: string): Promise<PackageInstance | undefined> {
    this.failures.check('store.get');
    this.getCalls.push(identityHash);
    return this.instances.get(identityHash);
  }

  seed(instance: PackageInstance): this {
    this.instances.set(instance.identityHash, instance);
    return this;
  }

  remove(identityHash: string): boolean {
    return this.instances.delete(identityHash);
  }

  list(): readonly PackageInstance[] {
    return [...this.instances.values()];
  }
}

export function packageIdentityHash(identity: PackageIdentity): string {
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

function encodeName(name: string): string {
  return name.startsWith('@') ? name.slice(1).replace('/', '+') : name;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
