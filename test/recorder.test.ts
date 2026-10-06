import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, LIMITS, validateBatch, type EventBatch, type RecorderOptions } from '../src/index';

const NOW = Date.UTC(2026, 9, 1, 12);
const A2A = { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' } as const;
const CUSTOM = { name: 'custom:test', version: '1', binding: 'other' } as const;

function endpoint(respond: (batch: EventBatch, call: number) => Response | Promise<Response>) {
  const batches: EventBatch[] = [];
  const inits: RequestInit[] = [];
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    urls.push(String(input));
    inits.push(init);
    const batch = JSON.parse(String(init.body)) as EventBatch;
    batches.push(batch);
    return respond(batch, batches.length);
  }) as typeof globalThis.fetch;
  return { fetch, batches, inits, urls };
}
const accepted = (batch: EventBatch) => Response.json({ accepted: batch.events.length, content_dropped: 0, rejected: [] }, { status: 202 });

function recorder(fetch: typeof globalThis.fetch, options: Partial<RecorderOptions> = {}) {
  let now = NOW;
  const logs: string[] = [];
  const instance = createRecorder({
    key: 'ak_test_x',
    endpoint: 'https://api.test/',
    fetch,
    now: () => now,
    flushIntervalMs: 0,
    log: (event) => logs.push(event),
    ...options,
  });
  return {
    instance,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('createRecorder', () => {
  it('records an operation as valid events sharing one operation ID', async () => {
    const server = endpoint(accepted);
    const { instance, advance } = recorder(server.fetch, { adapter: 'custom@1' });
    const op = instance.startOperation({
      protocol: A2A,
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      conversationRef: 'ctx-1',
      counterparty: { declared_name: 'Caller', authenticated: { issuer: 'https://idp', subject: 'user-42' } },
    });
    op.message({ role: 'caller', parts: [{ kind: 'text', text: 'find flights' }] });
    op.taskState({ taskRef: 't-1', state: 'working', nativeState: 'TASK_STATE_WORKING' });
    advance(25);
    op.finish({ outcome: 'ok', responseBytes: 10 });
    op.finish({ outcome: 'protocol_error' });
    await instance.flush();
    expect(server.urls).toEqual(['https://api.test/v1/agent-events']);
    expect(new Headers(server.inits[0].headers).get('authorization')).toBe('Bearer ak_test_x');
    const [batch] = server.batches;
    expect(batch.adapter).toBe('custom@1');
    expect(batch.events.map((event) => event.type)).toEqual([
      'operation.started',
      'message.observed',
      'task.state_changed',
      'operation.finished',
    ]);
    expect(new Set(batch.events.map((event) => event.operation_id)).size).toBe(1);
    expect(validateBatch(batch, NOW)).toMatchObject({ ok: true, rejected: [] });
    const started = batch.events[0];
    expect(started.type === 'operation.started' && started.counterparty.authenticated?.subject_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(batch)).not.toContain('user-42');
    const finished = batch.events[3];
    expect(finished.type === 'operation.finished' && finished.duration_ms).toBe(25);
    expect(instance.stats()).toMatchObject({ sent: 4, buffered: 0, dropped: 0 });
  });

  it('sends content unless disabled, after redaction; a failing redact sends no content', async () => {
    const server = endpoint(accepted);
    const redacted = recorder(server.fetch, { redact: (message) => ({ ...message, parts: [{ kind: 'text', text: '[redacted]' }] }) });
    redacted.instance
      .startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' })
      .message({ role: 'caller', parts: [{ kind: 'text', text: 'secret' }] });
    await redacted.instance.flush();
    const message = server.batches[0].events[1];
    expect(message.type === 'message.observed' && message.content?.parts).toEqual([{ kind: 'text', text: '[redacted]', truncated: false }]);
    const failing = recorder(server.fetch, {
      redact: () => {
        throw new Error('boom');
      },
    });
    failing.instance
      .startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' })
      .message({ role: 'caller', parts: [{ kind: 'text', text: 'secret' }] });
    await failing.instance.flush();
    expect(failing.logs).toContain('agent_telemetry_redact_failed');
    const withoutContent = server.batches[1].events[1];
    expect(withoutContent.type === 'message.observed' && withoutContent.content).toBeUndefined();
    expect(withoutContent.type === 'message.observed' && withoutContent.parts).toEqual([{ kind: 'text', bytes: 6 }]);
    const off = recorder(server.fetch, { content: false });
    off.instance
      .startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' })
      .message({ role: 'caller', parts: [{ kind: 'text', text: 'secret' }] });
    await off.instance.flush();
    expect(JSON.stringify(server.batches[2])).not.toContain('secret');
  });

  it('sends message content by default (product decision 2026-10-02)', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    instance
      .startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' })
      .message({ role: 'caller', parts: [{ kind: 'text', text: 'find flights' }] });
    await instance.flush();
    const message = server.batches[0].events[1];
    expect(message.type === 'message.observed' && message.content?.parts).toEqual([
      { kind: 'text', text: 'find flights', truncated: false },
    ]);
  });

  it('splits batches at 100 events', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    for (let index = 0; index < 60; index++)
      instance.startOperation({ protocol: A2A, direction: 'outbound', method: 'GetTask', kind: 'management' }).finish({ outcome: 'ok' });
    await instance.flush();
    expect(server.batches.map((batch) => batch.events.length)).toEqual([100, 20]);
  });

  it('keeps events after a server error and resends the same event IDs', async () => {
    const server = endpoint((batch, call) => (call === 1 ? new Response('down', { status: 503 }) : accepted(batch)));
    const { instance, advance } = recorder(server.fetch);
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' }).finish({ outcome: 'ok' });
    await instance.flush();
    expect(instance.stats()).toMatchObject({ buffered: 2, sent: 0 });
    advance(1000);
    await instance.flush();
    expect(server.batches[1].events.map((event) => event.event_id)).toEqual(server.batches[0].events.map((event) => event.event_id));
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 2 });
  });

  it('honours Retry-After on the timer and on flush; only a forced flush sends early', async () => {
    vi.useFakeTimers();
    const server = endpoint((batch, call) =>
      call === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }) : accepted(batch),
    );
    const instance = createRecorder({
      key: 'ak_test_x',
      endpoint: 'https://api.test',
      fetch: server.fetch,
      flushIntervalMs: 1000,
      log: () => {},
    });
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' }).finish({ outcome: 'ok' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.batches).toHaveLength(1);
    await instance.flush();
    expect(server.batches).toHaveLength(1);
    await instance.flush({ force: true });
    expect(server.batches).toHaveLength(2);
    await instance.shutdown();
  });

  it('backs off after a failure: an unforced flush skips a long backoff, shutdown forces the last attempt', async () => {
    const server = endpoint((batch, call) =>
      call === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }) : accepted(batch),
    );
    const { instance, advance } = recorder(server.fetch);
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' }).finish({ outcome: 'ok' });
    await instance.flush();
    await instance.flush();
    expect(server.batches).toHaveLength(1);
    advance(30_000);
    await instance.flush();
    expect(server.batches).toHaveLength(2);
    const failing = endpoint(() => new Response('down', { status: 503 }));
    const second = recorder(failing.fetch);
    second.instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await second.instance.flush();
    await second.instance.shutdown();
    expect(failing.batches.length).toBeGreaterThan(1);
  });

  it('waits out a short backoff (5 s or less) on an unforced flush, then makes one attempt', async () => {
    const server = endpoint((batch, call) => (call === 1 ? new Response('down', { status: 503 }) : accepted(batch)));
    let now = NOW;
    const instance = createRecorder({
      key: 'ak_test_x',
      endpoint: 'https://api.test',
      fetch: server.fetch,
      flushIntervalMs: 0,
      log: () => {},
      now: () => now,
    });
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    const sleep = vi.spyOn(globalThis, 'setTimeout');
    try {
      const flushed = instance.flush();
      // The clock moves while the flush sleeps, as a real one would.
      now += 1000;
      await flushed;
      expect(sleep.mock.calls.some(([, ms]) => typeof ms === 'number' && ms > 0 && ms <= 1000)).toBe(true);
    } finally {
      sleep.mockRestore();
    }
    expect(server.batches).toHaveLength(2);
    expect(instance.stats()).toMatchObject({ sent: 1, buffered: 0 });
  });

  it('reads Retry-After as seconds or an HTTP date, capped at 5 minutes', async () => {
    const answers = [
      new Response('', { status: 429, headers: { 'retry-after': new Date(NOW + 20_000).toUTCString() } }),
      new Response('', { status: 429, headers: { 'retry-after': '86400' } }),
    ];
    const server = endpoint((batch, call) => answers[call - 1] ?? accepted(batch));
    const { instance, advance } = recorder(server.fetch);
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    advance(14_000);
    await instance.flush();
    expect(server.batches).toHaveLength(1);
    advance(6_000);
    await instance.flush();
    expect(server.batches).toHaveLength(2);
    advance(294_000);
    await instance.flush();
    expect(server.batches).toHaveLength(2);
    advance(6_000);
    await instance.flush();
    expect(server.batches).toHaveLength(3);
  });

  it('stops for good on 401 and 410, logging once', async () => {
    const server = endpoint(() => new Response('no', { status: 401 }));
    const { instance, logs } = recorder(server.fetch);
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    expect(server.batches).toHaveLength(1);
    expect(instance.stats()).toMatchObject({ disabled: true, buffered: 0 });
    expect(logs.filter((event) => event === 'agent_telemetry_disabled')).toHaveLength(1);
  });

  it('drops a refused batch and keeps going', async () => {
    const server = endpoint((batch, call) => (call === 1 ? new Response('bad', { status: 400 }) : accepted(batch)));
    const { instance, logs } = recorder(server.fetch);
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    expect(server.batches).toHaveLength(2);
    expect(logs).toContain('agent_telemetry_batch_refused');
  });

  it('drops the oldest events on overflow and reports the count once', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch, { maxBufferEvents: 3 });
    for (let index = 0; index < 3; index++)
      instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' }).finish({ outcome: 'ok' });
    expect(instance.stats().dropped).toBe(3);
    await instance.flush();
    expect(server.batches[0]).toMatchObject({ dropped: 3 });
    expect(server.batches[0].events).toHaveLength(3);
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    expect(server.batches[1].dropped).toBe(0);
  });

  it('never throws into the host: network failures, timeouts and bad input are swallowed', async () => {
    const hanging = (async (_input: RequestInfo | URL, init: RequestInit = {}) =>
      await new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )) as typeof globalThis.fetch;
    const { instance } = recorder(hanging, { requestTimeoutMs: 20 });
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' }).finish({ outcome: 'ok' });
    await expect(instance.flush()).resolves.toBeUndefined();
    expect(instance.stats().buffered).toBe(2);
    const throwing = recorder((async () => {
      throw new TypeError('offline');
    }) as typeof globalThis.fetch);
    throwing.instance.startOperation({
      protocol: A2A,
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      counterparty: { authenticated: { issuer: 'i', subject: 's' } },
    });
    await expect(throwing.instance.flush()).resolves.toBeUndefined();
  });

  it('flushes on shutdown and ignores later events', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch, { flushIntervalMs: 50 });
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.shutdown();
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    await instance.flush();
    expect(server.batches).toHaveLength(1);
    await instance.shutdown();
  });

  it('counts events recorded after shutdown as dropped and logs it once', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    await instance.shutdown();
    instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' }).finish({ outcome: 'ok' });
    expect(instance.stats().dropped).toBe(2);
    expect(logs.filter((event) => event === 'agent_telemetry_dropped_after_shutdown')).toHaveLength(1);
  });

  it('uses an explicit start time for the started event and the duration', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = instance.startOperation({
      protocol: A2A,
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      startedAt: NOW - 5_000,
    });
    op.finish({ outcome: 'ok' });
    await instance.flush();
    const [started, finished] = server.batches[0].events;
    expect(started.occurred_at).toBe(new Date(NOW - 5_000).toISOString());
    expect(finished).toMatchObject({ started_at: new Date(NOW - 5_000).toISOString() });
    expect(finished.type === 'operation.finished' && finished.duration_ms).toBeGreaterThanOrEqual(5_000);
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });

  it('falls back to now when the start time is in the future or older than the validator accepts', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    for (const startedAt of [NOW + 1, NOW - LIMITS.pastMs - 1])
      instance
        .startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message', startedAt })
        .finish({ outcome: 'ok' });
    instance.startOperation({
      protocol: A2A,
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      startedAt: NOW - LIMITS.pastMs,
    });
    await instance.flush();
    const started = server.batches[0].events.filter((event) => event.type === 'operation.started');
    expect(started.map((event) => event.occurred_at)).toEqual([
      new Date(NOW).toISOString(),
      new Date(NOW).toISOString(),
      new Date(NOW - LIMITS.pastMs).toISOString(),
    ]);
  });

  it('falls back to now when the start time is not a finite number', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    instance
      .startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message', startedAt: Number.NaN })
      .finish({ outcome: 'ok' });
    await instance.flush();
    const [started, finished] = server.batches[0].events;
    expect(started.occurred_at).toBe(new Date(NOW).toISOString());
    expect(finished).toMatchObject({ started_at: new Date(NOW).toISOString(), duration_ms: 0 });
  });
});

describe('server-assigned conversations', () => {
  it('carries a conversation learnt from the response on the message and task events that report it', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' });
    op.message({ role: 'caller', parts: [{ kind: 'text', text: 'hi' }] });
    op.taskState({ taskRef: 't-1', state: 'completed', nativeState: 'TASK_STATE_COMPLETED', conversationRef: 'ctx-new' });
    op.message({ role: 'agent', parts: [{ kind: 'text', text: 'done' }], conversationRef: 'ctx-new' });
    op.finish({ outcome: 'ok' });
    await instance.flush();
    const events = server.batches[0].events;
    expect(events.map((event) => event.conversation_ref)).toEqual([undefined, undefined, 'ctx-new', 'ctx-new', undefined]);
    expect(events[3]).not.toHaveProperty('content.conversationRef');
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });
});

describe('protocol blocks on finish', () => {
  it('carries a block learnt from the response (activated extensions) on the finished event only', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = instance.startOperation({
      protocol: A2A,
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      a2a: { extensions_requested: ['https://ext.test/a'] },
    });
    op.finish({ outcome: 'ok', a2a: { extensions_activated: ['https://ext.test/a'] } });
    await instance.flush();
    const [started, finished] = server.batches[0].events;
    expect(started).toMatchObject({ a2a: { extensions_requested: ['https://ext.test/a'] } });
    expect(finished).toMatchObject({ type: 'operation.finished', a2a: { extensions_activated: ['https://ext.test/a'] } });
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });
});

describe('abandonTask', () => {
  it('abandons a task with a management operation and a terminal state carrying the reason', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    instance.abandonTask('task-9', {
      protocol: A2A,
      direction: 'inbound',
      state: 'canceled',
      reason: 'shutdown',
      conversationRef: 'ctx-9',
    });
    await instance.flush();
    const events = server.batches[0].events;
    expect(events.map((event) => event.type)).toEqual(['operation.started', 'task.state_changed', 'operation.finished']);
    expect(events[0]).toMatchObject({ method: 'task/abandon', kind: 'management', conversation_ref: 'ctx-9', task_ref: 'task-9' });
    expect(events[1]).toMatchObject({ task_ref: 'task-9', state: 'canceled', native_state: 'abandoned', reason: 'shutdown' });
    expect(events[2]).toMatchObject({ outcome: 'ok' });
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });

  it('cleans a reason and a native state the validator would reject', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    instance.abandonTask('task-9', { protocol: A2A, direction: 'inbound', state: 'failed', reason: `timed\nout\u0000${'x'.repeat(200)}` });
    instance
      .startOperation({ protocol: A2A, direction: 'inbound', method: 'GetTask', kind: 'management' })
      .taskState({ taskRef: 'task-9', state: 'working', nativeState: 'working\r\n', reason: '\n' });
    await instance.flush();
    const states = server.batches[0].events.filter((event) => event.type === 'task.state_changed');
    expect(states[0]).toMatchObject({ native_state: 'abandoned', reason: `timedout${'x'.repeat(120)}` });
    expect(states[1]).toMatchObject({ native_state: 'working' });
    expect(states[1]).not.toHaveProperty('reason');
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });
});

describe('validation at capture', () => {
  const start = { protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' } as const;

  it('drops and logs an event the server would reject, and sends the rest', async () => {
    const server = endpoint(accepted);
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const { instance } = recorder(server.fetch, { log: (event, fields) => lines.push({ event, ...(fields ? { fields } : {}) }) });
    // The started event is invalid, so its finish is dropped with it.
    instance.startOperation({ ...start, target: 'bad\ntarget' }).finish({ outcome: 'ok' });
    instance.startOperation({ ...start, counterparty: { authenticated: { issuer: 'idp\n', subject: 'user-1' } } });
    instance.startOperation(start).message({ role: 'caller', parts: [], messageId: 'has spaces' });
    await instance.flush();
    const events = server.batches[0].events;
    expect(events.map((event) => event.type)).toEqual(['operation.started']);
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
    // Logged once per rejection code.
    expect(lines.filter((line) => line.event === 'agent_telemetry_invalid_event').map((line) => line.fields)).toEqual([
      { type: 'operation.started', code: 'invalid_field' },
      { type: 'operation.started', code: 'invalid_counterparty' },
    ]);
    expect(instance.stats().dropped).toBe(4);
    expect(server.batches[0].dropped).toBe(4);
  });
});

describe('createRecorder edge cases', () => {
  const start = { protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' } as const;

  it('carries every optional field', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = instance.startOperation({
      ...start,
      protocol: CUSTOM,
      target: 'agent-b',
      taskRef: 't-9',
      requestBytes: 12,
      custom: { region: 'eu', retries: 2, cached: false },
      counterparty: { declared_name: 'Anonymous' },
    });
    op.message({ role: 'agent', messageId: 'm-1', artifact: true, parts: [{ kind: 'file', name: 'a.pdf', bytes: 3 }] });
    op.finish({
      outcome: 'tool_error',
      error: { nativeCode: '-32000', code: 'tool_failed' },
      responseBytes: 5,
      streamEvents: 3,
      firstByteMs: 7,
    });
    instance.startOperation({ ...start, a2a: { message_id: 'm-0' } });
    instance.startOperation({
      ...start,
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'streamable-http' },
      mcp: { request_id: '1' },
    });
    await instance.flush();
    const [started, message, finished, a2a, mcp] = server.batches[0].events;
    expect(a2a).toMatchObject({ a2a: { message_id: 'm-0' } });
    expect(mcp).toMatchObject({ mcp: { request_id: '1' } });
    expect(started).toMatchObject({ target: 'agent-b', task_ref: 't-9', request_bytes: 12, custom: { region: 'eu' } });
    expect(started).toMatchObject({ counterparty: { declared_name: 'Anonymous' } });
    expect(message).toMatchObject({ message_id: 'm-1', artifact: true });
    expect(finished).toMatchObject({ first_byte_ms: 7, stream_events: 3, response_bytes: 5 });
    expect(finished).toMatchObject({ error: { native_code: '-32000', code: 'tool_failed' } });
  });

  it('disables itself, never sending the key, for an endpoint that would send it in clear text', async () => {
    for (const url of ['http://api.doubleagent.so', 'http://localhost.evil.test', 'http://10.0.0.1:8787', 'ftp://api.test', 'not a url']) {
      const server = endpoint(accepted);
      const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
      const instance = createRecorder({
        key: 'ak_test_x',
        endpoint: url,
        fetch: server.fetch,
        flushIntervalMs: 0,
        log: (event, fields) => lines.push({ event, ...(fields ? { fields } : {}) }),
      });
      instance.startOperation(start).finish({ outcome: 'ok' });
      await instance.flush({ force: true });
      await instance.shutdown();
      expect(server.urls, url).toEqual([]);
      expect(instance.stats().disabled, url).toBe(true);
      expect(lines, url).toEqual([{ event: 'agent_telemetry_disabled', fields: { reason: 'insecure_endpoint' } }]);
    }
  });

  it('accepts https, and plain http on loopback only', async () => {
    const server = endpoint(accepted);
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:19200/', 'http://LOCALHOST', 'http://[::1]:8788', 'https://api.test']) {
      const instance = createRecorder({ key: 'ak_test_x', endpoint: url, fetch: server.fetch, flushIntervalMs: 0 });
      instance.startOperation(start);
      await instance.flush();
    }
    expect(server.urls).toEqual([
      'http://localhost:8787/v1/agent-events',
      'http://127.0.0.1:19200/v1/agent-events',
      'http://LOCALHOST/v1/agent-events',
      'http://[::1]:8788/v1/agent-events',
      'https://api.test/v1/agent-events',
    ]);
  });

  it('trims every trailing slash of the endpoint, in linear time on a long run of slashes', async () => {
    const server = endpoint(accepted);
    const slashes = '/'.repeat(100_000);
    for (const url of ['https://api.test///', `https://api.test${slashes}x`]) {
      const instance = createRecorder({ key: 'ak_test_x', endpoint: url, fetch: server.fetch, flushIntervalMs: 0 });
      instance.startOperation(start);
      await instance.flush();
    }
    const startedAt = performance.now();
    createRecorder({ key: 'ak_test_x', endpoint: `https://api.test${slashes}x`, fetch: server.fetch, flushIntervalMs: 0 });
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(server.urls).toEqual(['https://api.test/v1/agent-events', `https://api.test${slashes}x/v1/agent-events`]);
  });

  it('uses global fetch and the default endpoint, and counts a malformed 202 body', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('not json', { status: 202 });
    });
    try {
      const instance = createRecorder({ key: 'ak_test_x', flushIntervalMs: 0, log: () => {} });
      instance.startOperation(start);
      await instance.flush();
      expect(calls).toEqual(['https://api.doubleagent.so/v1/agent-events']);
      expect(instance.stats()).toMatchObject({ sent: 1, buffered: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('counts rejected events from the response and falls back to the batch size', async () => {
    const server = endpoint(() => Response.json({ rejected: [{ index: 0 }] }, { status: 202 }));
    const { instance } = recorder(server.fetch);
    instance.startOperation(start);
    await instance.flush();
    expect(instance.stats()).toMatchObject({ sent: 1, rejected: 1 });
  });

  it('stops on 403 and retries 429 without Retry-After', async () => {
    const forbidden = recorder(endpoint(() => new Response('no', { status: 403 })).fetch);
    forbidden.instance.startOperation(start);
    await forbidden.instance.flush();
    expect(forbidden.instance.stats().disabled).toBe(true);
    const limited = endpoint((batch, call) => (call === 1 ? new Response('wait', { status: 429 }) : accepted(batch)));
    const { instance, advance } = recorder(limited.fetch);
    instance.startOperation(start);
    await instance.flush();
    expect(instance.stats().buffered).toBe(1);
    advance(1000);
    await instance.flush();
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 1 });
  });

  it('runs without a timer, logging once, where timers cannot be created', async () => {
    const setTimer = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
      throw new Error('Disallowed operation called within global scope');
    });
    try {
      const server = endpoint(accepted);
      const { instance, logs } = recorder(server.fetch, { flushIntervalMs: 1000 });
      instance.startOperation(start);
      await instance.flush();
      expect(server.batches).toHaveLength(1);
      expect(logs.filter((event) => event === 'agent_telemetry_timer_unavailable')).toHaveLength(1);
      await instance.shutdown();
    } finally {
      setTimer.mockRestore();
    }
  });

  it('flushes on the timer', async () => {
    vi.useFakeTimers();
    const server = endpoint(accepted);
    const instance = createRecorder({
      key: 'ak_test_x',
      endpoint: 'https://api.test',
      fetch: server.fetch,
      flushIntervalMs: 1000,
      log: () => {},
    });
    instance.startOperation(start);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.batches).toHaveLength(1);
    await instance.shutdown();
  });

  it('logs and drops an event that cannot be built', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const op = instance.startOperation(start);
    op.message({ role: 'caller', parts: null as never });
    op.message({
      role: 'caller',
      parts: [],
      get messageId(): string {
        throw 'not an Error';
      },
    });
    await instance.flush();
    expect(logs.filter((event) => event === 'agent_telemetry_event_failed')).toHaveLength(2);
    expect(server.batches[0].events.map((event) => event.type)).toEqual(['operation.started']);
  });

  it('survives events that cannot be validated or serialized', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    instance.startOperation({ ...start, protocol: CUSTOM, custom: { size: 1n } as never });
    instance.startOperation({ ...start, protocol: CUSTOM, custom: cycle as never });
    const throwing = {
      toJSON() {
        throw 'not an Error';
      },
    };
    instance.startOperation(start).message({ role: 'caller', parts: [{ kind: 'data', json: throwing }] });
    instance.startOperation(start).finish({ outcome: 'ok' });
    await expect(instance.flush()).resolves.toBeUndefined();
    // Both custom blocks are `invalid_protocol_block`: logged once, and every drop is counted.
    expect(logs.filter((event) => event === 'agent_telemetry_invalid_event')).toHaveLength(1);
    expect(logs.filter((event) => event === 'agent_telemetry_event_failed')).toHaveLength(1);
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0].events.map((event) => event.type)).toEqual(['operation.started', 'operation.started', 'operation.finished']);
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 3, dropped: 3 });
  });

  it('returns an inert handle and logs through console when the clock is invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const instance = createRecorder({
        key: 'ak_test_x',
        fetch: endpoint(accepted).fetch,
        now: () => -1,
        flushIntervalMs: 0,
      });
      const op = instance.startOperation(start);
      expect(op.operationId).toBe('');
      op.message({ role: 'caller', parts: [] });
      op.taskState({ taskRef: 't', state: 'working', nativeState: 'x' });
      op.finish({ outcome: 'ok' });
      expect(instance.stats().buffered).toBe(0);
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'agent_telemetry_event_failed', reason: 'RangeError' }));
    } finally {
      warn.mockRestore();
    }
  });

  it('splits batches before they exceed 1 MiB', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = instance.startOperation(start);
    const parts = Array.from({ length: 3 }, () => ({ kind: 'text' as const, text: 'z'.repeat(30_000) }));
    for (let index = 0; index < 12; index++) op.message({ role: 'caller', parts });
    await instance.flush();
    expect(server.batches.length).toBeGreaterThan(1);
    expect(server.batches.flatMap((batch) => batch.events)).toHaveLength(13);
    for (const batch of server.batches) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(LIMITS.batchBytes);
  });
});

describe('overlapping flushes', () => {
  const start = { protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' } as const;
  const authenticated = { ...start, counterparty: { authenticated: { issuer: 'https://idp', subject: 'user-1' } } };
  const delay = (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const tick = () => delay(1);

  /** A fetch whose responses wait until the test opens them, one gate per call. */
  function gated(respond: (batch: EventBatch, call: number) => Response) {
    const batches: EventBatch[] = [];
    const gates: Array<() => void> = [];
    const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const batch = JSON.parse(String(init.body)) as EventBatch;
      batches.push(batch);
      const call = batches.length;
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      return respond(batch, call);
    }) as typeof globalThis.fetch;
    const called = async (count: number) => {
      for (let wait = 0; gates.length < count; wait++) {
        if (wait === 200) throw new Error(`fetch was called ${gates.length} times, expected ${count}`);
        await tick();
      }
    };
    const open = async (call: number) => {
      await called(call);
      gates[call - 1]();
    };
    return { fetch, batches, called, open };
  }
  const ids = (batches: EventBatch[]) => batches.flatMap((batch) => batch.events.map((event) => event.event_id));

  it('sends its own events without waiting for a flush that is still in flight', async () => {
    const server = gated(accepted);
    const { instance } = recorder(server.fetch);
    instance.startOperation(start);
    const first = instance.flush();
    await server.called(1);
    instance.startOperation(start).finish({ outcome: 'ok' });
    const second = instance.flush();
    await server.open(2);
    await second;
    expect(server.batches.map((batch) => batch.events.length)).toEqual([1, 2]);
    expect(instance.stats()).toMatchObject({ buffered: 1, sent: 2 });
    await server.open(1);
    await first;
    expect(new Set(ids(server.batches)).size).toBe(3);
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 3 });
  });

  it('requeues a failed flush without losing or duplicating the events another flush sent', async () => {
    const server = gated((batch, call) => (call === 1 ? new Response('down', { status: 503 }) : accepted(batch)));
    const { instance, advance } = recorder(server.fetch);
    instance.startOperation(start).finish({ outcome: 'ok' });
    const first = instance.flush();
    await server.called(1);
    instance.startOperation(start);
    const second = instance.flush();
    await server.open(2);
    await second;
    await server.open(1);
    await first;
    expect(instance.stats()).toMatchObject({ buffered: 2, sent: 1 });
    advance(1000);
    const third = instance.flush();
    await server.open(3);
    await third;
    const [failed, other, retried] = server.batches;
    expect(ids([retried])).toEqual(ids([failed]));
    expect(new Set([...ids([other]), ...ids([retried])]).size).toBe(3);
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 3 });
  });

  it('keeps the buffer bounded while a flush is in flight and reports drops once', async () => {
    const server = gated((batch, call) => (call === 1 ? new Response('down', { status: 503 }) : accepted(batch)));
    const { instance, advance } = recorder(server.fetch, { maxBufferEvents: 3 });
    instance.startOperation(start).finish({ outcome: 'ok' });
    const first = instance.flush();
    await server.called(1);
    for (let index = 0; index < 3; index++) instance.startOperation(start);
    expect(instance.stats()).toMatchObject({ buffered: 3, dropped: 2 });
    const second = instance.flush();
    await server.open(2);
    await second;
    await server.open(1);
    await first;
    expect(instance.stats()).toMatchObject({ buffered: 2, dropped: 2 });
    advance(1000);
    const third = instance.flush();
    await server.open(3);
    await third;
    expect(server.batches.map((batch) => batch.dropped)).toEqual([0, 2, 0]);
  });

  it('hashes the authenticated subject in the flush that sends the event', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const sign = vi.spyOn(crypto.subtle, 'sign');
    try {
      instance.startOperation(authenticated);
      expect(sign).not.toHaveBeenCalled();
      await instance.flush();
      expect(sign).toHaveBeenCalledTimes(1);
      expect(server.batches[0].events[0]).toMatchObject({ counterparty: { authenticated: { issuer: 'https://idp' } } });
    } finally {
      sign.mockRestore();
    }
  });

  it('drops an event whose hash fails and sends the rest', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const digest = vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('no crypto'));
    try {
      instance.startOperation(authenticated);
      instance.startOperation(start);
      await instance.flush();
      expect(logs).toContain('agent_telemetry_event_failed');
      expect(server.batches[0].events).toHaveLength(1);
      expect(server.batches[0].dropped).toBe(1);
      expect(instance.stats()).toMatchObject({ buffered: 0, sent: 1, dropped: 1 });
    } finally {
      digest.mockRestore();
    }
  });

  it('keeps events when a custom fetch misbehaves', async () => {
    const { instance, logs } = recorder((async () => undefined) as unknown as typeof globalThis.fetch);
    instance.startOperation(start);
    await expect(instance.flush()).resolves.toBeUndefined();
    expect(logs).toContain('agent_telemetry_flush_failed');
    expect(instance.stats().buffered).toBe(1);
  });

  it('waits on shutdown for flushes in flight, then sends what they requeued', async () => {
    const server = gated((batch, call) => (call === 1 ? new Response('down', { status: 503 }) : accepted(batch)));
    const { instance } = recorder(server.fetch);
    instance.startOperation(start);
    const first = instance.flush();
    await server.called(1);
    let done = false;
    const shutdown = (async () => {
      await instance.shutdown();
      done = true;
    })();
    await delay(20);
    expect(done).toBe(false);
    await server.open(1);
    await first;
    await server.open(2);
    await shutdown;
    expect(ids([server.batches[1]])).toEqual(ids([server.batches[0]]));
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 1 });
  });

  it('counts events a flush puts back after shutdown gave up waiting as dropped', async () => {
    // Ignores its abort signal, so the flush outlives shutdown's deadline (requestTimeoutMs + 1 s).
    const server = gated(() => new Response('down', { status: 503 }));
    const { instance, logs } = recorder(server.fetch, { requestTimeoutMs: 10 });
    instance.startOperation(start).finish({ outcome: 'ok' });
    const first = instance.flush();
    await server.called(1);
    await instance.shutdown();
    expect(instance.stats()).toMatchObject({ buffered: 2, dropped: 0 });
    await server.open(1);
    await first;
    expect(instance.stats()).toMatchObject({ buffered: 0, dropped: 2 });
    expect(logs).toContain('agent_telemetry_dropped_after_shutdown');
  });
});

describe('events that stop serializing after capture', () => {
  const start = { protocol: CUSTOM, direction: 'inbound', method: 'SendMessage', kind: 'message' } as const;

  it('drops, logs and counts the poisoned event instead of retrying the batch forever', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const custom: Record<string, unknown> = { region: 'eu' };
    instance.startOperation({ ...start, custom: custom as never });
    instance.startOperation(start).finish({ outcome: 'ok' });
    // The host mutates the object it passed in; the event holds it by reference.
    custom.size = 1n;
    await instance.flush();
    expect(logs).toContain('agent_telemetry_event_failed');
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0].events.map((event) => event.type)).toEqual(['operation.started', 'operation.finished']);
    expect(server.batches[0].dropped).toBe(1);
    expect(instance.stats()).toMatchObject({ buffered: 0, sent: 2, dropped: 1 });
  });

  it('drops the whole batch when it fails to serialize but no single event does', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    let isArmed = false;
    // Serializes at capture; once armed, fails the next time only (inside the batch), then serializes alone again.
    const flaky = {
      toJSON() {
        if (isArmed) {
          isArmed = false;
          throw new Error('flaky');
        }
        return { ok: true };
      },
    };
    instance.startOperation(start).message({ role: 'caller', parts: [{ kind: 'data', json: flaky }] });
    isArmed = true;
    await instance.flush();
    expect(server.batches).toHaveLength(0);
    expect(logs).toContain('agent_telemetry_event_failed');
    expect(instance.stats()).toMatchObject({ buffered: 0, dropped: 2 });
  });
});

describe('delivery observability', () => {
  const start = { protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' } as const;

  /** A recorder whose log lines keep their fields. */
  function logged(fetch: typeof globalThis.fetch) {
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const made = recorder(fetch, { log: (event, fields) => lines.push({ event, ...(fields ? { fields } : {}) }) });
    return { ...made, named: (event: string) => lines.filter((line) => line.event === event).map((line) => line.fields) };
  }

  it('logs a send failure the first time and whenever its kind changes, and again after a success', async () => {
    const answers: Array<() => Response> = [
      () => new Response('down', { status: 503 }),
      () => new Response('down', { status: 503 }),
      () => new Response('oops', { status: 500 }),
      () => {
        throw new TypeError('offline');
      },
      () => Response.json({ accepted: 1, rejected: [] }, { status: 202 }),
      () => new Response('down', { status: 503 }),
    ];
    const server = endpoint((_batch, call) => answers[call - 1]());
    const { instance, advance, named } = logged(server.fetch);
    instance.startOperation(start);
    for (let attempt = 0; attempt < answers.length; attempt++) {
      if (attempt === 5) instance.startOperation(start);
      await instance.flush();
      advance(60_000);
    }
    expect(server.batches).toHaveLength(6);
    expect(named('agent_telemetry_send_failed')).toEqual([{ status: 503 }, { status: 500 }, { reason: 'TypeError' }, { status: 503 }]);
  });

  it('logs the codes of events the server rejected', async () => {
    const rejected = [
      { index: 0, code: 'invalid_field' },
      { index: 1, code: 'invalid_field' },
      { index: 2, code: 'unknown_field' },
    ];
    const server = endpoint(() => Response.json({ accepted: 1, rejected }, { status: 202 }));
    const { instance, named } = logged(server.fetch);
    instance.startOperation(start);
    await instance.flush();
    expect(named('agent_telemetry_events_rejected')).toEqual([{ events: 3, codes: ['invalid_field', 'unknown_field'] }]);
  });

  it('counts a refused batch as dropped and reports it with the next batch', async () => {
    const server = endpoint((batch, call) => (call === 1 ? new Response('bad', { status: 400 }) : accepted(batch)));
    const { instance } = recorder(server.fetch);
    instance.startOperation(start).finish({ outcome: 'ok' });
    await instance.flush();
    expect(instance.stats()).toMatchObject({ dropped: 2, buffered: 0 });
    instance.startOperation(start);
    await instance.flush();
    expect(server.batches[1].dropped).toBe(2);
  });

  it('counts and logs what the last attempt at shutdown could not send', async () => {
    const server = endpoint(() => new Response('down', { status: 503 }));
    const { instance, logs } = recorder(server.fetch);
    instance.startOperation(start).finish({ outcome: 'ok' });
    await instance.shutdown();
    expect(logs).toContain('agent_telemetry_dropped_after_shutdown');
    expect(instance.stats()).toMatchObject({ buffered: 0, dropped: 2, sent: 0 });
  });

  it('treats any 2xx as sent and cancels the bodies it does not read', async () => {
    const cancelled: number[] = [];
    const respond = (status: number) => {
      if (status === 200) return Response.json({ accepted: 1, rejected: [] }, { status });
      if (status === 204) return new Response(null, { status });
      const body = new ReadableStream({
        cancel() {
          cancelled.push(status);
        },
      });
      return new Response(body, { status });
    };
    const server = endpoint((_batch, call) => respond([200, 204, 503, 400][call - 1]));
    const { instance, advance } = recorder(server.fetch);
    for (let call = 0; call < 4; call++) {
      instance.startOperation(start);
      await instance.flush();
      advance(60_000);
    }
    // The 503 batch is retried with the next event and then refused: both are dropped.
    expect(instance.stats()).toMatchObject({ sent: 2, dropped: 2, buffered: 0 });
    expect(cancelled).toEqual([503, 400]);
  });
});

describe('authenticated subject hashing', () => {
  const start = { protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message' } as const;
  const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

  /** The subject hash a recorder sends for `issuer` and `subject`, with the given options. */
  async function hashOf(issuer: string, subject: string, options: Partial<RecorderOptions> = {}): Promise<string> {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch, options);
    instance.startOperation({ ...start, counterparty: { authenticated: { issuer, subject } } });
    await instance.flush();
    const [started] = server.batches[0].events;
    return started.type === 'operation.started' ? (started.counterparty.authenticated?.subject_hash ?? '') : '';
  }

  it('is HMAC-SHA256 under the subject key, over a versioned message with the issuer, never plain SHA-256', async () => {
    const hash = await hashOf('https://idp', 'user-42', { subjectKey: 'sk-1' });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('sk-1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('subject:v1\nhttps://idp\nuser-42')));
    expect(hash).toBe(expected);
    expect(hash).not.toBe(hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('user-42'))));
  });

  it('is stable for the same key, and differs by key and by issuer', async () => {
    const first = await hashOf('https://idp', 'user-42', { subjectKey: 'sk-1' });
    expect(await hashOf('https://idp', 'user-42', { subjectKey: 'sk-1' })).toBe(first);
    expect(await hashOf('https://idp', 'user-42', { subjectKey: 'sk-2' })).not.toBe(first);
    expect(await hashOf('https://other-idp', 'user-42', { subjectKey: 'sk-1' })).not.toBe(first);
  });

  it('defaults the subject key to the agent key, also when it is empty', async () => {
    const byDefault = await hashOf('https://idp', 'user-42', { key: 'ak_test_y' });
    expect(await hashOf('https://idp', 'user-42', { key: 'ak_test_y', subjectKey: '' })).toBe(byDefault);
    expect(byDefault).toBe(await hashOf('https://idp', 'user-42', { key: 'ak_test_z', subjectKey: 'ak_test_y' }));
    expect(byDefault).not.toBe(await hashOf('https://idp', 'user-42', { key: 'ak_test_z' }));
  });
});
