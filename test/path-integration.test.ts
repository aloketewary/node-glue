import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PATH_INTEGRATION_END,
  PATH_INTEGRATION_START,
  PathIntegration
} from '../src/npm/path-integration.js';

async function temporaryHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'node-glue-path-'));
}

async function read(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

describe('PathIntegration', () => {
  it('creates tool-owned npm wrappers and one reversible shell integration', async () => {
    const home = await temporaryHome();
    const shellRcPath = join(home, '.bashrc');
    const existingShell = '# existing shell configuration\nexport PATH="/usr/local/bin:$PATH"\n';
    await writeFile(shellRcPath, existingShell);
    const systemNpm = join(home, 'system-npm');
    await writeFile(systemNpm, 'system npm remains unchanged\n');

    const integration = new PathIntegration({
      homeDirectory: home,
      shell: '/bin/bash',
      shellRcPath,
      shimModulePath: '/opt/node-glue/dist/npm/shim.js'
    });

    await expect(integration.enable()).resolves.toBe(join(home, '.node_modules', 'bin'));

    const npmShimPath = join(home, '.node_modules', 'bin', 'npm');
    const npxShimPath = join(home, '.node_modules', 'bin', 'npx');
    const npmShim = await read(npmShimPath);
    const npxShim = await read(npxShimPath);
    const enabledShell = await read(shellRcPath);

    expect(npmShim).toContain('# node-glue npm shim (tool-owned)');
    expect(npmShim).toContain('runNpmShim(process.argv.slice(2)');
    expect(npxShim).toContain("runNpmShim(['npx', ...process.argv.slice(2)]");
    expect(enabledShell).toContain('# existing shell configuration');
    expect(enabledShell).toContain(PATH_INTEGRATION_START);
    expect(enabledShell).toContain(PATH_INTEGRATION_END);
    expect(enabledShell).toContain(`export PATH='${join(home, '.node_modules', 'bin')}'`);
    expect((await lstat(npmShimPath)).mode & 0o111).not.toBe(0);
    expect(await read(systemNpm)).toBe('system npm remains unchanged\n');

    await integration.enable();
    const enabledAgain = await read(shellRcPath);
    expect(enabledAgain.match(new RegExp(PATH_INTEGRATION_START, 'g'))).toHaveLength(1);

    await integration.disable();
    const disabledShell = await read(shellRcPath);
    expect(disabledShell).toContain('# existing shell configuration');
    expect(disabledShell).not.toContain(PATH_INTEGRATION_START);
    expect(disabledShell).not.toContain(PATH_INTEGRATION_END);
    expect(disabledShell).not.toContain(join(home, '.node_modules', 'bin'));
    expect(await read(npmShimPath)).toContain('# node-glue npm shim (tool-owned)');
    expect(await read(systemNpm)).toBe('system npm remains unchanged\n');
  });

  it('refuses to replace an unmanaged executable in the tool-owned bin directory', async () => {
    const home = await temporaryHome();
    const binDirectory = join(home, '.node_modules', 'bin');
    const shellRcPath = join(home, '.bashrc');
    const npmShimPath = join(binDirectory, 'npm');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(binDirectory, { recursive: true }));
    await writeFile(npmShimPath, '#!/bin/sh\necho system npm\n');

    const integration = new PathIntegration({
      homeDirectory: home,
      shell: '/bin/bash',
      shellRcPath
    });

    await expect(integration.enable()).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      context: { path: npmShimPath, reason: 'unmanaged-bin-entry' }
    });
    expect(await read(npmShimPath)).toBe('#!/bin/sh\necho system npm\n');
    expect(await readFile(shellRcPath).catch(() => undefined)).toBeUndefined();
  });
});
