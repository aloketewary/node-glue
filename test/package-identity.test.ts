import { describe, expect, it } from 'vitest';
import {
  hashPackageIdentity,
  normalizePackageIdentity,
  packageIdentityFromResolvedSource,
  serializePackageIdentity
} from '../src/package-identity.js';
import type { PackageIdentity, ResolvedSource } from '../src/types.js';

const baseIdentity: PackageIdentity = {
  name: '@scope/package',
  versionOrRevision: '1.2.3',
  source: 'registry:https://registry.example/@scope/package@1.2.3'
};

describe('package identity', () => {
  it('serializes complete scoped names and fields in deterministic order', () => {
    const first = {
      ...baseIdentity,
      integrity: 'sha512-integrity sha256-integrity',
      environment: { nodeAbi: '115', arch: 'x64', platform: 'linux' }
    } satisfies PackageIdentity;
    const equivalent = {
      ...baseIdentity,
      integrity: '  sha256-integrity   sha512-integrity ',
      environment: { platform: 'linux', arch: 'x64', nodeAbi: '115' }
    } satisfies PackageIdentity;

    expect(serializePackageIdentity(first)).toBe(serializePackageIdentity(equivalent));
    expect(JSON.parse(serializePackageIdentity(first))).toEqual({
      name: '@scope/package',
      versionOrRevision: '1.2.3',
      source: 'registry:https://registry.example/@scope/package@1.2.3',
      integrity: 'sha256-integrity sha512-integrity',
      environment: { platform: 'linux', arch: 'x64', nodeAbi: '115' }
    });
  });

  it('produces a stable SHA-256 store key for equivalent identities', () => {
    const first = normalizePackageIdentity({
      ...baseIdentity,
      source: ' registry:https://registry.example/@scope/package@1.2.3 ',
      integrity: 'sha512-integrity',
      environment: { platform: 'linux' }
    });
    const equivalent = normalizePackageIdentity({
      ...baseIdentity,
      integrity: '  sha512-integrity  ',
      environment: { platform: 'linux', arch: undefined, nodeAbi: undefined }
    });

    expect(hashPackageIdentity(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPackageIdentity(first)).toBe(hashPackageIdentity(equivalent));
  });

  it('changes identity when applicable source, integrity, or environment changes', () => {
    const identity = { ...baseIdentity, integrity: 'sha512-integrity', environment: { platform: 'linux', arch: 'x64', nodeAbi: '115' } };
    const variations: PackageIdentity[] = [
      { ...identity, name: '@scope/other-package' },
      { ...identity, versionOrRevision: '1.2.4' },
      { ...identity, source: 'git:https://git.example/repo#revision' },
      { ...identity, integrity: 'sha512-other-integrity' },
      { ...identity, environment: { ...identity.environment, platform: 'darwin' } },
      { ...identity, environment: { ...identity.environment, arch: 'arm64' } },
      { ...identity, environment: { ...identity.environment, nodeAbi: '116' } }
    ];

    const hash = hashPackageIdentity(identity);
    for (const variation of variations) {
      expect(hashPackageIdentity(variation)).not.toBe(hash);
    }
  });

  it('uses the resolved source fingerprint and omits unavailable identity attributes', () => {
    const resolved: ResolvedSource = {
      source: { kind: 'git', locator: 'https://git.example/repo', ref: 'main' },
      name: '@scope/package',
      versionOrRevision: 'abc1234',
      resolvedLocator: 'https://git.example/repo#abc1234',
      sourceFingerprint: 'git:https://git.example/repo#abc1234'
    };

    expect(packageIdentityFromResolvedSource(resolved)).toEqual({
      name: '@scope/package',
      versionOrRevision: 'abc1234',
      source: 'git:https://git.example/repo#abc1234'
    });
  });
});
