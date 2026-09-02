import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeGlueApi } from '../src/api.js';
import type { ChildProcessAdapter, ProcessResult, ProcessSpec } from '../src/adapters/process.js';
import type { SourceAdapter } from '../src/adapters/source.js';
import { hashPackageIdentity, packageIdentityFromResolvedSource } from '../src/package-identity.js';
import { PackageStore } from '../src/package-store.js';
import { PosixPlatformCapabilities } from '../src/platform/capabilities.js';
import { createDefaultSourceAdapters } from '../src/sources/index.js';
import { InputReader } from '../src/input-reader.js';
import { NpmShim } from '../src/npm/shim.js';
import { PathIntegration } from '../src/npm/path-integration.js';
import type {
  DependencySource,
  PackageManifest,
  PackageInstance,
  ResolvedProject,
  ResolvedSource
} from '../src/types.js';
import {
  FakeRegistryTransport,
  FakeSourceTransport,
  TemporaryFileSystem,
  writeJsonFile
} from './fixtures/index.js';

const REGISTRY = 'https://registry.fixture.test';
const GIT_LOCATOR = 'git+https://git.fixture.test/repository.git#v1';
const TARBALL_LOCATOR = 'https://tarballs.fixture.test/tar-fixture-1.0.0.tgz';

class RecordingProcesses implements ChildProcessAdapter {
  readonly calls: ProcessSpec[] = [];
  result: ProcessResult = { exitCode: 0, stdout: '', stderr: '' };

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec);
    return this.result;
  }
}

class FixtureSourceAdapter implements SourceAdapter {
  constructor(private readonly source: ResolvedSource) {}

  canHandle(source: DependencySource): boolean {
    return JSON.stringify(source) === JSON.stringify(this.source.source);
  }

  async resolve(): Promise<ResolvedSource> {
    return this.source;
  }

  async fetch(source: ResolvedSource, destination: string) {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(join(destination, 'package.json'), JSON.stringify(source.manifest));
    await fs.writeFile(join(destination, 'index.js'), 'module.exports = true;\n');
    return { manifest: source.manifest!, contentPath: destination, contentDigest: 'fixture-content-digest' };
  }
}

const fs = new TemporaryFileSystem();

interface SourceFixture {
  root: string;
  projectRoot: string;
  storeDir: string;
  localRoot: string;
  registry: FakeRegistryTransport;
  sources: FakeSourceTransport;
  sourceAdapters: readonly SourceAdapter[];
  cleanup(): Promise<void>;
}

async function createSourceFixture(): Promise<SourceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'node-glue-e2e-'));
  const projectRoot = join(root, 'project');
  const localRoot = join(root, 'local-package');
  const storeDir = join(root, 'store');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(localRoot, { recursive: true });
  await writeJsonFile(join(localRoot, 'package.json'), { name: 'local-package', version: '1.0.0' });
  await writeFile(join(localRoot, 'index.js'), 'module.exports = "local";\n');

  const registry = new FakeRegistryTransport();
  const sources = new FakeSourceTransport();
  const registryPackages: Array<{ name: string; version: string; manifest: PackageManifest; url: string }> = [
    {
      name: '@fixture/scoped',
      version: '1.0.0',
      manifest: { name: '@fixture/scoped', version: '1.0.0', bin: { 'scoped-cli': 'bin/cli.js' } },
      url: `${REGISTRY}/@fixture/scoped/-/scoped-1.0.0.tgz`
    },
    {
      name: 'multi',
      version: '1.0.0',
      manifest: { name: 'multi', version: '1.0.0' },
      url: `${REGISTRY}/multi/-/multi-1.0.0.tgz`
    },
    {
      name: 'multi',
      version: '2.0.0',
      manifest: { name: 'multi', version: '2.0.0' },
      url: `${REGISTRY}/multi/-/multi-2.0.0.tgz`
    },
    {
      name: 'peer-host',
      version: '1.0.0',
      manifest: { name: 'peer-host', version: '1.0.0' },
      url: `${REGISTRY}/peer-host/-/peer-host-1.0.0.tgz`
    },
    {
      name: 'peer-consumer',
      version: '1.0.0',
      manifest: { name: 'peer-consumer', version: '1.0.0', peerDependencies: { 'peer-host': '^1.0.0' } },
      url: `${REGISTRY}/peer-consumer/-/peer-consumer-1.0.0.tgz`
    }
  ];
  for (const item of registryPackages) {
    registry.addMetadata(REGISTRY, item.name, {
      name: item.name,
      versions: { [item.version]: item.manifest },
      dist: { [item.version]: { tarball: item.url } }
    });
    registry.addTarball(item.url, { data: packageArchive(item.manifest, item.name === '@fixture/scoped') });
  }

  sources.addArtifact(GIT_LOCATOR, { data: packageArchive({ name: 'git-fixture', version: '1.0.0' }) });
  sources.addGitRevision('https://git.fixture.test/repository.git', 'v1', 'https://git.fixture.test/repository.git#abc123', 'abc123');
  sources.addArtifact(TARBALL_LOCATOR, { data: packageArchive({ name: 'tar-fixture', version: '1.0.0' }) });
  const sourceAdapters = createDefaultSourceAdapters({ filesystem: fs, registry, sources });

  return {
    root,
    projectRoot,
    storeDir,
    localRoot,
    registry,
    sources,
    sourceAdapters,
    async cleanup() { await rm(root, { recursive: true, force: true }); }
  };
}

async function writeCompleteLockfile(fixture: SourceFixture): Promise<void> {
  const dependencies = {
    '@fixture/scoped': '1.0.0',
    multi: '1.0.0',
    'peer-host': '1.0.0',
    'peer-consumer': '1.0.0',
    'local-package': 'file:../local-package',
    'git-fixture': 'git+https://git.fixture.test/repository.git#v1',
    'tar-fixture': TARBALL_LOCATOR
  };
  await writeJsonFile(join(fixture.projectRoot, 'package.json'), {
    name: 'complete-fixture-project', version: '1.0.0', private: true, dependencies
  });
  await writeJsonFile(join(fixture.projectRoot, 'package-lock.json'), {
    name: 'complete-fixture-project', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'complete-fixture-project', version: '1.0.0', dependencies },
      'node_modules/@fixture/scoped': { name: '@fixture/scoped', version: '1.0.0', resolved: `${REGISTRY}/@fixture/scoped/-/scoped-1.0.0.tgz` },
      'node_modules/multi': { name: 'multi', version: '1.0.0', resolved: `${REGISTRY}/multi/-/multi-1.0.0.tgz` },
      'node_modules/peer-host': { name: 'peer-host', version: '1.0.0', resolved: `${REGISTRY}/peer-host/-/peer-host-1.0.0.tgz` },
      'node_modules/peer-consumer': {
        name: 'peer-consumer', version: '1.0.0', resolved: `${REGISTRY}/peer-consumer/-/peer-consumer-1.0.0.tgz`,
        peerDependencies: { 'peer-host': '^1.0.0' }
      },
      'node_modules/peer-consumer/node_modules/multi': { name: 'multi', version: '2.0.0', resolved: `${REGISTRY}/multi/-/multi-2.0.0.tgz` },
      'node_modules/local-package': { name: 'local-package', version: '1.0.0', resolved: 'file:../local-package' },
      'node_modules/git-fixture': { name: 'git-fixture', version: '1.0.0', resolved: GIT_LOCATOR },
      'node_modules/tar-fixture': { name: 'tar-fixture', version: '1.0.0', resolved: TARBALL_LOCATOR }
    }
  });
}

function apiFor(fixture: SourceFixture, processes?: ChildProcessAdapter) {
  return createNodeGlueApi({
    filesystem: fs,
    sourceAdapters: fixture.sourceAdapters,
    packageStoreOptions: { storeDir: fixture.storeDir },
    ...(processes === undefined ? {} : { processes }),
    toolVersion: 'fixture-test'
  });
}

function packageArchive(manifest: PackageManifest, includeBin = false): Uint8Array {
  const entries = [tarEntry(`package/package.json`, JSON.stringify(manifest))];
  if (includeBin) entries.push(tarEntry('package/bin/cli.js', '#!/usr/bin/env node\n'));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function tarEntry(path: string, contents: string): Buffer {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(0x20, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function hashFor(source: ResolvedSource): string {
  return hashPackageIdentity(packageIdentityFromResolvedSource(source));
}

describe('temporary-fixture end-to-end integration', () => {
  it('acquires all source kinds, materializes exact placements, reuses immutable content, reports Doctor state, and collects only unreferenced content', async () => {
    const fixture = await createSourceFixture();
    try {
      await writeCompleteLockfile(fixture);
      const registrySourceAdapter = fixture.sourceAdapters.find((adapter) => adapter.canHandle({ kind: 'registry', registry: REGISTRY, name: '@fixture/scoped', spec: '^1.0.0' }));
      const localSourceAdapter = fixture.sourceAdapters.find((adapter) => adapter.canHandle({ kind: 'directory', path: fixture.localRoot }));
      const gitSourceAdapter = fixture.sourceAdapters.find((adapter) => adapter.canHandle({ kind: 'git', locator: 'git+https://git.fixture.test/repository.git', ref: 'v1' }));
      const tarballSourceAdapter = fixture.sourceAdapters.find((adapter) => adapter.canHandle({ kind: 'tarball', url: TARBALL_LOCATOR }));
      expect((await registrySourceAdapter!.resolve({ kind: 'registry', registry: REGISTRY, name: '@fixture/scoped', spec: '^1.0.0' })).versionOrRevision).toBe('1.0.0');
      expect((await localSourceAdapter!.resolve({ kind: 'directory', path: fixture.localRoot })).resolvedLocator).toBe(await fs.realpath(fixture.localRoot));
      expect((await gitSourceAdapter!.resolve({ kind: 'git', locator: 'git+https://git.fixture.test/repository.git', ref: 'v1' })).versionOrRevision).toBe('abc123');
      expect((await tarballSourceAdapter!.resolve({ kind: 'tarball', url: TARBALL_LOCATOR })).source.kind).toBe('tarball');
      const api = apiFor(fixture);
      const first = await api.ensureProject({ projectRoot: fixture.projectRoot, registry: REGISTRY });
      expect(first.packagesAdded).toBe(8);
      expect(fixture.registry.tarballCalls.length).toBeGreaterThanOrEqual(5);
      expect(fixture.sources.fetchCalls).toEqual(expect.arrayContaining([GIT_LOCATOR, TARBALL_LOCATOR]));

      const rootNodeModules = join(fixture.projectRoot, 'node_modules');
      expect((await fs.lstat(rootNodeModules)).type).toBe('symlink');
      const activeTarget = await fs.realpath(rootNodeModules);
      expect(activeTarget).toContain('/projects/');
      expect(await fs.lstat(join(activeTarget, '@fixture/scoped'))).toMatchObject({ type: 'symlink' });
      expect(await fs.lstat(join(activeTarget, 'peer-consumer/node_modules/multi'))).toMatchObject({ type: 'symlink' });
      expect(await fs.lstat(join(activeTarget, '.bin/scoped-cli'))).toMatchObject({ type: 'symlink' });

      const mapPath = join(fixture.storeDir, 'projects');
      const projectEntries = await fs.listDirectory(mapPath);
      expect(projectEntries.filter((entry) => entry.type === 'directory')).toHaveLength(1);
      const mapDocument = JSON.parse(await fs.readTextFile(join(mapPath, projectEntries[0]!.name, 'map.json'))) as { placements: Array<{ packageName: string; peerContext?: Record<string, string> }> };
      expect(mapDocument.placements.map((placement) => placement.packageName)).toEqual(expect.arrayContaining(['@fixture/scoped', 'local-package', 'git-fixture', 'tar-fixture']));
      expect(mapDocument.placements.filter((placement) => placement.packageName === 'multi')).toHaveLength(2);
      expect(mapDocument.placements.find((placement) => placement.packageName === 'peer-consumer')?.peerContext).toEqual({ 'peer-host': '1.0.0' });

      const second = await api.ensureProject({ projectRoot: fixture.projectRoot, registry: REGISTRY });
      expect(second.packagesAdded).toBe(0);
      expect(second.packagesReused).toBe(8);
      expect(second.materializationGeneration).toBe(first.materializationGeneration);

      const doctor = await api.doctorProject!(await fs.realpath(fixture.projectRoot));
      expect(doctor.status).toBe('ready');
      expect(doctor.findings.filter((finding) => finding.severity === 'error')).toHaveLength(0);

      const unusedSource: ResolvedSource = {
        source: { kind: 'registry', registry: REGISTRY, name: 'unused-fixture', spec: '1.0.0' },
        name: 'unused-fixture', versionOrRevision: '1.0.0', resolvedLocator: `${REGISTRY}/unused-fixture/-/unused-fixture-1.0.0.tgz`,
        sourceFingerprint: `registry:${REGISTRY}/unused-fixture@1.0.0`, manifest: { name: 'unused-fixture', version: '1.0.0' }
      };
      fixture.registry.addTarball(unusedSource.resolvedLocator, { data: packageArchive(unusedSource.manifest!) });
      const unusedRegistryAdapter = fixture.sourceAdapters.find((adapter) => adapter.canHandle(unusedSource.source));
      expect(unusedRegistryAdapter).toBeDefined();
      const unused = await new PackageStore({ filesystem: fs, sourceAdapter: unusedRegistryAdapter!, storeDir: fixture.storeDir }).ensure(unusedSource);
      const collected = await api.garbageCollect(fixture.storeDir);
      expect(collected.removedIdentityHashes).toContain(unused.identityHash);
      expect(collected.retainedIdentityHashes).toHaveLength(8);
      expect(await fs.exists(unused.contentPath)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates and publishes a lockfile for a no-lockfile project through injected resolver and source seams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-glue-no-lock-'));
    const projectRoot = join(root, 'project');
    const storeDir = join(root, 'store');
    try {
      await mkdir(projectRoot, { recursive: true });
      await writeJsonFile(join(projectRoot, 'package.json'), {
        name: 'no-lock-project', version: '1.0.0', private: true, dependencies: { 'fixture-no-lock': '1.0.0' }
      });
      const source: ResolvedSource = {
        source: { kind: 'registry', registry: REGISTRY, name: 'fixture-no-lock', spec: '1.0.0' },
        name: 'fixture-no-lock', versionOrRevision: '1.0.0', resolvedLocator: 'fixture:fixture-no-lock',
        sourceFingerprint: 'fixture:fixture-no-lock@1.0.0', manifest: { name: 'fixture-no-lock', version: '1.0.0' }
      };
      const instance: PackageInstance = {
        identity: packageIdentityFromResolvedSource(source), identityHash: hashFor(source), contentPath: '',
        manifest: source.manifest!, verifiedAt: new Date(0).toISOString()
      };
      const resolver = { resolve: async (): Promise<ResolvedProject> => ({
        projectRoot, lockfileHash: 'package-json-hash', sources: [source], packages: [instance],
        placements: [{ relativePath: 'node_modules/fixture-no-lock', packageIdentityHash: instance.identityHash, packageName: 'fixture-no-lock' }]
      }) };
      const api = createNodeGlueApi({
        filesystem: fs, resolver, sourceAdapter: new FixtureSourceAdapter(source),
        packageStoreOptions: { storeDir }, toolVersion: 'fixture-test'
      });
      await api.ensureProject({ projectRoot });
      const generated = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, unknown> };
      expect(generated.lockfileVersion).toBe(3);
      expect(generated.packages['node_modules/fixture-no-lock']).toBeDefined();
      expect((await fs.lstat(join(projectRoot, 'node_modules'))).type).toBe('symlink');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses unmanaged node_modules and leaves its content unchanged', async () => {
    const fixture = await createSourceFixture();
    try {
      await writeCompleteLockfile(fixture);
      const api = apiFor(fixture);
      await api.ensureProject({ projectRoot: fixture.projectRoot, registry: REGISTRY });
      await rm(join(fixture.projectRoot, 'node_modules'));
      await mkdir(join(fixture.projectRoot, 'node_modules'), { recursive: true });
      const marker = join(fixture.projectRoot, 'node_modules', 'developer-file.txt');
      await writeFile(marker, 'preserve-me');

      await expect(api.ensureProject({ projectRoot: fixture.projectRoot, registry: REGISTRY })).rejects.toMatchObject({ code: 'UNMANAGED_NODE_MODULES' });
      expect(await readFile(marker, 'utf8')).toBe('preserve-me');
      expect((await fs.lstat(join(fixture.projectRoot, 'node_modules'))).type).toBe('directory');
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs only explicitly allowed lifecycle scripts in project context with protected store paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-glue-lifecycle-'));
    const projectRoot = join(root, 'project');
    const storeDir = join(root, 'store');
    const processes = new RecordingProcesses();
    try {
      await mkdir(projectRoot, { recursive: true });
      await writeJsonFile(join(projectRoot, 'package.json'), { name: 'lifecycle-project', version: '1.0.0', dependencies: { 'lifecycle-fixture': '1.0.0' } });
      const source: ResolvedSource = {
        source: { kind: 'registry', registry: REGISTRY, name: 'lifecycle-fixture', spec: '1.0.0' },
        name: 'lifecycle-fixture', versionOrRevision: '1.0.0', resolvedLocator: 'fixture:lifecycle-fixture', sourceFingerprint: 'fixture:lifecycle-fixture@1.0.0',
        manifest: { name: 'lifecycle-fixture', version: '1.0.0', scripts: { postinstall: 'echo fixture' } }
      };
      const instance: PackageInstance = { identity: packageIdentityFromResolvedSource(source), identityHash: hashFor(source), contentPath: '', manifest: source.manifest!, verifiedAt: new Date(0).toISOString() };
      const resolver = { resolve: async (): Promise<ResolvedProject> => ({ projectRoot, lockfileHash: 'fixture-lock', sources: [source], packages: [instance], placements: [{ relativePath: 'node_modules/lifecycle-fixture', packageIdentityHash: instance.identityHash, packageName: 'lifecycle-fixture' }] }) };
      const api = createNodeGlueApi({ filesystem: fs, resolver, sourceAdapter: new FixtureSourceAdapter(source), packageStoreOptions: { storeDir }, processes, toolVersion: 'fixture-test' });
      await api.ensureProject({ projectRoot, lifecyclePolicy: { enabled: true, allowedScripts: ['postinstall'], outputDirectory: join(root, 'outputs') } });
      expect(processes.calls).toHaveLength(1);
      expect(processes.calls[0]).toMatchObject({ cwd: projectRoot, args: ['-c', 'echo fixture'], stdin: 'ignore' });
      expect(processes.calls[0]?.protectedPaths).toEqual(expect.arrayContaining([join(storeDir, 'packages')]));
      expect(processes.calls[0]?.env?.NODE_GLUE_LIFECYCLE_OUTPUT).toBe(join(root, 'outputs'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exercises npm shim delegation, ci cleanup, pass-through commands, and reversible PATH integration', async () => {
    const fixture = await createSourceFixture();
    const processes = new RecordingProcesses();
    try {
      await writeCompleteLockfile(fixture);
      const api = apiFor(fixture, processes);
      const events: string[] = [];
      const shim = new NpmShim({
        api,
        processes,
        realNpm: '/fixture/real-npm',
        npx: '/fixture/real-npx',
        validateLockfile: async (projectRoot) => { await new InputReader({ filesystem: fs }).readRoot(projectRoot); events.push('validate'); },
        cleanupToolOwnedLinks: async () => { events.push('cleanup'); }
      });
      await shim.dispatch(['install', '--save-exact'], { cwd: fixture.projectRoot, registry: REGISTRY, storeDir: fixture.storeDir });
      await shim.dispatch(['ci'], { cwd: fixture.projectRoot, storeDir: fixture.storeDir });
      await shim.dispatch(['run', 'build', '--', '--fixture'], { cwd: fixture.projectRoot, storeDir: fixture.storeDir });
      await shim.dispatch(['npx', '--yes', 'fixture-tool'], { cwd: fixture.projectRoot, storeDir: fixture.storeDir });
      await shim.dispatch(['config', 'get', 'registry'], { cwd: fixture.projectRoot });
      expect(events).toEqual(['validate', 'cleanup']);
      expect(processes.calls.map((call) => [call.executable, ...call.args])).toEqual([
        ['/fixture/real-npm', 'install', '--save-exact', '--package-lock-only', '--ignore-scripts'],
        ['/fixture/real-npm', 'run', 'build', '--', '--fixture'],
        ['/fixture/real-npx', '--yes', 'fixture-tool'],
        ['/fixture/real-npm', 'config', 'get', 'registry']
      ]);

      const home = join(fixture.root, 'home');
      const integration = new PathIntegration({ homeDirectory: home, binDirectory: join(home, 'bin'), shell: '/bin/sh' });
      await integration.enable();
      const enabled = await readFile(integration.shellRcPath, 'utf8');
      expect(enabled).toContain('node-glue PATH integration');
      await integration.disable();
      expect(await readFile(integration.shellRcPath, 'utf8')).not.toContain('node-glue PATH integration');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('macOS/Linux filesystem and symlink smoke checks', () => {
  it('verifies required temporary filesystem, symlink, and protected-path capabilities', async () => {
    const supported = process.platform === 'darwin' || process.platform === 'linux';
    if (!supported) {
      console.info(`[SKIP] Node Glue MVP smoke coverage requires macOS/Linux; host=${process.platform}`);
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'node-glue-capability-'));
    try {
      const target = join(root, 'target');
      const link = join(root, 'link');
      const output = join(root, 'output');
      await mkdir(target, { recursive: true });
      await fs.symlink(target, link);
      expect((await fs.lstat(link)).type).toBe('symlink');
      expect(await fs.realpath(link)).toBe(await fs.realpath(target));
      const capabilities = new PosixPlatformCapabilities(fs);
      expect(capabilities.supportsProtectedPaths).toBe(true);
      const context = await capabilities.prepare({ projectRoot: root, outputDirectory: output, protectedPaths: [join(root, 'store', 'packages')] });
      expect(context.environment.NODE_GLUE_PROJECT_ROOT).toBe(root);
      expect(await fs.lstat(output)).toMatchObject({ type: 'directory' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
