import type { EnvironmentFingerprint, PackageIdentity, ResolvedSource } from './types.js';
/**
 * Returns the environment attributes that are part of package identity.
 * Unknown fields and undefined values are intentionally omitted.
 */
export declare function normalizeEnvironmentFingerprint(environment: EnvironmentFingerprint | undefined): EnvironmentFingerprint | undefined;
/**
 * Normalizes an integrity field without changing its meaning. Integrity tokens
 * are whitespace-insensitive and may be supplied in any order.
 */
export declare function normalizeIntegrity(integrity: string | undefined): string | undefined;
/**
 * Normalizes the fields used to identify one package instance. Package names,
 * including complete scoped names, are preserved exactly apart from trimming
 * boundary whitespace on source fingerprints.
 */
export declare function normalizePackageIdentity(identity: PackageIdentity): PackageIdentity;
/**
 * Serializes package identity using a fixed field order and fixed environment
 * field order so equivalent identities always have identical bytes.
 */
export declare function serializePackageIdentity(identity: PackageIdentity): string;
/** Returns the SHA-256 hex digest used as the safe central-store identity path. */
export declare function hashPackageIdentity(identity: PackageIdentity): string;
/** Alias that reads naturally at call sites referring to the resulting store key. */
export declare const packageIdentityHash: typeof hashPackageIdentity;
/**
 * Builds identity from a resolved source while retaining the source adapter's
 * canonical fingerprint and only the environment fields defined by the type.
 */
export declare function packageIdentityFromResolvedSource(source: ResolvedSource): PackageIdentity;
/** Alias for callers constructing identity at the source-resolution boundary. */
export declare const createPackageIdentity: typeof packageIdentityFromResolvedSource;
//# sourceMappingURL=package-identity.d.ts.map