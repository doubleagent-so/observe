/**
 * Internal: the handle for one recorded operation. It builds the operation's events (started, messages, task states,
 * money, finished) and hands them to delivery, which validates each at capture. Never throws into the host.
 */
import { buildContent, summarizeParts, type MessageInput } from './content.ts';
import { LIMITS, type AgentEvent } from './contract.ts';
import type { Delivery } from './delivery.ts';
import { failureReason, type Log } from './http.ts';
import { costEvent, transactionEvent, type ChargeInput, type CostInput, type MoneyLinks, type TransactionInput } from './money.ts';
import { normalizeText } from './patterns.ts';
import type { ConversationInput, FinishInput, OperationHandle, StartInput, TaskStateInput } from './recorder.ts';
import type { SubjectHasher } from './subject-hasher.ts';
import { ulid } from './ulid.ts';

export interface OperationDependencies {
  delivery: Delivery;
  hasher: SubjectHasher;
  now: () => number;
  /** Send message content (the server still drops it unless the source captures content). */
  sendContent: boolean;
  redact?: (message: MessageInput) => MessageInput;
  /** Already guarded: it never throws. */
  log: Log;
}

const iso = (ms: number): string => new Date(ms).toISOString();
/** Stands in for the subject hash while an event is validated at capture; never sent. */
const PLACEHOLDER_HASH = '0'.repeat(64);
const withReason = (reason: string | undefined): { reason?: string } => (reason ? { reason } : {});

/**
 * An adapter's start time when the validator would accept it (not in the future, not older than `LIMITS.pastMs`);
 * otherwise now. A wrong clock never costs the event.
 */
function startTime(startedAt: number | undefined, at: number): number {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return at;
  return startedAt <= at && startedAt >= at - LIMITS.pastMs ? startedAt : at;
}

/** Records a transaction; returns its ID, or '' when it was dropped. */
export function recordTransaction(
  delivery: Delivery,
  links: MoneyLinks,
  input: ChargeInput & { kind: TransactionInput['kind'] },
  at: number,
): string {
  const transactionId = input.transactionId ?? ulid(at);
  return delivery.push(() => transactionEvent(links, { ...input, transactionId }, at)) ? transactionId : '';
}

/** The `operation.started` event, deferred when the counterparty's subject must be hashed in the flush that sends it. */
function startedEvent(input: StartInput, envelope: Record<string, unknown>, hasher: SubjectHasher) {
  const { authenticated, ...declared } = input.counterparty ?? {};
  const event = {
    ...envelope,
    type: 'operation.started',
    method: input.method,
    kind: input.kind,
    ...(input.target ? { target: input.target } : {}),
    counterparty: declared,
    ...(input.requestBytes !== undefined ? { request_bytes: input.requestBytes } : {}),
    ...(input.a2a ? { a2a: input.a2a } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.custom ? { custom: input.custom } : {}),
  } as AgentEvent;
  if (!authenticated) return event;
  // Validated at capture with a placeholder hash; only the real hash waits for the flush.
  const { issuer, subject } = authenticated;
  return {
    probe: { ...event, counterparty: { ...declared, authenticated: { issuer, subject_hash: PLACEHOLDER_HASH } } } as AgentEvent,
    complete: async () =>
      ({
        ...event,
        counterparty: { ...declared, authenticated: { issuer, subject_hash: await hasher.hash(issuer, subject) } },
      }) as AgentEvent,
  };
}

/** The `operation.finished` event's own fields. */
const finishedFields = (result: FinishInput, startedAt: number, at: number) => ({
  type: 'operation.finished' as const,
  outcome: result.outcome,
  started_at: iso(startedAt),
  duration_ms: Math.max(0, at - startedAt),
  ...(result.firstByteMs !== undefined ? { first_byte_ms: result.firstByteMs } : {}),
  ...(result.streamEvents !== undefined ? { stream_events: result.streamEvents } : {}),
  ...(result.responseBytes !== undefined ? { response_bytes: result.responseBytes } : {}),
  ...(result.error ? { error: { native_code: result.error.nativeCode, code: result.error.code } } : {}),
  ...(result.a2a ? { a2a: result.a2a } : {}),
});

/** One recorded operation: its identity, counters and the events it builds. Wrapped by a plain-object handle. */
class Operation {
  readonly operationId: string;
  readonly #input: StartInput;
  readonly #dependencies: OperationDependencies;
  readonly #startedAt: number;
  readonly #isStarted: boolean;
  readonly #links: MoneyLinks;
  #isFinished = false;
  #costs = 0;
  #isOverCap = false;

  constructor(input: StartInput, dependencies: OperationDependencies) {
    const { delivery, now } = dependencies;
    this.#input = input;
    this.#dependencies = dependencies;
    this.operationId = ulid(now());
    this.#startedAt = startTime(input.startedAt, now());
    this.#links = {
      protocol: input.protocol,
      direction: input.direction,
      operationId: this.operationId,
      conversationRef: input.conversationRef,
      taskRef: input.taskRef,
    };
    this.#isStarted = delivery.push(() => startedEvent(input, this.#envelope('operation.started', this.#startedAt), dependencies.hasher));
  }

  message(message: MessageInput & ConversationInput): void {
    const at = this.#dependencies.now();
    const { visible, withContent } = this.#visibleMessage(message);
    this.#dependencies.delivery.push(() => ({
      ...this.#envelope('message.observed', at, message),
      type: 'message.observed',
      message_id: message.messageId ?? ulid(at),
      role: message.role,
      artifact: message.artifact ?? false,
      parts: summarizeParts(message.parts),
      ...(withContent ? { content: buildContent(visible.parts) } : {}),
    }));
  }

  taskState(task: TaskStateInput): void {
    const at = this.#dependencies.now();
    this.#dependencies.delivery.push(() => ({
      ...this.#envelope('task.state_changed', at, task),
      type: 'task.state_changed',
      task_ref: task.taskRef,
      state: task.state,
      native_state: normalizeText(task.nativeState, LIMITS.nativeState) ?? 'unknown',
      ...withReason(normalizeText(task.reason, LIMITS.reason)),
    }));
  }

  cost(cost: CostInput): void {
    const { delivery, log, now } = this.#dependencies;
    try {
      if (this.#costs >= LIMITS.costsPerOperation) {
        // Logged once per operation; every further cost is counted as dropped and reported with the next batch.
        if (!this.#isOverCap) log('agent_telemetry_cost_limit', { operation: this.operationId, limit: LIMITS.costsPerOperation });
        this.#isOverCap = true;
        delivery.drop();
        return;
      }
      if (delivery.push(() => costEvent({ ...this.#links, taskRef: cost.taskRef ?? this.#input.taskRef }, cost, now()))) this.#costs++;
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
    }
  }

  charge(charge: ChargeInput): string {
    const { delivery, log, now } = this.#dependencies;
    try {
      const links = { ...this.#links, taskRef: charge.taskRef ?? this.#input.taskRef };
      return recordTransaction(delivery, links, { ...charge, kind: charge.kind ?? 'charge' }, now());
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return '';
    }
  }

  finish(result: FinishInput): void {
    if (this.#isFinished) return;
    this.#isFinished = true;
    const { delivery, now } = this.#dependencies;
    if (!this.#isStarted) {
      delivery.dropOrphan();
      return;
    }
    const at = now();
    delivery.push(() => ({ ...this.#envelope('operation.finished', at), ...finishedFields(result, this.#startedAt, at) }) as AgentEvent);
  }

  #envelope(type: AgentEvent['type'], at: number, observed: ConversationInput = {}) {
    const input = this.#input;
    return {
      schema_version: 1 as const,
      event_id: ulid(at),
      type,
      occurred_at: iso(at),
      protocol: input.protocol,
      direction: input.direction,
      operation_id: this.operationId,
      ...(input.conversationRef ? { conversation_ref: input.conversationRef } : {}),
      ...(observed.conversationRef ? { conversation_ref: observed.conversationRef } : {}),
      ...(input.taskRef ? { task_ref: input.taskRef } : {}),
    };
  }

  /** The message as sent: redacted when a `redact` is set; without content when redaction fails or is turned off. */
  #visibleMessage(message: MessageInput): { visible: MessageInput; withContent: boolean } {
    const { sendContent, redact, log } = this.#dependencies;
    if (!sendContent || !redact) return { visible: message, withContent: sendContent };
    try {
      return { visible: redact(message), withContent: true };
    } catch (error) {
      log('agent_telemetry_redact_failed', { reason: failureReason(error) });
      return { visible: message, withContent: false };
    }
  }
}

/**
 * Starts an operation (records its `operation.started` event) and returns its handle: a plain object, so hosts can
 * spread or wrap it, whose methods delegate to the operation.
 */
export function createOperationHandle(input: StartInput, dependencies: OperationDependencies): OperationHandle {
  const operation = new Operation(input, dependencies);
  return {
    operationId: operation.operationId,
    message: (message) => operation.message(message),
    taskState: (task) => operation.taskState(task),
    cost: (cost) => operation.cost(cost),
    charge: (charge) => operation.charge(charge),
    finish: (result) => operation.finish(result),
  };
}
