import type { FileSystemAdapter } from '../adapters/filesystem.js';
import type { ProcessEnvironment, ProcessResult } from '../adapters/process.js';
export interface PlatformPreparationOptions {
    projectRoot: string;
    outputDirectory: string;
    protectedPaths: readonly string[];
    environment?: ProcessEnvironment;
}
/**
 * Execution context prepared outside the immutable package store.
 * Child-process adapters must enforce protectedPaths as read-only boundaries.
 */
export interface ProtectedExecutionContext {
    readonly outputDirectory: string;
    readonly protectedPaths: readonly string[];
    readonly environment: ProcessEnvironment;
}
/** Platform seam for protection and project-context output preparation. */
export interface PlatformCapabilityAdapter {
    /** Whether the child-process boundary can enforce protectedPaths. */
    readonly supportsProtectedPaths: boolean;
    prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext>;
    /** Optional process-result inspection for adapters that report protected writes. */
    protectedPathAttempt?(result: ProcessResult): string | undefined;
}
/**
 * macOS/Linux capability implementation. Read-only enforcement is delegated to
 * the injected child-process adapter through ProcessSpec.protectedPaths; this
 * adapter refuses execution when that boundary is unavailable.
 */
export declare class PosixPlatformCapabilities implements PlatformCapabilityAdapter {
    private readonly filesystem;
    readonly supportsProtectedPaths = true;
    constructor(filesystem: FileSystemAdapter);
    prepare(options: PlatformPreparationOptions): Promise<ProtectedExecutionContext>;
}
/** Compatibility name for callers that prefer an adapter-oriented name. */
export declare class NodePlatformCapabilityAdapter extends PosixPlatformCapabilities {
}
//# sourceMappingURL=capabilities.d.ts.map