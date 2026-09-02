import { posix } from 'node:path';
import type { FileSystemAdapter } from '../../src/adapters/filesystem.js';
import type {
  DependencyPlacement,
  NormalizedLockfile,
  NormalizedLockfilePackage,
  PackageManifest,
  ProjectMap,
  ProjectState
} from '../../src/types.js';
import type { GeneratedPackageGraph } from './graph.js';
import { FakeFileSystem } from './fake-filesystem.js';

export interface PackageLockFixture {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: 2 | 3;
  readonly packages: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly dependencies?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface GenerationFixture {
  readonly projectId: string;
  readonly generation: string;
  readonly projectRoot: string;
  readonly directory: string;
  readonly nodeModulesPath: string;
  readonly markerPath: string;
}

export interface SymlinkFixture {
  readonly path: string;
  readonly target: string;
  readonly kind: 'project-node-modules' | 'package' | 'bin';
}

export function createLockfile(
  version: 2 | 3,
  graph: GeneratedPackageGraph,
  packageJson: PackageManifest = { name: 'fixture-project', version: '1.0.0' }
): NormalizedLockfile {
  const packages: NormalizedLockfilePackage[] = [{
    path: '',
    name: packageJson.name,
    version: packageJson.version,
    dependencies: Object.fromEntries(graph.placements.map((placement) => [placement.packageName, '*']))
  }];
  for (const source of graph.sources) {
    packages.push({
      path: `node_modules/${source.name}`,
      name: source.name,
      version: source.versionOrRevision,
      resolved: source.resolvedLocator,
      ...(source.integrity === undefined ? {} : { integrity: source.integrity }),
      ...(source.manifest?.dependencies === undefined ? {} : { dependencies: source.manifest.dependencies }),
      ...(source.manifest?.peerDependencies === undefined ? {} : { peerDependencies: source.manifest.peerDependencies }),
      ...(source.manifest?.bin === undefined ? {} : { bin: normalizeBin(source.manifest.name, source.manifest.bin) })
    });
  }
  return { lockfileVersion: version, packages };
}

export function createPackageLock(
  version: 2 | 3,
  graph: GeneratedPackageGraph,
  packageJson: PackageManifest = { name: 'fixture-project', version: '1.0.0' }
): PackageLockFixture {
  const packages: Record<string, Readonly<Record<string, unknown>>> = {
    '': {
      name: packageJson.name,
      version: packageJson.version,
      dependencies: Object.fromEntries(graph.placements.map((placement) => [placement.packageName, '*']))
    }
  };
  const dependencies: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const source of graph.sources) {
    const packageData = {
      name: source.name,
      version: source.versionOrRevision,
      resolved: source.resolvedLocator,
      ...(source.integrity === undefined ? {} : { integrity: source.integrity }),
      ...(source.manifest?.dependencies === undefined ? {} : { dependencies: source.manifest.dependencies })
    };
    packages[`node_modules/${source.name}`] = packageData;
    dependencies[source.name] = packageData;
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: version,
    packages,
    ...(version === 2 ? { dependencies } : {})
  };
}

export function createProjectMap(options: Partial<ProjectMap> = {}): ProjectMap {
  return {
    schemaVersion: 1,
    projectId: options.projectId ?? 'fixture-project-1234',
    projectRoot: options.projectRoot ?? '/fixture/project',
    lockfileHash: options.lockfileHash ?? 'fixture-lockfile-hash',
    placements: options.placements ?? [],
    generatedAt: options.generatedAt ?? '2025-01-01T00:00:00.000Z',
    toolVersion: options.toolVersion ?? '0.1.0'
  };
}

export function createProjectState(options: Partial<ProjectState> = {}): ProjectState {
  return {
    schemaVersion: 1,
    projectId: options.projectId ?? 'fixture-project-1234',
    projectRoot: options.projectRoot ?? '/fixture/project',
    updatedAt: options.updatedAt ?? '2025-01-01T00:00:00.000Z',
    status: options.status ?? 'ready',
    ...(options.lastSuccessfulMapGeneration === undefined ? {} : { lastSuccessfulMapGeneration: options.lastSuccessfulMapGeneration }),
    ...(options.lastSuccessfulMaterializationGeneration === undefined ? {} : { lastSuccessfulMaterializationGeneration: options.lastSuccessfulMaterializationGeneration }),
    ...(options.activeTarget === undefined ? {} : { activeTarget: options.activeTarget }),
    ...(options.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: options.lastSuccessfulAt })
  };
}

export function createGeneration(options: {
  projectId?: string;
  generation?: string;
  projectRoot?: string;
  storeDir?: string;
} = {}): GenerationFixture {
  const projectId = options.projectId ?? 'fixture-project-1234';
  const generation = options.generation ?? 'generation-1';
  const directory = posix.join(options.storeDir ?? '/fake-store', 'projects', projectId, 'generations', generation);
  return {
    projectId,
    generation,
    projectRoot: options.projectRoot ?? '/fixture/project',
    directory,
    nodeModulesPath: posix.join(directory, 'node_modules'),
    markerPath: posix.join(directory, '.node-glue-generation')
  };
}

export async function seedGeneration(
  filesystem: FileSystemAdapter,
  generation: GenerationFixture
): Promise<GenerationFixture> {
  await filesystem.mkdir(generation.nodeModulesPath, { recursive: true });
  await filesystem.writeFile(generation.markerPath, JSON.stringify({
    projectId: generation.projectId,
    generation: generation.generation,
    projectRoot: generation.projectRoot
  }));
  return generation;
}

export function createProjectSymlink(projectRoot: string, target: string): SymlinkFixture {
  return { path: posix.join(projectRoot, 'node_modules'), target, kind: 'project-node-modules' };
}

export async function seedProjectSymlink(
  filesystem: FileSystemAdapter,
  projectRoot: string,
  target: string
): Promise<SymlinkFixture> {
  const symlink = createProjectSymlink(projectRoot, target);
  if (!(await filesystem.exists(projectRoot))) await filesystem.mkdir(projectRoot, { recursive: true });
  await filesystem.symlink(symlink.target, symlink.path);
  return symlink;
}

export function graphPlacements(graph: GeneratedPackageGraph): readonly DependencyPlacement[] {
  return graph.placements;
}

function normalizeBin(name: string, bin: string | Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return typeof bin === 'string' ? { [name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name]: bin } : bin;
}
