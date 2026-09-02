import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../src/adapters/source.js';
import { IntegrityMismatchError, StoreError } from '../src/errors.js';
import { PackageStore, packageStorePath } from '../src/package-store.js';
import { hashPackageIdentity } from '../src/package-identity.js';
import type { FetchedPackage, PackageManifest, ResolvedSource } from '../src/types.js';
import { createFakeFileSystem, createFailureInjector } from './fixtures/index.js';

const manifest: PackageManifest = {
  name: '@fixture/store-package',
  version: '1.0.0',
  bin: { fixture: 'bin/fixture.js' }
};

const source: ResolvedSource = {
  source: { kind: 'tarball', url: 'https://example.test/store-package.tgz' },
  name: manifest.name,
  versionOrRevision: manifest.version,
  resolvedLocator: 'https://example.test/store-package.tgz',
  sourceFingerprint: 'tarball:https://example.test/store-package.tgz',
  integrity: 'sha512-source-integrity',
  manifest
};

class RecordingSourceAdapter implements SourceAdapter {
  fetchCount = 0;
  fail = false;
  fetchedIntegrity = source.integrity;

  canHandle(): boolean {
    return true;
  }

  async resolve(value: ResolvedSource['source']): Promise<ResolvedSource> {
    return { ...source, source: value };
  }

  async fetch(_source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    this.fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const filesystem = currentFilesystem;
    await filesystem.writeFile(join(destination, 'package.json'), JSON.stringify(manifest));
    await filesystem.mkdir(join(destination, 'bin'), { recursive: true });
    await filesystem.writeFile(join(destination, 'bin/fixture.js'), '#!/usr/bin/env node\n');
    if (this.fail) throw new Error('source failed');
    return {
      manifest,
      contentPath: destination,
      contentDigest: 'sha512-content',
      ...(this.fetchedIntegrity === undefined ? {} : { integrity: this.fetchedIntegrity })
    };
  }
}

// Test source adapters use the same injected filesystem as the store.
let currentFilesystem = createFakeFileSystem('/fixture');

describe('PackageStore', () => {
  it('publishes verified content and metadata under an immutable identity path', async () => {
    currentFilesystem = createFakeFileSystem('/fixture');
    const adapter = new RecordingSourceAdapter();
    const store = new PackageStore({
      filesystem: currentFilesystem,
      sourceAdapter: adapter,
      storeDir: '/fixture/store',
      clock: { now: () => new Date('2025-01-01T00:00:00.000Z'), nowIso: () => '2025-01-01T00:00:00.000Z' }
    });

    const instance = await store.ensure(source);
    const expected = packageStorePath('/fixture/store', sourceIdentity());

    expect(instance.identityHash).toBe(hashPackageIdentity(sourceIdentity()));
    expect(instance.contentPath).toBe(join(expected, 'content'));
    expect(await currentFilesystem.exists(join(expected, 'content/package.json'))).toBe(true);
    expect(await currentFilesystem.exists(join(expected, 'instance.json'))).toBe(true);
    expect(await store.get(instance.identityHash)).toEqual(instance);
  });

  it('reuses a verified identity and serializes concurrent acquisition', async () => {
    currentFilesystem = createFakeFileSystem('/fixture');
    const adapter = new RecordingSourceAdapter();
    const store = new PackageStore({ filesystem: currentFilesystem, sourceAdapter: adapter, storeDir: '/fixture/store' });

    const [first, second, third] = await Promise.all([
      store.ensure(source),
      store.ensure(source),
      store.ensure(source)
    ]);
    const reused = await store.ensure(source);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(reused).toEqual(first);
    expect(adapter.fetchCount).toBe(1);
  });

  it('rejects mismatched source integrity without publishing usable content', async () => {
    currentFilesystem = createFakeFileSystem('/fixture');
    const adapter = new RecordingSourceAdapter();
    adapter.fetchedIntegrity = 'sha512-different';
    const store = new PackageStore({ filesystem: currentFilesystem, sourceAdapter: adapter, storeDir: '/fixture/store' });

    await expect(store.ensure(source)).rejects.toBeInstanceOf(IntegrityMismatchError);
    const expected = packageStorePath('/fixture/store', sourceIdentity());
    expect(await currentFilesystem.exists(expected)).toBe(false);
  });

  it('cleans failed temporary work and leaves no partial publication after rename failure', async () => {
    const failures = createFailureInjector().failNext('filesystem.rename');
    currentFilesystem = createFakeFileSystem('/fixture', failures);
    const adapter = new RecordingSourceAdapter();
    const store = new PackageStore({ filesystem: currentFilesystem, sourceAdapter: adapter, storeDir: '/fixture/store' });

    await expect(store.ensure(source)).rejects.toBeInstanceOf(StoreError);
    expect((await currentFilesystem.listDirectory('/fixture/store/tmp'))).toHaveLength(0);
    const expected = packageStorePath('/fixture/store', sourceIdentity());
    expect(await currentFilesystem.exists(expected)).toBe(false);
  });
});

function sourceIdentity() {
  return {
    name: source.name,
    versionOrRevision: source.versionOrRevision,
    source: source.sourceFingerprint!,
    integrity: source.integrity
  };
}
