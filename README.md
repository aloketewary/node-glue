# Node Glue

Node Glue is a local package repository and project materializer for Node.js. It stores verified package instances once, records each project's exact dependency map, and creates a project-specific `node_modules` tree from links into the store.

The result is shared package content without forcing unrelated projects to share one dependency layout.

**Package:** `node-glue`
**CLI:** `node-glue`
**Version:** `0.1.0`
**Status:** MVP implementation

[![Node.js >= 20.5](https://img.shields.io/badge/node-%3E%3D20.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript 5.8](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests: Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)

## How it works

Node Glue separates package acquisition from project materialization:

```text
Verified immutable package store
              +
Collision-safe project map
              +
Staged project-specific node_modules generation
              ↓
Project-root node_modules symlink
```

For a project, Node Glue:

1. Finds the project root by locating `package.json` in the requested directory or an ancestor.
2. Reads and hashes `package.json` and, when present, `package-lock.json`.
3. Resolves the dependency graph, including transitive dependencies, multiple versions, scoped packages, peer contexts, optional dependencies, and platform conditions.
4. Fetches missing package instances and verifies their manifests and integrity evidence.
5. Publishes verified content atomically into the central store.
6. Writes a project map and stages a complete dependency tree.
7. Runs only explicitly permitted lifecycle scripts, when enabled.
8. Publishes a new generation and updates the project-root `node_modules` symlink.

Unchanged, healthy projects are reused without reacquiring packages.

## Supported platforms and inputs

- macOS and Linux
- Node.js `>=20.5.0`
- npm package manifests
- `package-lock.json` versions 2 and 3
- Projects without an existing lockfile; Node Glue generates and publishes one during installation
- Registry, local directory, Git, and HTTP(S) tarball sources
- Direct and transitive dependencies, scoped packages, multiple versions, peer placements, optional dependencies, and platform-specific dependencies

Workspaces, Yarn lockfiles, pnpm lockfiles, and Windows are outside this MVP.

## Installation and development

Install the published package locally in a project:

```bash
npm install --save-dev node-glue
npx --no-install node-glue install
```

For a machine-wide CLI installation, use a user-owned npm prefix or a Node.js version manager such as `nvm`; npm must have permission to write its global bin directory:

```bash
npm install --global node-glue
node-glue --help
```

For repository development, install pinned dependencies and run the checks:

```bash
npm ci
npm run check
npm run build
```

Build output is written to `dist/`. `npm pack` and `npm publish` run the release checks and rebuild `dist/` automatically, so a stale local build cannot be published.

Run the CLI directly from a built checkout:

```bash
node dist/cli.js --help
node dist/cli.js --version
```

## Publishing

Before the first public release, this package is distributed under the [MIT License](LICENSE). Release history is documented in [`CHANGELOG.md`](CHANGELOG.md).

Check the package without publishing it:

```bash
npm run check
npm pack --dry-run
npm publish --dry-run
```

After authenticating with npm, publish the current first-release version:

```bash
npm login
npm whoami
npm publish --access public
```

For later releases, bump version before publishing:

```bash
npm version patch
npm publish --access public
```

`npm version` updates `package.json` and `package-lock.json`. The package build reads its runtime version from `package.json`, and `prepack` runs checks plus a clean build before npm creates the release tarball.

## CLI

```text
node-glue <command> [options]
```

### Project commands

```bash
node-glue install
node-glue ensure
node-glue exec -- npm test
node-glue doctor
```

- `install` resolves, acquires, and materializes project dependencies.
- `ensure` verifies existing project state and repairs it when input or materialization is stale.
- `exec -- <command> [args...]` ensures the project, then runs the command with the project root as its working directory.
- `doctor` performs read-only diagnostics for maps, state, store references, generations, symlinks, and platform capabilities. It exits nonzero when the project is not ready.

### Store and shell commands

```bash
node-glue gc
node-glue enable
node-glue disable
```

- `gc` removes only verified package instances not referenced by any valid project map. It aborts before deletion when map or reference state is uncertain.
- `enable` creates tool-owned `npm` and `npx` wrappers in `~/.node_modules/bin` and adds a marked PATH block to the active shell startup file.
- `disable` removes only Node Glue's marked PATH block. It does not replace or remove the system npm installation.

### Options

```text
--project-root <path>  Project directory (default: current directory)
--store-dir <path>    Store directory (default: ~/.node_modules)
--registry <url>      npm registry URL
--run-scripts          Enable configured lifecycle scripts
-h, --help             Show help
-v, --version          Show version
```

`install` and `ensure` emit JSON results on success. `exec` forwards the child process output and exit status. Diagnostics use stable error codes and redact credentials from messages and context.

## Opt-in npm integration

After enabling PATH integration, the generated npm shim keeps npm responsible for package metadata while Node Glue owns acquisition and materialization:

```bash
node-glue enable
npm install express
npm ci
npm run build
npx tsc
node-glue disable
```

Dispatch behavior:

- `npm install`, `npm i`, `npm uninstall`, and `npm update` delegate metadata changes to the real npm with `--package-lock-only` and `--ignore-scripts`, then ensure the project.
- `npm ci` validates the lockfile, prepares proven tool-owned links, and materializes the locked tree without normal npm reification.
- `npm run`, `npm test`, and `npx` ensure the project before delegation.
- `npm config`, `npm version`, and unknown commands pass through to the real npm.

The shim resolves the real npm executable while excluding its own bin directory, preventing recursive dispatch. PATH integration is opt-in and reversible; Node Glue does not modify the system npm binary.

## Store layout

The default store is `~/.node_modules`. A custom location can be supplied with `--store-dir` or the library API.

```text
<store>/
├── packages/
│   └── <encoded-package-name>/
│       └── <64-character-identity-hash>/
│           ├── content/
│           └── instance.json
├── projects/
│   └── <project-id>/
│       ├── map.json
│       ├── state.json
│       └── generations/
│           └── <generation>/
│               └── node_modules/
└── tmp/
```

Package identity includes the package name, version or Git revision, canonical source fingerprint, available integrity, and applicable environment attributes. Project IDs include the canonical project root and collision-resistant data; a path collision never silently overwrites another project's map.

Project maps contain exact package placements and store identity hashes, not credential-bearing locators. The active project `node_modules` path is a symlink to a validated, tool-owned generation.

## Safety guarantees

Node Glue treats package sources and existing project state as untrusted input:

- Registry integrity is checked when integrity metadata is available.
- Package manifests must match the resolved package identity.
- Archive extraction rejects traversal, absolute paths, duplicate paths, symlinks, unsupported entries, malformed roots, and unsafe package layouts.
- Git sources record resolved revisions.
- Local directory sources are canonicalized and reject symlinks.
- Package publication uses temporary directories and atomic rename boundaries.
- Central package content is never used as a lifecycle-script working directory.
- Lifecycle scripts are disabled by default and require an explicit allowlist when enabled.
- Lifecycle execution happens in project context with protected store paths and isolated output directories.
- Existing `node_modules` content is replaced only when Node Glue can prove it owns the current symlink and generation. Unmanaged, broken, unknown, or ambiguous state is preserved and reported.
- Failed publication restores the previous successful map, generation, symlink, and state where possible.
- Garbage collection validates all project maps and references before removing anything.
- Diagnostics and persisted maps redact credentials and tokens.

## Library API

The package is ESM and exposes the orchestration API plus lower-level resolver, source, store, map, materializer, lifecycle, diagnostic, and npm-integration primitives.

```ts
import { ensureProject, inspectProject } from 'node-glue';

const result = await ensureProject({
  projectRoot: process.cwd(),
  // storeDir: '/path/to/store',
  // registry: 'https://registry.npmjs.org',
  // runScripts: true,
});

console.log(result);
// {
//   projectRoot: '/path/to/project',
//   packagesAdded: 4,
//   packagesReused: 12,
//   packagesRemoved: 0,
//   materializationGeneration: '...'
// }

const state = await inspectProject(process.cwd());
console.log(state.status); // 'ready' | 'incomplete' | 'unknown'
```

For embedding and tests, `createNodeGlueApi` accepts injected filesystem, transport, process, lock, clock, store, resolver, materializer, lifecycle, Doctor, and garbage-collector collaborators. This keeps network access, filesystem mutation, child processes, and time replaceable at integration boundaries.

Lifecycle policy can be narrowed to an explicit package/script allowlist:

```ts
import { ensureProject } from 'node-glue';

await ensureProject({
  projectRoot: process.cwd(),
  lifecyclePolicy: {
    enabled: true,
    allowedPackages: ['some-native-package'],
    allowedScripts: ['some-native-package:install'],
  },
});
```

## Architecture

```text
src/
├── api.ts                     Install/ensure/inspect/doctor/gc orchestration
├── cli.ts                    CLI parsing, JSON output, and exec handling
├── dependency-resolver.ts    Arborist-backed dependency graph resolution
├── input-reader.ts           Project manifest and lockfile input
├── lockfile.ts               Lockfile v2/v3 normalization and generation
├── package-store.ts          Verified immutable package publication and reuse
├── project-map.ts            Collision-safe project map persistence
├── materializer.ts           Staged dependency-tree generation publication
├── bin-links.ts              Project-specific executable links
├── lifecycle.ts              Explicit, isolated lifecycle execution
├── doctor.ts                 Read-only project and repository diagnostics
├── gc.ts                     Reference-preserving garbage collection
├── npm/                      Real npm discovery, shim dispatch, PATH integration
├── sources/                  Registry, directory, Git, tarball, and archive logic
├── adapters/                 Injectable filesystem, process, lock, time, and transport contracts
└── platform/                 Capability and protected-path integration
```

Important boundaries:

- Arborist interprets npm dependency graphs; Node Glue owns storage and final project materialization.
- Source adapters own source-specific resolution, transport, and archive handling.
- The package store publishes only verified content and never runs lifecycle scripts.
- The materializer builds and validates a complete generation before changing the project-root link.
- The CLI stays thin; orchestration is available through the library API.

## Testing

Run all type checks and tests:

```bash
npm run check
```

Run only the test suite:

```bash
npm test
```

Run TypeScript without emitting files:

```bash
npm run typecheck
```

Run the Vitest watcher during development:

```bash
npm run test:watch
```

The test suite uses fake filesystem, source, process, store, lock, and failure-injection adapters. Coverage includes project discovery, lockfile normalization and generation, source resolution, semver selection, package identity, integrity verification, immutable publication and reuse, project-map collision handling, ownership checks, staged materialization, rollback, lifecycle isolation, CLI behavior, Doctor, garbage collection, and npm shim dispatch.

## Project documents

- [`docs/node-glue-mvp.md`](docs/node-glue-mvp.md) — provisional design rationale and storage model.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development and package-validation workflow.
- [`CHANGELOG.md`](CHANGELOG.md) — release history.
- [`LICENSE`](LICENSE) — MIT license terms.
- [`.kiro/specs/node-glue-mvp/tasks.md`](.kiro/specs/node-glue-mvp/tasks.md) — implementation plan and acceptance traceability.

The implementation tasks supersede older open decisions in the provisional design where they differ, including no-lockfile support, Git and tarball sources, explicit lifecycle opt-in, project-wide symlink materialization, and fail-closed handling of unmanaged `node_modules`.

## License

Node Glue is distributed under the [MIT License](LICENSE). Copyright (c) 2026 Aloke Tewary.
