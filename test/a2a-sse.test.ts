import { describe, expect, it, vi } from 'vitest';
import { createRecorder, type EventBatch, type OperationHandle } from '../src/index';
import { withA2ATelemetry } from '../src/a2a/index';
import { observeStream } from '../src/a2a/sse';
import type { RecorderState } from '../src/state';

function setup() {
  const batches: EventBatch[] = [];
  const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const batch = JSON.parse(String(init.body)) as EventBatch;
    batches.push(batch);
    return Response.json({ accepted: batch.events.length, rejected: [] }, { status: 202 });
  }) as typeof globalThis.fetch;
  const recorder = createRecorder({ key: 'ak_test_x', endpoint: 'https://api.test', fetch, flushIntervalMs: 0, log: () => {} });
  return { recorder, events: () => batches.flatMap((batch) => batch.events) };
}

const encoder = new TextEncoder();
const event = (result: unknown, end = '\n\n') => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}${end}`;
const status = (state: string) => ({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state } } });
const frames = [
  event({ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } }),
  event(status('TASK_STATE_WORKING'), '\r\n\r\n'),
  event({ artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { artifactId: 'a1', parts: [{ text: 'partial ✓' }] } } }),
  event(status('TASK_STATE_COMPLETED')),
].join('');

/** Splits the stream at awkward points, including inside an event and inside a multi-byte character. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const request = () =>
  new Request('https://agent.example/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendStreamingMessage',
      params: { message: { messageId: 'm1', contextId: 'c1', role: 'ROLE_USER', parts: [{ text: 'go' }] } },
    }),
  });

const sse = (body: BodyInit, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) =>
  new Response(body, { ...init, headers: { 'content-type': 'text/event-stream', ...init.headers } });

const states = (events: EventBatch['events']) =>
  events.filter((item) => item.type === 'task.state_changed').map((item) => item.type === 'task.state_changed' && item.state);

describe('SSE streams', () => {
  it('passes events through byte-identical while recording states once per change', async () => {
    const { recorder, events } = setup();
    const handler = withA2ATelemetry(async () => sse(chunked(frames, 7), { headers: { 'x-keep': '1' } }), { recorder });
    const response = await handler(request());
    expect(response.headers.get('x-keep')).toBe('1');
    expect(await response.text()).toBe(frames);
    await recorder.flush();
    const types = events().map((item) => item.type);
    expect(types[0]).toBe('operation.started');
    expect(events()[0]).toMatchObject({ protocol: { binding: 'sse' } });
    expect(states(events())).toEqual(['working', 'completed']);
    expect(types).toContain('message.observed');
    expect(events().at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok', stream_events: 4 });
  });

  it('parses events split one byte at a time, with CR, LF and CRLF line endings', async () => {
    const { recorder, events } = setup();
    const body = [
      event(status('TASK_STATE_WORKING'), '\r\r'),
      event(status('TASK_STATE_INPUT_REQUIRED'), '\r\n\r\n'),
      event(status('TASK_STATE_COMPLETED'), '\n\n'),
    ].join('');
    const handler = withA2ATelemetry(async () => sse(chunked(body, 1)), { recorder });
    expect(await (await handler(request())).text()).toBe(body);
    await recorder.flush();
    expect(states(events())).toEqual(['working', 'input_required', 'completed']);
    expect(events().at(-1)).toMatchObject({ outcome: 'ok', stream_events: 3 });
  });

  it('hands the client the very same chunk objects, in order, and keeps status and headers', async () => {
    const { recorder } = setup();
    const chunks = [encoder.encode(frames.slice(0, 50)), encoder.encode(frames.slice(50))];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const handler = withA2ATelemetry(async () => sse(upstream, { status: 207, statusText: 'Multi', headers: { 'x-a': 'b' } }), {
      recorder,
    });
    const response = await handler(request());
    expect(response.status).toBe(207);
    expect(response.statusText).toBe('Multi');
    expect(response.headers.get('x-a')).toBe('b');
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toBe(chunks[0]);
    expect((await reader.read()).value).toBe(chunks[1]);
    expect((await reader.read()).done).toBe(true);
  });

  it('does not read upstream before the client asks for data', async () => {
    const { recorder } = setup();
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(encoder.encode(': ping\n'));
        },
      },
      { highWaterMark: 0 },
    );
    const handler = withA2ATelemetry(async () => sse(upstream), { recorder });
    const response = await handler(request());
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    await reader.read();
    expect(pulls).toBe(1);
    await reader.cancel();
  });

  it('counts malformed, empty and oversized events without observing them, and stays bounded', async () => {
    const { recorder, events } = setup();
    const huge = event({ ...status('TASK_STATE_FAILED'), padding: 'x'.repeat(5 * 1024 * 1024) });
    const hugeComment = `: ${'y'.repeat(5 * 1024 * 1024)}\n`;
    const manyLines = `${`data: ${'z'.repeat(1024)}\n`.repeat(5000)}\n`;
    const body = [
      ': keep-alive\n\n',
      'data: not json\n\n',
      'data\n\n',
      'event: update\nid: 7\nretry: 10\ndata: [1,2]\n\n',
      huge,
      hugeComment,
      manyLines,
      event(status('TASK_STATE_COMPLETED')),
    ].join('');
    const handler = withA2ATelemetry(async () => sse(chunked(body, 64 * 1024)), { recorder });
    expect(await (await handler(request())).text()).toBe(body);
    await recorder.flush();
    expect(states(events())).toEqual(['completed']);
    expect(events().at(-1)).toMatchObject({ outcome: 'ok', stream_events: 6 });
  });

  it('observes a final event that ends without a blank line and joins multi-line data', async () => {
    const { recorder, events } = setup();
    const json = JSON.stringify({ jsonrpc: '2.0', id: 1, result: status('TASK_STATE_COMPLETED') }, null, 1);
    const body = json
      .split('\n')
      .map((line) => `data:${line}`)
      .join('\n');
    const handler = withA2ATelemetry(async () => sse(body), { recorder });
    expect(await (await handler(request())).text()).toBe(body);
    await recorder.flush();
    expect(states(events())).toEqual(['completed']);
    expect(events().at(-1)).toMatchObject({ outcome: 'ok', stream_events: 1 });
  });

  it('records a client disconnect as a transport error and cancels upstream', async () => {
    const { recorder, events } = setup();
    let canceled: unknown;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames.slice(0, 40)));
      },
      cancel(reason) {
        canceled = reason;
      },
    });
    const handler = withA2ATelemetry(async () => sse(upstream), { recorder });
    const response = await handler(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('client went away');
    await recorder.flush();
    expect(canceled).toBe('client went away');
    expect(events().at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'transport_error' });
  });

  it('never waits on, or surfaces, an upstream cancel that hangs or fails', async () => {
    for (const cancel of [() => new Promise<void>(() => {}), () => Promise.reject(new Error('cancel failed'))]) {
      const { recorder, events } = setup();
      const upstream = new ReadableStream<Uint8Array>({ cancel });
      const handler = withA2ATelemetry(async () => sse(upstream), { recorder });
      const response = await handler(request());
      await response.body!.cancel('bye');
      await recorder.flush();
      expect(events().at(-1)).toMatchObject({ outcome: 'transport_error' });
    }
  });

  it('cancels upstream while a read is pending', async () => {
    const { recorder, events } = setup();
    let canceled = false;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull: () => new Promise<void>(() => {}),
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const handler = withA2ATelemetry(async () => sse(upstream), { recorder });
    const reader = (await handler(request())).body!.getReader();
    const pending = reader.read();
    await reader.cancel();
    expect(await pending).toEqual({ done: true, value: undefined });
    await recorder.flush();
    expect(canceled).toBe(true);
    expect(events().at(-1)).toMatchObject({ outcome: 'transport_error' });
  });

  it('records an upstream failure and errors the client stream', async () => {
    const { recorder, events } = setup();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream died'));
      },
    });
    const handler = withA2ATelemetry(async () => sse(upstream), { recorder });
    const response = await handler(request());
    await expect(response.text()).rejects.toThrow('upstream died');
    await recorder.flush();
    expect(events().at(-1)).toMatchObject({ outcome: 'transport_error' });
  });

  it('records an upstream failure after some events and delivers the events first', async () => {
    const { recorder, events } = setup();
    const first = encoder.encode(event(status('TASK_STATE_WORKING')));
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
      },
      pull(controller) {
        controller.error(new Error('mid-stream'));
      },
    });
    const reader = (await withA2ATelemetry(async () => sse(upstream), { recorder })(request())).body!.getReader();
    expect((await reader.read()).value).toBe(first);
    await expect(reader.read()).rejects.toThrow('mid-stream');
    await recorder.flush();
    expect(states(events())).toEqual(['working']);
    expect(events().at(-1)).toMatchObject({ outcome: 'transport_error', stream_events: 1 });
  });

  it('records a JSON-RPC error event as a protocol error', async () => {
    const { recorder, events } = setup();
    const body = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32004, message: 'no' } })}\n\n`;
    const handler = withA2ATelemetry(async () => sse(body), { recorder });
    await (await handler(request())).text();
    await recorder.flush();
    expect(events().at(-1)).toMatchObject({ outcome: 'protocol_error', error: { code: 'unsupported_operation' } });
  });
});

describe('observeStream', () => {
  const state = { linkTask: () => {}, taskChanged: () => true } as unknown as RecorderState;
  const throwing = (): OperationHandle => ({
    operationId: 'x',
    message: () => {
      throw new Error('message');
    },
    taskState: () => {
      throw new Error('taskState');
    },
    cost: () => {
      throw new Error('cost');
    },
    charge: () => {
      throw new Error('charge');
    },
    finish: () => {
      throw new Error('finish');
    },
  });
  const failingFlush = () => {
    throw new Error('flush');
  };
  const quiet = () => {};

  it('passes the stream through unchanged when every telemetry call throws, and logs once per stream', async () => {
    const log = vi.fn();
    const response = observeStream(sse(chunked(frames, 5)), throwing(), state, failingFlush, log);
    expect(await response.text()).toBe(frames);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'Error' });
  });

  it('keeps parsing the rest of a chunk, and the next chunk, after one event fails', async () => {
    const seen: string[] = [];
    const op: OperationHandle = {
      operationId: 'x',
      message() {},
      taskState(task) {
        seen.push(task.state);
        if (seen.length === 1) throw new Error('first event');
      },
      cost() {},
      charge: () => '',
      finish() {},
    };
    const first = event(status('TASK_STATE_WORKING')) + event(status('TASK_STATE_INPUT_REQUIRED')) + 'data: {"jsonrpc"';
    const second = `:"2.0","id":1,"result":${JSON.stringify(status('TASK_STATE_COMPLETED'))}}\r`;
    const third = '\n\r\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of [first, second, third]) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    const log = vi.fn();
    await observeStream(sse(upstream), op, state, quiet, log).text();
    expect(seen).toEqual(['working', 'input_required', 'completed']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('treats only an overlong data line, not another field starting with "data", as an oversized event', async () => {
    const taskState = vi.fn();
    const op = { operationId: 'x', message() {}, taskState, cost() {}, charge: () => '', finish() {} };
    const body = `dataset: ${'y'.repeat(5 * 1024 * 1024)}\n${event(status('TASK_STATE_COMPLETED'))}`;
    await observeStream(sse(chunked(body, 64 * 1024)), op, state, quiet, quiet).text();
    expect(taskState).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('errors and cancels the client stream exactly as upstream would when telemetry throws', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('boom'));
      },
    });
    await expect(observeStream(sse(failing), throwing(), state, failingFlush, quiet).text()).rejects.toThrow('boom');
    const open = new ReadableStream<Uint8Array>();
    await observeStream(sse(open), throwing(), state, failingFlush, quiet).body!.cancel();
  });

  it('passes through chunks it cannot decode', async () => {
    const upstream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not bytes');
        controller.enqueue(42);
        controller.close();
      },
    });
    const finish = vi.fn();
    const op = { operationId: 'x', message() {}, taskState() {}, cost() {}, charge: () => '', finish };
    const response = sse(upstream as ReadableStream<Uint8Array>);
    const reader = observeStream(response, op, state, quiet, quiet).body!.getReader();
    expect((await reader.read()).value).toBe('not bytes');
    expect((await reader.read()).value).toBe(42);
    expect((await reader.read()).done).toBe(true);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });

  it('returns a locked response untouched and finishes the operation', () => {
    const response = sse('data: {}\n\n');
    response.body!.getReader();
    const finish = vi.fn();
    const flush = vi.fn();
    const op = { operationId: 'x', message() {}, taskState() {}, cost() {}, charge: () => '', finish };
    expect(observeStream(response, op, state, flush, quiet)).toBe(response);
    expect(finish).toHaveBeenCalledWith({ outcome: 'ok' });
    expect(flush).toHaveBeenCalled();
  });
});
