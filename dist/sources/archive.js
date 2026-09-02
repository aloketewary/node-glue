import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { posix } from 'node:path';
import { NodeGlueError } from '../errors.js';
import { sourceDescription, sourceFailure, copyDirectory } from './utils.js';
/**
 * Extracts the small, ordinary ustar/pax-free archives emitted by npm sources.
 * Every entry is validated before any filesystem write occurs.
 */
export async function extractPackageArchive(filesystem, archive, destination, source, expectedRoot) {
    const entries = parseArchive(archive, source);
    const roots = new Set(entries.map((entry) => entry.path.split('/')[0]).filter((root) => root !== undefined && root.length > 0));
    if (roots.size !== 1)
        return sourceFailure('Package archive must contain exactly one package root directory.', source);
    const root = [...roots][0];
    if (expectedRoot !== undefined && root !== expectedRoot) {
        return sourceFailure(`Package archive has invalid root directory ${root}; expected ${expectedRoot}.`, source);
    }
    if (!entries.some((entry) => entry.path === `${root}/package.json` && entry.type === 'file')) {
        return sourceFailure(`Package archive root ${root} does not contain package.json.`, source);
    }
    try {
        await filesystem.mkdir(destination, { recursive: true });
        for (const entry of entries) {
            const target = posix.join(destination, entry.path);
            if (entry.type === 'directory') {
                await filesystem.mkdir(target, { recursive: true });
            }
            else {
                await filesystem.mkdir(posix.dirname(target), { recursive: true });
                await filesystem.writeFile(target, entry.data ?? new Uint8Array());
            }
        }
        return {
            packageRoot: posix.join(destination, root),
            contentDigest: archiveDigest(archive)
        };
    }
    catch (cause) {
        await filesystem.remove(destination, { recursive: true, force: true }).catch(() => undefined);
        if (cause instanceof NodeGlueError)
            throw cause;
        return sourceFailure(`Cannot extract package archive from ${sourceDescription(source)}.`, source, cause);
    }
}
function parseArchive(input, source) {
    let data = input;
    if (data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
        try {
            data = gunzipSync(data);
        }
        catch (cause) {
            return sourceFailure('Package archive is not valid gzip data.', source, cause);
        }
    }
    const entries = [];
    const paths = new Set();
    let offset = 0;
    let sawEnd = false;
    while (offset + 512 <= data.byteLength) {
        const header = data.slice(offset, offset + 512);
        offset += 512;
        if (header.every((byte) => byte === 0)) {
            sawEnd = true;
            break;
        }
        validateChecksum(header, source);
        const name = readString(header, 0, 100);
        const prefix = readString(header, 345, 155);
        const rawPath = prefix.length > 0 ? `${prefix}/${name}` : name;
        const path = safeArchivePath(rawPath, source);
        const size = readOctal(header, 124, 12, source);
        const typeFlag = readString(header, 156, 1) || '0';
        const end = offset + size;
        if (end > data.byteLength)
            return sourceFailure('Package archive entry extends beyond archive bounds.', source);
        if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'L' || typeFlag === 'K') {
            return sourceFailure('Package archive uses unsupported extended entry metadata.', source);
        }
        if (typeFlag !== '0' && typeFlag !== '5') {
            return sourceFailure(`Package archive contains unsupported entry type ${typeFlag}.`, source);
        }
        if (paths.has(path))
            return sourceFailure(`Package archive contains duplicate entry ${path}.`, source);
        paths.add(path);
        entries.push(typeFlag === '5'
            ? { path: path.endsWith('/') ? path.slice(0, -1) : path, type: 'directory' }
            : { path, type: 'file', data: data.slice(offset, end) });
        offset += Math.ceil(size / 512) * 512;
    }
    if (!sawEnd || entries.length === 0)
        return sourceFailure('Package archive is empty or truncated.', source);
    return entries;
}
function safeArchivePath(rawPath, source) {
    const path = rawPath.replace(/^\.\//, '');
    const segments = path.split('/');
    if (path.length === 0 || path.startsWith('/') || path.includes('\\') || segments.some((segment) => segment === '..' || segment.length === 0)) {
        return sourceFailure(`Package archive contains unsafe path ${rawPath}.`, source);
    }
    const normalized = posix.normalize(path);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        return sourceFailure(`Package archive contains path traversal: ${rawPath}.`, source);
    }
    return normalized;
}
function validateChecksum(header, source) {
    const expectedText = readString(header, 148, 8).trim();
    const expected = Number.parseInt(expectedText, 8);
    if (!Number.isFinite(expected))
        return sourceFailure('Package archive has an invalid header checksum.', source);
    const checked = new Uint8Array(header);
    checked.fill(0x20, 148, 156);
    const actual = checked.reduce((sum, byte) => sum + byte, 0);
    if (actual !== expected)
        return sourceFailure('Package archive header checksum verification failed.', source);
}
function readString(data, start, length) {
    let end = start;
    while (end < start + length && data[end] !== 0)
        end++;
    return new TextDecoder().decode(data.slice(start, end)).trim();
}
function readOctal(data, start, length, source) {
    const value = readString(data, start, length);
    const parsed = Number.parseInt(value, 8);
    if (!Number.isFinite(parsed) || parsed < 0)
        return sourceFailure('Package archive has an invalid entry size.', source);
    return parsed;
}
function archiveDigest(data) {
    return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}
/** Extracts into a tool-owned temporary directory, then publishes only the validated package root. */
export async function extractPackageToDestination(filesystem, archive, destination, source, expectedRoot) {
    const parent = posix.dirname(destination);
    await filesystem.mkdir(parent, { recursive: true });
    const temporaryDirectory = await filesystem.createTemporaryDirectory(parent, '.node-glue-source');
    try {
        const extracted = await extractPackageArchive(filesystem, archive, temporaryDirectory, source, expectedRoot);
        await copyDirectory(filesystem, extracted.packageRoot, destination, source);
        return { packageRoot: destination, contentDigest: extracted.contentDigest };
    }
    finally {
        await filesystem.remove(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
}
//# sourceMappingURL=archive.js.map