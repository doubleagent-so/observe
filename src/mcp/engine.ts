/**
 * The MCP pairing engine shared by the transport wrapper and the fetch wrapper. It sees JSON-RPC messages from either
 * side, pairs requests with responses per direction, remembers what `initialize` said and calls the recorder. It only
 * reads messages; it never changes or holds them. Internal.
 *
 * Example (server role): peer `{ id: 1, method: 'tools/call', params: { name: 'search' } }` starts an inbound `tool`
 * operation pending under `peer:1`; our `{ id: 1, result: { content: [] } }` finishes it `ok`.
 */
import { LIMITS, type Access, type Binding, type Direction, type Kind, type McpBlock } from '../contract.ts';
import { scopeList } from '../evidence.ts';
import { failureReason, guardLog, type Log } from '../http.ts';
import { isRecord, METHOD } from '../patterns.ts';
import type { CounterpartyInput, FinishInput, OperationHandle, Recorder } from '../recorder.ts';
import { Lru, recorderState, type RecorderState } from '../state.ts';
import {
  TOOL_ERROR,
  X402_PAYMENT_META,
  bounded,
  httpUrl,
  isToolError,
  mcpCapabilities,
  mcpError,
  mcpKind,
  mcpMessage,
  mcpMeta,
  mcpPeerInfo,
  mcpRequestId,
  mcpRequestMessages,
  mcpRequestPeer,
  mcpResultMessages,
  mcpTarget,
  mcpTask,
  mcpToolAccess,
  mcpVersion,
  nativeRef,
  type McpMessage,
  type McpRequestPeer,
  type McpTaskObservation,
} from './mapping.ts';
import type { InflightScope } from './inflight.ts';
import { PendingRequests, pendingKey, type Origin, type StartedRequest } from './pending.ts';
import type { McpSession } from './session.ts';

export type McpRole = 'server' | 'client';
export type { Origin, StartedRequest } from './pending.ts';

export interface McpOperationInfo {
  method: string;
  kind: Kind;
  direction: Direction;
  target?: string;
  /** The JSON-RPC id as sent (`1` and `"1"` are different requests); absent for operations that are not requests. */
  requestId?: string | number;
  sessionId?: string;
  /** The request params as received; read them, never change them. */
  params?: unknown;
}

export type OnOperation = (op: OperationHandle, info: McpOperationInfo) => void;

export type McpPeerInfo = { name: string; version?: string };

/**
 * Replaces caller-chosen MCP identifiers before they are recorded. Unset functions record the value as sent. A
 * function returns the value to record, or `undefined` to drop it; its value is checked like the original (one the wire would reject is dropped), and a
 * function that throws drops the value and logs `agent_telemetry_redact_failed`. Recording only: messages, pairing and
 * the `onOperation` hook still see the original values.
 *
 * Example: `{ taskId: (id) => hmac(id) }` records task `abc` as `task_ref: hmac('abc')` on every event that names it.
 */
export interface McpRedactIds {
  /** The JSON-RPC request id (numbers as their decimal string), recorded as `mcp.request_id`. */
  requestId?: (id: string) => string | undefined;
  /** The client's `initialize` name and version, recorded as `mcp.client_info` and `counterparty.client_info`. */
  clientInfo?: (info: McpPeerInfo) => McpPeerInfo | undefined;
  /** A tasks `taskId`, recorded as `task_ref`. Keep it deterministic so a task's events stay linked. */
  taskId?: (id: string) => string | undefined;
}

export interface EngineOptions {
  recorder: Recorder;
  role: McpRole;
  binding: Binding;
  /** The issuer of `authInfo` principals. Default: `mcp`. */
  issuer?: string;
  /** Client role: the server's URL; only its origin is sent, as `card_url`. */
  serverUrl?: string;
  onOperation?: OnOperation;
  redactIds?: McpRedactIds;
  log: Log;
}

export interface ObserveContext {
  session: McpSession;
  /** The SDK's `extra.authInfo` for a received message. Only `clientId` and `scopes` are read; the token never is. */
  authInfo?: unknown;
  /** The `MCP-Protocol-Version` header, when the transport has one. */
  versionHint?: string | null;
  /** Host evidence from `identify`; overrides session evidence per field. */
  counterparty?: CounterpartyInput;
  startedAt?: number;
  /** Collects the requests started by this call; finish them with `engine.finish(session, started, …)`. */
  started?: StartedRequest[];
  /**
   * When set, responses finish only these requests: the body of a POST answers that POST's requests, never another
   * request that reused one of their ids.
   */
  answering?: readonly StartedRequest[];
  /** Where a received request lives, so its handler can find its operation with `mcpOperation`. */
  scope?: InflightScope;
  /** What the transport knows about the response so far (bytes, stream events, time to first byte), for finishes. */
  finishMetrics?: () => FinishMetrics;
}

/** The response measurements an operation's finish can carry. */
export type FinishMetrics = Pick<FinishInput, 'responseBytes' | 'streamEvents' | 'firstByteMs'>;

export interface OperationExtra {
  version?: string;
  target?: string;
  taskRef?: string;
  mcp?: McpBlock;
  requestId?: string | number;
  params?: unknown;
  /** Server role: what this request's `_meta` says about the client (MCP 2026-07-28). */
  peer?: McpRequestPeer;
  /** A `tools/call` of a tool whose annotations the server listed. */
  access?: Access;
}

export interface McpEngine {
  /** Records one JSON-RPC message or a batch. Never throws; a malformed message is logged and skipped. */
  observe(origin: Origin, value: unknown, context: ObserveContext): void;
  /** Starts an operation that is not a paired request (a session `DELETE`); the caller finishes it. */
  operation(origin: Origin, method: string, kind: Kind, context: ObserveContext, extra?: OperationExtra): OperationHandle;
  /** Finishes the listed requests that are still pending (and still the same operations). */
  finish(session: McpSession, started: readonly StartedRequest[], input: FinishInput): void;
  /** Finishes everything pending in the session as `transport_error`. */
  close(session: McpSession): void;
}

type RpcRequest = Extract<McpMessage, { type: 'request' }>;
type RpcResponse = Extract<McpMessage, { type: 'result' | 'error' }>;
type RpcNotification = Extract<McpMessage, { type: 'notification' }>;

/** Tools whose access is remembered per server, from its `tools/list` results; the least recently used is forgotten. */
const MAX_TOOLS = 1_000;

/** What MCP servers assume when an HTTP request carries no `MCP-Protocol-Version`. */
const HTTP_DEFAULT_VERSION = '2025-03-26';

/**
 * A principal ID kept whole (at most `LIMITS.issuer` units): an overlong or malformed one is dropped, never cut, so two
 * principals never hash alike.
 */
const wholeId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= LIMITS.issuer ? bounded(value, LIMITS.issuer) : undefined;

/**
 * The server URL as a `card_url`: its origin only (`https://user:pw@mcp.example/k/sk_live_123?key=x` →
 * `https://mcp.example`). Credentials, paths, queries and fragments can all carry API keys.
 */
function cardUrl(value: unknown): string | undefined {
  const url = httpUrl(value);
  return url ? httpUrl(new URL(url).origin) : undefined;
}

const otherSide = (origin: Origin): Origin => (origin === 'peer' ? 'self' : 'peer');
/** A request from the peer is inbound and one we send is outbound, whichever role we play. */
const directionOf = (origin: Origin): Direction => (origin === 'peer' ? 'inbound' : 'outbound');

/** The optional parts of the hook's `McpOperationInfo`. */
function hookDetails(extra: OperationExtra, sessionId: string | undefined): Partial<McpOperationInfo> {
  return {
    ...(extra.target ? { target: extra.target } : {}),
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(extra.params !== undefined ? { params: extra.params } : {}),
  };
}

class Engine implements McpEngine {
  readonly #options: EngineOptions;
  readonly #log: Log;
  readonly #issuer: string;
  readonly #serverUrl: string | undefined;
  readonly #fallbackVersion: string;
  readonly #pending: PendingRequests;
  /** The server's tools by name (as recorded in `target`) → their access, from `tools/list` annotations. */
  readonly #toolAccess = new Lru<Access>(MAX_TOOLS);

  constructor(options: EngineOptions) {
    this.#options = options;
    this.#log = guardLog(options.log);
    this.#issuer = bounded(options.issuer, LIMITS.issuer) ?? 'mcp';
    this.#serverUrl = cardUrl(options.serverUrl);
    const isHttp = options.binding === 'streamable-http' || options.binding === 'sse';
    this.#fallbackVersion = isHttp ? HTTP_DEFAULT_VERSION : 'unknown';
    this.#pending = new PendingRequests(options.recorder);
  }

  /**
   * Task dedupe and links, kept with the direction of the requests that reach the task's executor: a process that both
   * serves and calls a task through one recorder records each side's states.
   */
  #stateFor(direction: Direction): RecorderState {
    return recorderState(this.#options.recorder, 'mcp', direction);
  }

  #evidence(context: ObserveContext, peer: McpRequestPeer | undefined): CounterpartyInput {
    const { session } = context;
    if (this.#options.role === 'client') {
      return {
        ...(session.serverInfo ? { declared_name: session.serverInfo.name } : {}),
        ...(this.#serverUrl ? { card_url: this.#serverUrl } : {}),
        ...context.counterparty,
      };
    }
    // Per request: a principal proven on one request says nothing about the next one. So is what a request's `_meta`
    // says about its client (MCP 2026-07-28); without it, what `initialize` said for the session.
    const clientInfo = peer?.clientInfo ?? session.clientInfo;
    const version = peer?.version ?? session.requestedVersion;
    const advertised = version
      ? [
          {
            name: 'mcp' as const,
            versions: [version],
            bindings: [this.#options.binding],
            capabilities: peer?.capabilities ?? session.capabilities,
          },
        ]
      : undefined;
    const authenticated = this.#authenticated(context.authInfo);
    return {
      ...(clientInfo ? { client_info: clientInfo } : {}),
      ...(authenticated ? { authenticated } : {}),
      ...(advertised ? { advertised_protocols: advertised } : {}),
      ...context.counterparty,
    };
  }

  /** The SDK's `authInfo`: `clientId` as the subject and the client id, with its granted `scopes`. Never the token. */
  #authenticated(authInfo: unknown): CounterpartyInput['authenticated'] {
    if (!isRecord(authInfo)) return undefined;
    const subject = wholeId(authInfo.clientId);
    if (!subject) return undefined;
    const scopes = scopeList(authInfo.scopes);
    return { issuer: this.#issuer, subject, client_id: subject, ...(scopes?.length ? { scopes } : {}) };
  }

  /** Server role: a `tools/list` result teaches each listed tool's access; a tool listed without annotations has none. */
  #learnTools(result: unknown): void {
    if (!isRecord(result) || !Array.isArray(result.tools)) return;
    for (const tool of result.tools.slice(0, MAX_TOOLS)) {
      const name = isRecord(tool) ? bounded(tool.name, LIMITS.target) : undefined;
      if (!name) continue;
      const access = mcpToolAccess(tool);
      if (access) this.#toolAccess.set(name, access);
      else this.#toolAccess.delete(name);
    }
  }

  /** `value` through the host's redaction and checked like the original; dropped and logged when redaction throws. */
  #redacted<T>(
    redact: ((value: T) => T | undefined) | undefined,
    value: T | undefined,
    check: (value: unknown) => T | undefined,
  ): T | undefined {
    if (value === undefined || !redact) return value;
    try {
      return check(redact(value));
    } catch (error) {
      this.#log('agent_telemetry_redact_failed', { reason: failureReason(error) });
      return undefined;
    }
  }

  #taskRef(value: unknown): string | undefined {
    return this.#redacted(this.#options.redactIds?.taskId, nativeRef(value), nativeRef);
  }

  /** A task in a result or notification, with its `task_ref` redacted; null when there is none left to record. */
  #task(value: unknown): McpTaskObservation | null {
    const task = mcpTask(value);
    const taskRef = task ? this.#taskRef(task.taskRef) : undefined;
    return task && taskRef ? { ...task, taskRef } : null;
  }

  #notifyHook(op: OperationHandle, info: McpOperationInfo): void {
    if (!this.#options.onOperation) return;
    try {
      this.#options.onOperation(op, info);
    } catch (error) {
      this.#log('agent_telemetry_hook_failed', { reason: failureReason(error) });
    }
  }

  /**
   * The negotiated version, else the latest valid `MCP-Protocol-Version` hint (kept on the session, so requests the
   * server sends in a stateless exchange carry it too), else the binding's default.
   */
  #sessionVersion(context: ObserveContext): string {
    const { session } = context;
    const hint = mcpVersion(context.versionHint);
    if (hint) session.versionHint = hint;
    return session.protocolVersion ?? session.versionHint ?? this.#fallbackVersion;
  }

  operation(origin: Origin, method: string, kind: Kind, context: ObserveContext, extra: OperationExtra = {}): OperationHandle {
    const { session } = context;
    const direction = directionOf(origin);
    const conversationRef = nativeRef(session.id);
    const mcp = extra.mcp && Object.keys(extra.mcp).length ? extra.mcp : undefined;
    const op = this.#options.recorder.startOperation({
      protocol: {
        name: 'mcp',
        version: extra.version ?? this.#sessionVersion(context),
        binding: this.#options.binding,
      },
      direction,
      method: METHOD.test(method) ? method : 'unknown',
      kind,
      ...(extra.target ? { target: extra.target } : {}),
      ...(conversationRef ? { conversationRef } : {}),
      ...(extra.taskRef ? { taskRef: extra.taskRef } : {}),
      counterparty: this.#evidence(context, extra.peer),
      ...(context.startedAt !== undefined ? { startedAt: context.startedAt } : {}),
      ...(mcp ? { mcp } : {}),
      ...(extra.access ? { access: extra.access } : {}),
    });
    this.#notifyHook(op, { method, kind, direction, ...hookDetails(extra, conversationRef) });
    return op;
  }

  /** Server role: what a peer `initialize` tells us about the client. */
  #learnFromRequest(origin: Origin, message: RpcRequest, context: ObserveContext): void {
    if (origin !== 'peer' || this.#options.role !== 'server') return;
    const { session } = context;
    if (message.method !== 'initialize' || !isRecord(message.params)) return;
    const clientInfo = this.#redacted(this.#options.redactIds?.clientInfo, mcpPeerInfo(message.params.clientInfo), mcpPeerInfo);
    session.clientInfo = clientInfo ?? session.clientInfo;
    session.requestedVersion = mcpVersion(message.params.protocolVersion) ?? session.requestedVersion;
    session.capabilities = mcpCapabilities(message.params.capabilities);
  }

  /** Server role: what a peer request's `_meta` says about its client, with the client info redacted like `initialize`'s. */
  #requestPeer(origin: Origin, params: unknown): McpRequestPeer | undefined {
    if (origin !== 'peer' || this.#options.role !== 'server') return undefined;
    const peer = mcpRequestPeer(params);
    if (!peer) return undefined;
    const { clientInfo, ...rest } = peer;
    const redacted = this.#redacted(this.#options.redactIds?.clientInfo, clientInfo, mcpPeerInfo);
    return { ...rest, ...(redacted ? { clientInfo: redacted } : {}) };
  }

  /** The `mcp` block's client facts: this request's `_meta`, else (on `initialize`) what it announced. */
  #clientBlock(origin: Origin, method: string, peer: McpRequestPeer | undefined, session: McpSession): McpBlock {
    if (peer?.clientInfo || peer?.capabilities) {
      return {
        ...(peer.clientInfo ? { client_info: peer.clientInfo } : {}),
        ...(peer.capabilities ? { capabilities: peer.capabilities } : {}),
      };
    }
    const announced = method === 'initialize' && origin === 'peer' && this.#options.role === 'server' ? session.clientInfo : undefined;
    return announced ? { client_info: announced, capabilities: session.capabilities } : {};
  }

  /** What a request adds to its operation. Reads the params only; a hostile value throws before anything starts. */
  #requestExtra(origin: Origin, message: RpcRequest, session: McpSession): OperationExtra {
    const { method } = message;
    const params = isRecord(message.params) ? message.params : {};
    const target = mcpTarget(method, params);
    const taskRef = method.startsWith('tasks/') ? this.#taskRef(params.taskId) : undefined;
    const peer = this.#requestPeer(origin, params);
    const version = (method === 'initialize' ? mcpVersion(params.protocolVersion) : undefined) ?? peer?.version;
    const access = method === 'tools/call' && target ? this.#toolAccess.get(target) : undefined;
    const requestId = this.#redacted(this.#options.redactIds?.requestId, mcpRequestId(message.id), mcpRequestId);
    return {
      ...(version ? { version } : {}),
      ...(target ? { target } : {}),
      ...(taskRef ? { taskRef } : {}),
      mcp: {
        ...(requestId ? { request_id: requestId } : {}),
        ...this.#clientBlock(origin, method, peer, session),
      },
      requestId: message.id,
      params: message.params,
      ...(peer ? { peer } : {}),
      ...(access ? { access } : {}),
    };
  }

  #start(origin: Origin, message: RpcRequest, context: ObserveContext): void {
    this.#learnFromRequest(origin, message, context);
    const { session } = context;
    const { method } = message;
    const messages = mcpRequestMessages(method, message.params);
    const extra = this.#requestExtra(origin, message, session);
    const kind = mcpKind(method);
    const op = this.operation(origin, method, kind, context, extra);
    for (const input of messages) op.message(input);
    if (extra.taskRef) this.#stateFor(directionOf(origin)).linkTask(extra.taskRef, op);
    const payment = mcpMeta(message.params, X402_PAYMENT_META);
    const started = this.#pending.add(session, {
      origin,
      id: message.id,
      op,
      method,
      kind,
      ...(payment !== undefined ? { payment } : {}),
      ...(context.scope ? { scope: context.scope } : {}),
    });
    context.started?.push(started);
  }

  #recordTaskState(state: RecorderState, op: OperationHandle, task: McpTaskObservation): void {
    state.linkTask(task.taskRef, op);
    if (state.taskChanged(task.taskRef, task.state)) op.taskState(task);
  }

  /** What an `initialize` result tells us: the negotiated version and (client role) the server's name. */
  #learnFromInitializeResult(result: unknown, session: McpSession): void {
    if (!isRecord(result)) return;
    session.protocolVersion = mcpVersion(result.protocolVersion) ?? session.protocolVersion;
    if (this.#options.role === 'client') session.serverInfo = mcpPeerInfo(result.serverInfo) ?? session.serverInfo;
  }

  /** A response from `origin` finishes the request the other side sent with the same id. */
  #complete(origin: Origin, message: RpcResponse, context: ObserveContext): void {
    if (message.id === null) return;
    const { session } = context;
    const requester = otherSide(origin);
    const key = pendingKey(requester, message.id);
    const waiting = this.#pending.find(session, key);
    if (!waiting) return;
    if (context.answering && !context.answering.some((entry) => entry.key === key && entry.op === waiting.op)) return;
    const done = this.#pending.take(session, key, message.type === 'result' ? message.result : undefined);
    if (!done) return;
    const { op, method } = done;
    const metrics = context.finishMetrics?.() ?? {};
    if (message.type === 'error') return op.finish({ outcome: 'protocol_error', error: mcpError(message.error), ...metrics });
    const { result } = message;
    if (method === 'initialize') this.#learnFromInitializeResult(result, session);
    if (method === 'tools/list') this.#learnTools(result);
    for (const input of mcpResultMessages(method, result)) op.message(input);
    const task = this.#task(result);
    if (task) this.#recordTaskState(this.#stateFor(directionOf(requester)), op, task);
    op.finish({ ...(isToolError(method, result) ? { outcome: 'tool_error', error: TOOL_ERROR } : { outcome: 'ok' }), ...metrics });
  }

  /** `notifications/cancelled` from the requester; any other id shape is ignored, never stringified into a key. */
  #cancel(origin: Origin, params: Record<string, unknown>, session: McpSession): void {
    const { requestId } = params;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    this.#pending.take(session, pendingKey(origin, requestId))?.op.finish({ outcome: 'canceled' });
  }

  #notify(origin: Origin, message: RpcNotification, context: ObserveContext): void {
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === 'notifications/cancelled') return this.#cancel(origin, params, context.session);
    if (message.method !== 'notifications/tasks/status') return;
    const task = this.#task(params);
    if (!task) return;
    // The sender executes the task; requests reaching it were sent by the other side.
    const owner = otherSide(origin);
    const state = this.#stateFor(directionOf(owner));
    const linked = state.operationFor(task.taskRef);
    if (linked) return this.#recordTaskState(state, linked, task);
    // A task this instance never saw created (another instance, or forgotten): recorded on its own operation.
    const op = this.operation(owner, message.method, 'management', context, { taskRef: task.taskRef });
    this.#recordTaskState(state, op, task);
    op.finish({ outcome: 'ok' });
  }

  #observeOne(origin: Origin, entry: unknown, context: ObserveContext): void {
    const message = mcpMessage(entry);
    if (!message) return;
    if (message.type === 'request') this.#start(origin, message, context);
    else if (message.type === 'notification') this.#notify(origin, message, context);
    else this.#complete(origin, message, context);
  }

  observe(origin: Origin, value: unknown, context: ObserveContext): void {
    try {
      this.#pending.sweep(context.session);
    } catch (error) {
      this.#log('agent_telemetry_event_failed', { reason: failureReason(error) });
    }
    for (const entry of Array.isArray(value) ? value : [value]) {
      try {
        this.#observeOne(origin, entry, context);
      } catch (error) {
        this.#log('agent_telemetry_event_failed', { reason: failureReason(error) });
      }
    }
  }

  finish(session: McpSession, started: readonly StartedRequest[], input: FinishInput): void {
    for (const { key, op } of started) {
      if (this.#pending.find(session, key)?.op !== op) continue;
      this.#pending.take(session, key)?.op.finish(input);
    }
  }

  close(session: McpSession): void {
    this.#pending.closeAll(session);
  }
}

export function createMcpEngine(options: EngineOptions): McpEngine {
  return new Engine(options);
}
