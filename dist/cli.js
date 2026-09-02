#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityUnavailableError, InvalidInputError, NodeGlueError, sanitizeDiagnosticContext } from './errors.js';
import { createNodeGlueApi } from './api.js';
import { VERSION } from './index.js';
import { PathIntegration } from './npm/path-integration.js';
const HELP = `Node Glue ${VERSION}

Usage:
  node-glue <command> [options]

Commands:
  install     Resolve and materialize project dependencies
  ensure      Verify and repair project dependency state
  exec        Ensure project, then run a command after "--"
  doctor      Inspect project and repository state
  gc          Remove unreferenced package instances
  enable      Enable the opt-in npm PATH integration
  disable     Disable the opt-in npm PATH integration

Options:
  --project-root <path>  Project directory (default: current directory)
  --store-dir <path>    Node Glue store directory
  --registry <url>      npm registry URL
  --run-scripts          Explicitly enable configured lifecycle scripts
  -h, --help             Show this help
  -v, --version          Show the version

Examples:
  node-glue install --project-root .
  node-glue ensure
  node-glue exec -- node app.js
`;
/**
 * Run the CLI. Help and version remain synchronous for embedders that use the
 * original scaffold contract; operational commands return a Promise.
 */
export function runCli(args = process.argv.slice(2), options = {}) {
    const output = options.output ?? defaultOutput;
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        output.stdout(`${HELP}\n`);
        return 0;
    }
    if (args[0] === '--version' || args[0] === '-v') {
        output.stdout(`${VERSION}\n`);
        return 0;
    }
    return runCliAsync(args, options);
}
export async function runCliAsync(args = process.argv.slice(2), options = {}) {
    const output = options.output ?? defaultOutput;
    try {
        const separator = args[0] === 'exec' ? args.slice(1).indexOf('--') : -1;
        const optionArgs = separator >= 0 ? args.slice(1, separator + 1) : args.slice(1);
        if (isCommand(args[0]) && optionArgs.some((argument) => argument === '--help' || argument === '-h')) {
            output.stdout(`${HELP}\n`);
            return 0;
        }
        const parsed = parseCommand(args, options.cwd ?? process.cwd());
        const api = options.api ?? createNodeGlueApi(parsed.storeDir === undefined ? {} : { packageStoreOptions: { storeDir: parsed.storeDir } });
        const pathIntegration = options.pathIntegration ?? new PathIntegration({
            ...(options.env === undefined ? {} : { env: options.env })
        });
        switch (parsed.command) {
            case 'install': {
                const result = await api.installProject(projectOptions(parsed));
                writeJson(output, result);
                return 0;
            }
            case 'ensure': {
                const result = await api.ensureProject(projectOptions(parsed));
                writeJson(output, result);
                return 0;
            }
            case 'exec':
                return await executeCommand(parsed, api, options, output);
            case 'doctor': {
                const report = api.doctorProject === undefined
                    ? await api.inspectProject(parsed.projectRoot)
                    : await api.doctorProject(parsed.projectRoot);
                writeJson(output, report);
                return report.status === 'ready' ? 0 : 1;
            }
            case 'gc': {
                const result = await api.garbageCollect(parsed.storeDir);
                writeJson(output, result);
                return 0;
            }
            case 'enable':
                return await runPathIntegration('enable', pathIntegration, output);
            case 'disable':
                return await runPathIntegration('disable', pathIntegration, output);
        }
    }
    catch (cause) {
        output.stderr(`${formatDiagnostic(cause)}\n`);
        return 1;
    }
}
export function formatDiagnostic(cause) {
    if (cause instanceof NodeGlueError) {
        return formatDiagnosticRecord(cause.code, cause.message, cause.context);
    }
    if (cause instanceof Error) {
        return formatDiagnosticRecord('INVALID_INPUT', cause.message, {});
    }
    return formatDiagnosticRecord('INVALID_INPUT', String(cause), {});
}
function formatDiagnosticRecord(code, message, context) {
    const safeContext = sanitizeDiagnosticContext(context);
    const fields = Object.entries(safeContext)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.map((item) => sanitizeMessage(item)).join(',') : sanitizeMessage(String(value))}`);
    return `[${code}] ${sanitizeMessage(message)}${fields.length === 0 ? '' : ` (${fields.join(' ')})`}`;
}
function sanitizeMessage(message) {
    return message
        .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, '$1[REDACTED]@')
        .replace(/([?&](?:token|secret|password|passwd|authorization|api[-_]?key)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}
async function executeCommand(parsed, api, options, output) {
    const execArgs = parsed.execArgs ?? [];
    if (execArgs.length === 0) {
        throw new InvalidInputError('exec requires a command after "--".', { command: 'exec' });
    }
    const ensured = await api.ensureProject(projectOptions(parsed));
    const environment = {
        ...(options.env ?? process.env),
        NODE_GLUE_PROJECT_ROOT: ensured.projectRoot,
        INIT_CWD: ensured.projectRoot
    };
    if (parsed.storeDir !== undefined)
        environment.NODE_GLUE_STORE_DIR = parsed.storeDir;
    const result = await (options.processes ?? new NodeChildProcessAdapter()).run({
        executable: execArgs[0],
        args: execArgs.slice(1),
        cwd: ensured.projectRoot,
        env: environment,
        stdin: 'inherit',
        stdout: 'pipe',
        stderr: 'pipe'
    });
    if (result.stdout.length > 0)
        output.stdout(result.stdout);
    if (result.stderr.length > 0)
        output.stderr(result.stderr);
    return result.exitCode === null ? 1 : result.exitCode;
}
async function runPathIntegration(command, integration, output) {
    if (integration === undefined) {
        throw new CapabilityUnavailableError(`PATH integration is not configured for ${command}.`, { command });
    }
    const message = command === 'enable' ? await integration.enable() : await integration.disable();
    writeJson(output, { command, ...(message === undefined ? {} : { message }) });
    return 0;
}
function projectOptions(parsed) {
    return {
        projectRoot: parsed.projectRoot,
        ...(parsed.storeDir === undefined ? {} : { storeDir: parsed.storeDir }),
        ...(parsed.registry === undefined ? {} : { registry: parsed.registry }),
        ...(parsed.runScripts ? { runScripts: true } : {})
    };
}
function parseCommand(args, defaultCwd) {
    const command = args[0];
    if (!isCommand(command)) {
        throw new InvalidInputError(`Unknown command: ${command ?? '(missing)'}.`, { command: command ?? '(missing)' });
    }
    const commandArgs = args.slice(1);
    const separator = command === 'exec' ? commandArgs.indexOf('--') : -1;
    const optionArgs = separator >= 0 ? commandArgs.slice(0, separator) : commandArgs;
    const execArgs = separator >= 0 ? commandArgs.slice(separator + 1) : undefined;
    if (command === 'exec' && separator < 0) {
        throw new InvalidInputError('exec requires "--" before the command.', { command: 'exec' });
    }
    let projectRoot = resolve(defaultCwd);
    let storeDir;
    let registry;
    let runScripts = false;
    let positional;
    for (let index = 0; index < optionArgs.length; index += 1) {
        const argument = optionArgs[index];
        if (argument === '--help' || argument === '-h') {
            return { command, projectRoot, runScripts };
        }
        if (argument === '--run-scripts') {
            runScripts = true;
            continue;
        }
        if (argument === '--project-root' || argument === '--project' || argument === '-C') {
            projectRoot = resolveOptionPath(optionArgs, ++index, argument, defaultCwd);
            continue;
        }
        if (argument === '--store-dir') {
            storeDir = resolveOptionPath(optionArgs, ++index, argument, defaultCwd);
            continue;
        }
        if (argument === '--registry') {
            registry = requireOptionValue(optionArgs, ++index, argument);
            continue;
        }
        if (argument.startsWith('-')) {
            throw new InvalidInputError(`Unknown option: ${argument}.`, { option: argument });
        }
        if (positional !== undefined) {
            throw new InvalidInputError(`Unexpected argument: ${argument}.`, { argument });
        }
        positional = argument;
    }
    if (positional !== undefined) {
        projectRoot = resolve(defaultCwd, positional);
    }
    if ((command === 'gc' || command === 'enable' || command === 'disable') && positional !== undefined) {
        throw new InvalidInputError(`Unexpected argument: ${positional}.`, { argument: positional, command });
    }
    return {
        command,
        projectRoot,
        ...(storeDir === undefined ? {} : { storeDir }),
        ...(registry === undefined ? {} : { registry }),
        runScripts,
        ...(execArgs === undefined ? {} : { execArgs })
    };
}
function isCommand(value) {
    return value === 'install'
        || value === 'ensure'
        || value === 'exec'
        || value === 'doctor'
        || value === 'gc'
        || value === 'enable'
        || value === 'disable';
}
function requireOptionValue(args, index, option) {
    const value = args[index];
    if (value === undefined || value.startsWith('-')) {
        throw new InvalidInputError(`Option ${option} requires a value.`, { option });
    }
    return value;
}
function resolveOptionPath(args, index, option, base) {
    return resolve(base, requireOptionValue(args, index, option));
}
function writeJson(output, value) {
    output.stdout(`${JSON.stringify(value)}\n`);
}
const defaultOutput = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
};
class NodeChildProcessAdapter {
    async run(spec) {
        return await new Promise((resolveResult, reject) => {
            const child = spawn(spec.executable, [...spec.args], {
                cwd: spec.cwd,
                env: spec.env,
                shell: false,
                stdio: [spec.stdin ?? 'ignore', spec.stdout ?? 'pipe', spec.stderr ?? 'pipe']
            });
            let stdout = '';
            let stderr = '';
            if (child.stdout !== null)
                child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            if (child.stderr !== null)
                child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.once('error', reject);
            child.once('close', (exitCode, signal) => resolveResult({
                exitCode,
                stdout,
                stderr,
                ...(signal === null ? {} : { signal })
            }));
        });
    }
}
const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
    const result = runCli();
    if (result instanceof Promise) {
        result.then((exitCode) => { process.exitCode = exitCode; }).catch((cause) => {
            process.stderr.write(`${formatDiagnostic(cause)}\n`);
            process.exitCode = 1;
        });
    }
    else {
        process.exitCode = result;
    }
}
//# sourceMappingURL=cli.js.map