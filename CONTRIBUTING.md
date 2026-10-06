# Contributing

Thanks for helping agents report what they do. The most useful contributions are:

- **A protocol case the adapters get wrong.** An A2A or MCP exchange that is recorded with the wrong outcome, kind,
  target or task state. Open a bug with a minimal reproduction (the request and response, keys removed).
- **An SDK version the wrappers break on.** The `@a2a-js/sdk` or `@modelcontextprotocol/sdk` version and the error.
- **A new adapter**, or better coverage of an existing protocol.

## Workflow

```sh
npm ci
npm test               # vitest
npm run test:coverage  # ≥ 90% lines and branches on src/
npm run typecheck
npm run build          # dist/, as published
```

## Project layout

| Path | |
|---|---|
| `src/recorder.ts` | `createRecorder`: operations, money and costs, with buffering and delivery |
| `src/delivery.ts` | Batching, retries, backoff and `Retry-After`; never throws |
| `src/validate.ts`, `src/contract.ts` | The event contract and its checks, applied before anything is sent |
| `src/a2a/` | A2A adapter: `withA2ATelemetry`, the `@a2a-js/sdk` wrappers and the mapping |
| `src/mcp/` | MCP adapter: transport wrapper, `withMcpTelemetry` and the mapping |
| `test/` | Vitest suites |
| `scripts/build.mjs` | Builds the publishable `dist/` |

## Rules

1. **Test first.** Write the failing test, then the change.
2. **Never hurt the host.** The recorder must not throw into, block or slow the agent it observes. A failure to send
   is logged once and dropped.
3. **Privacy by default.** Subject identifiers are hashed (HMAC) before they leave the process; content is captured
   only as documented in the README.
4. **The contract is shared with the server.** New event fields are optional and additive; say in the pull request
   when one is new.
5. **Public API.** `test/exports.test.ts` lists every export. Adding one is a minor release; removing or renaming one
   is a major release.
6. **Erasable TypeScript only** (no enums, namespaces or parameter properties), with `.ts` extensions on relative
   imports. `npm run typecheck` enforces both.

## Releases

Maintainers bump `version` in `package.json`, update `CHANGELOG.md`, and push a `v<version>` tag. The release
workflow checks the tag matches `package.json`, tests, builds and publishes `dist/` to npm with provenance, then creates
the GitHub Release with that version's `CHANGELOG.md` section as its notes.

Security issues go to [Security](SECURITY.md), not public issues.
