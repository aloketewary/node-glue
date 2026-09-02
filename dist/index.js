/** Public library entry point. */
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const packageMetadata = nodeRequire('../package.json');
export const VERSION = packageMetadata.version;
export * from './errors.js';
export * from './lockfile.js';
export * from './input-reader.js';
export * from './project.js';
export * from './types.js';
export * from './package-identity.js';
export * from './package-store.js';
export * from './dependency-resolver.js';
export * from './project-map.js';
export * from './state.js';
export * from './ownership.js';
export * from './doctor.js';
export * from './gc.js';
export * from './materializer.js';
export * from './bin-links.js';
export * from './locks.js';
export * from './sources/index.js';
export * from './lifecycle.js';
export * from './platform/index.js';
export * from './api.js';
export * from './npm/real-npm.js';
export * from './npm/shim.js';
export * from './npm/path-integration.js';
//# sourceMappingURL=index.js.map