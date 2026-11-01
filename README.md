# Control-plane SDK

Source-available building blocks for local control-plane products: state
reconciliation, protected persistence, reviewed Docker operations, local API
access controls and browser launch authentication. This is a library, not a
ready-to-run business application.

## Entry points

| Import                                      | Responsibility                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@frasergrant/control-plane-sdk` or `/core` | Versioned state, reconciliation, operation coordination, subscriptions and error/redaction contracts.             |
| `/persistence`                              | Scoped protected files, locking, state repositories, shared-folder guards and backup readers.                     |
| `/docker`                                   | Local Docker Engine transport, resource ownership, reviewed updates/removal, health checks and temporary helpers. |
| `/host`                                     | Loopback, bearer-token and same-origin request checks.                                                            |
| `/browser`                                  | Launch-token/session handling and subscriptions without a framework dependency.                                   |

Core has no Docker, persistence, product UI or stack dependencies. Runtime
packages are Zod and microdiff. See [building a product](docs/building-a-product.md)
for composition, review and recovery responsibilities.

## Develop and verify

Bun 1.4.0 and Linux x64 are the verified development environment. Git is required
for revision-pinned consumers. Real integration tests require access to a local
Docker Engine Unix socket and create isolated synthetic resources. They do not
operate existing business deployments or require real provider credentials.

```sh
bun install --frozen-lockfile
bun run check
# Optional: requires a local Docker Engine
bun run test:docker
```

`check` builds ESM JavaScript and declarations, checks module boundaries, runs
unit tests and exercises an isolated packed consumer. It also tests source-only
imports and a browser bundle without generated SDK output.

## Consume from Git

Use the repository's HTTPS URL pinned to the full SDK commit selected for the
consumer:

```json
{
  "dependencies": {
    "@frasergrant/control-plane-sdk": "git+https://github.com/FraserGrant/control-plane-sdk.git#<full-commit-sha>"
  }
}
```

Commit the consuming application's manifest and generated lockfile together.
Once this source snapshot is published, HTTPS reads require no GitHub account
or SSH key. The consumer needs no sibling SDK checkout, SDK build or install
hook: Bun and TypeScript use included source through the package exports.
Browser bundles use source for shared validation; Docker and filesystem entry
points remain host-only.

Built packages also provide ESM JavaScript and declarations. The SDK check
covers both built and source-only consumption. `private: true` intentionally
prevents accidental npm publication; public Git source and npm publication are
separate actions.

## Product responsibilities and limits

The consuming product owns service definitions, credentials, topology, migration
policy, provider checks, operator confirmation, recovery behaviour and UI. It must
retain resource ownership checks, stale-review refusal and post-apply verification.
A successful state observation is not a distributed transaction or automatic
rollback. This library does not provide a hosted service, fleet manager or stable
third-party plugin compatibility guarantee. Remote Docker TCP endpoints and
Windows named pipes are not supported by this implementation.

## Licence

The existing [personal and hiring review licence](LICENSE.md) permits the stated
personal and hiring-assessment uses. Business operation, commercial integration
and other commercial uses require a separately accepted paid agreement under
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). Public source visibility does not
grant unrestricted commercial or open-source rights. Third-party dependencies
retain their own terms; other products are not included unless expressly agreed.
