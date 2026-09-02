import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { CapabilityUnavailableError } from '../errors.js';
function isWithin(parent, candidate) {
    const child = relative(parent, candidate);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function normalizePaths(paths) {
    return [...new Set(paths.map((path) => normalize(resolve(path))))];
}
/**
 * macOS/Linux capability implementation. Read-only enforcement is delegated to
 * the injected child-process adapter through ProcessSpec.protectedPaths; this
 * adapter refuses execution when that boundary is unavailable.
 */
export class PosixPlatformCapabilities {
    filesystem;
    supportsProtectedPaths = true;
    constructor(filesystem) {
        this.filesystem = filesystem;
    }
    async prepare(options) {
        if (process.platform !== 'darwin' && process.platform !== 'linux') {
            throw new CapabilityUnavailableError('Lifecycle execution requires macOS or Linux protected-path support.', { capability: 'protected-paths', operation: 'lifecycle', platform: process.platform });
        }
        const projectRoot = normalize(resolve(options.projectRoot));
        const outputDirectory = normalize(resolve(options.outputDirectory));
        const protectedPaths = normalizePaths(options.protectedPaths);
        if (!isAbsolute(projectRoot) || !isAbsolute(outputDirectory)) {
            throw new CapabilityUnavailableError('Lifecycle project and output paths must be absolute.', { capability: 'absolute-project-context', operation: 'lifecycle' });
        }
        const protectedStorePath = protectedPaths.find((path) => isWithin(path, outputDirectory));
        if (protectedStorePath !== undefined) {
            throw new CapabilityUnavailableError('Lifecycle output cannot be inside an immutable package-store path.', { capability: 'isolated-output', operation: 'lifecycle', outputDirectory, protectedPath: protectedStorePath });
        }
        await this.filesystem.mkdir(outputDirectory, { recursive: true });
        return {
            outputDirectory,
            protectedPaths,
            environment: {
                ...options.environment,
                NODE_GLUE_PROJECT_ROOT: projectRoot,
                NODE_GLUE_LIFECYCLE_OUTPUT: outputDirectory,
                npm_config_node_glue_lifecycle_output: outputDirectory
            }
        };
    }
}
/** Compatibility name for callers that prefer an adapter-oriented name. */
export class NodePlatformCapabilityAdapter extends PosixPlatformCapabilities {
}
//# sourceMappingURL=capabilities.js.map