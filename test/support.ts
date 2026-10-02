/** Shared helpers for the MCP tests: a capturing recorder and event lookups. */
import { expect } from 'vitest';
import {
  createRecorder,
  validateBatch,
  type AgentEvent,
  type EventBatch,
  type MessageObserved,
  type OperationFinished,
  type OperationStarted,
  type Recorder,
  type TaskStateChanged,
} from '../src/index';

export interface Capture {
  recorder: Recorder;
  batches: EventBatch[];
  logs: string[];
  events(): AgentEvent[];
  /** A `waitUntil` that remembers the work, for `settle`. */
  schedule(promise: Promise<unknown>): void;
  /** Waits for scheduled work, flushes and returns every event sent. */
  settle(): Promise<AgentEvent[]>;
}

export function capture(): Capture {
  const batches: EventBatch[] = [];
  const logs: string[] = [];
  const pending: Promise<unknown>[] = [];
  const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const batch = JSON.parse(String(init.body)) as EventBatch;
    batches.push(batch);
    return Response.json({ accepted: batch.events.length, content_dropped: 0, rejected: [] }, { status: 202 });
  }) as typeof globalThis.fetch;
  const recorder = createRecorder({
    key: 'ak_test_x',
    endpoint: 'https://api.test',
    fetch,
    flushIntervalMs: 0,
    maxBufferEvents: 20_000,
    log: (event) => void logs.push(event),
  });
  const events = () => batches.flatMap((batch) => batch.events);
  return {
    recorder,
    batches,
    logs,
    events,
    schedule: (promise) => void pending.push(promise),
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
      await recorder.flush();
      return events();
    },
  };
}

export function expectValid(batches: EventBatch[]): void {
  for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
}

export const starts = (events: AgentEvent[]): OperationStarted[] =>
  events.filter((event): event is OperationStarted => event.type === 'operation.started');

/** The `nth` operation with `method` and everything recorded on it. */
export function operation(events: AgentEvent[], method: string, nth = 0) {
  const start = starts(events).filter((event) => event.method === method)[nth];
  if (!start) throw new Error(`no ${method} operation #${nth}`);
  const own = events.filter((event) => event.operation_id === start.operation_id);
  return {
    start,
    finish: own.find((event): event is OperationFinished => event.type === 'operation.finished'),
    finishes: own.filter((event) => event.type === 'operation.finished').length,
    messages: own.filter((event): event is MessageObserved => event.type === 'message.observed'),
    tasks: own.filter((event): event is TaskStateChanged => event.type === 'task.state_changed'),
  };
}

/**
 * The `subject_hash` the recorder sends: `HMAC-SHA256(subjectKey, "subject:v1\n" + issuer + "\n" + subject)` as hex.
 * `capture()` recorders use the agent key `ak_test_x` as the subject key.
 */
export async function subjectHash(issuer: string, subject: string, subjectKey = 'ak_test_x'): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(subjectKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`subject:v1\n${issuer}\n${subject}`)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
