# @doubleagent-so/observe

**[Live demo](https://lab.doubleagent.dev)** · [Docs](https://doubleagent.so/docs/agents/) · [Website](https://doubleagent.so) ·
[npm](https://www.npmjs.com/package/@doubleagent-so/observe) · [Changelog](https://github.com/doubleagent-so/observe/blob/main/CHANGELOG.md) · [Report an issue](https://github.com/doubleagent-so/observe/issues)

[![npm](https://img.shields.io/npm/v/@doubleagent-so/observe.svg)](https://www.npmjs.com/package/@doubleagent-so/observe)
[![CI](https://github.com/doubleagent-so/observe/actions/workflows/ci.yml/badge.svg)](https://github.com/doubleagent-so/observe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/doubleagent-so/observe/blob/main/LICENSE)
[![Types](https://img.shields.io/badge/types-included-3178c6.svg)](https://github.com/doubleagent-so/observe/blob/main/src/index.ts)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://github.com/doubleagent-so/observe/blob/main/package.json)
[![Runtimes](https://img.shields.io/badge/runs%20on-Node%2020%2B%20%C2%B7%20Workers%20%C2%B7%20Bun%20%C2%B7%20Deno-555.svg)](#install)

Record what your AI agent does at its protocol boundaries (A2A, MCP or your own protocol) and see it in
[Double Agent](https://doubleagent.so): every request and stream, the task states it went through, who called, and
how it ended.

It records only what crosses the boundary. Internal tool calls, model calls and reasoning are not recorded. Metadata is
always sent; message content is sent too, but Double Agent keeps it only for sources with content capture turned on.

Runs on Node 20+, Cloudflare Workers, Bun and Deno. It uses only `fetch`, Web Streams and Web Crypto, and has no
runtime dependencies.

## Install

```sh
npm i @doubleagent-so/observe
```

`@a2a-js/sdk` (`>=1.3 <2`) and `@modelcontextprotocol/sdk` (`>=1.29 <2`) are optional peer dependencies. Install them
only if you use the SDK recipes below.

The package is ESM only (`require` works where Node supports `require(esm)`). TypeScript projects need
`moduleResolution` set to `node16`, `nodenext` or `bundler`.

## Get a key

In the Double Agent dashboard, open **Agents → Add agent**. Copy the agent key and store it as the
`DOUBLEAGENT_AGENT_KEY` secret or environment variable. The snippets below read it from there.

## A2A on Workers, Hono or any fetch-style server

`withA2ATelemetry` wraps a `fetch` handler. It observes JSON-RPC POSTs and `GET /.well-known/agent-card.json`, and
passes every other request through untouched.

```ts
import { Hono } from 'hono';
import { createRecorder } from '@doubleagent-so/observe';
import { withA2ATelemetry } from '@doubleagent-so/observe/a2a';

type Env = { DOUBLEAGENT_AGENT_KEY: string };

const app = new Hono<{ Bindings: Env }>();
// ... your A2A routes

let handle: ((request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Created on the first request, when the secret is available; reused after that.
    handle ??= withA2ATelemetry(app.fetch, {
      recorder: createRecorder({ key: env.DOUBLEAGENT_AGENT_KEY, adapter: 'my-agent@1.0.0', flushIntervalMs: 0 }),
      waitUntil: true,
    });
    return handle(request, env, ctx);
  },
};
```

On Workers and other serverless runtimes, always set `waitUntil`. Telemetry parses responses and sends events in the
background; without `waitUntil` the runtime can stop that work as soon as the response is returned, and events are
lost. `waitUntil: true` uses the handler argument that has a `waitUntil` method (the Workers `ctx`); you can also pass
a function, such as `waitUntil: (promise) => ctx.waitUntil(promise)`. With `waitUntil` set, the wrapper flushes the
recorder after each operation, so use `flushIntervalMs: 0` to turn off the background timer.

Request bodies are read from a clone, up to 1 MiB; larger bodies are recorded with method `unknown`. Streaming (SSE)
responses are observed as they pass through, without buffering. Responses are parsed up to 4 MiB, and each SSE event
up to 4 MiB; above that the call is still recorded `ok` (or by its HTTP status), without the messages and task states
the oversized body carries. Pass `identify(request)` to name the caller from authentication you have already verified.

x402 payments are recorded as charges with `method: 'x402'` and `basis: 'reported'` (receipts are not verified on
chain). Both x402 transports are read, and a call is charged at most once:

- **A2A metadata** (preferred): the caller's message carries the payment in `metadata["x402.payment.payload"]` with
  `x402.payment.status: "payment-submitted"`, and a task status message in the response (a unary result or a streamed
  status update) carries `metadata["x402.payment.receipts"]` with status `payment-completed` or `payment-failed`. The
  last receipt is charged to that status message's task.
- **HTTP headers** (the fallback): the request carries the payment (`PAYMENT-SIGNATURE`, or `X-PAYMENT` in x402 v1)
  and the response the settlement (`PAYMENT-RESPONSE`, or `X-PAYMENT-RESPONSE`), both decoding. The charge goes to the
  task the response carries, else the request's task, else only the operation. Streamed responses use the request's
  task.

A charge is `settled` when the receipt reports success, else `failed`. The amount is the payment's atomic token units;
zero amounts are not recorded. The asset is USDC unless the payment names another asset we know (EURC, or a stablecoin
symbol); payments in other assets are not recorded. x402 v1 payments do not name their asset, so they are assumed to
be USDC, and v1 SVM `exact` payments carry no amount, so they are not recorded. Network ids are kept exactly as sent
(`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). Only the amount, asset, network and transaction hash are
read, never signatures or payer addresses. Nothing is recorded for 401 and 403 responses or Agent Card requests. AP2
payment mandates are not recorded; report AP2 payments with `op.charge` or `recorder.transaction`.

Other options:

- `cardPath`: the Agent Card path recorded as `GetAgentCard` (default `/.well-known/agent-card.json`).
- `log(event, fields)`: where telemetry problems are reported (default `console.warn` with one JSON line). Fields never
  carry request data, only error names.

## A2A servers on `@a2a-js/sdk`

Wrap the request handler and the task store. The task store records state changes saved by background executions,
including after the response has been sent.

```ts
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { createRecorder } from '@doubleagent-so/observe';
import { instrumentA2AHandler, instrumentTaskStore } from '@doubleagent-so/observe/a2a';

const recorder = createRecorder({ key: process.env.DOUBLEAGENT_AGENT_KEY!, adapter: 'my-agent@1.0.0' });

const taskStore = instrumentTaskStore(new InMemoryTaskStore(), { recorder });
const handler = instrumentA2AHandler(new DefaultRequestHandler(card, taskStore, executor), { recorder, issuer: 'my-idp' });
// Serve `handler` with the SDK's transports as usual.
```

An authenticated `context.user` is recorded as `{ issuer, subject }`, and the subject is hashed with a key before it
leaves the process (see [Privacy](#privacy)). The SDK handler does not know its transport, so set `binding` if it is not JSON-RPC over HTTP.

The wrappers' types do not import the SDK, so they work without it installed. They check the handler's and store's
method names, not the SDK's argument types, and return your object's own method types. If a newer SDK 1.x adds a
method to `A2ARequestHandler`, wait for an update of this package before using that method through the wrapper.

Give each request its own `ServerCallContext`, as the SDK's transports do. The wrappers use it to link a new task to
the request that created it, so a context shared between requests can attach a task's first states to another
operation.

## Outbound calls with the `@a2a-js/sdk` client

Add the interceptor to record each call your agent makes to another agent, with the called agent's card URL.

```ts
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';
import { a2aTelemetryInterceptor } from '@doubleagent-so/observe/a2a';

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    clientConfig: { interceptors: [a2aTelemetryInterceptor({ recorder })] },
  }),
);
const client = await factory.createFromUrl('https://other-agent.example');
```

Put the interceptor first in `interceptors`, so that it sees every call and the final result. A call that fails is
recorded as started with no finish (`incomplete`), and the error reaches your code unchanged. The SDK does not tell
interceptors when a stream ends, so a stream finishes on the event after which the server closes it (a message, a
terminal state or `input_required`); a stream your code stops reading early stays `incomplete`. The SDK does not hand
interceptors the response headers either, so outbound calls record the extensions they request but not the ones the
called agent activates.

## What is recorded for A2A

- **Methods** are recorded under their A2A 1.0 names on every path: a 0.3 `message/send` is `SendMessage`,
  `tasks/get` is `GetTask`, and so on. `protocol.version` and `protocol.binding` still say which wire form was used.
  A method A2A does not define keeps its own name if it is a valid method name, else `unknown`.
- **Outcomes:** a result is `ok`; a JSON-RPC error is `protocol_error` with its code. An HTTP error status without a
  JSON-RPC error (an HTML 5xx page, 404, 413, 429) is `protocol_error` with code `http_error` and the status as native
  code; 401 and 403 are `auth_rejected`. When your handler throws, the operation is `protocol_error` with code
  `internal_error` (an `@a2a-js/sdk` `A2AError` keeps its own reason) and the error is rethrown unchanged. A client
  disconnect or a broken stream is `transport_error`.
- **Ids:** context, task and message ids are kept only as 1–256 printable ASCII characters without spaces. An id with
  spaces, control or non-ASCII characters is left out, and the operation is still recorded.
- **Conversations:** a first message sent without a `contextId` is linked to the conversation the agent assigns: the
  task states and messages of the reply carry it. When a request already names a conversation, the first one seen for
  the operation wins.
- **The `a2a` block:** the caller message's `message_id` and `reference_task_ids`, the extensions the caller requested
  (`A2A-Extensions`, or `X-A2A-Extensions` for 0.3) and, on the finished event, the extensions the agent activated.

## MCP servers and clients

Install the official SDK (`@modelcontextprotocol/sdk` 1.29 or later, below 2). The adapter never imports it: it works
on the SDK's transports through their shape.

### SDK servers and clients: `instrumentMcpTransport`

Wrap the transport before you connect it. Requests, responses and notifications pass through unchanged and in order,
and every other transport method (`handleRequest`, `closeSSEStream`, `start`, `close`) works as before.

```ts
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { instrumentMcpTransport } from '@doubleagent-so/observe/mcp';

const transport = instrumentMcpTransport(new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID }), {
  recorder,
  role: 'server',
  binding: 'streamable-http',
  issuer: 'https://auth.example.com',
});
await server.connect(transport);
```

An MCP client records its outbound calls the same way:

```ts
const transport = instrumentMcpTransport(new StreamableHTTPClientTransport(new URL(serverUrl)), {
  recorder,
  role: 'client',
  binding: 'streamable-http',
  serverUrl,
});
await client.connect(transport);
```

| Option        | Meaning                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recorder`    | The recorder from `createRecorder`.                                                                                                                           |
| `role`        | `'server'`: requests received are `inbound`. `'client'`: requests sent are `outbound`. Server-to-client callbacks are the reverse.                            |
| `binding`     | `'stdio'`, `'sse'`, `'streamable-http'` or `'other'`.                                                                                                         |
| `issuer`      | Server role: the issuer recorded with the SDK's `authInfo.clientId` (hashed, see [Privacy](#privacy)). Default `mcp`. The token is never read.                |
| `serverUrl`   | Client role: the server's URL. Only its origin (`https://mcp.example`) is recorded, as the counterparty's `card_url`: paths and queries can hold keys.        |
| `onOperation` | `(op, info) => void`, called as each operation starts (`info`: method, kind, direction, target, `requestId`, `sessionId`, `params`).                          |
| `redactIds`   | Optional. Replaces the request id, `clientInfo` or task id before they are recorded (see [Redacting MCP ids](#redacting-mcp-ids)). Default: recorded as sent. |
| `log`         | `(event, fields) => void` for telemetry failures. Default: JSON lines on `console.warn`.                                                                      |

The wrapped transport has the same type as the one you pass in (`McpTransportLike` is the shape it needs:
`send(message)` and an optional `sessionId`).

### Hand-rolled Streamable HTTP servers: `withMcpTelemetry`

For a server that does not use the SDK (or an SDK server on `WebStandardStreamableHTTPServerTransport` that you would
rather not wrap), wrap the fetch handler. Use one of the two wrappers for a server, not both.

```ts
import { withMcpTelemetry } from '@doubleagent-so/observe/mcp';

export default { fetch: withMcpTelemetry(handleMcp, { recorder, identify, waitUntil: true }) };
```

- **POST:** every JSON-RPC request in the body (one message or a batch) is an operation. A body that is not JSON-RPC
  passes through unrecorded; a body over 1 MiB is one operation named `unknown`. JSON responses are read from a copy
  in the background (up to 4 MiB); SSE responses are observed as they stream, never buffered.
- **GET** streams in a session are observed for the messages the server sends on them. **DELETE** with a session ID is
  the `management` operation `session/delete`.
- `identify(request)` returns evidence your host verified (auth middleware, signatures), as for A2A. `waitUntil: true`
  hands background work to the Workers `ctx`; pass a function to use your own.
- It flushes for you: after each request the recorder's buffer is flushed in the background (through `waitUntil`), so
  a Worker needs no flush of its own.
- `onOperation(op, info)` and `redactIds` work as for `instrumentMcpTransport`; `log(event, fields)`
  receives telemetry failures (default: JSON lines on `console.warn`; a logger that throws is ignored).
- A handler that throws is recorded as `protocol_error` with code `internal_error` (native code `exception`), and the
  error is rethrown unchanged.

### Paid tools and costs: `mcpOperation`

x402 payments are recorded as charges automatically (`method: 'x402'`, `basis: 'reported'`): from the JSON-RPC
`_meta` (`x402/payment` on the request, `x402/payment-response` on the result) with either wrapper, and from the x402
HTTP headers with `withMcpTelemetry`, where one settlement pays for the first tool call of the request. A call is charged
at most once, on its operation, `_meta` first. A settlement header proves the money moved, so it is charged however the
call ends (cancelled, closed or failed) and on any HTTP status except 401 and 403; `success: false` is recorded as a
failed charge.

`mcpOperation(recorder, extra)` returns the operation of the request a tool handler is serving, so the handler can
record charges and costs on it (see [Revenue and cost](#revenue-and-cost)):

```ts
import { mcpOperation } from '@doubleagent-so/observe/mcp';

server.registerTool('search', { inputSchema: { q: z.string() } }, async ({ q }, extra) => {
  mcpOperation(recorder, extra)?.charge({ amount: 5, currency: 'USD', method: 'credits', status: 'settled', basis: 'reported' });
  return { content: [{ type: 'text', text: await search(q) }] };
});
```

It reads `extra.sessionId`, `extra.requestId` and `extra.requestInfo` (`McpHandlerExtra`; the SDK's `extra` fits). It
returns `undefined` when the transport is not instrumented with this recorder, the request already finished, or the
request cannot be told apart from another one in flight (for example, two requests in one session that reuse an id);
it never returns another request's operation.

A hand-rolled handler behind `withMcpTelemetry` passes `{ sessionId, requestId, requestInfo: request }`, where
`sessionId` is the request's `Mcp-Session-Id` header (leave it out when there is none) and `request` is the very
`Request` object the handler received. An SDK server hosted behind `withMcpTelemetry` instead of
`instrumentMcpTransport` finds its operation only in stateful sessions: in stateless mode the SDK hands its handlers its
own request object, so `mcpOperation` returns `undefined`. Wrap the transport when you need both.

### What is recorded for MCP

- **Kinds:** `tools/call` is `tool`, `resources/read` is `resource`, `prompts/get` is `prompt`; `initialize` and the
  `*/list` methods are `discovery`; `sampling/createMessage`, `elicitation/create` and `roots/list` are `callback`;
  `ping`, `logging/setLevel`, `completion/complete`, subscriptions and `tasks/*` are `management`; anything else is
  `other`. Other notifications are not operations.
- **Targets:** the tool or prompt name; for resources, the URI without credentials, query or fragment
  (`https://user:pw@host/doc?sig=1` is `https://host/doc`). URIs that can carry personal data (`mailto:`, `tel:`,
  `data:`, `file:`) keep only their scheme.
- **Outcomes:** a result is `ok`; a tool result with `isError: true` is `tool_error`; a JSON-RPC error is
  `protocol_error` with its code; `notifications/cancelled` is `canceled`; a closed connection or broken stream with
  the request pending is `transport_error`. With `withMcpTelemetry`, 401 and 403 are `auth_rejected`, other HTTP
  errors `http_error`, and a handler that throws is `protocol_error` with code `internal_error` (native code
  `exception`); the error is rethrown unchanged.
- **Conversations:** one `Mcp-Session-Id` is one conversation, and so is one stdio connection. Stateless HTTP servers
  report operations without a conversation. An SDK client over Streamable HTTP learns its session ID from the
  `initialize` response, so its own `initialize` has no conversation.
- **Counterparty:** for servers, the client's `clientInfo`, its requested protocol version and capabilities
  (`sampling`, `elicitation`, `roots`, `tasks`) from `initialize`, and the principal from `authInfo` on each request;
  for clients, the server's name and the origin of `serverUrl`.
- **Tasks** (MCP 2025-11-25): task-creating results and `notifications/tasks/status` record each task state once per
  change (`cancelled` is recorded as `canceled`, with the native value kept).
- **Content:** tool arguments, results, prompt and sampling messages, and resource text. Images, audio and binary
  resources are recorded by media type and size only.
- Messages your side sends are recorded as they are sent, before delivery is confirmed: a response that then fails to
  send has already finished its operation.

### Redacting MCP ids

Three values come from the caller and are recorded as sent: the JSON-RPC request id (`mcp.request_id`), the client's
`initialize` name and version (`client_info`) and a tasks `taskId` (`task_ref`). If they can carry anything you would
rather not send, set `redactIds` on either wrapper. Each function is optional and gets the value as it would be recorded
(a numeric request id as its decimal string):

```ts
import { createHmac } from 'node:crypto';

const pseudonym = (id: string) => createHmac('sha256', env.ID_KEY).update(id).digest('hex').slice(0, 32);

instrumentMcpTransport(transport, {
  recorder,
  role: 'server',
  binding: 'streamable-http',
  redactIds: {
    requestId: () => undefined, // drop it
    clientInfo: ({ name }) => ({ name }), // keep the name, drop the version
    taskId: pseudonym, // the same task gets the same ref, so its states stay linked
  },
});
```

- Return the value to record, or `undefined` to drop it. A returned value is checked like the original; one the wire
  would reject is dropped.
- A function that throws drops that value and logs `agent_telemetry_redact_failed`; the operation is still recorded.
- Keep `taskId` deterministic: every event that names the task (the creating result, status notifications and
  `tasks/*` requests) uses the value it returns. Dropping it records those requests without a task and skips the
  task's states.
- Only what is recorded changes: pairing, your handlers and `onOperation` (`info.requestId`) still see the originals.

Exported types: `McpTransportLike`, `McpTransportOptions`, `McpTelemetryOptions`, `McpHandlerExtra`,
`McpOperationInfo`, `McpRedactIds`, `McpPeerInfo`, `McpRole` and `OnOperation`.

## Privacy

- **Message content is sent by default.** Text and data parts are sent within the [limits](#limits); Double Agent keeps
  them only for sources with content capture turned on, and drops them otherwise. To never send content, set
  `content: false` in code: `createRecorder({ key, content: false })`. `redact(message)` changes content before it
  leaves the process.
- **Authenticated subjects are hashed with a key.** `subject_hash` is
  `HMAC-SHA256(subjectKey, "subject:v1\n" + issuer + "\n" + subject)` in lowercase hex; the raw subject never leaves
  the process. `subjectKey` defaults to the agent key, which is one per source, so the same caller gets the same hash
  within a source and unrelated hashes across sources.
  - Rotating the agent key changes every subject hash, so the same caller looks new afterwards. To keep hashes stable
    across rotations, set a stable `subjectKey` (from a secret, such as `DOUBLEAGENT_SUBJECT_KEY`).
  - Keep `subjectKey` secret, like the agent key: anyone holding it can hash guessed subjects and match them.
- File bytes and file URLs are never sent; a file is recorded by its name, media type and size.
- **MCP ids are sent as the caller chose them** (request id, `clientInfo`, task id). To drop or replace them, set
  [`redactIds`](#redacting-mcp-ids) on the MCP wrapper.

## Custom protocols

For MCP, use the [MCP adapter](#mcp-servers-and-clients). For any other protocol, use the recorder directly: start an
operation, record its messages and task states, then finish it. Name your protocol `custom:<name>` (lowercase letters,
digits and dashes) and put your own fields in the `custom` block (string, number or boolean values).

```ts
import { createRecorder } from '@doubleagent-so/observe';

const recorder = createRecorder({ key: process.env.DOUBLEAGENT_AGENT_KEY!, adapter: 'quote-api@1.0.0' });

const op = recorder.startOperation({
  protocol: { name: 'custom:quote-api', version: '1.0', binding: 'http-json' },
  direction: 'inbound',
  method: 'quotes.create',
  kind: 'tool',
  target: 'flight-quote',
  conversationRef: sessionId,
  counterparty: { declared_name: callerName },
  custom: { region: 'eu', priority: true },
});
op.message({ role: 'caller', parts: [{ kind: 'data', json: request }] });
op.message({ role: 'agent', parts: [{ kind: 'data', json: quote }] });
op.finish({ outcome: quote ? 'ok' : 'protocol_error', ...(quote ? {} : { error: { nativeCode: '422', code: 'no_quote' } }) });
```

When the conversation is only known from the response (the agent assigned it), pass `conversationRef` to
`op.message(...)` or `op.taskState(...)`; the operation joins that conversation. If events of one operation name
different conversations, the first one Double Agent sees for the operation wins.

## Abandoning a task

When your agent gives up on a task itself (shutdown, timeout, operator cancel), end it with a reason. The task gets a
terminal transition, and the reason (up to 128 characters) is stored with it:

```ts
recorder.abandonTask('task-9', { protocol, direction: 'inbound', state: 'canceled', reason: 'shutdown' });
```

On an `@a2a-js/sdk` server, the instrumented task store can do this for every task still open. Opt in, then abandon
open tasks before shutting the recorder down (the recorder has no shutdown hook of its own):

```ts
const taskStore = instrumentTaskStore(new InMemoryTaskStore(), { recorder, abandonOpenTasksOnShutdown: true });

// On shutdown:
await taskStore.abandonOpenTasks(); // each open task → canceled, reason "shutdown"
await recorder.shutdown();
```

Without `abandonOpenTasksOnShutdown`, open tasks are left open.

## Revenue and cost

Record what a caller paid and what serving it cost.

```ts
op.cost({
  category: 'model',
  amountMicros: 4_200,
  currency: 'USD',
  basis: 'estimated',
  usage: { model: 'claude-x', input_tokens: 1200, output_tokens: 300 },
});
op.cost({ category: 'tool', amount: 0.0015, currency: 'USD', basis: 'reported' }); // decimal major units also work
const transactionId = op.charge({ amount: 500, currency: 'USD', method: 'card', status: 'pending', basis: 'reported' });

// Later, outside any request (e.g. your payment webhook): same transaction ID, new status.
recorder.transaction({
  transactionId,
  taskRef,
  protocol: 'a2a',
  kind: 'charge',
  amount: 500,
  currency: 'USD',
  method: 'card',
  processor: 'stripe',
  status: 'settled',
  basis: 'settled',
});
```

- `op.cost(input: CostInput)` records a cost of serving the operation: `category`, `currency`, `basis`, optional
  `usage`, and exactly one of `amountMicros` (integer millionths of the major unit) or `amount` (decimal major units,
  converted with `toMicros`), so sub-cent model costs keep their precision.
- `op.charge(input: ChargeInput)` records money the counterparty paid, as an integer `amount` in minor units (cents).
  `kind` defaults to `charge`; pass your own `transactionId` (a ULID) to update the same transaction later. It returns
  the transaction ID, or `''` when the charge was dropped.
- Both link to the operation and its task; pass `taskRef` to name another task.
- A money event attaches to a task only when its `protocol` and `direction` match the task's; otherwise it creates a
  separate stub task.
- `recorder.transaction(input: TransactionInput)` records a transaction outside any request (a settlement, a refund).
  It needs `taskRef` or `operationId`, opens no operation, and returns the transaction ID (`''` when dropped).
  `protocol` is a full object (`{ name, version, binding }`) or just a name (`'a2a'`, `'mcp'`, `'custom:<name>'`)
  when the version and binding are unknown; `direction` defaults to `inbound`, `occurredAt` (epoch ms) to now.
  `occurredAt` must be within the last 7 days and no more than 5 minutes ahead, or the event is dropped; for a late
  settlement, pass the time it settled, not when the charge was made.
- `basis`: `reported` (your claim), `settled` (confirmed by a provider; only with status `settled` or `refunded`),
  `estimated` (e.g. tokens × price). Reports keep them apart.
- Refunds are `kind: 'refund'` with a negative amount.
- Every money event is validated when you record it. Invalid input (a fractional or out-of-range amount, a lowercase
  currency, no task or operation) is dropped and logged as `agent_telemetry_invalid_event`; nothing throws and
  nothing waits on the network.

To build money events yourself, for example in a payment provider's webhook that posts its own batches, use the pure
builders the recorder uses: `transactionEvent(links: MoneyLinks, fields: TransactionFields, at, eventId?)` and
`costEvent(links, input: CostInput, at)`. Pass `eventId` to make a transaction event deterministic (the same
provider event always gives the same event ID). `protocolOf(protocol)` turns a bare protocol name into
`{ name, version: 'unknown', binding: 'other' }`, and `costMicros({ amountMicros, amount })` gives the micros a cost
input resolves to (`NaN`, which the validator rejects, when neither or both are given or `amount` is finer than a
micro). Check what you build with `validateEvent` before sending it.

## Flushing

The recorder buffers events and sends them in batches every 2 seconds (`flushIntervalMs`).

- **Long-running processes:** call `await recorder.shutdown()` before the process exits. It sends what is buffered.
- **Workers and serverless:** set `flushIntervalMs: 0`. `withA2ATelemetry` and `withMcpTelemetry` with `waitUntil` flush for you. With the
  SDK wrappers or the generic recorder, call `ctx.waitUntil(recorder.flush())` at the end of each request. One
  recorder per isolate is fine: each flush sends what is buffered with its own request and never waits on another
  request's flush. A recorder created at module scope on Workers runs without a timer (Workers forbid timers there)
  and logs `agent_telemetry_timer_unavailable` once.
- **Backoff:** after a failed send or a `Retry-After`, the recorder backs off (failures: up to 60 s; `Retry-After`,
  in seconds or as an HTTP date: up to 5 minutes). A `flush()` that finds 5 s or less of backoff left waits it out and
  then makes one attempt, so a Worker that flushes in `waitUntil` still delivers after a brief outage. With more left,
  `flush()` does nothing, so flushing on every request never hammers a struggling endpoint.
  `flush({ force: true })` sends anyway; `shutdown()` forces.

## Guarantees

- Never throws into your code or changes your requests, responses or streams; `createRecorder` itself never throws.
  Telemetry errors are logged and swallowed; your handler's errors are recorded and rethrown unchanged. A `log`
  function that throws loses that line and nothing else.
- Input from your code or a remote agent never gets your events rejected. Free text (file names, task states and
  reasons, the called agent's name) is cleaned of control characters and cut to the wire limits, and media types keep
  only their essence (`text/plain; charset=utf-8` → `text/plain`). Every event is validated at capture: one the API
  would still reject is dropped there, counted in `stats().dropped` and reported to the server, and logged as
  `agent_telemetry_invalid_event` (once per rejection code). When an `operation.started` is dropped, its
  `operation.finished` is dropped with it.
- Network errors, timeouts, 429 and 5xx answers delay telemetry: the batch is retried with backoff.
- An endpoint that is not `https://` (plain `http://` only for `localhost`, `127.0.0.1` and `[::1]`) disables the
  recorder from the start: it logs `agent_telemetry_disabled` with `reason: 'insecure_endpoint'`, `stats().disabled`
  is true, and nothing is ever sent, so the agent key never travels in clear text.
- A refused key (401 or 403) or a deleted source (410) stops the recorder for good: buffered and later events are
  discarded. Any other 4xx answer drops that batch (counted in `stats().dropped` and reported to the server) and the
  recorder carries on. Any 2xx answer counts as sent.
- A failed send logs `agent_telemetry_send_failed` with its `status` or `reason` the first time and whenever the kind
  of failure changes. Events the server rejects log `agent_telemetry_events_rejected` with the rejection codes.
- Retries reuse event IDs; the server stores each event once.
- The buffer is bounded (`maxBufferEvents`, default 5,000), and events a flush is still sending count toward the
  bound, so memory stays bounded. Overflow drops the oldest buffered events; while a flush is in flight and the buffer
  is full, that means new events are dropped. Every drop is counted in `stats().dropped` and reported to the server
  with the next batch.
- `shutdown()` waits up to `requestTimeoutMs` plus a second for flushes in flight, then makes one last forced
  attempt. Events still unsent after that are counted as dropped and logged, never silently lost. An event the host
  made unserializable after recording it (by changing an object it passed in) is dropped and counted at send time
  instead of blocking the queue. Events recorded after `shutdown()` are counted as dropped and logged once as
  `agent_telemetry_dropped_after_shutdown`.
- `authenticated.subject` is hashed (HMAC-SHA256, see [Privacy](#privacy)) before it leaves the process. Raw
  `Authorization` or signature headers are never treated as identity.
- File bytes and file URLs are never sent; a file is recorded by its name, media type and size.
- MCP request ids, `clientInfo` and task ids are sent as the caller chose them unless you set
  [`redactIds`](#redacting-mcp-ids).
- `redact(message)` runs before content leaves the process and changes content only: part summaries (kind, media type,
  size) come from the original parts. If it throws, no content is sent for that message.
- `content: false` never sends content.

`endpoint` sets the API origin (default `https://api.doubleagent.so`); the recorder posts to `<endpoint>/v1/agent-events`.
It must be `https://`, so the agent key never travels in clear text; `http://` is accepted only for `localhost`,
`127.0.0.1` and `[::1]`. Any other endpoint disables the recorder (see [Guarantees](#guarantees)); it never throws.

## Money events

Two event types carry money. Each names the task (`task_ref`) or the operation (`operation_id`) it belongs to, and
may name both; `operation_id` is optional only on these two types.

- `transaction.recorded`: `transaction_id` (a ULID; a later event with the same ID updates status and basis),
  `kind` (`TRANSACTION_KINDS`), `amount` as an integer in the currency's minor units (cents for USD, yen for JPY,
  millionths for USDC; negative only for a `refund`, within ±10^13), `currency`, `method` (`PAYMENT_METHODS`),
  `basis` (`MONEY_BASES`), `status` (`TRANSACTION_STATUSES`; a `settled` basis needs `settled` or `refunded`), and
  optional `processor` (lowercase, such as `stripe`) and `network` (kept as sent, such as `eip155:8453`) and
  `external_ref`.
- `cost.recorded`: `category` (`COST_CATEGORIES`), `amount_micros` as an integer in millionths of the currency's
  major unit (0 to 10^15), `currency`, `basis`, and optional `usage` (`model`, `input_tokens`, `output_tokens`,
  `units`, `unit`).

A currency is an ISO 4217 code or a token symbol: 3–5 uppercase letters or digits (`CURRENCY`). `isMoneyEvent(type)`
tells the two types apart from the rest. The validator rejects a bad amount with `invalid_amount`, a bad currency
with `invalid_currency`, and a money event with neither a task nor an operation with `missing_link`.

The currency helpers convert decimal amounts without floating-point drift:

```ts
import { currencyExponent, peggedTo, toMicros, toMinorUnits } from '@doubleagent-so/observe';

currencyExponent('JPY'); // 0; 'KWD' → 3, 'CLF' → 4, 'USDC' → 6, an unknown token → null
peggedTo('USDC'); // 'USD'; USDT → USD, EURC → EUR, anything else → null
toMinorUnits('120.5', 'USD'); // 12050; null for more decimals than the currency has
toMicros(0.0042); // 4200; null for anything finer than a micro
```

## Limits

- 100 events and 1 MiB per batch.
- Content ≤ 96 KiB per message, ≤ 32 KiB per part, ≤ 64 parts.
- At most 16 costs per operation (`LIMITS.costsPerOperation`). Further `op.cost` calls are dropped: the first one logs
  `agent_telemetry_cost_limit` (once per operation), and each one is counted in `stats().dropped` and reported to the
  server. Dropped invalid costs do not count toward the 16.
- Transaction amounts within ±10^13 minor units (`LIMITS.maxAmount`); cost amounts within 0 to 10^15 micros
  (`LIMITS.maxMicros`). An amount past these limits is dropped and logged, never sent.
- Request bodies are parsed up to 1 MiB.
- Responses and SSE events are parsed up to 4 MiB each.
- Per-task state and task-to-operation links are kept for the 10,000 most recent tasks per direction (inbound and
  outbound) per recorder. With `abandonOpenTasksOnShutdown`, the task store also remembers up to 10,000 open tasks.
- MCP: `withMcpTelemetry` keeps the 10,000 most recent sessions per recorder; a session it forgets has its pending
  requests finished as `transport_error`. Each session keeps at most 1,000 pending requests (the oldest beyond that is
  finished as `transport_error`), and a request still pending after an hour is finished as `transport_error` the next
  time its session is used. Targets, request IDs and client names are cut to 128 characters.

## License

MIT
