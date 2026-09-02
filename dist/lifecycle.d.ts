import type { FileSystemAdapter } from './adapters/filesystem.js';
import type { ChildProcessAdapter, ProcessEnvironment } from './adapters/process.js';
import { type PlatformCapabilityAdapter } from './platform/index.js';
import type { LifecyclePolicy, ResolvedProject } from './types.js';
export interface LifecycleRunnerOptions {
    processes: ChildProcessAdapter;
    filesystem: FileSystemAdapter;
    platform?: PlatformCapabilityAdapter;
    /** Additional immutable store roots, when package content paths alone are insufficient. */
    protectedStorePaths?: readonly string[];
    environment?: ProcessEnvironment;
    shell?: string;
}
/**
 * Executes only explicitly permitted install lifecycle scripts in project
 * context. The runner never uses a package-store directory as cwd.
 */
export declare class LifecycleRunner {
    private readonly processes;
    private readonly filesystem;
    private readonly platform;
    private readonly protectedStorePaths;
    private readonly environment;
    private readonly shell;
    constructor(options: LifecycleRunnerOptions);
    /**
     * A missing policy, false enabled flag, or absent/empty script allowlist is
     * an intentional no-op. This is the default-safe lifecycle behavior.
     */
    run(project: ResolvedProject, policy?: LifecyclePolicy): Promise<void>;
    private prepareExecution;
    private runScript;
}
export type { PlatformCapabilityAdapter } from './platform/index.js';
//# sourceMappingURL=lifecycle.d.ts.map