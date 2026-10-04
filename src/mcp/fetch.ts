/**
 * `withMcpTelemetry`: observes MCP Streamable HTTP traffic on any fetch-style server, built on the SDK or by hand.
 *
 * - POST with a JSON body: every JSON-RPC request in it (single or batch) is an operation; responses in it (a client
 *   answering `sampling/createMessage`) finish our callbacks; `notifications/cancelled` finishes as `canceled`. Bodies
 *   that are not JSON-RPC pass through unrecorded; bodies over 1 MiB are one `unknown` operation.
 * - Session: a valid `Mcp-Session-Id` header shares one session per recorder; without one, each POST gets its own, so
 *   concurrent stateless requests that reuse JSON-RPC ids never pair across each other.
 * - SSE responses and GET streams in a session are observed as they flow, never buffered.
 * - DELETE with a session header is the `management` operation `session/delete`.
 * Requests and responses are read from clones; the handler and the client get the originals, untouched.
 */
import {
  HANDLER_THREW,
  JSON_TYPE,
  MAX_RESPONSE_BYTES,
  createScheduler,
  defaultLog,
  failureReason,
  guardLog,
  httpError,
  identifyCaller,
  isEventStream,
  readLimited,
  safely,
  type LimitedRead,
  type Log,
  type WaitUntil,
} from '../http.ts';
import { isRecord } from '../patterns.ts';
import { x402Charge } from '../payments.ts';
import type { CounterpartyInput, FinishInput, Recorder } from '../recorder.ts';
import { observeSse } from '../sse.ts';
import {
  createMcpEngine,
  type FinishMetrics,
  type McpEngine,
  type ObserveContext,
  type McpRedactIds,
  type OnOperation,
  type StartedRequest,
} from './engine.ts';
import { HttpSessions, restoreFacts, sessionFacts, type SessionFacts } from './http-sessions.ts';
import { nativeRef } from './mapping.ts';
import { chargeOnce, type McpSession } from './session.ts';

export interface McpTelemetryOptions {
  recorder: Recorder;
  /** Host-verified evidence about the caller (auth middleware, signatures). Never raw `Authorization` headers. */
  identify?: (request: Request) => CounterpartyInput | Promise<CounterpartyInput>;
  /** `true` uses the first handler argument with a `waitUntil` function (the Workers `ctx`). */
  waitUntil?: true | WaitUntil;
  /** Called with each operation's handle as it starts (paid tools: charge or record cost on it). */
  onOperation?: OnOperation;
  /** Replaces the request id, client name and version or task id before they are recorded. Default: recorded as sent. */
  redactIds?: McpRedactIds;
  /** Telemetry failures; a logger that throws is ignored. Default: JSON lines on `console.warn`. */
  log?: Log;
}

type Handler<Args extends unknown[]> = (request: Request, ...args: Args) => Response | Promise<Response>;
type Schedule = (promise: Promise<unknown>) => void;
type Parsed = { kind: 'skip' } | { kind: 'oversized' } | { kind: 'messages'; body: unknown; hasInitialize: boolean };
type Messages = Extract<Parsed, { kind: 'messages' }>;

/** A JSON-RPC message or batch, or why it is not one. Any entry that is not JSON-RPC 2.0 makes the body "not ours". */
function parse(read: LimitedRead): Parsed {
  if (read === null) return { kind: 'oversized' };
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return { kind: 'skip' };
  }
  const entries: unknown[] = Array.isArray(body) ? body : [body];
  if (!entries.length || !entries.every((entry) => isRecord(entry) && entry.jsonrpc === '2.0')) return { kind: 'skip' };
  return { kind: 'messages', body, hasInitialize: entries.some((entry) => isRecord(entry) && entry.method === 'initialize') };
}

/** How an HTTP status finishes the operations of its request when no JSON-RPC response says otherwise. */
function outcomeFor(status: number): FinishInput {
  if (status === 401 || status === 403) return { outcome: 'auth_rejected' };
  if (status >= 400) return { outcome: 'protocol_error', error: httpError(status) };
  return { outcome: 'ok' };
}

/** One POST of JSON-RPC messages, from its request to its response. */
interface PostExchange {
  request: Request;
  body: unknown;
  /** Reassigned once for a deferred `initialize`: its session ID comes with the response. */
  session: McpSession;
  started: StartedRequest[];
  /** `initialize` without a session learns its session ID from the response, so it is recorded afterwards. */
  isDeferred: boolean;
  /** What a cached session knew before this request: an `initialize` the server rejects must not change it. */
  before: SessionFacts | undefined;
  /** Epoch ms when the request arrived. */
  startedAt: number;
  requestContext(): ObserveContext;
  /** The response answers this POST's requests only, never another POST's request that reused an id. */
  responseContext(): ObserveContext;
}

class McpFetchTelemetry<Args extends unknown[]> {
  readonly #handler: Handler<Args>;
  readonly #options: McpTelemetryOptions;
  readonly #log: Log;
  readonly #engine: McpEngine;
  readonly #sessions: HttpSessions;
  readonly #schedulerFor: (args: readonly unknown[]) => Schedule;

  constructor(handler: Handler<Args>, options: McpTelemetryOptions) {
    this.#handler = handler;
    this.#options = options;
    this.#log = guardLog(options.log ?? defaultLog);
    this.#engine = createMcpEngine({
      recorder: options.recorder,
      role: 'server',
      binding: 'streamable-http',
      ...(options.onOperation ? { onOperation: options.onOperation } : {}),
      ...(options.redactIds ? { redactIds: options.redactIds } : {}),
      log: this.#log,
    });
    this.#sessions = new HttpSessions(options.recorder);
    this.#schedulerFor = createScheduler(options.waitUntil, this.#log);
  }

  async handle(request: Request, args: Args): Promise<Response> {
    const schedule = this.#schedulerFor(args);
    if (request.method === 'POST' && JSON_TYPE.test(request.headers.get('content-type') ?? '')) return this.#post(request, args, schedule);
    if (request.method === 'DELETE') return this.#remove(request, args, schedule);
    if (request.method === 'GET') return this.#observeStandalone(request, await this.#handler(request, ...args), schedule);
    return this.#handler(request, ...args);
  }

  async #post(request: Request, args: Args, schedule: Schedule): Promise<Response> {
    const parsed = await this.#readRequest(request);
    if (parsed.kind === 'skip') return this.#handler(request, ...args);
    if (parsed.kind === 'oversized') return this.#postOversized(request, args, schedule);
    return this.#postMessages(request, args, schedule, parsed);
  }

  async #postMessages(request: Request, args: Args, schedule: Schedule, parsed: Messages): Promise<Response> {
    const exchange = await this.#beginExchange(request, parsed);
    if (!exchange.isDeferred) this.#safely(() => this.#engine.observe('peer', exchange.body, exchange.requestContext()));
    let response: Response;
    try {
      response = await this.#handler(request, ...args);
    } catch (error) {
      if (exchange.isDeferred) this.#safely(() => this.#engine.observe('peer', exchange.body, exchange.requestContext()));
      this.#endExchange(exchange, { outcome: 'protocol_error', error: HANDLER_THREW }, schedule);
      throw error;
    }
    if (exchange.isDeferred) exchange.session = this.#sessions.forId(response.headers.get('mcp-session-id'));
    this.#sessions.commit(exchange.session, response.status);
    if (exchange.isDeferred) this.#safely(() => this.#engine.observe('peer', exchange.body, exchange.requestContext()));
    this.#safely(() => this.#attachHeaderCharge(request, response, exchange));
    if (response.status >= 400) {
      this.#endExchange(exchange, outcomeFor(response.status), schedule);
      return response;
    }
    const firstByteMs = Math.max(0, Date.now() - exchange.startedAt);
    if (isEventStream(response))
      return this.#observeMessages(response, exchange.responseContext, exchange.started, schedule, { firstByteMs });
    this.#settleJson(response, exchange.responseContext, exchange.started, schedule, { firstByteMs });
    return response;
  }

  /** Everything one POST needs before its handler runs: evidence, session and the contexts its messages use. */
  async #beginExchange(request: Request, parsed: Messages): Promise<PostExchange> {
    const counterparty = await this.#identify(request);
    const versionHint = request.headers.get('mcp-protocol-version');
    const headerSession = request.headers.get('mcp-session-id');
    const sessionRef = nativeRef(headerSession);
    const startedAt = Date.now();
    const session = this.#sessions.forId(headerSession);
    const isDeferred = parsed.hasInitialize && !sessionRef;
    // A hand-rolled handler finds its operation with `mcpOperation(recorder, { sessionId, requestId, requestInfo: request })`.
    const scope = sessionRef ? { sessionId: sessionRef } : { request };
    const exchange: PostExchange = {
      request,
      body: parsed.body,
      session,
      started: [],
      isDeferred,
      startedAt,
      before: parsed.hasInitialize && this.#sessions.isShared(session) ? sessionFacts(session) : undefined,
      requestContext: () => ({
        session: exchange.session,
        counterparty,
        versionHint,
        started: exchange.started,
        scope,
        ...(isDeferred ? { startedAt } : {}),
      }),
      responseContext: () => ({ session: exchange.session, counterparty, versionHint, answering: exchange.started }),
    };
    return exchange;
  }

  /** Ends a POST whose response is not observed: its requests finish with `input`; a rejected `initialize` is undone. */
  #endExchange(exchange: PostExchange, input: FinishInput, schedule: Schedule): void {
    this.#safely(() => {
      if (exchange.before) restoreFacts(exchange.session, exchange.before);
      this.#engine.finish(exchange.session, exchange.started, input);
      this.#endRequest(exchange.session);
    });
    this.#flushLater(schedule);
  }

  /** A body too large to parse: one `unknown` operation, finished from the status. */
  async #postOversized(request: Request, args: Args, schedule: Schedule): Promise<Response> {
    const op = this.#engine.operation('peer', 'unknown', 'other', {
      session: this.#sessions.forId(request.headers.get('mcp-session-id')),
      counterparty: await this.#identify(request),
      versionHint: request.headers.get('mcp-protocol-version'),
    });
    let response: Response;
    try {
      response = await this.#handler(request, ...args);
    } catch (error) {
      this.#safely(() => op.finish({ outcome: 'protocol_error', error: HANDLER_THREW }));
      this.#flushLater(schedule);
      throw error;
    }
    this.#safely(() => op.finish(outcomeFor(response.status)));
    this.#flushLater(schedule);
    return response;
  }

  /** A session `DELETE`: recorded as `session/delete`; on success the session's pending requests end and it is forgotten. */
  async #remove(request: Request, args: Args, schedule: Schedule): Promise<Response> {
    const ref = nativeRef(request.headers.get('mcp-session-id'));
    if (!ref) return this.#handler(request, ...args);
    const session = this.#sessions.forId(ref);
    const op = this.#engine.operation('peer', 'session/delete', 'management', {
      session,
      counterparty: await this.#identify(request),
      versionHint: request.headers.get('mcp-protocol-version'),
    });
    let response: Response;
    try {
      response = await this.#handler(request, ...args);
    } catch (error) {
      this.#safely(() => op.finish({ outcome: 'protocol_error', error: HANDLER_THREW }));
      this.#flushLater(schedule);
      throw error;
    }
    this.#safely(() => op.finish(outcomeFor(response.status)));
    if (response.status < 400) {
      this.#safely(() => this.#engine.close(session));
      this.#sessions.forget(ref);
    }
    this.#flushLater(schedule);
    return response;
  }

  /** A GET stream in a session (standalone, or resuming an earlier one): its messages are observed; no operation of its own. */
  #observeStandalone(request: Request, response: Response, schedule: Schedule): Response {
    const ref = nativeRef(request.headers.get('mcp-session-id'));
    if (!ref || response.status >= 400 || !isEventStream(response)) return response;
    const session = this.#sessions.forId(ref);
    this.#sessions.commit(session, response.status);
    const versionHint = request.headers.get('mcp-protocol-version');
    return this.#observeMessages(response, () => ({ session, versionHint }), [], schedule);
  }

  /**
   * Observes every JSON-RPC message the server sends on an SSE stream, passing the bytes through unchanged:
   * server→client requests start outbound callbacks, responses finish this POST's requests, task statuses are recorded.
   * When the stream ends, this POST's still-pending requests finish `transport_error`, unless the stream was resumable
   * (it carried event IDs, in a cached session) and ended normally or by the client going away: the response then comes
   * on a resumed GET stream. A stream that could not be read (`unread`) is returned untouched and finishes them `ok`.
   * Finishes carry the stream's event count and the time to its first byte.
   */
  #observeMessages(
    response: Response,
    responseContext: () => ObserveContext,
    started: readonly StartedRequest[],
    schedule: Schedule,
    timing: FinishMetrics = {},
  ): Response {
    let isResumable = false;
    let events = 0;
    const streamContext = (): ObserveContext => ({ ...responseContext(), finishMetrics: () => ({ ...timing, streamEvents: events }) });
    return observeSse(
      response,
      {
        event: ({ data, id }) => {
          events++;
          if (id !== undefined) isResumable = true;
          let message: unknown;
          try {
            message = JSON.parse(data);
          } catch {
            return; // Priming events and non-JSON data are not MCP messages.
          }
          this.#engine.observe('self', message, streamContext());
        },
        end: (how, total) => {
          try {
            const { session } = responseContext();
            const willResume = (how === 'done' || how === 'canceled') && isResumable && this.#sessions.isShared(session);
            if (how === 'unread') this.#engine.finish(session, started, { outcome: 'ok', ...timing });
            else if (!willResume) this.#engine.finish(session, started, { outcome: 'transport_error', ...timing, streamEvents: total });
            this.#endRequest(session);
          } finally {
            this.#flushLater(schedule);
          }
        },
      },
      this.#log,
    );
  }

  /**
   * Pairs a JSON response with this POST's requests in the background (read from a clone taken now, at most 4 MiB);
   * whatever is still pending afterwards finishes `ok`, as a 2xx without a matching response. Finishes carry the
   * response's size (when read) and the time to its first byte.
   */
  #settleJson(
    response: Response,
    responseContext: () => ObserveContext,
    started: readonly StartedRequest[],
    schedule: Schedule,
    timing: FinishMetrics = {},
  ): void {
    const settle = async () => {
      let metrics: FinishMetrics = timing;
      try {
        // readLimited clones before its first await, so the clone is taken now, before the response is returned.
        const read = await readLimited(response, MAX_RESPONSE_BYTES);
        if (read) metrics = { ...timing, responseBytes: read.bytes };
        if (read?.text) this.#engine.observe('self', JSON.parse(read.text), { ...responseContext(), finishMetrics: () => metrics });
      } catch (error) {
        // A body that is not JSON has nothing to pair; anything else is a telemetry failure worth a log line.
        if (!(error instanceof SyntaxError)) this.#log('agent_telemetry_event_failed', { reason: failureReason(error) });
      }
      this.#safely(() => {
        const { session } = responseContext();
        this.#engine.finish(session, started, { outcome: 'ok', ...metrics });
        this.#endRequest(session);
      });
      await this.#flushQuietly();
    };
    this.#safely(() => schedule(settle()));
  }

  /**
   * x402 header evidence pays for one HTTP request: it goes to the POST's first tool call. A settlement header proves the
   * money moved, so it is charged on any status but 401 and 403 (`success: false` as a failed charge): at once when the
   * call sent no `_meta` payment, else when the call leaves, if its result carries no `_meta` settlement.
   */
  #attachHeaderCharge(request: Request, response: Response, exchange: PostExchange): void {
    if (response.status === 401 || response.status === 403) return;
    const evidence = x402Charge(request, response);
    if (!evidence) return;
    for (const { key, op } of exchange.started) {
      const pending = exchange.session.pending.get(key);
      if (pending?.op !== op || pending.kind !== 'tool') continue;
      pending.headerCharge = evidence;
      if (pending.payment === undefined) chargeOnce(pending);
      return;
    }
  }

  /** A session that is not cached ends with its request: anything still pending in it can never be answered. */
  #endRequest(session: McpSession): void {
    if (!this.#sessions.isShared(session)) this.#engine.close(session);
  }

  /** Reads the request's JSON-RPC body from a clone; any failure means "not ours" and the request passes through. */
  async #readRequest(request: Request): Promise<Parsed> {
    try {
      return parse(await readLimited(request));
    } catch (error) {
      this.#log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return { kind: 'skip' };
    }
  }

  async #identify(request: Request): Promise<CounterpartyInput> {
    return identifyCaller(this.#options.identify, request, this.#log);
  }

  #safely(work: () => void): void {
    safely(this.#log, work);
  }

  /** Hands a flush to the scheduler; never throws. */
  #flushLater(schedule: Schedule): void {
    this.#safely(() => schedule(this.#flushQuietly()));
  }

  async #flushQuietly(): Promise<void> {
    try {
      await this.#options.recorder.flush();
    } catch (error) {
      this.#log('agent_telemetry_event_failed', { reason: failureReason(error) });
    }
  }
}

export function withMcpTelemetry<Args extends unknown[]>(
  handler: Handler<Args>,
  options: McpTelemetryOptions,
): (request: Request, ...args: Args) => Promise<Response> {
  const telemetry = new McpFetchTelemetry(handler, options);
  return async (request, ...args) => telemetry.handle(request, args);
}
