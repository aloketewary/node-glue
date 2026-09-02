export type ProcessEnvironment = Readonly<Record<string, string | undefined>>;
export type ProcessStdio = 'pipe' | 'inherit' | 'ignore';
export interface ProcessSpec {
    executable: string;
    args: readonly string[];
    cwd: string;
    env?: ProcessEnvironment;
    stdin?: ProcessStdio;
    stdout?: ProcessStdio;
    stderr?: ProcessStdio;
    timeoutMs?: number;
    /** Paths that must be protected by the platform process adapter. */
    protectedPaths?: readonly string[];
}
export interface ProcessResult {
    exitCode: number | null;
    signal?: string;
    stdout: string;
    stderr: string;
}
/** Injectable child-process boundary; tests can record calls without running scripts. */
export interface ChildProcessAdapter {
    run(spec: ProcessSpec): Promise<ProcessResult>;
    terminate?(signal?: string): Promise<void>;
}
//# sourceMappingURL=process.d.ts.map