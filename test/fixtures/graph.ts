import type { DependencyPlacement, PackageInstance, PackageManifest, ResolvedSource } from '../../src/types.js';
import { packageIdentityHash } from './fake-store.js';

export interface GeneratedPackageGraph {
  readonly projectRoot: string;
  readonly packages: readonly PackageInstance[];
  readonly sources: readonly ResolvedSource[];
  readonly placements: readonly DependencyPlacement[];
}

export interface PackageGraphOptions {
  count?: number;
  projectRoot?: string;
  scopedEvery?: number;
  includeBins?: boolean;
}

/** Creates deterministic direct package graphs suitable for unit and property inputs. */
export function createPackageGraph(options: PackageGraphOptions = {}): GeneratedPackageGraph {
  const count = options.count ?? 3;
  if (!Number.isInteger(count) || count < 0) throw new RangeError('Graph count must be a non-negative integer');
  const projectRoot = options.projectRoot ?? '/fixture/project';
  const packages: PackageInstance[] = [];
  const sources: ResolvedSource[] = [];
  const placements: DependencyPlacement[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = options.scopedEvery !== undefined && options.scopedEvery > 0 && index % options.scopedEvery === 0
      ? `@fixture/package-${index}`
      : `fixture-package-${index}`;
    const version = `1.0.${index}`;
    const manifest: PackageManifest = {
      name,
      version,
      ...(options.includeBins === true ? { bin: { [`${name.replace('@fixture/', '')}`]: 'bin/cli.js' } } : {})
    };
    const source: ResolvedSource = {
      source: { kind: 'registry', registry: 'https://registry.example.test', name, spec: version },
      name,
      versionOrRevision: version,
      resolvedLocator: `https://registry.example.test/${name}/-/${name.replace('@fixture/', '')}-${version}.tgz`,
      sourceFingerprint: `registry:https://registry.example.test/${name}@${version}`,
      integrity: `sha512-fixture-${index}`,
      manifest
    };
    const identity = {
      name,
      versionOrRevision: version,
      source: source.sourceFingerprint ?? source.resolvedLocator,
      ...(source.integrity === undefined ? {} : { integrity: source.integrity })
    };
    packages.push({
      identity,
      identityHash: packageIdentityHash(identity),
      contentPath: `/fake-store/packages/${name.replace('/', '+')}/${packageIdentityHash(identity)}/content`,
      manifest,
      verifiedAt: '2025-01-01T00:00:00.000Z'
    });
    sources.push(source);
    placements.push({
      relativePath: `node_modules/${name}`,
      packageIdentityHash: packageIdentityHash(identity),
      packageName: name,
      ...(options.includeBins === true ? { binEntries: { [name.replace('@fixture/', '')]: 'bin/cli.js' } } : {})
    });
  }
  return { projectRoot, packages, sources, placements };
}
