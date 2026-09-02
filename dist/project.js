import { realpath as nodeRealpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ProjectNotFoundError } from './errors.js';
const nodeProjectDiscoveryFileSystem = {
    async exists(path) {
        try {
            await nodeRealpath(path);
            return true;
        }
        catch {
            return false;
        }
    },
    realpath: nodeRealpath
};
/** Locates the nearest project root and returns its canonical absolute path. */
export class ProjectLocator {
    filesystem;
    constructor(filesystem = nodeProjectDiscoveryFileSystem) {
        this.filesystem = filesystem;
    }
    async locate(requestedDirectory = process.cwd()) {
        const requestedPath = isAbsolute(requestedDirectory) ? requestedDirectory : resolve(requestedDirectory);
        let current;
        try {
            current = await this.filesystem.realpath(requestedPath);
        }
        catch (cause) {
            throw new ProjectNotFoundError(`Cannot locate a project from requested directory: ${requestedPath}.`, { requestedDirectory: requestedPath });
        }
        while (true) {
            const packageJsonPath = `${current}/package.json`;
            if (await this.filesystem.exists(packageJsonPath)) {
                return current;
            }
            const parent = dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
        throw new ProjectNotFoundError(`No package.json found at or above requested directory: ${requestedPath}.`, { requestedDirectory: requestedPath });
    }
}
export async function locateProjectRoot(requestedDirectory = process.cwd(), filesystem = nodeProjectDiscoveryFileSystem) {
    return new ProjectLocator(filesystem).locate(requestedDirectory);
}
export { nodeProjectDiscoveryFileSystem };
//# sourceMappingURL=project.js.map