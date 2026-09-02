# Node Glue MVP Design

## 1. Scope and design decisions

Node Glue is a TypeScript library and CLI running on Node.js on macOS and Linux. It owns package acquisition, verification, immutable storage, project maps, dependency-tree materialization, diagnostics, cleanup, and an opt-in npm shim. Real npm remains responsible for npm metadata operations where the command contract requires it.

The design preserves these decisions from clarification and requirements:

- A project may have no `package-lock.json`; Node Glue resolves from `package.json` and writes a lockfile before publishing its Project Map.
- Supported sources are npm registry packages, local directories, Git references, and tarball URLs.
- Lifecycle scripts are disabled by default and run only when explicitly enabled, in a project-context sandbox outside the immutable store.
- Each project exposes a complete, project-specific dependency tree through one project-wide `node_modules` symlink.
- Node Glue never replaces or deletes an unmanaged `node_modules` path or its content.
- Lockfile versions 2 and 3 are supported. Workspaces and Yarn/pnpm lockfiles remain outside the MVP unless represented by a supported npm lockfile.

The implementation starts as one package with library and CLI entry points. Internal modules remain replaceable so the core can later be split into `@node-glue/core`, `@node-glue/store`, `@node-glue/npm`, and `@node-glue/cli`.

## 2. Architecture

```text
CLI/API
  ├─ ProjectLocator + InputReader
  ├─ Lockfile/PackageJson adapters
  ├─ DependencyResolver ── SourceResolver adapters ── npm / local / Git / tarball
  ├─ PackageStore ── integrity verification + immutable publication
  ├─ ProjectMapRepository ── atomic map and state files
  ├─ Materializer ── staging + package/bin links + project-wide symlink
  ├─ LifecycleRunner ── explicit opt-in, protected project-context execution
  ├─ Doctor + GarbageCollector
  └─ NpmShim + RealNpmRunner
```

### 2.1 Project and input layer

`ProjectLocator` searches from the requested directory toward its ancestors, or uses the requested directory when it contains `package.json`. It returns a canonical absolute Project Root. `InputReader` reads `package.json` and an optional `package-lock.json`, records file hashes, and rejects malformed JSON with a typed diagnostic containing Project Root and source path.

`LockfileReader` accepts only lockfile versions 2 and 3. It converts both formats into one internal normalized representation, preserving package paths, resolved URLs, integrity, dependency declarations, peer metadata, optional flags, and bin metadata. For a project without a lockfile, `DependencyResolver` builds an npm-compatible ideal tree from `package.json`; `LockfileWriter` serializes the resolved tree to a canonical package-lock representation and atomically publishes it before the Project Map.

The lockfile writer never copies credentials from npm configuration or source metadata. URL credentials are used only by the source adapter and are removed from persisted lockfile/map fields where npm permits redaction; a credential-bearing source that cannot be safely represented is rejected with a diagnostic rather than persisted.

### 2.2 Dependency resolution

`DependencyResolver` is isolated behind an adapter interface. The default adapter uses `@npmcli/arborist` for npm tree interpretation and ideal-tree construction, `semver` for range operations where needed, and `pacote`/source-specific adapters for manifests and content. Arborist never owns final reification: it supplies a normalized graph to Node Glue.

Resolution algorithm:

1. Read direct dependencies, dev dependencies, optional dependencies, peer declarations, overrides, and supported lockfile metadata.
2. Build or read the complete direct/transitive graph.
3. Resolve every source to a `PackageInstance` candidate and retain placement information.
4. Preserve distinct placements when conflicting constraints require multiple versions.
5. Record peer-dependent placements with their selected peer context.
6. Validate optional/platform conditions and dependency constraints.
7. Return an immutable `ResolvedProject` only after all required constraints are satisfiable.

A failed constraint produces `ResolutionConflictError` with package names, ranges, and the graph paths that introduced them. Materialization is not called for an incomplete graph.

### 2.3 Dependency source adapters

All source adapters implement the same boundary so transport and storage remain independent:

```ts
export type DependencySource =
  | { kind: 'registry'; registry: string; name: string; spec: string }
  | { kind: 'directory'; path: string }
  | { kind: 'git'; locator: string; ref?: string }
  | { kind: 'tarball'; url: string };

export interface SourceAdapter {
  canHandle(source: DependencySource): boolean;
  resolve(source: DependencySource): Promise<ResolvedSource>;
  fetch(source: ResolvedSource, destination: string): Promise<FetchedPackage>;
}

export interface ResolvedSource {
  source: DependencySource;
  name: string;
  versionOrRevision: string;
  integrity?: string;
  resolvedLocator: string;
  environment?: EnvironmentFingerprint;
}
```

- Registry resolution uses the configured registry and `pacote` metadata/tarball behavior.
- Directory resolution canonicalizes the path, reads its package manifest, and fingerprints content/source identity so local instances cannot be confused with registry instances.
- Git resolution records the resolved commit revision, not only a mutable branch or tag.
- Tarball resolution records URL, available integrity, archive digest, and package metadata after safe extraction.

Unsupported source syntax is rejected before network or filesystem acquisition. Archive extraction uses a temporary directory, rejects path traversal and invalid package roots, and only passes validated package content to the store.

### 2.4 Package identity and central store

A package is identified by a canonical serialized `PackageIdentity`, hashed with SHA-256 for path safety. Name and version alone are insufficient.

```ts
export interface EnvironmentFingerprint {
  platform?: NodeJS.Platform;
  arch?: string;
  nodeAbi?: string;
}

export interface PackageIdentity {
  name: string;                 // complete name, including scope
  versionOrRevision: string;
  source: string;               // canonical source kind + locator fingerprint
  integrity?: string;
  environment?: EnvironmentFingerprint;
}

export interface PackageInstance {
  identity: PackageIdentity;
  identityHash: string;
  contentPath: string;
  manifest: PackageManifest;
  verifiedAt: string;
}
```

The default store is `~/.node_modules`, with a layout similar to:

```text
~/.node_modules/
├── packages/<encoded-name>/<identity-hash>/
│   ├── content/                 # immutable package files
│   └── instance.json            # identity, manifest summary, verification record
├── projects/<project-id>/
│   ├── map.json
│   ├── state.json
│   └── generations/<generation>/node_modules/
├── cache/                       # cacache transport/cache data, never project state
└── tmp/
```

`PackageStore` fetches and extracts outside any published package directory, verifies registry/source integrity, writes metadata, fsyncs where supported, and publishes the completed instance by atomic rename into a previously unused identity path. A matching verified identity is reused without another download. Store paths are tool-owned and never used as lifecycle working directories.

A failed verification, extraction, or publication leaves no usable partial instance. If an identity already has a successful publication, failed replacement work is discarded and the old content remains untouched. Store writes are serialized per identity; independent identities may proceed concurrently.

### 2.5 Project maps and state

A project identifier is derived from a canonical Project Root using a readable basename plus a collision-resistant hash. `ProjectMapRepository` checks the stored canonical root whenever an identifier already exists; a mismatch causes a longer/different hash identifier rather than overwriting the unrelated map.

```ts
export interface DependencyPlacement {
  relativePath: string;            // e.g. node_modules/react or nested path
  packageIdentityHash: string;
  packageName: string;
  peerContext?: Record<string, string>;
  binEntries?: Record<string, string>;
}

export interface ProjectMap {
  schemaVersion: 1;
  projectId: string;
  projectRoot: string;
  lockfileHash: string;
  placements: DependencyPlacement[];
  generatedAt: string;
  toolVersion: string;
}
```

The persisted map contains exact placements and identity hashes, never bearer tokens, registry passwords, auth headers, or unredacted credential URLs. Map replacement uses write-to-temporary-file, flush/close, and atomic rename. A map generation is accepted only after schema and reference validation.

`state.json` records the last successful map generation, materialization generation, active target, and diagnostic-safe timestamps. It is advisory; the map and filesystem are revalidated by `ensure` and `doctor`.

### 2.6 Materialization and ownership

`Materializer` converts a resolved project map into symlink-based project state:

1. Acquire the project operation lock and validate required filesystem/symlink capabilities.
2. Inspect the existing Project Root `node_modules` path before changing anything.
3. Prove it is absent or tool-owned. A tool-owned symlink must target a registered project generation; a tool-owned directory must contain a valid ownership marker and matching project state. Unknown, broken, or ambiguous ownership is treated as unmanaged.
4. Build the complete dependency tree under `projects/<id>/generations/<new-generation>/node_modules` in a temporary staging directory.
5. Create package links for every placement, nested dependency link, scoped-package segment, and project-specific `.bin` entry. All links resolve to verified central instances or generated project-context state.
6. Validate the staged tree, map references, symlink targets, and bin targets.
7. Publish the generation and create a temporary project-root symlink, then atomically rename it to the Project Root `node_modules` path where supported.
8. Atomically update state/map references and retain the previously successful generation until the new publication is confirmed.

The Project Root symlink points to the selected tool-owned generation directory. The entire dependency tree is staged before this symlink changes, so Node sees either the prior complete tree or the new complete tree. Neighboring project files are never touched. Unmanaged `node_modules` content causes `UnmanagedNodeModulesError` before replacement and includes remediation (`move it`, `remove it manually`, or explicitly adopt it in a future command; no automatic adoption is in MVP).

### 2.7 Lifecycle and environment-specific output

Lifecycle execution is controlled by `runScripts: false` by default. When enabled, `LifecycleRunner` evaluates an explicit allowlist/configuration and runs only permitted scripts in Project Context. It never runs a script while populating `packages/.../content`.

The runner uses a platform capability adapter to make the central store readable but non-writable to the child process and to redirect generated native/build output to project-specific or compatible-environment-specific state. On macOS/Linux, the adapter uses the strongest available OS-level read-only/filesystem isolation mechanism; if the required capability is unavailable, the affected script operation stops with a capability diagnostic rather than falling back to an unprotected store. A write attempt to a protected path terminates the script and reports the path. Nonzero exit reports package, script name, exit status, and Project Root, while the last successful materialization remains active.

### 2.8 CLI, npm shim, and Real npm

Public library API:

```ts
export interface EnsureProjectOptions {
  projectRoot: string;
  storeDir?: string;
  registry?: string;
  runScripts?: boolean;
  lifecyclePolicy?: LifecyclePolicy;
}

export interface InstallResult {
  projectRoot: string;
  packagesAdded: number;
  packagesReused: number;
  packagesRemoved: number;
  materializationGeneration: string;
}

export function ensureProject(options: EnsureProjectOptions): Promise<InstallResult>;
export function inspectProject(projectRoot: string): Promise<ProjectState>;
export function garbageCollect(storeDir?: string): Promise<GarbageCollectionResult>;
```

CLI commands are thin orchestration around the library:

- `node-glue install`: discover/read, resolve, acquire, map, and materialize.
- `node-glue ensure`: compare lockfile/map/state and repair missing or stale tool-owned links.
- `node-glue exec -- <command>`: ensure first, then spawn with Project Root as cwd and project context.
- `node-glue doctor`: inspect maps, generations, symlink targets, source content, and store references.
- `node-glue gc`: acquire the store lock, read and validate every current Project Map, mark all referenced identity hashes, then sweep only unmarked instances.
- `node-glue enable`/`disable`: add/remove only a tool-owned bin directory from shell PATH integration.

The npm shim resolves and stores the absolute Real npm path before invoking it, excluding the shim directory from lookup to avoid recursion. Its dispatch table is:

| Command | Shim behavior |
|---|---|
| `install`, `i`, `uninstall`, `update` | Delegate metadata/lockfile operation to Real npm in package-lock-only-compatible mode, then ensure/materialize. |
| `ci` | Validate lockfile, remove only proven tool-owned links, ensure locked instances, then exact-tree materialize; do not call normal `npm ci` reification. |
| `run`, `test` | Ensure, then delegate unchanged to Real npm. |
| `npx` | Ensure, then delegate to Real npm/npx with original arguments. |
| `config`, `version` | Pass through unchanged and do not mutate repository state. |

Unknown commands are passed through conservatively unless they are explicitly unsafe to intercept; the system npm installation is never modified. Disabling removes only the tool-owned PATH integration and leaves the prior npm installation intact.

### 2.9 Doctor, garbage collection, and locking

All diagnostics use stable codes and structured context, then render human-readable messages. Important codes include `PROJECT_NOT_FOUND`, `PARSE_FAILURE`, `UNSUPPORTED_LOCKFILE`, `SOURCE_FAILURE`, `RESOLUTION_CONFLICT`, `INTEGRITY_MISMATCH`, `UNMANAGED_NODE_MODULES`, `OWNERSHIP_UNKNOWN`, `PUBLICATION_FAILURE`, `LIFECYCLE_FAILURE`, `PROTECTED_PATH`, `MISSING_STORE_INSTANCE`, `STALE_PROJECT_MAP`, `UNRESOLVED_REFERENCE`, and `CAPABILITY_UNAVAILABLE`.

Project operations use a per-project lock. Store publication and garbage collection use a store lock. GC refuses to sweep if any current map is unreadable, malformed, or references an unresolved instance. Doctor reports each affected path and reason, including broken symlinks, stale maps, incomplete generations, and missing central content.

## 3. Main interfaces and module boundaries

```ts
export interface ProjectLocator {
  locate(start: string): Promise<string>;
}

export interface ProjectInputReader {
  read(projectRoot: string): Promise<ProjectInput>;
}

export interface DependencyResolver {
  resolve(input: ProjectInput, options: ResolveOptions): Promise<ResolvedProject>;
}

export interface PackageStore {
  ensure(instance: ResolvedSource, options?: StoreOptions): Promise<PackageInstance>;
  get(identityHash: string): Promise<PackageInstance | undefined>;
}

export interface ProjectMapRepository {
  read(projectId: string): Promise<ProjectMap | undefined>;
  publish(map: ProjectMap): Promise<void>;
  list(): Promise<ProjectMapSummary[]>;
}

export interface Materializer {
  materialize(projectRoot: string, map: ProjectMap): Promise<MaterializationResult>;
}

export interface LifecycleRunner {
  run(project: ResolvedProject, policy: LifecyclePolicy): Promise<void>;
}
```

These interfaces keep transport, resolution, storage, materialization, process execution, and CLI concerns independently testable. Filesystem and child-process access are injected behind adapters so unit/property tests do not require a network or destructive filesystem operations.

## 4. End-to-end flows

### Install or ensure with a lockfile

```text
locate Project Root
  → read package.json + lockfile v2/v3
  → normalize lockfile and validate package.json compatibility
  → resolve placements and peer contexts
  → ensure verified Package Instances in central store
  → build and atomically publish complete Project Map
  → optionally run permitted project-context lifecycle work
  → stage and publish generation + project-wide node_modules symlink
  → update successful state
```

### Install without a lockfile

```text
locate/read package.json
  → build npm-compatible ideal tree
  → acquire and verify all selected sources
  → write canonical package-lock.json atomically
  → publish Project Map with resulting lockfile hash
  → materialize project tree
```

If any step before publication fails, no new map or project symlink is published. If lifecycle or materialization fails after a previous success, the previous map/generation remains active and the failure is diagnosable.

### Garbage collection

```text
lock store
  → read every current Project Map
  → validate all maps and references
  → if any reference is unresolved: abort without deletion
  → mark referenced identity hashes
  → sweep only unmarked package instances
  → retain transport cache according to cache policy
```

## 5. Error handling and recovery

Errors are typed, actionable, and include safe context. They never include credentials or full environment secrets. Each mutating operation follows a prepare/validate/publish boundary:

- Parse, source, resolution, and integrity errors stop before map/materialization publication.
- Store failures write only temporary paths and preserve already-published instances.
- Map failures leave the previous complete map readable.
- Materialization failures leave the previous complete generation and root symlink active.
- Unmanaged or ambiguous `node_modules` paths fail before unlink/rmdir.
- Lifecycle failures cannot make central package content the active mutable workspace.
- GC uncertainty is fail-closed: no package is deleted when references cannot be determined.
- Missing symlink or atomic-rename capabilities stop the affected operation with a capability requirement.

## Correctness Properties

*A correctness property describes behavior that must hold for all valid inputs. Properties below are the consolidated set after reflecting on the acceptance-criteria prework; overlapping checks are combined, while filesystem, process, external-service, and one-time setup checks remain example, edge-case, integration, or smoke tests.*

### Property 1: Supported project inputs normalize consistently

For any valid project input with either a package-lock v2/v3 or no lockfile, normalization and resolution SHALL produce one complete internal project graph; when no lockfile is present, the generated lockfile SHALL be durably published before the corresponding Project Map can be published.

**Validates: Requirements 1.2, 1.3, 1.4**

### Property 2: Resolution preserves dependency graph identity and context

For any satisfiable dependency graph, resolution SHALL include every required direct and transitive placement, preserve each complete scoped package name, retain distinct Package Instance identities for conflicting versions, and record the selected peer context for every peer-dependent placement.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 3: Environment and integrity affect package identity when applicable

For any package metadata, changing an available integrity value or an environment attribute that affects package contents SHALL produce a distinct Package Instance identity, while equivalent identity inputs SHALL produce the same identity hash.

**Validates: Requirements 3.5, 3.6**

### Property 4: Verified content is the only content publishable to the store

For any fetched package content and available source integrity data, matching content SHALL be eligible for immutable publication and mismatching content SHALL never produce a usable Package Instance; a matching already-verified identity SHALL be reused without a second download.

**Validates: Requirements 4.1, 4.2, 4.5**

### Property 5: Store publication is immutable and script-free

For any successfully published Package Instance, its content SHALL reside under a tool-owned immutable path and later acquisition or lifecycle processing SHALL neither mutate that content nor execute a Lifecycle Script in the Central Package Store.

**Validates: Requirements 4.3, 4.4**

### Property 6: Project maps are complete, collision-safe, and secret-free

For any Project Root and resolved placement set, the published Project Map SHALL contain a stable collision-resistant project identifier, the exact lockfile hash, every selected Package Instance placement, and no registry credentials or other secrets; unrelated roots SHALL never overwrite one another's map.

**Validates: Requirements 5.1, 5.2, 5.5, 5.6**

### Property 7: Unchanged projects are idempotent

For any successfully materialized project, repeating ensure with the same lockfile hash SHALL skip dependency acquisition and preserve equivalent map/materialization state, while a changed hash SHALL invalidate the stale state before acquisition.

**Validates: Requirements 5.4**

### Property 8: Materialization stages a complete tree before publication

For any valid Project Map, materialization SHALL construct and validate the complete project-specific dependency tree, including nested placements and `.bin` links, before changing the Project Root `node_modules` publication.

**Validates: Requirements 6.1, 6.6**

### Property 9: Tool-owned materialization replacement is ownership-bound

For any prior `node_modules` state proven to be tool-owned, materialization SHALL replace it with the new project-wide symlink targeting the selected tool-owned generation; for any unproven or unmanaged state, materialization SHALL make no replacement.

**Validates: Requirements 6.4, 6.5, 9.1**

### Property 10: Failed publication preserves the last successful state

For any project with a last successful map and materialization, an injected staging, validation, publication, or permitted lifecycle failure SHALL leave that prior map, generation, and project-wide symlink usable and discoverable by Doctor.

**Validates: Requirements 6.8, 8.5, 9.3**

### Property 11: Explicit lifecycle execution remains isolated

For any package and explicit lifecycle policy, only permitted scripts SHALL run, execution SHALL occur in Project Context with the central store protected from writes, and environment-specific outputs SHALL be written outside immutable Package Instance content.

**Validates: Requirements 8.2, 8.3, 8.4**

### Property 12: Garbage collection is reference-preserving and fail-closed

For any set of valid Project Maps and Package Instances, garbage collection SHALL preserve every identity referenced by any current map and may remove only unreferenced instances; if any reference set cannot be determined, it SHALL remove none.

**Validates: Requirements 9.4, 9.5**

## 7. Testing strategy

Use complementary test types:

- Unit tests for parsers, canonical identity, secret redaction, source-format validation, ownership proofs, map serialization, and diagnostic formatting.
- Property-based tests for Properties 1–12, with at least 100 generated cases per property. Each test is tagged `Feature: node-glue-mvp, Property N: <property text>` and uses injected resolver/store/filesystem/process adapters.
- Example and edge-case tests for project discovery, malformed input, unsupported lockfiles/sources, conflicting constraints, unmanaged/ambiguous `node_modules`, failed integrity/extraction/publication, protected paths, and capability failures.
- Integration tests for registry/local/Git/tarball adapters; CLI commands; Real npm delegation; atomic filesystems; Doctor; and GC.
- Smoke tests on macOS and Linux for install, materialization, Doctor, GC, shim enable/disable, and required symlink capabilities.

Property tests must not make real network calls, run arbitrary lifecycle scripts, or delete a developer's filesystem. Integration fixtures use temporary stores and projects. Frontend/UI testing is not applicable to this CLI/library MVP.

## 8. Operational considerations

The store and project operations need explicit lock files with stale-lock diagnostics. Temporary files and generations receive tool-owned names and are cleaned only when no active operation references them. Debug logs may include identity hashes and safe source kinds but never credentials. Store schema and map schema versions are persisted so future releases can migrate or reject state explicitly rather than guessing.
