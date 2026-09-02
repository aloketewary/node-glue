import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { EnvironmentFingerprint, PackageManifest } from '../types.js';
export declare const SUPPORTED_SOURCE_FORMATS: readonly ["npm registry", "absolute local directory", "Git URL", "HTTP(S) tarball URL"];
export declare function currentEnvironment(): EnvironmentFingerprint;
export declare function sourceDescription(source: unknown): string;
export declare function unsupportedSource(message: string, source: unknown): never;
export declare function sourceFailure(message: string, source: unknown, cause?: unknown): never;
export declare function preserveSourceError(error: unknown): never;
export declare function canonicalHttpUrl(value: string, source: unknown): string;
export declare function validatePackageName(name: unknown, source: unknown): string;
export declare function readManifest(text: string, source: unknown, manifestPath: string): PackageManifest;
export declare function readManifestFromFile(filesystem: Pick<FileSystemAdapter, 'readTextFile'>, manifestPath: string, source: unknown): Promise<PackageManifest>;
export declare function archiveIntegrity(data: Uint8Array): string;
export declare function verifyIntegrity(data: Uint8Array, integrity: string | undefined, source: unknown): void;
export declare function copyDirectory(filesystem: FileSystemAdapter, sourceDirectory: string, destinationDirectory: string, source: unknown): Promise<string>;
export declare function canonicalDirectoryPath(path: string, source: unknown): string;
export declare function isRecord(value: unknown): value is Record<string, any>;
export declare function pathWithin(path: string, parent: string): boolean;
//# sourceMappingURL=utils.d.ts.map