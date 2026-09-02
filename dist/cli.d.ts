#!/usr/bin/env node
import { type NodeGlueApi } from './api.js';
import type { ChildProcessAdapter, ProcessEnvironment } from './adapters/process.js';
export interface CliOutput {
    stdout(text: string): void;
    stderr(text: string): void;
}
export interface CliPathIntegration {
    enable(): Promise<string | void>;
    disable(): Promise<string | void>;
}
export interface CliOptions {
    api?: NodeGlueApi;
    processes?: ChildProcessAdapter;
    pathIntegration?: CliPathIntegration;
    output?: CliOutput;
    cwd?: string;
    env?: ProcessEnvironment;
}
/**
 * Run the CLI. Help and version remain synchronous for embedders that use the
 * original scaffold contract; operational commands return a Promise.
 */
export declare function runCli(args?: readonly string[], options?: CliOptions): number | Promise<number>;
export declare function runCliAsync(args?: readonly string[], options?: CliOptions): Promise<number>;
export declare function formatDiagnostic(cause: unknown): string;
//# sourceMappingURL=cli.d.ts.map