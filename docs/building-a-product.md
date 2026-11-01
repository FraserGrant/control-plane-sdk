# Building a control-plane product

Composition guidance for the source-available SDK. Use each exported module
through its public package entry point and verify the exact consumer revision.

## Compose the layers

Import state and resource contracts from `/core`, protected local storage from
`/persistence` and Docker implementation from `/docker`. Define a product-specific
`DockerStackDefinition<Settings, Secrets, VerificationOptions>` using validated
schemas and `defineDockerStack`. Declare stable stack identity, setup version,
pinned images, service roles, resource catalog, data-volume artifacts, settings,
credentials, migration paths, native bootstrap and verification.

The declaration validates catalog uniqueness and explicit retention. It does not
run native setup or configure the updater. Supply a `DockerRuntimePolicy` with
ownership checks, resource names, supported setup versions, dependencies,
explicit sensitive environment names and whole-selection validation. Credentials,
matching endpoints and required data mounts must remain valid after all apply/keep
choices are combined. The product owns these rules.

## Review and apply

1. Read inventory with `readRuntimeInventory` and create a `runtimeReview` using
   a stable private fingerprint key and the last applied baseline.
2. Present a sanitised baseline/running/proposed comparison. Conflicts require
   explicit decisions; manual changes default to keeping their running values.
3. Acquire the deployment lock and reread state. Call `applyState` with
   `DockerStateUpdater`, the reviewed revision and `runtimeChoices`.
4. Prepare declared resources only after complete selection validation. Supply
   ordered service-readiness hooks rather than treating creation as readiness.
5. Retain the last committed baseline after partial failure. Reread and verify
   the effective result before persisting successful state. Reject stale reviews.

The updater supports named Docker networks and fixed loopback bindings. It
preserves supported manual settings during replacement and refuses unsupported
options before stopping services. In-place updates can still proceed when an
independent replacement is blocked. Omitted healthchecks disable inherited image
checks. The lower-level transport also supports `none` for archive helpers.

## Recovery and product responsibilities

Use `ensurePersistentResources`, `inspectResourceCatalog`, `resourceBlockers`,
`removalAction` `reviewResourceRemoval` and `removeReviewedResource` for catalog lifecycle mechanics.
Removal reviews include a revision over all observed slots, retention choices and caller-provided configuration. The product supplies exact confirmation, checks review freshness under its lock, and owns progress,
supported setup versions and the explicit choice to delete retained data.

Use `FileStore`, `FileStateRepository`, `validateSharedFolder`, `backupManifest`, `validateBackupManifest`, `listBackupInventory`
and `readBackupSnapshot` for protected persistence and artifact identity. They do
not establish application consistency or prove that an archive restores. The
product checks deployment/stack identity, setup/image compatibility and credentials
paired with data; it also owns staging, recovery backups and interruption guards.
A database product may need a native backup protocol instead of volume archives.

## Application and browser adapters

Use `OperationCoordinator.run(id, action)` for process-local exclusion and start/end
notifications. It rejects a duplicate operation synchronously and releases the slot
on success or failure. It is not a persistent lock or job queue: keep `FileStore.locked`
around runtime changes and store product-specific journals and recovery markers.
Use `observeSnapshots({ subscribe, read }, signal)` to coalesce changes and release
subscriptions on abort or failure. Redact errors with explicit sensitive values
through `redactValues`; supply the complete secret inventory from the product.

`FileStateRepository(store, id)` persists validated snapshots through the protected
store, defaulting to `infrastructure-state.json`. An optional filename supports
other state models. `validateSharedFolder(path, protectedPaths)` rejects unresolved
paths, roots and ancestors of supplied sensitive locations. Products must provide
all protected paths, including their state directory and Docker socket.

`waitForHealthy` takes the product's ownership adapter and service role. Its default
150 attempts at two-second intervals preserves the first consumer's readiness
policy; override timing for another stack. `withTemporaryContainer` starts a supplied
specification, runs an action and stops/removes the original created identity in
`finally`. The product supplies helper images, commands, labels and mounts, checks
occupied names, and decides whether failed recovery needs retained staging volumes.
Cleanup errors propagate; these helpers do not create transactional rollback.

Import `authorizeLocalRequest` from `/host` in the API host, then map `AppError` to
your HTTP framework's public errors. Bind the server to loopback, generate a private
nonempty launch token, retain response security headers and protect every API route.
The helper checks the Host header, loopback hostname, bearer token and Origin;
it does not bind or serve a network listener itself.

Instantiate `LaunchAuthentication(productStorageKey)` from `/browser` in a browser.
It retains the token in session storage and removes accepted tokens from the URL.
Its subscriptions and revision support React's `useSyncExternalStore` without
making React an SDK dependency. `watchLaunchTokens()` returns listener cleanup.
Keep the storage key stable across a product rename. Neither module import nor
server-side type checking instantiates browser state.

Keep product screens, tRPC routing, confirmation wording, journal schemas, recovery
policy, business instructions and artwork in the application. Do not give agent
containers a Docker socket or operator token. The first consumer is now
[Personal and Small Business Operations](https://github.com/FraserGrant/personal-small-business-operations), for personal
and small-business agent flows using Hermes and n8n. The previous Compose prototype
was retired on 26 October 2026; current development belongs to that product and
this SDK. Runtime identities and setup semantics are unchanged.

## Verification

`tests/state.test.ts` exercises conflicts, drift, schema migration, stale reviews,
partial failure and post-apply verification. `tests/generic-docker.test.ts` uses
three different services with ordered dependencies. Resource lifecycle and backup
contracts run without a product import. `tests/module-boundaries.test.ts` follows
imports and re-exports transitively. The packed-consumer check validates exported
JavaScript and declarations outside this workspace. Real Docker tests are opt-in.

Additional products and targets need their own verification. Existing licence
terms remain in force; visibility does not grant additional commercial rights.

## Service controls and backup cleanup

Added 27 October 2026. `restartOwnedService(docker, ownership, role, containerId)`
checks the reviewed identity, ownership and supported setup before stopping and
starting that same container ID. The product holds its deployment lock, excludes
other operations, confirms interruptions, journals progress and waits for health.
It supplies service labels, available actions and observed loopback links to its UI.
A restart does not replace the container or alter its configuration or data volumes.

`readBackupConfig(deploymentDirectory, backupName, parseMetadata)` reads a bounded,
nonempty regular configuration file without following symlinks. Return only the
metadata the UI needs; configurations can contain secrets. Historical artifact
requirements and restore compatibility are product policy. File presence alone
establishes neither archive integrity nor recoverability.

Use `reviewBackupRemoval(directory, { keepLatest: 3 })` or `{ names: [name] }` to
preview removal. Inventory order uses the epoch timestamp in generated backup
names, falling back to directory modification time. The review includes selected
folders, retained folders, byte counts and a revision over the full inventory and
file identities. `removeReviewedBackups(directory, selection, revision)` refuses a
changed inventory, invalid names, links and nonregular selected contents. Hold the
deployment lock across revalidation and deletion; the product also blocks pending
restore recovery and owns confirmation. Cleanup is explicit and has no scheduler.
