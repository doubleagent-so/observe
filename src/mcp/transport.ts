/**
 * `instrumentMcpTransport`: records every JSON-RPC message an MCP SDK server or client sends and receives, for any
 * transport (stdio, Streamable HTTP, SSE, in-memory), without touching handlers or messages.
 *
 * How it hooks in: the SDK's `Protocol.connect` reads the transport's `onmessage`/`onclose`, chains them and assigns
 * its own. The wrapper is a `Proxy` over the original object: handlers set through it are stored, and the original's
 * own `onmessage`/`onclose` are replaced once, at wrap time, by observers that record and then call the stored handler
 * with the same arguments. `send` records the outgoing message, then calls the original synchronously. Every other
 * property and method (`handleRequest`, `closeSSEStream`, getters) is forwarded, with methods bound to the original so
 * classes with private state keep working; `instanceof` holds.
 *
 * Outgoing messages are recorded before the original `send` settles: a response we send finishes its operation even
 * if delivery then fails (only requests we send are finished `transport_error` when their `send` rejects).
 */
import type { Binding } from '../contract.ts';
import { defaultLog, guardLog, safely, type Log } from '../http.ts';
import { isRecord } from '../patterns.ts';
import type { Recorder } from '../recorder.ts';
import { ulid } from '../ulid.ts';
import { createMcpEngine, type McpRedactIds, type McpRole, type ObserveContext, type OnOperation, type StartedRequest } from './engine.ts';
import { nativeRef } from './mapping.ts';
import { newSession } from './session.ts';

/** The part of the SDK's `Transport` the wrapper relies on. Every SDK transport satisfies it structurally. */
export interface McpTransportLike {
  send(message: unknown, options?: unknown): Promise<void>;
  sessionId?: string;
}

export interface McpTransportOptions {
  recorder: Recorder;
  /** `server` for MCP servers (requests received are inbound), `client` for MCP clients. */
  role: McpRole;
  binding: Extract<Binding, 'stdio' | 'sse' | 'streamable-http' | 'other'>;
  /** Issuer recorded with `authInfo.clientId` (server role). Default `mcp`. */
  issuer?: string;
  /** Client role: the server's URL; only its origin is recorded, as the counterparty's `card_url`. */
  serverUrl?: string;
  /** Called with each operation's handle as it starts (paid tools: charge or record cost on it). */
  onOperation?: OnOperation;
  /** Replaces the request id, client name and version or task id before they are recorded. Default: recorded as sent. */
  redactIds?: McpRedactIds;
  /** Telemetry failures; a logger that throws is ignored. Default: JSON lines on `console.warn`. */
  log?: Log;
}

type Handler = (...args: unknown[]) => unknown;

/** The first string of a header value (`string` or Node's `string[]`). */
const headerText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
};

/**
 * A header from the SDK's `extra.requestInfo`: anything with a `get(name)` (`Headers`, from any realm), or a plain
 * record whose names are matched without regard to case (values may be arrays). `name` is lower-case.
 */
function requestHeader(requestInfo: unknown, name: string): string | undefined {
  if (!isRecord(requestInfo)) return undefined;
  const { headers } = requestInfo;
  if (headers === null || typeof headers !== 'object') return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') return headerText(get.call(headers, name)) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry ? headerText(entry[1]) : undefined;
}

export function instrumentMcpTransport<T extends McpTransportLike>(transport: T, options: McpTransportOptions): T {
  const log = guardLog(options.log ?? defaultLog);
  const engine = createMcpEngine({ ...options, log });
  const original = transport as T & Record<PropertyKey, unknown>;
  const session = newSession();
  // stdio has no session ID: one connection is one conversation.
  const connectionRef = options.binding === 'stdio' ? ulid(Date.now()) : undefined;
  const boundMethods = new WeakMap<Handler, Handler>();
  let onmessage = original.onmessage as Handler | undefined;
  let onclose = original.onclose as Handler | undefined;

  /** The session as it stands now: a stateful HTTP transport learns its ID only when `initialize` arrives. */
  const contextFor = (extra: Partial<ObserveContext> = {}): ObserveContext => {
    session.id = nativeRef(original.sessionId) ?? connectionRef;
    return { session, ...extra };
  };

  Reflect.set(original, 'onmessage', (...args: unknown[]) => {
    safely(log, () => {
      const extra = isRecord(args[1]) ? args[1] : {};
      // Stateless servers use a new transport per request, so only the header tells them the negotiated version.
      const versionHint = requestHeader(extra.requestInfo, 'mcp-protocol-version');
      const sessionId = typeof original.sessionId === 'string' && original.sessionId ? original.sessionId : undefined;
      // The SDK hands the handler the same `sessionId` and `requestInfo` object, so `mcpOperation` finds this request.
      const scope = { ...(sessionId ? { sessionId } : {}), ...(isRecord(extra.requestInfo) ? { request: extra.requestInfo } : {}) };
      engine.observe('peer', args[0], contextFor({ authInfo: extra.authInfo, versionHint, scope }));
    });
    return onmessage?.(...args);
  });
  Reflect.set(original, 'onclose', (...args: unknown[]) => {
    safely(log, () => engine.close(contextFor().session));
    return onclose?.(...args);
  });

  /** Records, then sends at once (before any await), so nothing is delayed or reordered. Rejections pass through. */
  async function send(message: unknown, ...rest: unknown[]): Promise<void> {
    const started: StartedRequest[] = [];
    safely(log, () => engine.observe('self', message, contextFor({ started })));
    try {
      return await (Reflect.apply(original.send, original, [message, ...rest]) as Promise<void>);
    } catch (error) {
      safely(log, () => engine.finish(session, started, { outcome: 'transport_error' }));
      throw error;
    }
  }

  function boundMethod(method: Handler): Handler {
    let bound = boundMethods.get(method);
    if (!bound) {
      bound = method.bind(original);
      boundMethods.set(method, bound);
    }
    return bound;
  }

  return new Proxy(original, {
    get(object, property) {
      if (property === 'send') return send;
      if (property === 'onmessage') return onmessage;
      if (property === 'onclose') return onclose;
      const value = Reflect.get(object, property, object);
      // `constructor` stays the class itself, so `wrapped.constructor === Class` and static members keep working.
      if (property === 'constructor' || typeof value !== 'function') return value;
      return boundMethod(value as Handler);
    },
    set(object, property, value) {
      if (property === 'onmessage') onmessage = value as Handler | undefined;
      else if (property === 'onclose') onclose = value as Handler | undefined;
      else return Reflect.set(object, property, value, object);
      return true;
    },
  }) as T;
}
