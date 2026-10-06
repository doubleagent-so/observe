# Changelog

## 0.2.1 — 2026-10-06

- **Security:** trailing slashes of the endpoint URL and trailing zeros of currency amounts are trimmed with a linear
  scan instead of two regular expressions that crafted input could stall (ReDoS; CodeQL). Behaviour is unchanged.
- **Docs:** shared Double Agent README header, top links and footer, with links on doubleagent.so.
- **Releases:** the release workflow now also creates the GitHub Release, with this changelog section as its notes.

## 0.2.0 — 2026-10-04

- **MCP:** `redactIds` on `instrumentMcpTransport` and `withMcpTelemetry` replaces or drops the request id, the
  client's `clientInfo` and task ids before they are recorded. Each function is optional; without it they are recorded
  as sent, as before. New types `McpRedactIds` and `McpPeerInfo`.
- **Docs:** the `@a2a-js/sdk` client example builds its factory from `ClientFactoryOptions.default`, which typechecks
  against the SDK 1.3.

## 0.1.0 — 2026-10-02

First public release. Record what your AI agent does at its protocol boundaries (A2A, MCP or your own protocol) and see
it in Double Agent.

- **Recorder** (`createRecorder`): a bounded buffer, batched delivery with retries, backoff and `Retry-After`,
  `flush`/`shutdown`, and `stats()`. It never throws into your code. Safe on Workers: no module-scope timer, and no
  promises shared across requests. It sends only to `https://` endpoints (plain `http://` only for `localhost`,
  `127.0.0.1` and `[::1]`); any other endpoint disables it.
- **Privacy:** authenticated subjects are hashed with HMAC-SHA256 under `subjectKey`, which defaults to the agent key.
  Message content is sent by default and kept only for sources with content capture on; `content: false` or `redact`
  controls it. File bytes, file URLs and tokens are never sent.
- **A2A** (`@doubleagent-so/observe/a2a`): `withA2ATelemetry` for fetch-style servers, and `instrumentA2AHandler`,
  `instrumentTaskStore` and `a2aTelemetryInterceptor` for `@a2a-js/sdk` 1.x.
- **MCP** (`@doubleagent-so/observe/mcp`): `instrumentMcpTransport` for MCP SDK servers and clients on any transport,
  `withMcpTelemetry` for Streamable HTTP servers (JSON and SSE responses, resumable streams, session `DELETE`), and
  `mcpOperation`, so tool handlers can record charges and costs on their own operation.
- **Errors:** a handler that throws is recorded as `protocol_error` with code `internal_error`, on A2A and MCP alike, and
  the error is rethrown unchanged.
- **Money:** `op.charge`, `op.cost` and `recorder.transaction`, plus currency helpers. x402 payments are recorded
  automatically: from A2A message metadata or MCP `_meta` first, with the x402 HTTP headers as the fallback, and
  charged once per call. A settlement header proves the money moved, so it is charged however the call ends and on any
  HTTP status except 401 and 403; `success: false` is recorded as a failed charge.
- Every event is validated at capture. The wire contract and the validator are exported. ESM only, with TypeScript
  types that need neither SDK (`@a2a-js/sdk` and `@modelcontextprotocol/sdk` are optional peer dependencies). Runs on
  Node 20+, Cloudflare Workers, Bun and Deno, with no runtime dependencies.
