# Node Glue

> A Maven-like local package repository for Node.js projects.

Node Glue is being built to make dependency reuse predictable, safe, and project-specific. The long-term goal is to download a package version once, keep it in an immutable local store, and materialize the exact dependency layout each project needs—without forcing unrelated projects to share one `node_modules` tree.

**Current package:** `node-glue`  
**CLI name:** `node-glue`  
**Status:** Foundation / early MVP

[![Node.js >= 20.5](https://img.shields.io/badge/node-%3E%3D20.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)

## Why Node Glue?

Modern Node.js projects repeatedly download and unpack the same package versions. At the same time, a single shared `node_modules` directory cannot safely represent every project's dependency graph, peer dependency context, platform, or lockfile.

Node Glue separates those concerns:

```text
Immutable package store
          +
Project-specific dependency map
          +
Generated project links
```

This model is intended to provide:

- **Faster project setup:** reuse package content already present locally.
- **Reproducible installs:** derive project state from package metadata and lockfile identity.
- **Correct isolation:** preserve each project's own dependency layout and package versions.
- **Safer operations:** verify package content, reject unsafe archives, and keep storage boundaries explicit.
- **Familiar workflows:** remain compatible with the Node.js and npm ecosystem rather than introducing a new package format.

## What exists today

The current release is the foundation for the repository engine, not a finished install replacement. It includes:

- Project-root discovery by walking ancestor directories for `package.json`.
- Project input reading with deterministic SHA-256 hashes for `package.json` and, when present, `package-lock.json`.
- Validation for npm lockfile versions 2 and 3.
- Injectable source adapters for:
  - npm-style registry packages and semver resolution;
  - absolute local directories;
  - Git sources and resolved revisions;
  - HTTP(S) tarballs.
- Package manifest validation and registry integrity verification when integrity metadata is supplied.
- Defensive archive extraction that rejects traversal, absolute paths, duplicate paths, symlinks, unsupported entries, and malformed package roots.
- Structured, sanitized diagnostics through typed repository errors.
- An adapter-oriented TypeScript architecture that can be tested without relying on live registries or the host filesystem.

## What is next

The product direction is to add the repository lifecycle around this foundation:

1. Resolve package trees from npm lockfiles.
2. Store verified package instances centrally and immutably.
3. Maintain project maps keyed by project and lockfile state.
4. Materialize project-specific `node_modules` and `.bin` links.
5. Add controlled lifecycle-script handling for project-context builds.
6. Provide functional `install`, `ensure`, `exec`, `doctor`, and `gc` commands.
7. Add an opt-in npm shim so familiar commands can use the repository transparently.

These capabilities are design targets. They are **not yet shipped** in the current package.

## Quick start

### Requirements

- macOS or Linux
- Node.js `>=20.5.0`
- npm

### Install dependencies and verify the project

```bash
npm ci
npm run check
```

### Build

```bash
npm run build
```

Build output is written to `dist/`, including JavaScript, declarations, declaration maps, and source maps.

### Inspect the current CLI scaffold

```bash
node dist/cli.js --help
node dist/cli.js --version
```

The CLI currently implements help and version reporting. The command names shown by help are the planned interface; dependency installation and materialization are not yet dispatched.

## Library usage

The package exposes project-input and source-adapter primitives as an ESM library. For example, read and fingerprint the nearest Node.js project:

```ts
import { readProjectInput } from 'node-glue';

const project = await readProjectInput(process.cwd());

console.log({
  root: project.projectRoot,
  packageJsonHash: project.packageJsonHash,
  lockfileHash: project.lockfileHash,
});
```

This reads project metadata only. It does not resolve dependencies, download packages, or create `node_modules`.

Source adapters are designed around explicit infrastructure boundaries so production and test implementations can be supplied independently:

```ts
import {
  SourceAdapterRegistry,
  createDefaultSourceAdapters,
} from 'node-glue';

const adapters = new SourceAdapterRegistry(
  createDefaultSourceAdapters({
    filesystem,
    registry: registryTransport,
    sources: sourceTransport,
  }),
);

const resolved = await adapters.resolve(dependencySource);
await adapters.fetch(resolved, destination);
```

`filesystem`, `registryTransport`, and `sourceTransport` are intentionally supplied by the caller. The current package does not yet provide a default production store or network wiring.

## Architecture

```text
src/
├── index.ts                 Public package exports
├── cli.ts                   Thin CLI scaffold
├── project.ts               Project-root discovery
├── input-reader.ts          Manifest/lockfile reading and hashing
├── types.ts                 Domain models and public types
├── errors.ts                Structured diagnostics and redaction
├── adapters/                Injectable filesystem, process, lock, time, and transport contracts
└── sources/                 Registry, directory, Git, tarball, and archive logic
```

Key design choices:

- **Explicit boundaries:** filesystem, registry, source transport, process, time, and locking are represented as adapters.
- **Fail-closed source selection:** unsupported source formats produce structured errors instead of falling through silently.
- **Content validation before publication:** manifests, archive paths, package identity, and integrity are checked before package content is accepted.
- **Deterministic project identity:** source metadata is hashed before future resolution and materialization work.
- **Thin CLI:** orchestration belongs in the library core; the CLI should remain a small user-facing entry point.

## Supported source inputs

| Source | Current support | Notes |
| --- | --- | --- |
| Registry | Implemented adapter | Exact versions, dist-tags, and semver ranges through injected registry transport |
| Local directory | Implemented adapter | Absolute paths; canonicalized and recursively copied; symlink sources rejected |
| Git | Implemented adapter | Revision resolution delegated to injected source transport |
| Tarball | Implemented adapter | HTTP(S) fetch plus guarded archive extraction |

The source adapters are usable building blocks. They are not yet connected to a complete dependency resolver or install command.

## Safety model

The implementation treats package acquisition as an untrusted-input boundary:

- Registry integrity is checked when supported integrity metadata is available.
- Credential-bearing URLs are rejected and diagnostic context is sanitized.
- Archive traversal and absolute paths are rejected.
- Unsupported archive entry types and extended metadata are rejected.
- Package archives must contain one valid package root and `package.json`.
- Local source symlinks are rejected.
- Errors carry stable codes and safe context for diagnostics.

The planned central store will add immutability, atomic publication, ownership tracking, and garbage collection. Those guarantees should not be assumed from the current foundation alone.

## Development

Run the full local validation suite:

```bash
npm run check
```

Run only tests:

```bash
npm test
```

Run the TypeScript compiler without emitting files:

```bash
npm run typecheck
```

Run tests in watch mode during development:

```bash
npm run test:watch
```

Tests use Vitest and cover project discovery, input parsing, lockfile validation, hashing, CLI flags, source adapters, semver selection, local copying, Git revision capture, archive safety, and fixture seams.

## Project roadmap

### Foundation — current

- [x] TypeScript/ESM package and CLI entry point
- [x] Project discovery and input fingerprinting
- [x] Lockfile v2/v3 validation
- [x] Registry, directory, Git, and tarball source adapter contracts
- [x] Manifest, integrity, and archive safety validation
- [x] Structured diagnostics and test doubles

### Repository engine — next

- [ ] npm-compatible dependency-tree resolution
- [ ] Content-addressed or immutable package storage
- [ ] Project maps and lockfile change detection
- [ ] Atomic project materialization
- [ ] Project-specific `node_modules` and `.bin` links
- [ ] Concurrency and stale-lock handling

### Developer experience — planned

- [ ] Functional `node-glue install` and `node-glue ensure`
- [ ] `node-glue exec`, `doctor`, and `gc`
- [ ] Opt-in npm shim and reversible `PATH` integration
- [ ] Controlled lifecycle and native-package handling
- [ ] Broader workspace and package-manager support

## Contributing

Contributions should preserve the adapter boundaries and keep untrusted package input fail-closed. Before opening a change:

1. Keep public behavior documented by tests.
2. Add or update focused tests for changed source, parser, or error behavior.
3. Run `npm run check`.
4. Avoid presenting roadmap behavior as implemented behavior.

See [`docs/node-glue-mvp.md`](docs/node-glue-mvp.md) for the provisional product design, storage model, npm integration proposal, open decisions, and longer-term architecture.

## License

No license has been declared yet.
