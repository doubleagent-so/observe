/**
 * Internal: the requests of a session that still wait for a response. Every way a request leaves (a response, a
 * cancel, a reused id, the one-hour sweep, the cap, a close) goes through here, so each one is untracked for
 * `mcpOperation` and charged (x402) exactly once before its operation finishes.
 *
 * Keys keep the JSON-RPC id's type and who sent it: `peer:1`, `self:"1"`.
 */
import type { Kind } from '../contract.ts';
import type { OperationHandle, Recorder } from '../recorder.ts';
import { trackInflight, type InflightScope } from './inflight.ts';
import { MAX_PENDING, chargeOnce, closePending, requestKey, type McpSession, type PendingOperation } from './session.ts';

/** Who sent a message: the other side (`peer`) or the instrumented side (`self`). */
export type Origin = 'peer' | 'self';

/** A request one call started: its pending key and its operation, so a reused key never finishes the wrong one. */
export interface StartedRequest {
  key: string;
  op: OperationHandle;
}

export interface NewRequest {
  origin: Origin;
  id: string | number;
  op: OperationHandle;
  method: string;
  kind: Kind;
  /** The request's x402 payment payload (`params._meta['x402/payment']`), if any. */
  payment?: unknown;
  /** Where a received request lives, so its handler can find its operation with `mcpOperation`. */
  scope?: InflightScope;
}

/** Requests pending longer than this are finished as `transport_error` the next time their session is used. */
const MAX_PENDING_AGE_MS = 60 * 60 * 1000;
/** How a request is finished when the requester reuses its id while it is still pending. */
const DUPLICATE_REQUEST_ID = { nativeCode: 'duplicate_request_id', code: 'duplicate_request_id' } as const;

/** The key of a pending request: `peer:1` for the number 1, `peer:"1"` for the string "1". */
export const pendingKey = (origin: Origin, id: string | number): string => `${origin}:${requestKey(id)}`;

/** Both releases, in order; either may be absent. */
function chainRelease(first: (() => void) | undefined, second: (() => void) | undefined): (() => void) | undefined {
  if (!first || !second) return first ?? second;
  return () => {
    first();
    second();
  };
}

export class PendingRequests {
  readonly #recorder: Recorder;

  constructor(recorder: Recorder) {
    this.#recorder = recorder;
  }

  /** Tracks a new request; a request still pending under its key is displaced. Returns what the caller started. */
  add(session: McpSession, request: NewRequest): StartedRequest {
    const { origin, id, op, method, kind, payment, scope } = request;
    const key = pendingKey(origin, id);
    const tracked = origin === 'peer' && scope ? trackInflight(this.#recorder, scope, id, op) : undefined;
    const release = chainRelease(this.#displace(session, key), tracked);
    session.pending.set(key, {
      op,
      startedAt: Date.now(),
      method,
      kind,
      ...(release ? { release } : {}),
      ...(payment !== undefined ? { payment } : {}),
    });
    // Beyond the cap the oldest request is forgotten: finished, never left open.
    if (session.pending.size > MAX_PENDING)
      this.take(session, session.pending.keys().next().value!)?.op.finish({ outcome: 'transport_error' });
    return { key, op };
  }

  /** The request pending under `key`, left in place. */
  find(session: McpSession, key: string): PendingOperation | undefined {
    return session.pending.get(key);
  }

  /**
   * Removes a pending request, stops tracking it for `mcpOperation` and records its charge (from `result`'s `_meta`,
   * else the settlement header). The caller only finishes the operation.
   */
  take(session: McpSession, key: string, result?: unknown): PendingOperation | undefined {
    const pending = session.pending.get(key);
    if (!pending) return undefined;
    session.pending.delete(key);
    pending.release?.();
    chargeOnce(pending, result);
    return pending;
  }

  /** Finishes requests pending longer than an hour; the oldest come first, so the sweep stops at the first young one. */
  sweep(session: McpSession): void {
    const oldest = Date.now() - MAX_PENDING_AGE_MS;
    for (const [key, pending] of session.pending) {
      if (pending.startedAt >= oldest) return;
      this.take(session, key)?.op.finish({ outcome: 'transport_error' });
    }
  }

  /** Finishes everything pending in the session as `transport_error`. */
  closeAll(session: McpSession): void {
    closePending(session);
  }

  /**
   * A reused id displaces the request still pending under it: that operation is charged and finished (never orphaned),
   * but its `mcpOperation` entry stays until the new request is released too, so neither handler is handed the other's
   * operation. Returns the displaced release, to chain.
   */
  #displace(session: McpSession, key: string): (() => void) | undefined {
    const displaced = session.pending.get(key);
    if (!displaced) return undefined;
    session.pending.delete(key);
    chargeOnce(displaced);
    displaced.op.finish({ outcome: 'protocol_error', error: DUPLICATE_REQUEST_ID });
    return displaced.release;
  }
}
