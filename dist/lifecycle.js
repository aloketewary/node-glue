import { isAbsolute, normalize, resolve } from 'node:path';
import { CapabilityUnavailableError, LifecycleError, NodeGlueError, ProtectedPathError } from './errors.js';
import { NodePlatformCapabilityAdapter } from './platform/index.js';
const INSTALL_LIFECYCLE_SCRIPTS = [
    'preinstall',
    'install',
    'postinstall',
    'prepare'
];
/**
 * Executes only explicitly permitted install lifecycle scripts in project
 * context. The runner never uses a package-store directory as cwd.
 */
export class LifecycleRunner {
    processes;
    filesystem;
    platform;
    protectedStorePaths;
    environment;
    shell;
    constructor(options) {
        this.processes = options.processes;
        this.filesystem = options.filesystem;
        this.platform = options.platform ?? new NodePlatformCapabilityAdapter(options.filesystem);
        this.protectedStorePaths = options.protectedStorePaths ?? [];
        this.environment = options.environment ?? process.env;
        this.shell = options.shell ?? '/bin/sh';
    }
    /**
     * A missing policy, false enabled flag, or absent/empty script allowlist is
     * an intentional no-op. This is the default-safe lifecycle behavior.
     */
    async run(project, policy = { enabled: false }) {
        if (policy.enabled !== true)
            return;
        const scripts = collectLifecycleScripts(project);
        const permittedScripts = scripts.filter((script) => isPermitted(script, policy));
        if (permittedScripts.length === 0)
            return;
        const projectRoot = normalize(resolve(project.projectRoot));
        const outputDirectory = normalize(resolve(policy.outputDirectory ?? `${projectRoot}/.node-glue/lifecycle`));
        const protectedPaths = immutablePaths(project.packages, this.protectedStorePaths);
        const execution = await this.prepareExecution({
            projectRoot,
            outputDirectory,
            protectedPaths,
            environment: this.environment
        });
        for (const script of permittedScripts) {
            await this.runScript(projectRoot, script, execution);
        }
    }
    async prepareExecution(options) {
        if (!this.platform.supportsProtectedPaths) {
            throw new CapabilityUnavailableError('Lifecycle execution requires a child-process adapter that protects immutable store paths.', { capability: 'protected-paths', operation: 'lifecycle', projectRoot: options.projectRoot });
        }
        try {
            return await this.platform.prepare(options);
        }
        catch (cause) {
            if (cause instanceof NodeGlueError)
                throw cause;
            throw new CapabilityUnavailableError('Lifecycle execution capability preparation failed.', { capability: 'lifecycle-isolation', operation: 'lifecycle', projectRoot: options.projectRoot });
        }
    }
    async runScript(projectRoot, script, execution) {
        const spec = {
            executable: this.shell,
            args: ['-c', script.command],
            cwd: projectRoot,
            env: {
                ...execution.environment,
                NODE_GLUE_PROJECT_ROOT: projectRoot,
                NODE_GLUE_LIFECYCLE_OUTPUT: execution.outputDirectory,
                npm_config_node_glue_lifecycle_output: execution.outputDirectory,
                INIT_CWD: projectRoot,
                npm_lifecycle_event: script.scriptName,
                npm_package_name: script.packageName
            },
            stdin: 'ignore',
            stdout: 'inherit',
            stderr: 'inherit',
            protectedPaths: execution.protectedPaths
        };
        let result;
        try {
            result = await this.processes.run(spec);
        }
        catch (cause) {
            if (cause instanceof ProtectedPathError) {
                throw new ProtectedPathError(cause.message, {
                    ...cause.context,
                    package: script.packageName,
                    script: script.scriptName,
                    projectRoot
                });
            }
            if (cause instanceof CapabilityUnavailableError)
                throw cause;
            if (cause instanceof NodeGlueError)
                throw cause;
            throw new LifecycleError(`Lifecycle script ${script.scriptName} for ${script.packageName} could not be executed.`, lifecycleContext(script, projectRoot), cause);
        }
        const protectedPath = this.platform.protectedPathAttempt?.(result);
        if (protectedPath !== undefined) {
            throw new ProtectedPathError(`Lifecycle script ${script.scriptName} attempted to modify protected path ${protectedPath}.`, { ...lifecycleContext(script, projectRoot), protectedPath });
        }
        if (result.exitCode !== 0 || result.signal !== undefined) {
            const status = result.signal === undefined ? String(result.exitCode) : `signal:${result.signal}`;
            throw new LifecycleError(`Lifecycle script ${script.scriptName} for ${script.packageName} failed with ${status}.`, { ...lifecycleContext(script, projectRoot), exitStatus: status });
        }
    }
}
function lifecycleContext(script, projectRoot) {
    return {
        package: script.packageName,
        packageIdentityHash: script.packageIdentityHash,
        script: script.scriptName,
        projectRoot
    };
}
function immutablePaths(packages, additionalPaths) {
    return [...new Set([
            ...packages.map((instance) => instance.contentPath),
            ...additionalPaths
        ].filter((path) => isAbsolute(path)).map((path) => normalize(resolve(path))))];
}
function collectLifecycleScripts(project) {
    const scripts = [];
    for (const instance of project.packages) {
        for (const scriptName of INSTALL_LIFECYCLE_SCRIPTS) {
            const command = instance.manifest.scripts?.[scriptName];
            if (typeof command !== 'string' || command.length === 0)
                continue;
            scripts.push({
                packageName: instance.manifest.name,
                packageIdentityHash: instance.identityHash,
                scriptName,
                command
            });
        }
    }
    return scripts;
}
function isPermitted(script, policy) {
    const allowedScripts = policy.allowedScripts;
    if (allowedScripts === undefined || allowedScripts.length === 0)
        return false;
    const scriptRules = new Set(allowedScripts);
    const qualifiedNames = [
        script.scriptName,
        `${script.packageName}:${script.scriptName}`,
        `${script.packageName}#${script.scriptName}`,
        `${script.packageName}@${script.packageIdentityHash}:${script.scriptName}`
    ];
    if (!qualifiedNames.some((rule) => scriptRules.has(rule)))
        return false;
    const allowedPackages = policy.allowedPackages;
    if (allowedPackages !== undefined && allowedPackages.length > 0) {
        if (!allowedPackages.includes(script.packageName) && !allowedPackages.includes(script.packageIdentityHash)) {
            return false;
        }
    }
    return true;
}
//# sourceMappingURL=lifecycle.js.map