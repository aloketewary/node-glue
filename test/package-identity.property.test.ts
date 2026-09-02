import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { hashPackageIdentity } from '../src/package-identity.js';
import type { EnvironmentFingerprint, PackageIdentity } from '../src/types.js';
import { propertyTag } from './fixtures/property-tags.js';

interface IdentityCase {
  readonly identity: PackageIdentity;
  readonly equivalentIdentity: PackageIdentity;
  readonly integrityVariation: PackageIdentity;
  readonly environmentVariations: readonly PackageIdentity[];
}

const identityCaseArbitrary: fc.Arbitrary<IdentityCase> = fc
  .record({
    packageId: fc.integer({ min: 0, max: 999_999 }),
    major: fc.integer({ min: 0, max: 99 }),
    minor: fc.integer({ min: 0, max: 99 }),
    patch: fc.integer({ min: 0, max: 99 }),
    integrityId: fc.integer({ min: 0, max: 999_999 }),
    platform: fc.constantFrom<NonNullable<EnvironmentFingerprint['platform']>>('linux', 'darwin'),
    arch: fc.constantFrom('x64', 'arm64'),
    nodeAbi: fc.integer({ min: 100, max: 999 }).map(String)
  })
  .map(({ packageId, major, minor, patch, integrityId, platform, arch, nodeAbi }) => {
    const name = `@fixture/package-${packageId}`;
    const versionOrRevision = `${major}.${minor}.${patch}`;
    const source = `registry:https://registry.example.test/${name}@${versionOrRevision}`;
    const firstIntegrityToken = `sha512-fixture-${integrityId}`;
    const secondIntegrityToken = `sha256-fixture-${integrityId}`;
    const environment: EnvironmentFingerprint = { platform, arch, nodeAbi };
    const identity: PackageIdentity = {
      name,
      versionOrRevision,
      source,
      integrity: `${firstIntegrityToken} ${secondIntegrityToken}`,
      environment
    };
    const equivalentIdentity: PackageIdentity = {
      name,
      versionOrRevision,
      source: ` ${source} `,
      integrity: `  ${secondIntegrityToken}   ${firstIntegrityToken} `,
      environment: { nodeAbi, platform, arch }
    };

    return {
      identity,
      equivalentIdentity,
      integrityVariation: {
        ...identity,
        integrity: `${firstIntegrityToken}-changed ${secondIntegrityToken}`
      },
      environmentVariations: [
        {
          ...identity,
          environment: { ...environment, platform: platform === 'linux' ? 'darwin' : 'linux' }
        },
        {
          ...identity,
          environment: { ...environment, arch: arch === 'x64' ? 'arm64' : 'x64' }
        },
        {
          ...identity,
          environment: { ...environment, nodeAbi: String(Number(nodeAbi) + 1) }
        }
      ]
    };
  });

describe('package identity property coverage', () => {
  it(propertyTag(3, 'Environment and integrity affect package identity when applicable'), () => {
    fc.assert(
      fc.property(identityCaseArbitrary, ({ identity, equivalentIdentity, integrityVariation, environmentVariations }) => {
        const identityHash = hashPackageIdentity(identity);

        expect(hashPackageIdentity(equivalentIdentity)).toBe(identityHash);
        expect(hashPackageIdentity(integrityVariation)).not.toBe(identityHash);
        for (const environmentVariation of environmentVariations) {
          expect(hashPackageIdentity(environmentVariation)).not.toBe(identityHash);
        }
      }),
      { numRuns: 100 }
    );
  });
});
