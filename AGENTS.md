# Control-plane SDK

Read README.md and docs/building-a-product.md before changing contracts.
This repository owns shared control-plane code, not a deployable product.

- Core has no Docker, persistence, application, stack, profile, React or tRPC imports.
- Persistence may depend on core; Docker may depend on core and persistence.
  Host and browser adapters may depend on core and their own modules only; keep
  React, tRPC and product policy out of both. Browser modules must import without
  reading browser globals until instantiated in the browser.
  tests/module-boundaries.test.ts follows imports transitively to enforce this.
- Runtime dependencies are Zod and microdiff. Validate external data and preserve
  typed contracts; do not use casts or untyped external input.
- Keep stack-specific credentials, resource identities, assets, migration policy,
  verification, operator confirmation and business instructions in the consumer.
- Preserve ownership, manual drift, explicit conflict decisions, stale-review
  refusal, protected files and post-apply verification when changing behaviour.
- Use explicit .js relative imports so Bun can load source and the ESM build can
  load emitted JavaScript. Public exports provide source for Bun and types, and
  compiled JavaScript as the default import. Browser bundles use source for shared
  validation; Docker/filesystem APIs remain host-only. Include source and compiled
  output in packed artifacts, and test Git-style imports with dist/ removed.
- Git consumers pin a full SHA and need no install scripts or sibling checkout.
  Do not add a prepare hook that depends on uninstalled development tools.
- Test public package entry points and the compiled package artifact.
- Run `bun install --frozen-lockfile` and `bun run check`. Check builds JavaScript
  and declarations, runs deterministic tests and checks an isolated packed consumer.
- Runtime changes also require `bun run test:docker`, using only isolated synthetic
  resources. Consumer changes require that product's checks and runtime regressions.
- Keep state, secrets, node_modules, build output and package artifacts ignored.
- Preserve existing licences. Keep npm `private: true` unless registry publication
  is separately approved. Source publication, releases, history replacement and
  live service changes require explicit operator authority.
