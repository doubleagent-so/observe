/**
 * The recorder: adapters and custom integrations call it at protocol boundaries. It never throws into, delays or
 * changes the host's work. Events are buffered (bounded), batched, and retried with the same event IDs, so the
 * server deduplicates retries. Composition only: `Delivery` sends, `createOperationHandle` builds events and
 * `SubjectHasher` hashes authenticated subjects.
 */
import type { MessageInput } from './content.ts';
import type {
  A2aBlock,
  Access,
  AuthenticatedEvidence,
  CounterpartyEvidence,
  CustomBlock,
  DelegationEvidence,
  Direction,
  Kind,
  McpBlock,
  Outcome,
  Protocol,
  TaskState,
} from './contract.ts';
import { Delivery } from './delivery.ts';
import { defaultLog, failureReason, guardLog, type Log } from './http.ts';
import { protocolOf, type ChargeInput, type CostInput, type MoneyLinks, type TransactionInput } from './money.ts';
import { createOperationHandle, recordTransaction, type OperationDependencies } from './operation.ts';
import { SubjectHasher } from './subject-hasher.ts';
import { trimTrailing } from './text.ts';

/** The host's authenticated principal; `subject` is hashed (HMAC-SHA256, see `subjectKey`) before it leaves the process. */
export type AuthenticatedInput = Omit<AuthenticatedEvidence, 'subject_hash'> & { subject: string };

/**
 * The grant the caller acts under. `principal` (the person or account the agent acts for) and `grant_id` are raw and
 * hashed before they leave the process, like `authenticated.subject`: the principal with the subject formula and the
 * grant's issuer (so it matches that issuer's authenticated subjects), the grant id as `grant:v1`.
 */
export type DelegationInput = Omit<DelegationEvidence, 'principal_hash' | 'grant_id_hash'> & { principal?: string; grant_id?: string };

export type CounterpartyInput = Omit<CounterpartyEvidence, 'authenticated' | 'delegation'> & {
  authenticated?: AuthenticatedInput;
  delegation?: DelegationInput;
};

export interface StartInput {
  protocol: Protocol;
  direction: Direction;
  method: string;
  kind: Kind;
  target?: string;
  conversationRef?: string;
  taskRef?: string;
  counterparty?: CounterpartyInput;
  requestBytes?: number;
  a2a?: A2aBlock;
  mcp?: McpBlock;
  custom?: CustomBlock;
  /** Epoch ms when the operation began, for adapters that learn its conversation only later. Default: now. */
  startedAt?: number;
  /** What the operation does: `read`, `write` or `destructive`. */
  access?: Access;
  /** The scopes the operation needs. */
  scopeRequired?: string[];
}

export interface FinishInput {
  outcome: Outcome;
  error?: { nativeCode: string; code: string };
  responseBytes?: number;
  streamEvents?: number;
  firstByteMs?: number;
  /** What the response says (A2A: `extensions_activated`); sent on the finished event. */
  a2a?: A2aBlock;
  /** A 403 `insufficient_scope` challenge: the scopes the server asked for (see `parseInsufficientScope`). */
  insufficientScope?: { required: string[] };
}

/** A conversation the response reports (an agent-assigned A2A `contextId`) when the request carried none. */
export interface ConversationInput {
  conversationRef?: string;
}

export interface TaskStateInput extends ConversationInput {
  taskRef: string;
  state: TaskState;
  nativeState: string;
  reason?: string;
}

export interface AbandonInput {
  protocol: Protocol;
  direction: Direction;
  state: 'canceled' | 'failed';
  reason: string;
  conversationRef?: string;
}

export interface OperationHandle {
  readonly operationId: string;
  message(input: MessageInput & ConversationInput): void;
  taskState(input: TaskStateInput): void;
  /** A cost of serving this operation (model, tool, outbound agent, compute); at most 16 are recorded per operation. */
  cost(input: CostInput): void;
  /** Money the counterparty paid for this operation; returns the transaction ID ('' when dropped). */
  charge(input: ChargeInput): string;
  finish(input: FinishInput): void;
}

export interface RecorderStats {
  buffered: number;
  dropped: number;
  sent: number;
  rejected: number;
  disabled: boolean;
}

export interface Recorder {
  startOperation(input: StartInput): OperationHandle;
  /** Ends a task the agent is giving up on (shutdown, timeout, operator cancel) with a reason. */
  abandonTask(taskRef: string, input: AbandonInput): void;
  /**
   * Records a transaction outside any request (a settlement, a refund); needs `taskRef` or `operationId` and opens no
   * operation. Returns the transaction ID ('' when dropped).
   */
  transaction(input: TransactionInput): string;
  /**
   * Sends what is buffered (one attempt per batch). After a failure or a `Retry-After` it does nothing until the backoff
   * ends, unless `force` is set. Never rejects.
   */
  flush(options?: FlushOptions): Promise<void>;
  /** Flushes (forced), stops the timer and ignores later events. */
  shutdown(): Promise<void>;
  stats(): RecorderStats;
}

export interface FlushOptions {
  /** Send now even while backing off after a failure or a `Retry-After`. Default false; `shutdown()` forces. */
  force?: boolean;
}

export interface RecorderOptions {
  key: string;
  /**
   * Secret for hashing authenticated subjects, delegation principals and grant ids (HMAC-SHA256). Default: `key`, which is one per source. Rotating the agent
   * key changes every subject hash unless a stable `subjectKey` is set. Keep it secret: with it, hashes can be matched
   * against guessed subjects.
   */
  subjectKey?: string;
  /** Default `https://api.doubleagent.so`. Must be `https://`; `http://` only for `localhost`, `127.0.0.1` and `[::1]`. */
  endpoint?: string;
  /** Reported to the source, e.g. `a2a-js@0.1.0`; default `custom`. */
  adapter?: string;
  /** Send message content (the server still drops it unless the source captures content). Default true. */
  content?: boolean;
  redact?: (message: MessageInput) => MessageInput;
  maxBufferEvents?: number;
  /** Background flush interval; 0 disables the timer (call flush yourself, e.g. in waitUntil). Default 2000. */
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** The handle for an operation that could not start: every method does nothing. Not exported from the package root. */
export const NOOP_OPERATION: OperationHandle = Object.freeze({
  operationId: '',
  message() {},
  taskState() {},
  cost() {},
  charge: () => '',
  finish() {},
});

const DEFAULT_ENDPOINT = 'https://api.doubleagent.so';

/** Hosts where plain `http://` is allowed: the key never leaves the machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The ingest URL for an endpoint, or undefined for anything but `https://` (or `http://` on loopback), so the bearer
 * key is never sent in clear text. The recorder then disables itself rather than throw into the host's startup.
 */
function ingestUrl(endpoint: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return undefined;
  }
  const isSecure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  return isSecure ? `${trimTrailing(endpoint, '/')}/v1/agent-events` : undefined;
}

/**
 * The background flush timer, or undefined. Workers forbid timers in the global scope, so a recorder created there
 * runs without one (the host flushes, e.g. in `waitUntil`) instead of failing the Worker's startup.
 */
function startTimer(interval: number, delivery: Delivery, log: Log): ReturnType<typeof setInterval> | undefined {
  if (interval <= 0) return undefined;
  try {
    const started = setInterval(() => void delivery.flush(false), interval);
    (started as { unref?: () => void }).unref?.();
    return started;
  } catch (error) {
    log('agent_telemetry_timer_unavailable', { reason: failureReason(error) });
    return undefined;
  }
}

export function createRecorder(options: RecorderOptions): Recorder {
  const now = options.now ?? Date.now;
  /** Every internal log goes through here, so a host logger that throws never reaches the host's own code. */
  const log = guardLog(options.log ?? defaultLog);
  const url = ingestUrl(options.endpoint ?? DEFAULT_ENDPOINT);
  const delivery = new Delivery({
    url: url ?? '',
    key: options.key,
    adapter: options.adapter ?? 'custom',
    // Called without a receiver: Workers' fetch throws "Illegal invocation" when called as a method.
    fetcher: options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    now,
    maxBuffer: options.maxBufferEvents ?? 5_000,
    timeoutMs: options.requestTimeoutMs ?? 10_000,
    log,
  });
  // Same shape as a refused key: nothing is ever sent, so the key never travels in clear text.
  if (!url) delivery.disable('insecure_endpoint');
  const dependencies: OperationDependencies = {
    delivery,
    // `||`, not `??`: an empty subject key (an unset secret) falls back to the agent key too.
    hasher: new SubjectHasher(options.subjectKey || options.key),
    now,
    // Product decision (2026-10-02): content capture stays on by default; `content: false` turns it off.
    sendContent: options.content ?? true,
    ...(options.redact ? { redact: options.redact } : {}),
    log,
  };
  const timer = delivery.isDisabled ? undefined : startTimer(options.flushIntervalMs ?? 2000, delivery, log);
  const startOperation = (input: StartInput): OperationHandle => createOperationHandle(input, dependencies);

  return {
    startOperation(input) {
      try {
        return startOperation(input);
      } catch (error) {
        log('agent_telemetry_event_failed', { reason: failureReason(error) });
        return NOOP_OPERATION;
      }
    },
    abandonTask(taskRef, input) {
      try {
        const op = startOperation({
          protocol: input.protocol,
          direction: input.direction,
          method: 'task/abandon',
          kind: 'management',
          taskRef,
          conversationRef: input.conversationRef,
        });
        op.taskState({ taskRef, state: input.state, nativeState: 'abandoned', reason: input.reason });
        op.finish({ outcome: 'ok' });
      } catch (error) {
        log('agent_telemetry_event_failed', { reason: failureReason(error) });
      }
    },
    transaction(input) {
      try {
        const links: MoneyLinks = {
          protocol: protocolOf(input.protocol),
          direction: input.direction ?? 'inbound',
          operationId: input.operationId,
          taskRef: input.taskRef,
          conversationRef: input.conversationRef,
        };
        return recordTransaction(delivery, links, input, input.occurredAt ?? now());
      } catch (error) {
        log('agent_telemetry_event_failed', { reason: failureReason(error) });
        return '';
      }
    },
    flush: ({ force = false } = {}) => delivery.flush(force, true),
    async shutdown() {
      if (timer) clearInterval(timer);
      await delivery.shutdown();
    },
    stats: () => delivery.stats(),
  };
}
