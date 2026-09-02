import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { VERSION } from '../src/index.js';

describe('package scaffold', () => {
  it('exports a package version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('supports help and version CLI flags', () => {
    expect(runCli(['--help'])).toBe(0);
    expect(runCli(['--version'])).toBe(0);
  });
});
