import { createHash } from 'node:crypto';
import type { EnvironmentFingerprint, PackageIdentity, ResolvedSource } from './types.js';

const ENVIRONMENT_KEYS = ['platform', 'arch', 'nodeAbi'] as const;
type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];

/**
 * Returns the environment attributes that are part of package identity.
 * Unknown fields and undefined values are intentionally omitted.
 */
export function normalizeEnvironmentFingerprint(
  environment: EnvironmentFingerprint | undefined
): EnvironmentFingerprint | undefined {
  if (environment === undefined) return undefined;

  const normalized: EnvironmentFingerprint = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

/**
 * Normalizes an integrity field without changing its meaning. Integrity tokens
 * are whitespace-insensitive and may be supplied in any order.
 */
export function normalizeIntegrity(integrity: string | undefined): string | undefined {
  if (integrity === undefined) return undefined;

  const tokens = integrity.trim().split(/\s+/).filter((token) => token.length > 0).sort();
  return tokens.length === 0 ? undefined : tokens.join(' ');
}

/**
 * Normalizes the fields used to identify one package instance. Package names,
 * including complete scoped names, are preserved exactly apart from trimming
 * boundary whitespace on source fingerprints.
 */
export function normalizePackageIdentity(identity: PackageIdentity): PackageIdentity {
  const source = identity.source.trim();
  if (identity.name.length === 0) throw new TypeError('Package identity name must not be empty.');
  if (identity.versionOrRevision.length === 0) throw new TypeError('Package identity version or revision must not be empty.');
  if (source.length === 0) throw new TypeError('Package identity source must not be empty.');

  const integrity = normalizeIntegrity(identity.integrity);
  const environment = normalizeEnvironmentFingerprint(identity.environment);

  return {
    name: identity.name,
    versionOrRevision: identity.versionOrRevision,
    source,
    ...(integrity === undefined ? {} : { integrity }),
    ...(environment === undefined ? {} : { environment })
  };
}

/**
 * Serializes package identity using a fixed field order and fixed environment
 * field order so equivalent identities always have identical bytes.
 */
export function serializePackageIdentity(identity: PackageIdentity): string {
  const normalized = normalizePackageIdentity(identity);
  const payload: Record<string, unknown> = {
    name: normalized.name,
    versionOrRevision: normalized.versionOrRevision,
    source: normalized.source
  };

  if (normalized.integrity !== undefined) payload.integrity = normalized.integrity;
  if (normalized.environment !== undefined) {
    const environment: Record<EnvironmentKey, string> = {} as Record<EnvironmentKey, string>;
    for (const key of ENVIRONMENT_KEYS) {
      const value = normalized.environment[key];
      if (value !== undefined) environment[key] = value;
    }
    payload.environment = environment;
  }

  return JSON.stringify(payload);
}

/** Returns the SHA-256 hex digest used as the safe central-store identity path. */
export function hashPackageIdentity(identity: PackageIdentity): string {
  return createHash('sha256').update(serializePackageIdentity(identity), 'utf8').digest('hex');
}

/** Alias that reads naturally at call sites referring to the resulting store key. */
export const packageIdentityHash = hashPackageIdentity;

/**
 * Builds identity from a resolved source while retaining the source adapter's
 * canonical fingerprint and only the environment fields defined by the type.
 */
export function packageIdentityFromResolvedSource(source: ResolvedSource): PackageIdentity {
  const sourceFingerprint = source.sourceFingerprint ?? `${source.source.kind}:${source.resolvedLocator}`;
  return normalizePackageIdentity({
    name: source.name,
    versionOrRevision: source.versionOrRevision,
    source: sourceFingerprint,
    ...(source.integrity === undefined ? {} : { integrity: source.integrity }),
    ...(source.environment === undefined ? {} : { environment: source.environment })
  });
}

/** Alias for callers constructing identity at the source-resolution boundary. */
export const createPackageIdentity = packageIdentityFromResolvedSource;
