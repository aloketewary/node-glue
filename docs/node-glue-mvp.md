# Node Glue MVP

**Status:** Draft / provisional design

## Purpose

Create a Maven-like local repository for Node.js packages.

The tool should let multiple projects reuse the same downloaded package versions while preserving a project-specific `node_modules` layout. Developers should continue using familiar npm commands such as `npm install`, `npm ci`, `npm run`, and `npx`.

The tool is not intended to expose one shared `node_modules` directory to every project. Node dependency resolution is project-specific, so the system will use:

```text
Central immutable package store
        +
Project-specific dependency map
        +
Generated node_modules links
```

## Proposed storage layout

```text
~/.node_modules/
├── packages/
│   ├── react/
│   │   └── 18.2.0/
│   ├── lodash/
│   │   └── 4.17.21/
│   └── @angular/
│       └── core/
│           └── <version>/
├── projects/
│   └── <project-id>/
│       ├── map.json
│       └── node_modules/
└── cache/
```

A project map records the exact package instances selected for that project:

```json
{
  "project": "api-doot",
  "lockfileHash": "sha256:<hash>",
  "packages": {
    "react": "18.2.0",
    "lodash": "4.17.21"
  }
}
```

Package identity must use more than name and version. The package integrity value, registry, platform, architecture, and Node ABI may also be relevant, especially for native or optional dependencies.

## Developer experience

The initial explicit commands are:

```bash
node-glue install
node-glue ensure
node-glue exec -- npm test
node-glue doctor
node-glue gc
```

The target experience is normal npm usage through an opt-in npm shim:

```bash
node-glue enable
npm install express
npm ci
npm run build
npx tsc
```

The shim must not replace the system npm installation by default. It should be enabled by adding a tool-owned directory to `PATH`.

## npm integration

The npm shim will delegate package declaration and lockfile operations to the real npm executable, while the Node Glue owns package storage and final materialization.

### `npm install` / `npm i`

```text
npm i express
    ↓
Node Glue npm shim
    ↓
real npm updates package.json and package-lock.json
    ↓
Node Glue reads the resulting lockfile
    ↓
missing packages are stored centrally
    ↓
project-specific node_modules links are generated
```

Where compatible, npm should be used in package-lock-only mode so it does not create the final local dependency tree. Package lifecycle scripts should not run while the central package store is being populated.

### `npm ci`

The shim should not delegate directly to normal `npm ci`, because npm removes the existing `node_modules` directory and creates its own tree. Instead, the tool should:

1. Validate `package.json` against `package-lock.json`.
2. Remove only links owned by Node Glue.
3. Ensure all locked package contents exist centrally.
4. Materialize the exact project tree.

### Other commands

```text
npm install / npm i       update package metadata, then materialize
npm uninstall             update package metadata, then materialize
npm update                update package metadata, then materialize
npm ci                    validate lockfile, then clean-materialize
npm run / npm test        ensure project, then delegate to npm
npx                       ensure project, then delegate to npx
npm config / npm version  delegate unchanged
```

## Technology choice

### TypeScript and Node.js

Use TypeScript for the library and CLI.

Reasons:

- Direct access to Node package and filesystem behavior.
- Easy npm package distribution.
- Existing npm ecosystem libraries can be reused.
- Lifecycle scripts and Node executables run in the native environment.
- The same code can expose a library API and a CLI.

### Existing libraries

Use adapters around npm ecosystem components:

- `@npmcli/arborist`: interpret package trees and lockfiles; build the ideal dependency tree.
- `pacote`: resolve and fetch npm-compatible package manifests and tarballs.
- `cacache`: provide content-addressed, concurrent, corruption-resistant cache behavior.
- `semver`: handle npm-compatible version ranges where required.

Arborist should be isolated behind an internal resolver interface. The tool should use its tree interpretation capabilities but own custom central storage and project materialization rather than depending on standard npm reification behavior.

Go and Rust remain possible future implementation choices for a native standalone executable. They are not recommended for MVP because they would require reimplementing npm registry, lockfile, semver, package metadata, lifecycle, and resolution behavior.

## Proposed package architecture

Start as one npm package with a library core and a thin CLI:

```text
src/
├── api.ts
├── project.ts
├── lockfile.ts
├── dependency-tree.ts
├── package-store.ts
├── materializer.ts
├── bin-links.ts
└── cli.ts
```

Suggested library boundary:

```ts
export interface EnsureProjectOptions {
  projectRoot: string;
  storeDir?: string;
  registry?: string;
  runScripts?: boolean;
}

export interface InstallResult {
  projectRoot: string;
  packagesAdded: number;
  packagesReused: number;
  packagesRemoved: number;
}

export function ensureProject(
  options: EnsureProjectOptions,
): Promise<InstallResult>;

export function inspectProject(
  projectRoot: string,
): Promise<ProjectState>;

export function garbageCollect(
  storeDir: string,
): Promise<GarbageCollectionResult>;
```

Split into multiple packages only after the core behavior is stable:

```text
@node-glue/core
@node-glue/npm
@node-glue/store
@node-glue/cli
```

## MVP installation flow

```text
1. Find project root.
2. Read package.json.
3. Read package-lock.json.
4. Resolve the dependency tree.
5. Fetch missing package metadata and tarballs.
6. Verify package integrity.
7. Extract packages into immutable central directories.
8. Build or update the project map.
9. Generate project-specific node_modules links.
10. Generate .bin links.
11. Run permitted project-context lifecycle work.
12. Atomically publish the resulting tree.
```

Materialization should happen in a temporary staging directory. The completed tree should be published atomically where the platform permits. Existing unmanaged `node_modules` content must not be deleted automatically.

## Initial scope

Recommended MVP boundaries:

```text
Language:              TypeScript
Runtime:               Node.js
Platforms:             macOS and Linux
Package source:        npm registry
Lockfiles:             package-lock.json v2 and v3
Storage:               ~/.node_modules
Project layout:        symlink-based
CLI:                   yes
npm shim:              opt-in
Lifecycle scripts:     explicit or controlled mode
Workspaces:            later
Yarn/pnpm lockfiles:   later
Git/file dependencies: later
```

The MVP should support:

- Direct dependencies.
- Transitive dependencies.
- Multiple versions of the same package.
- Scoped packages.
- Package integrity verification.
- Project-specific `.bin` links.
- Lockfile change detection.
- Reuse of packages across projects.
- Safe cleanup of unreferenced central versions.
- Clear diagnostics for unsupported dependency layouts.

## Lifecycle and native packages

Central package directories must remain immutable. Install scripts must never modify the canonical package contents.

Lifecycle handling requires a separate project-context phase. Native packages may require platform, architecture, and Node ABI-specific outputs. These outputs must be stored per project or per compatible environment rather than written into the shared immutable package directory.

MVP should begin with controlled lifecycle behavior and explicit configuration. Full npm-compatible script behavior can be expanded after the storage and materialization model is proven.

## Safety rules

- Never delete an unmanaged `node_modules` directory automatically.
- Never execute package scripts inside the central immutable store.
- Verify registry integrity before accepting package content.
- Use atomic writes for maps and installation state.
- Use a project identifier that cannot collide between unrelated directories.
- Keep secrets and registry credentials out of project maps.
- Provide `doctor` diagnostics for broken links and incomplete installs.
- Make shell integration opt-in and reversible.

## Open decisions before implementation lock

1. Require an existing `package-lock.json`, or resolve projects without one?
2. Support npm registry packages only, or include file, Git, and tarball dependencies?
3. Enable lifecycle scripts by default or require an explicit option?
4. Use a project `node_modules` symlink, or create links inside the real project directory?
5. How should peer dependencies be represented in project maps?
6. How should native package build outputs be isolated?
7. Should the first npm shim support only `npm i`, `npm ci`, and `npm run`, or more commands?
8. What project identifier should be used for projects with the same directory name?
9. What package name should be used for the published library and CLI?

## References

- [npm Arborist](https://github.com/npm/cli/tree/latest/workspaces/arborist)
- [Pacote](https://github.com/npm/pacote)
- [cacache](https://github.com/npm/cacache)
- [npm package-lock.json documentation](https://docs.npmjs.com/cli/v9/configuring-npm/package-lock-json)
- [npm install strategy documentation](https://docs.npmjs.com/cli/v12/commands/npm-ci)
- [Node.js package documentation](https://nodejs.org/docs/latest/api/packages.html)
