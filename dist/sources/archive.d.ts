import type { FileSystemAdapter } from '../adapters/filesystem.js';
export interface ExtractedArchive {
    packageRoot: string;
    contentDigest: string;
}
/**
 * Extracts the small, ordinary ustar/pax-free archives emitted by npm sources.
 * Every entry is validated before any filesystem write occurs.
 */
export declare function extractPackageArchive(filesystem: FileSystemAdapter, archive: Uint8Array, destination: string, source: unknown, expectedRoot?: string): Promise<ExtractedArchive>;
/** Extracts into a tool-owned temporary directory, then publishes only the validated package root. */
export declare function extractPackageToDestination(filesystem: FileSystemAdapter, archive: Uint8Array, destination: string, source: unknown, expectedRoot?: string): Promise<ExtractedArchive>;
//# sourceMappingURL=archive.d.ts.map