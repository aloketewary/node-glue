# Requirements Document

## Introduction

Node Glue provides a Maven-like local repository for Node.js projects. Node Glue stores verified package instances in an immutable central package store, records project-specific dependency selections in project maps, and exposes each project dependency tree through a project-wide `node_modules` symlink. Node Glue preserves familiar npm workflows while preventing unmanaged project content from being deleted.

The MVP targets TypeScript running on Node.js on macOS and Linux. The MVP supports npm registry packages, local directory dependencies, Git dependencies, tarball dependencies, package-lock.json versions 2 and 3, direct and transitive dependencies, scoped packages, multiple versions of one package, project-specific `.bin` links, lockfile change detection, package reuse, safe garbage collection, and an opt-in npm shim.

## Glossary

- **Node Glue**: The library and CLI system that resolves dependencies, stores package instances, records project state, and materializes project dependency trees.
- **Project**: A Node.js application directory containing `package.json` and, when available, `package-lock.json`.
- **Project Root**: The directory selected as the root of a Project.
- **Dependency Source**: An npm registry, local directory, Git reference, or tarball URL used to obtain a package.
- **Package Instance**: A resolved package identified by package name, version or source revision, integrity data when available, Dependency Source, platform, architecture, and Node ABI when those attributes affect package contents.
- **Central Package Store**: The Node Glue storage area containing verified Package Instances under tool-owned immutable paths.
- **Project Map**: A tool-owned record containing a Project identifier, lockfile hash, and exact Package Instances and dependency placements selected for a Project.
- **Materializer**: The Node Glue component that creates a staged project dependency tree and publishes the project-wide `node_modules` symlink.
- **Tool-Owned Node Modules**: A `node_modules` path created and tracked by Node Glue, including the project-wide symlink and its tool-owned target.
- **Unmanaged Node Modules**: A `node_modules` path or content not created and tracked by Node Glue.
- **Lockfile**: A `package-lock.json` file using npm lockfile version 2 or 3.
- **Real npm**: The system npm executable that remains outside Node Glue ownership.
- **npm Shim**: The opt-in executable that intercepts selected npm commands, delegates metadata operations to Real npm, and invokes Node Glue materialization.
- **Lifecycle Script**: An npm package script that executes during dependency installation or project setup.
- **Project Context**: The Project Root and its project-specific environment, separate from the Central Package Store.
- **Doctor**: The Node Glue diagnostic command that reports broken links, incomplete installs, and inconsistent project state.
- **Garbage Collector**: The Node Glue operation that removes unreferenced Package Instances from the Central Package Store.

## Requirements

### Requirement 1: Project discovery and dependency input

**User Story:** As a developer, I want Node Glue to work with existing and new Node.js projects, so that package management does not require a pre-existing lockfile.

#### Acceptance Criteria

1. WHEN a command targets a directory containing `package.json`, THE Node Glue SHALL identify the directory as a Project Root.
2. WHEN a Project contains a Lockfile with version 2 or 3, THE Node Glue SHALL read dependency declarations and resolved package metadata from the Lockfile.
3. WHEN a Project does not contain a Lockfile, THE Node Glue SHALL resolve dependency declarations from `package.json` using npm-compatible dependency resolution rules.
4. WHEN Node Glue resolves a Project without a Lockfile, THE Node Glue SHALL produce a Lockfile containing the resolved dependency set before publishing the Project Map.
5. IF `package.json` or the Lockfile cannot be parsed, THEN THE Node Glue SHALL stop the operation and report the Project Root, source file, and parse failure.
6. IF a Project uses an unsupported lockfile version, THEN THE Node Glue SHALL stop the operation and report the supported lockfile versions.

### Requirement 2: Dependency source support

**User Story:** As a developer, I want to use the dependency sources supported by npm, so that Node Glue can manage the package inputs used by my projects.

#### Acceptance Criteria

1. WHEN a dependency resolves to an npm registry source, THE Node Glue SHALL fetch the package metadata and package content from the configured registry.
2. WHEN a dependency resolves to a local directory source, THE Node Glue SHALL read package metadata and content from the referenced local directory.
3. WHEN a dependency resolves to a Git source, THE Node Glue SHALL fetch the package at the resolved Git reference and identify the Package Instance by the resolved source revision.
4. WHEN a dependency resolves to a tarball source, THE Node Glue SHALL fetch and extract the referenced tarball as a Package Instance.
5. IF a Dependency Source cannot be reached or does not provide valid package metadata, THEN THE Node Glue SHALL stop resolution and report the source and failure reason.
6. IF a local directory, Git source, or tarball source is outside the supported source format, THEN THE Node Glue SHALL stop resolution and report the source format and supported formats.

### Requirement 3: Dependency resolution and package identity

**User Story:** As a developer, I want Node Glue to reproduce the exact dependency tree selected for my Project, so that package resolution remains project-specific and repeatable.

#### Acceptance Criteria

1. WHEN dependency resolution starts, THE Node Glue SHALL resolve direct and transitive dependencies into a complete dependency tree.
2. WHEN two dependency placements require different versions of one package, THE Node Glue SHALL retain each required version as a distinct Package Instance.
3. WHEN a dependency name uses a scope, THE Node Glue SHALL preserve the complete scoped package name in resolution, storage, maps, and materialization.
4. WHEN a package has peer dependencies, THE Node Glue SHALL record each peer-dependent placement and its selected peer context in the Project Map.
5. WHEN package integrity data is available, THE Node Glue SHALL include the integrity data in Package Instance identity.
6. WHEN platform, architecture, or Node ABI changes package contents, THE Node Glue SHALL include the applicable environment attribute in Package Instance identity.
7. IF dependency constraints cannot produce a valid dependency tree, THEN THE Node Glue SHALL stop materialization and report the conflicting package names and constraints.

### Requirement 4: Central package storage and integrity

**User Story:** As a developer, I want verified packages reused across Projects without mutation, so that repeated installations save network and storage work without creating cross-project corruption.

#### Acceptance Criteria

1. WHEN a Package Instance is accepted into the Central Package Store, THE Node Glue SHALL verify available registry or source integrity data before publication.
2. WHEN a requested Package Instance already exists with matching identity and verified content, THE Node Glue SHALL reuse the stored content without downloading a duplicate.
3. WHEN a Package Instance is published, THE Node Glue SHALL store package content under a tool-owned immutable path.
4. WHILE package content is being populated in the Central Package Store, THE Node Glue SHALL execute no Lifecycle Script in the Central Package Store.
5. IF package content fails integrity verification, THEN THE Node Glue SHALL reject the content, preserve no usable Package Instance for the failed content, and report the source and verification failure.
6. IF a Package Instance cannot be extracted or stored, THEN THE Node Glue SHALL leave the previously published Central Package Store content unchanged and report the Package Instance identity.

### Requirement 5: Project maps and reuse

**User Story:** As a developer, I want Node Glue to record exact Project selections, so that Node Glue can detect changes and reuse packages safely across Projects.

#### Acceptance Criteria

1. WHEN dependency resolution completes, THE Node Glue SHALL create or update a Project Map containing a collision-resistant Project identifier.
2. WHEN a Project Map is published, THE Node Glue SHALL record the Project Root's Lockfile hash and exact Package Instance selections.
3. WHEN a Project Map changes, THE Node Glue SHALL publish the complete replacement map through an atomic file update.
4. WHEN a Project is unchanged since its last successful materialization, THE Node Glue SHALL detect the unchanged Lockfile hash before repeating dependency acquisition.
5. THE Node Glue SHALL exclude registry credentials, authentication tokens, and other secrets from every Project Map.
6. IF a Project identifier conflicts with an unrelated Project Root, THEN THE Node Glue SHALL generate a different identifier and preserve both Project Maps.

### Requirement 6: Project dependency materialization

**User Story:** As a developer, I want each Project to expose its own dependency layout through the normal `node_modules` path, so that Node.js resolution and npm commands continue to work.

#### Acceptance Criteria

1. WHEN a Project dependency tree is ready, THE Materializer SHALL construct the complete Project-specific dependency tree in a temporary staging location before publication.
2. WHEN materialization succeeds, THE Materializer SHALL publish a project-wide symlink at the Project Root's `node_modules` path that targets the Project's Tool-Owned Node Modules directory.
3. WHEN the Project Root has no `node_modules` path, THE Materializer SHALL create the project-wide symlink without deleting any other Project content.
4. WHEN the Project Root's `node_modules` path is a Tool-Owned Node Modules symlink or directory, THE Materializer SHALL replace that path with the project-wide symlink.
5. IF the Project Root's `node_modules` path contains Unmanaged Node Modules content, THEN THE Materializer SHALL fail before replacement, preserve the unmanaged path and content, and report the path and required remediation.
6. WHEN a dependency tree contains executable package entries, THE Materializer SHALL create Project-specific `.bin` links for the executable entries.
7. WHEN publication completes, THE Materializer SHALL make the Project dependency tree and Project-wide symlink visible as one completed materialization operation where the host platform supports atomic publication.
8. IF staging or publication fails, THEN THE Materializer SHALL preserve the last successfully published Tool-Owned Node Modules state and report the failed publication step.

### Requirement 7: npm command integration

**User Story:** As a developer, I want familiar npm commands to update metadata and use Node Glue storage, so that adoption does not require replacing normal Node.js workflows.

#### Acceptance Criteria

1. WHEN a developer runs `node-glue install`, THE Node Glue SHALL resolve the Project, acquire missing Package Instances, update the Project Map, and materialize the Project dependency tree.
2. WHEN a developer runs `node-glue ensure`, THE Node Glue SHALL verify the Project dependency state and materialize missing or stale Project links.
3. WHEN a developer runs `node-glue exec -- <command>`, THE Node Glue SHALL ensure the Project before executing the requested command in Project Context.
4. WHEN a developer runs `node-glue doctor`, THE Doctor SHALL report broken Project links, incomplete installs, stale Project Maps, and missing Central Package Store content.
5. WHEN a developer runs `node-glue gc`, THE Garbage Collector SHALL remove only Package Instances not referenced by any Project Map.
6. WHEN the npm shim is enabled, THE npm Shim SHALL be activated by adding a tool-owned directory to `PATH`.
7. THE npm Shim SHALL leave the system npm installation unchanged unless a developer explicitly changes `PATH` to enable the npm Shim.
8. WHEN a developer runs `npm install`, `npm i`, `npm uninstall`, or `npm update` through the npm Shim, THE npm Shim SHALL delegate package metadata changes to Real npm and then invoke Node Glue materialization.
9. WHEN a developer runs `npm ci` through the npm Shim, THE npm Shim SHALL validate the Lockfile, remove only Tool-Owned Node Modules links, ensure all locked Package Instances, and materialize the exact Project tree.
10. WHEN a developer runs `npm run` or `npm test` through the npm Shim, THE npm Shim SHALL ensure the Project and then delegate execution to Real npm.
11. WHEN a developer runs `npx` through the npm Shim, THE npm Shim SHALL ensure the Project and then delegate execution to Real npm's `npx` behavior.
12. WHEN a developer runs `npm config` or `npm version` through the npm Shim, THE npm Shim SHALL delegate the command to Real npm without changing Node Glue storage state.
13. WHEN a developer disables the npm Shim, THE Node Glue SHALL remove only the tool-owned `PATH` integration and restore command lookup to the prior npm installation.

### Requirement 8: Lifecycle and environment-specific outputs

**User Story:** As a developer, I want package scripts controlled explicitly and native outputs isolated from shared packages, so that installation remains safe and environment-specific builds do not mutate shared content.

#### Acceptance Criteria

1. THE Node Glue SHALL keep Lifecycle Scripts disabled unless a developer supplies an explicit lifecycle configuration option.
2. WHEN Lifecycle Scripts are explicitly enabled, THE Node Glue SHALL execute permitted scripts only in Project Context.
3. WHEN a Lifecycle Script produces platform-, architecture-, or Node ABI-specific output, THE Node Glue SHALL store the output in Project-specific or compatible-environment-specific state outside the immutable Package Instance.
4. IF a Lifecycle Script attempts to modify a Central Package Store path, THEN THE Node Glue SHALL stop the script operation and report the protected path.
5. IF a Lifecycle Script exits with a failure status, THEN THE Node Glue SHALL report the package, script name, exit status, and Project Root while preserving the last successful materialization.

### Requirement 9: Safety, diagnostics, and supported operation

**User Story:** As a developer, I want clear failures and safe cleanup, so that Node Glue cannot silently remove project data or leave an ambiguous installation state.

#### Acceptance Criteria

1. IF Node Glue cannot safely determine whether a `node_modules` path is Tool-Owned Node Modules, THEN THE Node Glue SHALL fail the operation before deleting or replacing the path.
2. IF a Project has broken symlinks or incomplete Project-specific state, THEN THE Doctor SHALL identify each affected path and provide a diagnostic reason.
3. WHEN a Project installation succeeds, THE Node Glue SHALL make the successful Project Map and materialization state available to Doctor.
4. WHEN garbage collection starts, THE Garbage Collector SHALL preserve every Package Instance referenced by any current Project Map.
5. IF garbage collection cannot determine Package Instance references, THEN THE Garbage Collector SHALL stop cleanup and report the unresolved reference state.
6. WHEN Node Glue runs on macOS or Linux, THE Node Glue SHALL support the MVP installation, materialization, diagnostic, and cleanup operations.
7. IF a host environment cannot provide a required filesystem or symlink capability, THEN THE Node Glue SHALL stop the affected operation and report the capability requirement.
