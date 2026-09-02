import { dirname, normalize, resolve } from 'node:path';
import { OwnershipUnknownError, UnmanagedNodeModulesError } from './errors.js';
/** Marker stored inside a published generation's node_modules directory. */
export const GENERATION_OWNERSHIP_MARKER = '.node-glue-generation.json';
export const GENERATION_OWNERSHIP_SCHEMA_VERSION = 1;
export function createProjectGenerationRegistry(registrations) {
    const snapshot = registrations.map(normalizeRegistration);
    return {
        registrations: snapshot,
        async list(projectId) {
            return projectId === undefined
                ? snapshot
                : snapshot.filter((registration) => registration.projectId === projectId);
        }
    };
}
export function generationOwnershipMarkerPath(generationPath) {
    return resolve(generationPath, GENERATION_OWNERSHIP_MARKER);
}
export function serializeGenerationOwnershipMarker(marker) {
    validateMarker(marker);
    return `${JSON.stringify(marker, null, 2)}\n`;
}
/**
 * Inspect without changing the filesystem. This function deliberately treats
 * every unproven state as unsafe; callers may replace only the two tool-owned
 * classifications returned by this function.
 */
export async function inspectNodeModulesOwnership(nodeModulesPath, options) {
    const path = resolve(nodeModulesPath);
    let exists;
    try {
        exists = await options.filesystem.exists(path);
    }
    catch (cause) {
        return unknown(path, 'Unable to determine whether node_modules exists.', cause);
    }
    if (!exists)
        return { kind: 'absent', path };
    let metadata;
    try {
        metadata = await options.filesystem.lstat(path);
    }
    catch (cause) {
        return unknown(path, 'Unable to inspect node_modules metadata.', cause);
    }
    if (metadata.type === 'symlink') {
        return inspectSymlink(path, options);
    }
    if (metadata.type !== 'directory') {
        return {
            kind: 'unmanaged',
            path,
            fileType: metadata.type,
            reason: `node_modules is a ${metadata.type}, not a proven tool-owned directory or symlink.`
        };
    }
    return inspectGenerationDirectory(path, options);
}
/**
 * Prove that replacement is safe. No unlink/rmdir/remove operation is used by
 * this guard, including when ownership cannot be proven.
 */
export async function assertNodeModulesReplaceable(nodeModulesPath, options) {
    const ownership = await inspectNodeModulesOwnership(nodeModulesPath, options);
    if (ownership.kind === 'absent' ||
        ownership.kind === 'tool-owned-symlink' ||
        ownership.kind === 'tool-owned-generation') {
        return ownership;
    }
    const context = {
        path: ownership.path,
        reason: ownership.reason,
        remediation: remediationFor(ownership)
    };
    if (ownership.kind === 'unmanaged') {
        throw new UnmanagedNodeModulesError(`Refusing to replace unmanaged node_modules at ${ownership.path}. ${context.remediation}`, context);
    }
    throw new OwnershipUnknownError(`Refusing to replace node_modules at ${ownership.path}: ownership is not safely determinable. ${context.remediation}`, context);
}
async function inspectSymlink(path, options) {
    let target;
    try {
        target = await options.filesystem.readlink(path);
    }
    catch (cause) {
        return unknown(path, 'node_modules is a symlink whose target cannot be read.', cause);
    }
    const targetPath = resolve(dirname(path), target);
    let resolvedTarget;
    try {
        resolvedTarget = normalize(await options.filesystem.realpath(path));
    }
    catch (cause) {
        return {
            kind: 'broken-link',
            path,
            target: targetPath,
            reason: 'node_modules is a broken symlink; its target cannot be resolved.'
        };
    }
    // realpath may canonicalize a target while a registration stores its lexical
    // path. Check both forms, but never accept a marker without registration.
    const registrations = await registrationsFor(options, [targetPath, resolvedTarget]);
    if (registrations.length === 0) {
        const marker = await readMarkerIfPresent(resolvedTarget, options.filesystem);
        return marker.kind === 'valid'
            ? {
                kind: 'unknown-marker',
                path,
                reason: 'Symlink target has a valid Node Glue marker but is not a registered project generation.'
            }
            : {
                kind: 'unmanaged',
                path,
                target: targetPath,
                reason: 'Symlink target is not a registered project generation.'
            };
    }
    if (registrations.length > 1) {
        return {
            kind: 'ambiguous',
            path,
            reason: 'Symlink target matches more than one project-generation registration.'
        };
    }
    const registration = registrations[0];
    if (registration === undefined) {
        return {
            kind: 'ambiguous',
            path,
            reason: 'Symlink target registration could not be read safely.'
        };
    }
    const marker = await readMarker(resolvedTarget, options.filesystem);
    const markerResult = compareMarker(marker, registration);
    if (markerResult !== undefined) {
        return { kind: markerResult.kind, path, reason: markerResult.reason };
    }
    const projectMismatch = projectMismatchReason(registration, options);
    if (projectMismatch !== undefined) {
        return { kind: 'ambiguous', path, reason: projectMismatch };
    }
    return { kind: 'tool-owned-symlink', path, target: targetPath, registration };
}
async function inspectGenerationDirectory(path, options) {
    const registrations = await registrationsFor(options, [path]);
    const marker = await readMarker(path, options.filesystem);
    if (marker.kind === 'missing') {
        return registrations.length === 0
            ? { kind: 'unmanaged', path, reason: 'Directory has no Node Glue ownership marker.' }
            : {
                kind: 'unknown-marker',
                path,
                reason: 'Directory is registered as a generation but its ownership marker is missing.'
            };
    }
    if (marker.kind !== 'valid') {
        return { kind: marker.kind, path, reason: marker.reason };
    }
    if (registrations.length === 0) {
        return {
            kind: 'unknown-marker',
            path,
            reason: 'Directory has a valid Node Glue ownership marker but no registered project generation.'
        };
    }
    if (registrations.length > 1) {
        return {
            kind: 'ambiguous',
            path,
            reason: 'Directory matches more than one project-generation registration.'
        };
    }
    const registration = registrations[0];
    if (registration === undefined) {
        return {
            kind: 'ambiguous',
            path,
            reason: 'Directory registration could not be read safely.'
        };
    }
    const markerResult = compareMarker(marker, registration);
    if (markerResult !== undefined) {
        return { kind: markerResult.kind, path, reason: markerResult.reason };
    }
    const projectMismatch = projectMismatchReason(registration, options);
    if (projectMismatch !== undefined) {
        return { kind: 'ambiguous', path, reason: projectMismatch };
    }
    return { kind: 'tool-owned-generation', path, registration };
}
async function readMarkerIfPresent(path, filesystem) {
    try {
        if (!(await filesystem.exists(generationOwnershipMarkerPath(path))))
            return { kind: 'missing' };
    }
    catch {
        return { kind: 'unknown-marker', reason: 'Unable to determine whether the ownership marker exists.' };
    }
    return readMarker(path, filesystem);
}
async function readMarker(path, filesystem) {
    const markerPath = generationOwnershipMarkerPath(path);
    let text;
    try {
        if (!(await filesystem.exists(markerPath)))
            return { kind: 'missing' };
        text = await filesystem.readTextFile(markerPath);
    }
    catch {
        return { kind: 'unknown-marker', reason: 'Node Glue ownership marker cannot be read.' };
    }
    try {
        const value = JSON.parse(text);
        validateMarker(value);
        return { kind: 'valid', marker: value };
    }
    catch {
        return { kind: 'unknown-marker', reason: 'Node Glue ownership marker is malformed or unsupported.' };
    }
}
async function registrationsFor(options, paths) {
    let registrations;
    try {
        registrations = await options.registry.list(options.projectId);
    }
    catch {
        return [];
    }
    const candidates = new Map();
    for (const registration of registrations) {
        let normalized;
        try {
            normalized = normalizeRegistration(registration);
        }
        catch {
            continue;
        }
        if (options.projectId !== undefined && normalized.projectId !== options.projectId)
            continue;
        if (paths.some((path) => samePath(normalized.generationPath, path))) {
            candidates.set(`${normalized.projectId}:${normalized.generation}`, normalized);
        }
    }
    return [...candidates.values()];
}
function normalizeRegistration(registration) {
    if (registration.projectId.length === 0 ||
        registration.generation.length === 0 ||
        registration.projectRoot.length === 0 ||
        registration.generationPath.length === 0) {
        throw new Error('Invalid project generation registration.');
    }
    return {
        projectId: registration.projectId,
        generation: registration.generation,
        projectRoot: normalize(resolve(registration.projectRoot)),
        generationPath: normalize(resolve(registration.generationPath))
    };
}
function validateMarker(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Marker must be an object.');
    const marker = value;
    if (marker.schemaVersion !== GENERATION_OWNERSHIP_SCHEMA_VERSION ||
        typeof marker.projectId !== 'string' ||
        marker.projectId.length === 0 ||
        typeof marker.generation !== 'string' ||
        marker.generation.length === 0 ||
        typeof marker.projectRoot !== 'string' ||
        !marker.projectRoot.startsWith('/')) {
        throw new Error('Marker fields are invalid.');
    }
}
function compareMarker(marker, registration) {
    if (marker.kind !== 'valid') {
        return marker.kind === 'missing'
            ? { kind: 'unknown-marker', reason: 'Registered generation has no ownership marker.' }
            : marker;
    }
    const value = marker.marker;
    if (value.projectId !== registration.projectId ||
        value.generation !== registration.generation ||
        normalize(resolve(value.projectRoot)) !== registration.projectRoot) {
        return {
            kind: 'ambiguous',
            reason: 'Ownership marker does not match the registered project generation.'
        };
    }
    return undefined;
}
function projectMismatchReason(registration, options) {
    if (options.projectId !== undefined && registration.projectId !== options.projectId) {
        return 'Registered generation belongs to a different project.';
    }
    if (options.projectRoot !== undefined && registration.projectRoot !== normalize(resolve(options.projectRoot))) {
        return 'Registered generation belongs to a different project root.';
    }
    return undefined;
}
function samePath(left, right) {
    return normalize(resolve(left)) === normalize(resolve(right));
}
function unknown(path, reason, cause) {
    // Cause is intentionally not exposed in the classification: inspection is
    // safe to report, while raw filesystem errors may contain host-sensitive data.
    void cause;
    return { kind: 'unknown-marker', path, reason };
}
function remediationFor(ownership) {
    if (ownership.kind === 'unmanaged') {
        return 'Move or remove it manually, then retry; Node Glue will not adopt or delete it automatically.';
    }
    return 'Inspect the path and its project generation registration, then repair or remove it manually before retrying.';
}
//# sourceMappingURL=ownership.js.map