# Implementation Plan: Node Glue MVP

## Overview

Implement the TypeScript/Node.js MVP as one package with a library core and thin CLI. Build the system in dependency order: typed boundaries and test doubles, project/lockfile input, source-aware dependency resolution, verified immutable storage, project maps, staged materialization, lifecycle isolation, CLI/diagnostics/GC, npm shim, and final end-to-end wiring.

Established decisions carried into every task:

- Support projects with or without `package-lock.json`; support lockfile versions 2 and 3.
- Support npm registry, local directory, Git, and tarball sources.
- Keep lifecycle scripts disabled unless explicitly enabled; never run them in the central store.
- Store verified package instances under immutable tool-owned paths and reuse matching identities.
- Materialize the complete project tree behind one project-wide `node_modules` symlink.
- Treat unmanaged, broken, unknown, or ambiguous `node_modules` state as unmanaged and fail before replacement.
- Keep maps and diagnostics free of credentials and fail closed for publication, lifecycle, and garbage-collection uncertainty.

## Tasks

- [x] 1. Establish the TypeScript package, module boundaries, and test harness
  - [x] 1.1 Create the package/CLI scaffold and compiler/test configuration
    - Create `package.json`, `tsconfig.json`, `src/index.ts`, `src/cli.ts`, and the test configuration used by the repository.
    - Register the `node-glue` executable and library entry point.
    - Add pinned runtime/build dependencies for `@npmcli/arborist`, `pacote`, `cacache`, and `semver`, plus the chosen test and property-testing libraries.
    - Target Node.js on macOS and Linux without introducing workspace/Yarn/pnpm behavior.
    - _Requirements: 9.6_
  - [x] 1.2 Define domain types, module contracts, typed diagnostics, and injected side-effect adapters
    - Create `src/types.ts`, `src/errors.ts`, and adapter contracts under `src/adapters/` for filesystem, locks, child processes, registry/source transport, and time/randomness.
    - Define `DependencySource`, `ResolvedSource`, `EnvironmentFingerprint`, `PackageIdentity`, `PackageInstance`, `DependencyPlacement`, `ProjectMap`, project state, lifecycle policy, and public API option/result types from the design.
    - Define stable diagnostic codes including parse, unsupported lockfile/source, resolution, integrity, ownership, publication, lifecycle, missing-store, stale-map, unresolved-reference, and capability failures.
    - Ensure injected adapters make unit and property tests independent of real networks, arbitrary scripts, and destructive filesystem operations.
    - _Requirements: 1.5, 1.6, 2.5, 2.6, 3.7, 4.5, 4.6, 6.5, 6.8, 8.4, 8.5, 9.1, 9.2, 9.5, 9.7_
  - [x] 1.3 Build reusable temporary-project, fake-source, fake-store, fake-filesystem, and failure-injection fixtures
    - Add `test/fixtures/` and shared helpers for generated package graphs, lockfiles, maps, generations, symlinks, and injected failures.
    - Tag generated property cases with `Feature: node-glue-mvp` and the corresponding property number.

- [ ] 2. Implement project discovery and normalized dependency inputs
  - [x] 2.1 Implement project-root discovery and safe `package.json`/lockfile input reading
    - Create `src/project.ts` and `src/input-reader.ts` to locate a canonical Project Root from a requested directory or ancestor containing `package.json`.
    - Read and hash `package.json` and optional `package-lock.json`; return typed parse diagnostics containing Project Root and source path.
    - Reject unsupported lockfile versions with supported-version diagnostics.
    - _Requirements: 1.1, 1.5, 1.6_
  - [x] 2.2 Implement package-lock v2/v3 readers and one normalized internal graph representation
    - Create `src/lockfile.ts` to preserve package paths, resolved locators, integrity, dependencies, peer metadata, optional/platform flags, and bin metadata.
    - Normalize v2 and v3 into the same internal representation while validating package.json compatibility.
    - Redact or reject credential-bearing persisted locators so lockfile/map persistence cannot leak secrets.
    - _Requirements: 1.2, 3.1, 3.3, 3.4, 5.5_
  - [x] 2.3 Implement canonical lockfile generation and atomic no-lockfile publication
    - Add `LockfileWriter` to serialize a resolved graph to a canonical package-lock representation.
    - Write through a temporary file, flush/close where supported, and atomically rename before the corresponding Project Map can be published.
    - Preserve the no-lockfile path as a first-class flow rather than requiring an existing lockfile.
    - _Requirements: 1.3, 1.4, 5.3_
  - [ ] 2.4 Add project/input example and property tests
    - Cover ancestor discovery, malformed JSON, unsupported lockfile versions, credential redaction, and v2/v3 normalization examples.
    - **Property 1: Supported project inputs normalize consistently**
    - Verify that valid v2/v3 or no-lockfile inputs produce one complete internal graph and that generated lockfile persistence precedes Project Map publication.
    - **Validates: Requirements 1.2, 1.3, 1.4**

- [ ] 3. Implement source adapters and complete dependency resolution
  - [x] 3.1 Implement registry, local-directory, Git, and tarball source adapters
    - Create `src/sources/` with a common `SourceAdapter` interface and adapters for npm registry packages, canonicalized local directories, Git references resolved to commit revisions, and tarball URLs.
    - Validate supported source syntax before acquisition; read manifests; record canonical locator, source kind, integrity/digest, and environment attributes.
    - Extract tarballs in temporary locations with path-traversal and invalid-package-root protection.
    - Report unreachable sources, invalid metadata, and unsupported formats without publishing partial package state.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [x] 3.2 Implement the resolver adapter and normalized complete dependency graph
    - Create `src/dependency-resolver.ts` and isolate `@npmcli/arborist` behind the internal resolver interface.
    - Resolve direct/transitive dependencies, overrides, optional/platform conditions, multiple versions, scoped names, peer placements, and lockfile/no-lockfile flows.
    - Produce `ResolvedProject` only after all required constraints are satisfiable; include graph paths and package/range details in conflicts.
    - Preserve source identity and package metadata for every placement without invoking final npm reification.
    - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.7_
  - [-] 3.3 Add property tests for graph identity and peer context
    - **Property 2: Resolution preserves dependency graph identity and context**
    - Generate satisfiable graphs and verify all direct/transitive placements, scoped names, conflicting Package Instance identities, and selected peer contexts are retained.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
  - [ ] 3.4 Add source and resolution failure tests
    - Test invalid source formats, unreachable/invalid metadata, tarball traversal, Git revision capture, unsatisfied constraints, optional/platform behavior, and unsupported layouts.
    - _Requirements: 2.5, 2.6, 3.7_

- [ ] 4. Implement canonical package identity and immutable central storage
  - [x] 4.1 Implement canonical Package Instance identity and environment fingerprinting
    - Create `src/package-identity.ts` to serialize identity fields deterministically and hash them with SHA-256 for safe store paths.
    - Include complete scoped name, version/revision, canonical source fingerprint, available integrity, and only environment attributes that affect package contents.
    - Ensure equivalent inputs hash identically and distinct applicable integrity/environment inputs cannot collide as one logical instance.
    - _Requirements: 3.3, 3.5, 3.6, 4.2_
  - [x] 4.2 Implement PackageStore acquisition, verification, extraction, reuse, and atomic publication
    - Create `src/package-store.ts` with temporary fetch/extract paths, source-integrity verification, metadata/manifest recording, fsync-capable publication, and per-identity serialization.
    - Publish only fully verified content into `storeDir/packages/<encoded-name>/<identity-hash>/content` plus `instance.json`.
    - Reuse matching verified identities without downloading duplicates; discard failed temporary work and preserve previously published content on failure.
    - Never invoke lifecycle scripts in the central store.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 9.7_
  - [~] 4.3 Add property test for identity sensitivity and equivalence
    - **Property 3: Environment and integrity affect package identity when applicable**
    - Generate identity inputs and verify equivalent inputs share a hash while changed applicable integrity/environment attributes produce distinct hashes.
    - **Validates: Requirements 3.5, 3.6**
  - [ ] 4.4 Add property test for verification and reuse
    - **Property 4: Verified content is the only content publishable to the store**
    - Verify matching content can publish, mismatches never yield usable instances, and matching verified identities trigger no second download.
    - **Validates: Requirements 4.1, 4.2, 4.5**
  - [ ] 4.5 Add property test for immutable, script-free store publication
    - **Property 5: Store publication is immutable and script-free**
    - Verify published content cannot be changed by later acquisition/lifecycle processing and no lifecycle process runs with a central-store working directory.
    - **Validates: Requirements 4.3, 4.4**

- [ ] 5. Implement Project Map persistence, state, and operation locking
  - [x] 5.1 Implement collision-safe ProjectMapRepository and secret-safe serialization
    - Create `src/project-map.ts` to derive a readable basename plus collision-resistant hash from canonical Project Root.
    - Check the stored canonical root on identifier reuse and generate a different identifier instead of overwriting an unrelated map.
    - Persist schema version, Project Root, lockfile hash, exact placements, peer contexts, bin entries, generation metadata, and tool version without credentials.
    - Validate map schema and Package Instance references before accepting a map.
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 9.3_
  - [x] 5.2 Implement atomic map/state updates and project/store locks
    - Create `src/state.ts` and `src/locks.ts` for temporary-file-plus-rename map replacement, advisory state records, per-project locks, store locks, stale-lock diagnostics, and tool-owned temporary/generation cleanup rules.
    - Preserve the last readable map/state when an update fails.
    - _Requirements: 5.3, 6.8, 9.3, 9.5_
  - [ ] 5.3 Add property test for complete, collision-safe, secret-free maps
    - **Property 6: Project maps are complete, collision-safe, and secret-free**
    - Generate roots, placements, hashes, collisions, and source metadata; verify exact map content, stable collision handling, and absence of credentials/secrets.
    - **Validates: Requirements 5.1, 5.2, 5.5, 5.6**
  - [ ] 5.4 Add property test for unchanged-project idempotence
    - **Property 7: Unchanged projects are idempotent**
    - Verify same lockfile hash skips dependency acquisition and preserves equivalent map/materialization state, while changed hashes invalidate stale state before acquisition.
    - **Validates: Requirements 5.4**

- [ ] 6. Implement staged project-wide `node_modules` materialization and ownership safety
  - [x] 6.1 Implement ownership inspection and unmanaged-node_modules fail-closed checks
    - Create `src/ownership.ts` to classify absent paths, registered tool-owned symlinks, valid tool-owned generation directories, broken links, unknown markers, and ambiguous states.
    - Require proof that a path targets a registered project generation before replacement; classify all unproven state as unmanaged.
    - Return `UNMANAGED_NODE_MODULES` or `OWNERSHIP_UNKNOWN` with path and remediation, without unlink/rmdir on failure.
    - _Requirements: 6.3, 6.4, 6.5, 9.1_
  - [ ] 6.2 Implement complete staged dependency-tree and `.bin` link construction
    - Create `src/materializer.ts` and `src/bin-links.ts` to build `projects/<id>/generations/<generation>/node_modules` in a temporary staging location.
    - Materialize root/nested placements, scoped package segments, package links to verified store instances, and project-specific executable `.bin` links.
    - Validate every map reference, symlink target, bin target, and staged tree before publication.
    - _Requirements: 6.1, 6.6, 9.7_
  - [ ] 6.3 Implement generation publication, project-root symlink replacement, rollback, and capability checks
    - Publish a completed generation and project-root `node_modules` symlink atomically where supported, retaining the prior successful generation until the new state is confirmed.
    - Create the symlink when absent; replace only proven tool-owned state; never touch neighboring project content.
    - Preserve prior map/generation/symlink on injected staging, validation, publication, rename, or symlink-capability failure.
    - _Requirements: 6.2, 6.3, 6.4, 6.7, 6.8, 9.6, 9.7_
  - [ ] 6.4 Add property test for complete pre-publication staging
    - **Property 8: Materialization stages a complete tree before publication**
    - Generate valid maps and verify nested links and `.bin` links are fully built and validated before the project-root `node_modules` publication changes.
    - **Validates: Requirements 6.1, 6.6**
  - [ ] 6.5 Add property test for ownership-bound replacement
    - **Property 9: Tool-owned materialization replacement is ownership-bound**
    - Verify proven tool-owned state is replaceable and unmanaged, broken, unknown, or ambiguous state is preserved byte-for-byte with no replacement attempt.
    - **Validates: Requirements 6.4, 6.5, 9.1**
  - [ ] 6.6 Add property test for failed-publication recovery
    - **Property 10: Failed publication preserves the last successful state**
    - Inject failures at staging, validation, publication, symlink, and permitted lifecycle boundaries; verify prior map, generation, symlink, and Doctor-visible state remain usable.
    - **Validates: Requirements 6.8, 8.5, 9.3**

- [ ] Checkpoint A - Ensure input, resolver, store, map, and materializer unit/property tests pass before adding command integration.

- [ ] 7. Implement explicit lifecycle execution and environment-specific outputs
  - [x] 7.1 Implement LifecycleRunner with opt-in policy, Project Context, protected store, and output isolation
    - Create `src/lifecycle.ts` and platform capability adapters under `src/platform/`.
    - Default `runScripts` to false; enforce explicit allowlists/configuration when enabled.
    - Run permitted scripts only from Project Context, keep immutable store paths protected/read-only to the child process, and redirect native/build outputs to project or compatible-environment state.
    - Stop with a capability diagnostic when required protection is unavailable; report package, script, exit status, and Project Root on failure.
    - _Requirements: 4.4, 6.8, 8.1, 8.2, 8.3, 8.4, 8.5, 9.7_
  - [ ] 7.2 Add property test for explicit lifecycle isolation
    - **Property 11: Explicit lifecycle execution remains isolated**
    - Generate policies and script outcomes; verify only permitted scripts run, default-disabled scripts do not run, protected paths reject writes, and environment outputs stay outside immutable package content.
    - **Validates: Requirements 8.2, 8.3, 8.4**

- [ ] 8. Implement public API, CLI commands, Doctor, and fail-closed garbage collection
  - [ ] 8.1 Wire public API orchestration for install, ensure, inspect, and garbage collection
    - Create `src/api.ts` to orchestrate locator/input, resolver, source acquisition, store, map, lifecycle, materializer, state, and locks.
    - Implement `ensureProject` with lockfile and no-lockfile flows, unchanged-hash short circuit, exact map publication, and materialization result reporting.
    - Implement `inspectProject` using revalidation rather than trusting advisory state alone.
    - _Requirements: 1.1-1.6, 2.1-2.6, 3.1-3.7, 4.1-4.6, 5.1-5.6, 6.1-6.8, 8.1-8.5_
  - [ ] 8.2 Implement CLI command parsing and safe process execution
    - Complete `src/cli.ts` with `install`, `ensure`, `exec -- <command>`, `doctor`, `gc`, `enable`, and `disable` commands.
    - Ensure `exec` runs after project ensure with Project Root as cwd and Project Context; render stable diagnostics without secrets and return child exit status.
    - _Requirements: 7.1, 7.2, 7.3, 9.2, 9.3, 9.6, 9.7_
  - [ ] 8.3 Implement Doctor diagnostics and structured state inspection
    - Create `src/doctor.ts` to report broken project links, incomplete generations, stale maps, missing store instances, unresolved references, unknown ownership, and capability issues with affected paths and reasons.
    - Make successful map/materialization state discoverable by Doctor.
    - _Requirements: 7.4, 9.2, 9.3, 9.6, 9.7_
  - [ ] 8.4 Implement reference-preserving, fail-closed Garbage Collector
    - Create `src/gc.ts` to lock the store, read/validate every current Project Map, mark all referenced identity hashes, and sweep only unmarked package instances.
    - Abort without deletion when any map is unreadable, malformed, or references an unresolved instance; retain transport cache according to policy.
    - _Requirements: 7.5, 9.4, 9.5_
  - [ ] 8.5 Add property test for garbage-collection safety
    - **Property 12: Garbage collection is reference-preserving and fail-closed**
    - Generate valid/invalid maps and package instances; verify every referenced instance survives, only unreferenced instances are eligible for removal, and unresolved references cause zero deletion.
    - **Validates: Requirements 9.4, 9.5**

- [ ] 9. Implement opt-in npm shim and reversible PATH integration
  - [ ] 9.1 Implement Real npm discovery and shim dispatch
    - Create `src/npm/real-npm.ts` and `src/npm/shim.ts` to resolve the absolute Real npm executable while excluding the shim directory to prevent recursion.
    - Dispatch `install`/`i`/`uninstall`/`update` through metadata/lockfile-only-compatible Real npm operations followed by repository ensure/materialization.
    - Implement `ci` as lockfile validation, tool-owned-link cleanup, locked acquisition, and exact-tree materialization without normal npm reification.
    - Ensure `run`/`test`/`npx` first ensure then delegate; pass `config`/`version` through unchanged; conservatively handle unknown commands.
    - _Requirements: 7.8, 7.9, 7.10, 7.11, 7.12, 7.13_
  - [ ] 9.2 Implement opt-in enable/disable PATH integration
    - Add tool-owned bin-directory creation and shell integration under `src/npm/path-integration.ts` or equivalent.
    - `enable` must add only the tool-owned directory; `disable` must remove only that integration and preserve the prior npm installation.
    - Keep the system npm unchanged unless the developer explicitly changes PATH.
    - _Requirements: 7.6, 7.7, 7.13_
  - [ ] 9.3 Add npm shim and command-delegation integration tests
    - Use fake Real npm and temporary PATHs to verify dispatch, argument preservation, recursion avoidance, npm ci safety, pass-through commands, enable/disable reversibility, and unchanged system npm.
    - _Requirements: 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.13_

- [ ] 10. Complete end-to-end wiring and supported-platform validation
  - [ ] 10.1 Wire all modules into the final install/ensure/exec/doctor/gc/shim flows
    - Connect CLI/API entry points to the concrete resolver, source adapters, store, map repository, materializer, lifecycle runner, Doctor, GC, and npm shim implementations.
    - Verify no module bypasses ownership checks, atomic publication boundaries, lock acquisition, secret redaction, or injected adapter seams.
    - Add final result/error serialization and preserve previous successful state across all post-publication failures.
    - _Requirements: 1.1-9.7_
  - [ ] 10.2 Add temporary-fixture integration and macOS/Linux smoke coverage
    - Exercise registry/local/Git/tarball acquisition through fixtures, no-lockfile lockfile creation, multiple versions/scoped packages/peer contexts, immutable reuse, complete symlink materialization, unmanaged-node_modules refusal, lifecycle opt-in, Doctor, GC, and shim flows.
    - Run filesystem/symlink capability checks on macOS and Linux; skip only environment-inapplicable cases with explicit diagnostics.
    - Confirm property tests run with at least 100 generated cases per Property 1–12 and no test uses a real developer filesystem or arbitrary external lifecycle script.
    - _Requirements: 1.1-9.7_

- [ ] Final Checkpoint - Ensure all tests pass, type checks/lint pass, and the implementation has no unintegrated modules or unsafe unmanaged-node_modules replacement path.

## Acceptance Traceability

- **Requirement 1 — Project discovery and dependency input:** 2.1–2.4, 3.2, 8.1, 10.1–10.2.
- **Requirement 2 — Dependency source support:** 3.1–3.4, 8.1, 10.2.
- **Requirement 3 — Dependency resolution and package identity:** 1.2, 2.2, 3.2–3.4, 4.1, 4.3, 8.1, 10.2.
- **Requirement 4 — Central package storage and integrity:** 1.2, 4.1–4.5, 7.1, 8.1, 10.1–10.2.
- **Requirement 5 — Project maps and reuse:** 2.3, 5.1–5.4, 8.1, 10.1–10.2.
- **Requirement 6 — Project dependency materialization:** 1.2, 5.2, 6.1–6.6, 7.1, 8.1, 10.1–10.2.
- **Requirement 7 — npm command integration:** 8.2, 9.1–9.3, 10.1–10.2.
- **Requirement 8 — Lifecycle and environment-specific outputs:** 1.2, 6.3/6.6, 7.1–7.2, 8.1, 10.1–10.2.
- **Requirement 9 — Safety, diagnostics, and supported operation:** 1.2, 5.2, 6.1/6.3/6.5–6.6, 7.1, 8.2–8.5, 9.1–9.3, 10.1–10.2.

## Notes

- Tasks marked with `*` are optional test tasks and may be skipped for a faster MVP; core implementation tasks remain required.
- Property tests are complementary to unit, example, integration, and smoke tests. Each Property 1–12 has a dedicated task and must use injected adapters, at least 100 generated cases, and no real network/arbitrary lifecycle execution.
- Checkpoints are validation gates only; they are not implementation leaf tasks.
- The active MVP document remains provisional, but its older open decisions are superseded by the completed requirements/design: no-lockfile support, registry/local/Git/tarball sources, explicit lifecycle opt-in, project-wide symlink materialization, and fail-safe unmanaged `node_modules` handling.
- Implementation is TypeScript on Node.js for macOS and Linux. Do not introduce workspaces, Yarn/pnpm lockfiles, automatic lifecycle execution, central-store mutation, or automatic unmanaged-content adoption in this MVP.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1", "4.1", "5.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "4.2", "5.2", "6.1", "7.1"] },
    { "id": 3, "tasks": ["2.3", "3.3", "3.4", "4.3", "5.3", "5.4", "6.2"] },
    { "id": 4, "tasks": ["2.4", "4.4", "4.5", "6.3", "7.2"] },
    { "id": 5, "tasks": ["6.4", "6.5", "6.6", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4", "9.1", "9.2"] },
    { "id": 7, "tasks": ["8.5", "9.3"] },
    { "id": 8, "tasks": ["10.1"] },
    { "id": 9, "tasks": ["10.2"] }
  ]
}
```
