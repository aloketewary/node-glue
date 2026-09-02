import { dirname, join, posix, relative, resolve } from 'node:path';
import type { FileSystemAdapter } from './adapters/filesystem.js';
import { InvalidInputError, PublicationError } from './errors.js';
import type { DependencyPlacement, PackageInstance } from './types.js';

export interface BinLinkPlan {
  readonly linkPath: string;
  /** Relative link target, matching npm's project-local .bin layout. */
  readonly target: string;
  readonly packagePath: string;
  readonly packageName: string;
  readonly binName: string;
  readonly sourcePath: string;
}

export interface BinLinkPackage {
  readonly placement: DependencyPlacement;
  readonly packagePath: string;
  readonly instance: PackageInstance;
}

/**
 * Build deterministic project-local executable links for a set of placements.
 * The returned targets are relative to each .bin directory, so the links remain
 * valid when the complete generation is moved into its final location.
 */
export function planBinLinks(
  nodeModulesPath: string,
  packages: readonly BinLinkPackage[]
): readonly BinLinkPlan[] {
  const plans: BinLinkPlan[] = [];
  const seen = new Set<string>();

  for (const { placement, packagePath, instance } of packages) {
    const entries = placement.binEntries ?? manifestBinEntries(instance.manifest.bin, instance.manifest.name);
    for (const [binName, binPath] of Object.entries(entries)) {
      validateBinName(binName, placement.packageName);
      const normalizedBinPath = normalizeBinPath(binPath, placement.packageName, binName);

      const binDirectory = binDirectoryFor(nodeModulesPath, packagePath);
      const linkPath = join(binDirectory, binName);
      if (seen.has(resolve(linkPath))) {
        throw new PublicationError('Dependency tree contains duplicate executable entries.', {
          path: linkPath,
          packageName: placement.packageName,
          binName
        });
      }
      seen.add(resolve(linkPath));

      const packageTarget = join(packagePath, ...normalizedBinPath.split('/'));
      const target = relative(dirname(linkPath), packageTarget);
      if (target.length === 0 || target.startsWith('/') || target.split('/').includes('..') && !target.startsWith('../')) {
        throw new PublicationError('Executable entry target cannot be represented safely.', {
          path: linkPath,
          packageName: placement.packageName,
          binName
        });
      }
      plans.push({
        linkPath,
        target,
        packagePath,
        packageName: placement.packageName,
        binName,
        sourcePath: join(instance.contentPath, ...normalizedBinPath.split('/'))
      });
    }
  }

  return plans;
}

export async function createBinLinks(
  filesystem: FileSystemAdapter,
  plans: readonly BinLinkPlan[]
): Promise<void> {
  for (const plan of plans) {
    await filesystem.mkdir(dirname(plan.linkPath), { recursive: true });
    await filesystem.symlink(plan.target, plan.linkPath);
  }
}

/** Validate targets before links are created, including central-store files. */
export async function validateBinLinkPlans(
  filesystem: FileSystemAdapter,
  plans: readonly BinLinkPlan[]
): Promise<void> {
  for (const plan of plans) {
    const metadata = await safeLstat(filesystem, plan.sourcePath);
    if (metadata === undefined || metadata.type !== 'file') {
      throw new PublicationError('Package executable target is missing or is not a file.', {
        path: plan.sourcePath,
        packageName: plan.packageName,
        binName: plan.binName
      });
    }
  }
}

/** Return the .bin directory associated with a package placement. */
export function binDirectoryFor(nodeModulesPath: string, packagePath: string): string {
  const root = resolve(nodeModulesPath);
  const packageRelative = relative(root, resolve(packagePath)).replaceAll('\\', '/');
  const segments = packageRelative.split('/').filter(Boolean);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0) return join(root, '.bin');
  if (nodeModulesIndex === segments.length - 1) {
    throw new InvalidInputError('Package placement is not below a node_modules directory.', {
      packagePath
    });
  }
  return join(root, ...segments.slice(0, nodeModulesIndex + 1), '.bin');
}

function manifestBinEntries(
  bin: string | Readonly<Record<string, string>> | undefined,
  packageName: string
): Readonly<Record<string, string>> {
  if (bin === undefined) return {};
  if (typeof bin === 'string') return { [defaultBinName(packageName)]: bin };
  return bin;
}

function defaultBinName(packageName: string): string {
  const slash = packageName.lastIndexOf('/');
  return slash < 0 ? packageName : packageName.slice(slash + 1);
}

function validateBinName(name: string, packageName: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new PublicationError('Package executable name is unsafe.', { packageName, binName: name });
  }
}

function normalizeBinPath(path: string, packageName: string, binName: string): string {
  if (typeof path !== 'string') {
    throw new PublicationError('Package executable target path is not a string.', { packageName, binName });
  }
  const normalizedInput = path.startsWith('./') ? path.slice(2) : path;
  if (
    normalizedInput.length === 0 ||
    normalizedInput.startsWith('/') ||
    normalizedInput.includes('\\') ||
    normalizedInput.includes('\0') ||
    posix.normalize(normalizedInput) !== normalizedInput ||
    normalizedInput === '.' ||
    normalizedInput === '..' ||
    normalizedInput.startsWith('../')
  ) {
    throw new PublicationError('Package executable target path is unsafe.', { packageName, binName });
  }
  return normalizedInput;
}

async function safeLstat(filesystem: FileSystemAdapter, path: string) {
  try {
    return await filesystem.lstat(path);
  } catch {
    return undefined;
  }
}
