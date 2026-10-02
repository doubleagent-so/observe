/**
 * Requests in flight, by what an MCP SDK request handler can see (`extra.sessionId`, `extra.requestId`,
 * `extra.requestInfo`), so a handler can find its own operation: `mcpOperation(recorder, extra)?.charge(…)`.
 *
 * Keys: `<sessionId>\0<requestId>` in a session; the HTTP request object (by identity) for stateless HTTP, where every
 * client starts its ids at 0; `\0<requestId>` otherwise (stdio, in-memory). Ids keep their type (`1` and `"1"` differ).
 * Each key holds the set of live operations under it, and an answer is given only when exactly one is live: never
 * another request's operation.
 */
import type { OperationHandle, Recorder } from '../recorder.ts';
import { Lru } from '../state.ts';
import { requestKey } from './session.ts';

/** The fields of the SDK's `RequestHandlerExtra` that `mcpOperation` reads; the SDK's `extra` satisfies it. */
export interface McpHandlerExtra {
  sessionId?: string;
  requestId: string | number;
  requestInfo?: unknown;
}

/** Where a request was received: its session, else its HTTP request object (stateless), else its connection. */
export interface InflightScope {
  sessionId?: string;
  request?: object;
}

type Live = Set<OperationHandle>;

interface Registry {
  /** By session (or connection) key; bounded, 10,000 keys per recorder. */
  keyed: Lru<Live>;
  /** By HTTP request object, then request id; entries go with the request object. */
  perRequest: WeakMap<object, Map<string, Live>>;
}

const registries = new WeakMap<Recorder, Registry>();

const keyOf = (sessionId: string | undefined, requestId: string): string => `${sessionId ?? ''}\u0000${requestId}`;
const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
/** The one live operation under a key; none when there is none or more than one. */
const onlyLive = (live: Live | undefined): OperationHandle | undefined => (live?.size === 1 ? live.values().next().value : undefined);

function registryFor(recorder: Recorder): Registry {
  let registry = registries.get(recorder);
  if (!registry) {
    registry = { keyed: new Lru<Live>(), perRequest: new WeakMap() };
    registries.set(recorder, registry);
  }
  return registry;
}

/** Adds `op` under `key` in `map`; the returned release removes it (once) and drops the key when nothing is left. */
function track(
  map: { get(key: string): Live | undefined; set(key: string, value: Live): unknown; delete(key: string): unknown },
  key: string,
  op: OperationHandle,
): () => void {
  let live = map.get(key);
  if (!live) {
    live = new Set();
    map.set(key, live);
  }
  const owned = live;
  owned.add(op);
  return () => {
    owned.delete(op);
    if (!owned.size && map.get(key) === owned) map.delete(key);
  };
}

/** Tracks `op` until the returned release function runs. `requestId` is the JSON-RPC id as sent. */
export function trackInflight(recorder: Recorder, scope: InflightScope, requestId: string | number, op: OperationHandle): () => void {
  const { keyed, perRequest } = registryFor(recorder);
  if (!scope.sessionId && scope.request) {
    let requests = perRequest.get(scope.request);
    if (!requests) {
      requests = new Map();
      perRequest.set(scope.request, requests);
    }
    return track(requests, requestKey(requestId), op);
  }
  return track(keyed, keyOf(scope.sessionId, requestKey(requestId)), op);
}

/**
 * The operation for the request an MCP handler is serving: record charges and costs on it. `undefined` when the
 * transport is not instrumented with this recorder, the request already finished, or the key is ambiguous.
 */
export function mcpOperation(recorder: Recorder, extra: McpHandlerExtra): OperationHandle | undefined {
  const registry = registries.get(recorder);
  if (!registry || !isObject(extra)) return undefined;
  if (typeof extra.requestId !== 'string' && typeof extra.requestId !== 'number') return undefined;
  const requestId = requestKey(extra.requestId);
  const sessionId = typeof extra.sessionId === 'string' && extra.sessionId ? extra.sessionId : undefined;
  if (!sessionId && isObject(extra.requestInfo)) return onlyLive(registry.perRequest.get(extra.requestInfo)?.get(requestId));
  return onlyLive(registry.keyed.get(keyOf(sessionId, requestId)));
}
