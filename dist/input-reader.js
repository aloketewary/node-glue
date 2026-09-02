import { createHash } from 'node:crypto';
import { readFile as nodeReadFile, realpath as nodeRealpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ParseError, UnsupportedLockfileError } from './errors.js';
import { locateProjectRoot } from './project.js';
import { LockfileReader } from './lockfile.js';
const nodeProjectInputFileSystem = {
    async exists(path) {
        try {
            await nodeRealpath(path);
            return true;
        }
        catch {
            return false;
        }
    },
    realpath: nodeRealpath,
    async readTextFile(path) {
        return nodeReadFile(path, 'utf8');
    }
};
export const SUPPORTED_LOCKFILE_VERSIONS = [2, 3];
/** Reads project metadata and normalizes a supported lockfile dependency graph. */
export class InputReader {
    filesystem;
    locator;
    constructor(options = {}) {
        this.filesystem = options.filesystem ?? nodeProjectInputFileSystem;
        this.locator = options.locator ?? {
            locate: (requestedDirectory) => locateProjectRoot(requestedDirectory, this.filesystem)
        };
    }
    async read(requestedDirectory = process.cwd()) {
        const projectRoot = await this.locator.locate(requestedDirectory);
        return this.readRoot(projectRoot);
    }
    async readRoot(projectRoot) {
        const canonicalRoot = await this.canonicalizeRoot(projectRoot);
        const packageJsonPath = join(canonicalRoot, 'package.json');
        const packageJsonText = await this.readSource(canonicalRoot, packageJsonPath);
        const packageJsonHash = hashText(packageJsonText);
        const packageManifest = parseJsonObject(packageJsonText, canonicalRoot, packageJsonPath, 'package.json');
        const lockfilePath = join(canonicalRoot, 'package-lock.json');
        if (!(await this.filesystem.exists(lockfilePath))) {
            return {
                projectRoot: canonicalRoot,
                packageJsonPath,
                packageJsonHash,
                packageManifest
            };
        }
        const lockfileText = await this.readSource(canonicalRoot, lockfilePath);
        const lockfileHash = hashText(lockfileText);
        const lockfileDocument = parseJsonObject(lockfileText, canonicalRoot, lockfilePath, 'package-lock.json');
        validateLockfileVersion(lockfileDocument, canonicalRoot, lockfilePath);
        const lockfile = new LockfileReader().read(lockfileDocument, packageManifest, {
            projectRoot: canonicalRoot,
            sourcePath: lockfilePath
        });
        return {
            projectRoot: canonicalRoot,
            packageJsonPath,
            packageJsonHash,
            packageManifest,
            lockfilePath,
            lockfileHash,
            lockfileDocument,
            lockfile
        };
    }
    async canonicalizeRoot(projectRoot) {
        try {
            return await this.filesystem.realpath(resolve(projectRoot));
        }
        catch (cause) {
            throw new ParseError(`Cannot read project input because Project Root cannot be canonicalized: ${projectRoot}.`, { projectRoot, sourcePath: projectRoot }, cause);
        }
    }
    async readSource(projectRoot, sourcePath) {
        try {
            return await this.filesystem.readTextFile(sourcePath);
        }
        catch (cause) {
            throw new ParseError(`Cannot read project input source: ${sourcePath}.`, { projectRoot, sourcePath }, cause);
        }
    }
}
export async function readProjectInput(requestedDirectory = process.cwd(), options = {}) {
    return new InputReader(options).read(requestedDirectory);
}
export function hashText(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
function parseJsonObject(text, projectRoot, sourcePath, sourceName) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (cause) {
        throw new ParseError(`Cannot parse ${sourceName} for Project Root ${projectRoot}.`, { projectRoot, sourcePath }, cause);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ParseError(`${sourceName} must contain a JSON object for Project Root ${projectRoot}.`, { projectRoot, sourcePath });
    }
    return parsed;
}
function validateLockfileVersion(lockfile, projectRoot, sourcePath) {
    const version = lockfile.lockfileVersion;
    if (version === 2 || version === 3)
        return;
    const renderedVersion = typeof version === 'string' || typeof version === 'number' ? String(version) : 'missing';
    throw new UnsupportedLockfileError(`Unsupported package-lock.json version ${renderedVersion}. Supported versions: ${SUPPORTED_LOCKFILE_VERSIONS.join(', ')}.`, {
        projectRoot,
        sourcePath,
        lockfileVersion: renderedVersion,
        supportedVersions: SUPPORTED_LOCKFILE_VERSIONS.map(String)
    });
}
export { nodeProjectInputFileSystem };
//# sourceMappingURL=input-reader.js.map