import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import type { SourceAdapter } from '../src/adapters/source.js';
import type { PlatformCapabilityAdapter, PlatformPreparationOptions, ProtectedExecutionContext } from '../src/platform/index.js';
import { IntegrityMismatchError } from '../src/errors.js';
import { LifecycleRunner } from '../src/lifecycle.js';
import { PackageStore, packageStorePath } from '../src/package-store.js';
import { hashPackageIdentity, packageIdentityFromResolvedSource } from '../src/package-identity.js';
import type { FetchedPackage, PackageManifest, ResolvedProject, ResolvedSource } from '../src/types.js';
import { FakeSourceAdapter } from './fixtures/fake-source.js';
import { createFakeFileSystem, type FakeFileSystem } from './fixtures/fake-filesystem.js';
import { propertyTag } from './fixtures/property-tags.js';

interface VerificationCase {
  readonly packageId: number;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly integrityId: number;
}

const verificationCaseArbitrary: fc.Arbitrary<VerificationCase> = fc.record({
  packageId: fc.integer({ min: 0, max: 999_999 }),
  major: fc.integer({ min: 0, max: 99 }),
  minor: fc.integer({ min: 0, max: 99 }),
  patch: fc.integer({ min: 0, max: 99 }),
  integrityId: fc.integer({ min: 0, max: 999_999 })
});

interface PublicationCase {
  readonly packageId: number;
  readonly marker: number;
}

const publicationCaseArbitrary: fc.Arbitrary<PublicationCase> = fc.record({
  packageId: fc.integer({ min: 0, max: 999_999 }),
  marker: fc.integer({ min: 0, max: 999_999 })
});

class MutableContentSourceAdapter implements SourceAdapter {
  readonly fetchCalls: string[] = [];
  marker: number;

  constructor(
    private readonly filesystem: FakeFileSystem,
    private readonly manifest: PackageManifest,
    marker: number
  ) {
    this.marker = marker;
  }

  canHandle(): boolean {
    return true;
  }

  async resolve(source: ResolvedSource['source']): Promise<ResolvedSource> {
    return {
      source,
      name: this.manifest.name,
      versionOrRevision: this.manifest.version,
      resolvedLocator: `https://example.test/${this.manifest.name}.tgz`,
      sourceFingerprint: `tarball:https://example.test/${this.manifest.name}.tgz`,
      integrity: 'sha512-immutable-fixture',
      manifest: this.manifest
    };
  }

  async fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage> {
    this.fetchCalls.push(source.resolvedLocator);
    await this.filesystem.writeFile(join(destination, 'content.txt'), `source-${this.marker}`);
    return {
      manifest: this.manifest,
      contentPath: destination,
      integrity: source.integrity
    };
  }
}

class RecordingLifecycleProcess implements ChildProcessAdapter {
  readonly calls: ProcessSpec[] = [];

  constructor(private readonly filesystem: FakeFileSystem, private readonly marker: string) {}

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec);
    // Simulate a relative lifecycle output. If cwd were central-store content,
    // this would mutate the published package and fail the property below.
    await this.filesystem.writeFile(join(spec.cwd, 'content.txt'), this.marker);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

class RecordingLifecyclePlatform implements PlatformCapabilityAdapter {
  readonly supportsProtectedPaths = true;
  readonly preparations: PlatformPreparationOptions[] = [];

  async prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext> {
    this.preparations.push(options);
    return {
      outputDirectory: options.outputDirectory,
      protectedPaths: options.protectedPaths,
      environment: options.environment ?? {}
    };
  }
}

describe('package store property coverage', () => {
  it(propertyTag(4, 'Verified content is the only content publishable to the store'), async () => {
    await fc.assert(
      fc.asyncProperty(verificationCaseArbitrary, async ({ packageId, major, minor, patch, integrityId }) => {
        const name = `@fixture/package-${packageId}`;
        const version = `${major}.${minor}.${patch}`;
        const expectedIntegrity = `sha512-fixture-${integrityId}`;
        const source: ResolvedSource = {
          source: { kind: 'tarball', url: `https://example.test/${packageId}-${version}.tgz` },
          name,
          versionOrRevision: version,
          resolvedLocator: `https://example.test/${packageId}-${version}.tgz`,
          sourceFingerprint: `tarball:https://example.test/${packageId}-${version}.tgz`,
          integrity: expectedIntegrity,
          manifest: { name, version }
        };

        const matchingFilesystem = createFakeFileSystem('/fixture');
        const matchingAdapter = new FakeSourceAdapter([{
          source: source.source,
          manifest: source.manifest,
          integrity: expectedIntegrity
        }]);
        const matchingStore = new PackageStore({
          filesystem: matchingFilesystem,
          sourceAdapter: matchingAdapter,
          storeDir: '/fixture/store',
          clock: { now: () => new Date('2025-01-01T00:00:00.000Z'), nowIso: () => '2025-01-01T00:00:00.000Z' }
        });

        const published = await matchingStore.ensure(source);
        const identity = packageIdentityFromResolvedSource(source);
        const identityHash = hashPackageIdentity(identity);
        expect(published.identityHash).toBe(identityHash);
        expect(await matchingStore.get(identityHash)).toEqual(published);

        const reuseStore = new PackageStore({
          filesystem: matchingFilesystem,
          sourceAdapter: matchingAdapter,
          storeDir: '/fixture/store'
        });
        expect(await reuseStore.ensure(source)).toEqual(published);
        expect(matchingAdapter.fetchCalls).toHaveLength(1);

        const mismatchedFilesystem = createFakeFileSystem('/fixture');
        const mismatchedAdapter = new FakeSourceAdapter([{
          source: source.source,
          manifest: source.manifest,
          integrity: `${expectedIntegrity}-mismatch`
        }]);
        const mismatchedStore = new PackageStore({
          filesystem: mismatchedFilesystem,
          sourceAdapter: mismatchedAdapter,
          storeDir: '/fixture/store'
        });

        await expect(mismatchedStore.ensure(source)).rejects.toBeInstanceOf(IntegrityMismatchError);
        expect(await mismatchedStore.get(identityHash)).toBeUndefined();
        expect(await mismatchedFilesystem.exists(packageStorePath('/fixture/store', identity))).toBe(false);
        expect(mismatchedAdapter.fetchCalls).toHaveLength(1);
      }),
      { numRuns: 100 }
    );
  });

  it(propertyTag(5, 'Store publication is immutable and script-free'), async () => {
    await fc.assert(
      fc.asyncProperty(publicationCaseArbitrary, async ({ packageId, marker }) => {
        const filesystem = createFakeFileSystem('/fixture');
        const projectRoot = `/fixture/project-${packageId}`;
        const name = `@fixture/immutable-${packageId}`;
        const version = '1.0.0';
        const manifest: PackageManifest = {
          name,
          version,
          scripts: { postinstall: 'write lifecycle output' }
        };
        const source: ResolvedSource = {
          source: { kind: 'tarball', url: `https://example.test/${packageId}.tgz` },
          name,
          versionOrRevision: version,
          resolvedLocator: `https://example.test/${packageId}.tgz`,
          sourceFingerprint: `tarball:https://example.test/${packageId}.tgz`,
          integrity: 'sha512-immutable-fixture',
          manifest
        };
        const adapter = new MutableContentSourceAdapter(filesystem, manifest, marker);
        const store = new PackageStore({
          filesystem,
          sourceAdapter: adapter,
          storeDir: '/fixture/store',
          clock: { now: () => new Date('2025-01-01T00:00:00.000Z'), nowIso: () => '2025-01-01T00:00:00.000Z' }
        });

        const published = await store.ensure(source);
        const contentPath = join(published.contentPath, 'content.txt');
        expect(await filesystem.readTextFile(contentPath)).toBe(`source-${marker}`);

        // A later acquisition of the same identity must reuse the publication,
        // even if the source would now provide different bytes.
        adapter.marker = marker + 1;
        expect(await store.ensure(source)).toEqual(published);
        expect(adapter.fetchCalls).toHaveLength(1);
        expect(await filesystem.readTextFile(contentPath)).toBe(`source-${marker}`);

        // A permitted lifecycle script receives Project Context as cwd. The
        // process fixture writes relative output, proving store content stays unchanged.
        filesystem.seedDirectory(projectRoot);
        const processes = new RecordingLifecycleProcess(filesystem, `lifecycle-${packageId}`);
        const platform = new RecordingLifecyclePlatform();
        const runner = new LifecycleRunner({ processes, filesystem, platform });
        const project: ResolvedProject = {
          projectRoot,
          lockfileHash: `lock-${packageId}`,
          placements: [],
          sources: [source],
          packages: [published]
        };

        await runner.run(project, {
          enabled: true,
          allowedScripts: ['postinstall'],
          outputDirectory: `${projectRoot}/.node-glue/lifecycle`
        });

        expect(processes.calls).toHaveLength(1);
        expect(processes.calls[0].cwd).toBe(projectRoot);
        expect(processes.calls[0].cwd).not.toBe(published.contentPath);
        expect(processes.calls[0].protectedPaths).toContain(published.contentPath);
        expect(platform.preparations[0].projectRoot).toBe(projectRoot);
        expect(platform.preparations[0].protectedPaths).toContain(published.contentPath);
        expect(await filesystem.readTextFile(contentPath)).toBe(`source-${marker}`);
      }),
      { numRuns: 100 }
    );
  });
});
