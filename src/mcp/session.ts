/**
 * What one MCP session (or connection) has told us so far, and the requests still waiting for a response. Internal.
 *
 * Example: after `initialize` from Claude, a server session holds
 * `{ id: 'session-1', clientInfo: { name: 'claude-ai', version: '0.1.0' }, requestedVersion: '2025-11-25',
 *    protocolVersion: '2025-11-25', capabilities: ['sampling'], pending: Map { 'peer:1' → … } }`.
 */
import type { Capability, Kind } from '../contract.ts';
import type { ChargeInput } from '../money.ts';
import { x402Evidence } from '../payments.ts';
import type { OperationHandle, Recorder } from '../recorder.ts';
import { Lru } from '../state.ts';
import { X402_RESPONSE_META, mcpMeta } from './mapping.ts';

export interface PendingOperation {
  op: OperationHandle;
  /** Epoch ms when the request was seen; requests pending longer than an hour are finished. */
  startedAt: number;
  method: string;
  kind: Kind;
  /** Stops tracking the request for `mcpOperation`. */
  release?: () => void;
  /** The request's x402 payment payload (`params._meta['x402/payment']`), as sent. */
  payment?: unknown;
  /** x402 evidence from the HTTP headers (fetch wrapper); used when the request leaves without `_meta` evidence. */
  headerCharge?: ChargeInput;
  /** True once the call's charge is recorded: a call is charged at most once. */
  isCharged?: boolean;
}

/**
 * Records the call's x402 charge, once, just before its operation finishes, on every exit: a result, an error, a
 * cancel, a displacement, a sweep, an eviction or a close. The `_meta` evidence (payment on the request, settlement on
 * the `result`) wins; otherwise the settlement header, which proves the money moved however the call ended.
 */
export function chargeOnce(pending: PendingOperation, result?: unknown): void {
  if (pending.isCharged) return;
  const paid = x402Evidence(pending.payment, mcpMeta(result, X402_RESPONSE_META)) ?? pending.headerCharge;
  if (!paid) return;
  pending.isCharged = true;
  pending.op.charge(paid);
}

export interface McpSession {
  /** The conversation reference: `Mcp-Session-Id`, or a connection ID for stdio. */
  id?: string;
  clientInfo?: { name: string; version?: string };
  serverInfo?: { name: string; version?: string };
  /** The version the client asked for in `initialize`. */
  requestedVersion?: string;
  /** The version agreed in the `initialize` result. */
  protocolVersion?: string;
  capabilities: Capability[];
  /** The latest valid `MCP-Protocol-Version` header seen, for requests the server sends without one. */
  versionHint?: string;
  /** Pending requests by `"<origin>:<id>"` (string ids quoted: `peer:1`, `peer:"1"`), oldest first. */
  pending: Map<string, PendingOperation>;
}

/**
 * A JSON-RPC id as a key that keeps its type: `1` for the number 1, `"1"` for the string "1". Ids of different types
 * are different requests, so one can never stand for the other.
 */
export const requestKey = (id: string | number): string => (typeof id === 'number' ? String(id) : JSON.stringify(id));

/** Pending requests kept per session; beyond this the oldest is finished as a transport_error and forgotten. */
export const MAX_PENDING = 1_000;

export const newSession = (id?: string): McpSession => ({ ...(id ? { id } : {}), capabilities: [], pending: new Map() });

/**
 * Finishes everything pending in a session as `transport_error` and stops tracking it for `mcpOperation`: the
 * connection closed, the session was deleted, or the session cache forgot it.
 */
export function closePending(session: McpSession): void {
  const pending = [...session.pending.values()];
  session.pending.clear();
  for (const { release } of pending) release?.();
  for (const entry of pending) {
    chargeOnce(entry);
    entry.op.finish({ outcome: 'transport_error' });
  }
}

const caches = new WeakMap<Recorder, Lru<McpSession>>();

/**
 * Sessions `withMcpTelemetry` keeps for this recorder, by session ID (bounded, 10,000). A session the cache
 * forgets has its pending requests finished, so none is left open.
 */
export function mcpSessions(recorder: Recorder): Lru<McpSession> {
  let cache = caches.get(recorder);
  if (!cache) {
    cache = new Lru<McpSession>(undefined, (_id, session) => closePending(session));
    caches.set(recorder, cache);
  }
  return cache;
}
