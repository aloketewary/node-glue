import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  GitSourceAdapter,
  LocalDirectorySourceAdapter,
  RegistrySourceAdapter,
  SourceAdapterRegistry,
  TarballSourceAdapter
} from '../src/sources/index.js';
import { SourceFailureError, UnsupportedSourceError } from '../src/errors.js';
import { createFakeFileSystem, FakeRegistryTransport, FakeSourceTransport } from './fixtures/index.js';

function packageArchive(root: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}): Uint8Array {
  const entries = [
    tarEntry(`${root}/package.json`, JSON.stringify(manifest)),
    ...Object.entries(extra).map(([path, value]) => tarEntry(`${root}/${path}`, value))
  ];
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function tarEntry(path: string, contents: string): Buffer {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
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

describe('source adapters', () => {
  it('resolves registry ranges and fetches a validated npm package archive', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const registry = new FakeRegistryTransport();
    const artifact = packageArchive('package', { name: '@fixture/demo', version: '1.2.0' }, { 'index.js': 'export default 1;' });
    registry.addMetadata('https://registry.example', '@fixture/demo', {
      name: '@fixture/demo',
      versions: { '1.2.0': { name: '@fixture/demo', version: '1.2.0' }, '2.0.0': { name: '@fixture/demo', version: '2.0.0' } },
      dist: { '1.2.0': { tarball: 'https://registry.example/@fixture/demo/-/demo-1.2.0.tgz' } }
    });
    registry.addTarball('https://registry.example/@fixture/demo/-/demo-1.2.0.tgz', { data: artifact });

    const adapter = new RegistrySourceAdapter({ filesystem, transport: registry });
    const resolved = await adapter.resolve({ kind: 'registry', registry: 'https://registry.example/', name: '@fixture/demo', spec: '^1.0.0' });
    const fetched = await adapter.fetch(resolved, '/fixture/download');

    expect(resolved.versionOrRevision).toBe('1.2.0');
    expect(resolved.resolvedLocator).toContain('demo-1.2.0.tgz');
    expect(resolved.environment?.platform).toBe(process.platform);
    expect(fetched.manifest).toMatchObject({ name: '@fixture/demo', version: '1.2.0' });
    expect(await filesystem.exists('/fixture/download/index.js')).toBe(true);
  });

  it('canonicalizes local directories and copies only validated package content', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    filesystem.seedFile('/fixture/packages/local/package.json', JSON.stringify({ name: 'local-package', version: '1.0.0' }));
    filesystem.seedFile('/fixture/packages/local/index.js', 'module.exports = 1;');
    const adapter = new LocalDirectorySourceAdapter({ filesystem });

    const resolved = await adapter.resolve({ kind: 'directory', path: '/fixture/packages/./local' });
    const fetched = await adapter.fetch(resolved, '/fixture/copied');

    expect(resolved.resolvedLocator).toBe('/fixture/packages/local');
    expect(resolved.sourceFingerprint).toBe('directory:/fixture/packages/local');
    expect(fetched.contentPath).toBe('/fixture/copied');
    expect(await filesystem.exists('/fixture/copied/index.js')).toBe(true);
  });

  it('captures Git revisions and extracts Git archives without publishing invalid roots', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const transport = new FakeSourceTransport();
    transport.addGitRevision('https://git.example/repo.git', 'v1', 'https://git.example/repo.git#abc1234', 'abc1234');
    transport.addArtifact('https://git.example/repo.git#abc1234', { data: packageArchive('repo', { name: 'git-package', version: '3.0.0' }) });
    const adapter = new GitSourceAdapter({ filesystem, transport });

    const resolved = await adapter.resolve({ kind: 'git', locator: 'git+https://git.example/repo.git', ref: 'v1' });
    const fetched = await adapter.fetch(resolved, '/fixture/git');

    expect(resolved.versionOrRevision).toBe('abc1234');
    expect(resolved.sourceFingerprint).toContain('#abc1234');
    expect(fetched.manifest.name).toBe('git-package');
  });

  it('rejects tar traversal before creating destination content and reports unsupported formats', async () => {
    const filesystem = createFakeFileSystem('/fixture');
    const transport = new FakeSourceTransport();
    transport.addArtifact('https://example.test/bad.tgz', { data: packageArchive('package/../../escape', { name: 'bad', version: '1.0.0' }) });
    const adapter = new TarballSourceAdapter({ filesystem, transport });
    const resolved = await adapter.resolve({ kind: 'tarball', url: 'https://example.test/bad.tgz' });

    await expect(adapter.fetch(resolved, '/fixture/bad')).rejects.toBeInstanceOf(SourceFailureError);
    expect(await filesystem.exists('/fixture/bad')).toBe(false);
    await expect(new SourceAdapterRegistry([]).resolve({ kind: 'unsupported' } as never)).rejects.toBeInstanceOf(UnsupportedSourceError);
  });
});
