import { describe, expect, it } from 'vitest';
import { withMcpTelemetry } from '../src/mcp/index';
import { mcpSessions, newSession } from '../src/mcp/session';
import { capture, expectValid, operation } from './support';

const encoder = new TextEncoder();
const frame = (message: unknown, id?: string) => `${id ? `id: ${id}\n` : ''}event: message\ndata: ${JSON.stringify(message)}\n\n`;
const sseHeaders = { 'content-type': 'text/event-stream' };
const session = { 'mcp-session-id': 'sse-1', 'mcp-protocol-version': '2025-11-25' };

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

const post = (body: unknown) =>
  new Request('https://hand.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...session },
    body: JSON.stringify(body),
  });
const get = (headers: Record<string, string> = session) =>
  new Request('https://hand.example/mcp', { headers: { accept: 'text/event-stream', ...headers } });
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarize', arguments: { doc: 'a' } } };
const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } };
const sampling = {
  jsonrpc: '2.0',
  id: 's1',
  method: 'sampling/createMessage',
  params: { messages: [{ role: 'user', content: { type: 'text', text: 'summarize' } }], maxTokens: 10 },
};
const result = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'résumé ✓' }] } };

describe('withMcpTelemetry SSE', () => {
  it('passes the stream through byte-identical and records the call, the callback and its answer', async () => {
    const c = capture();
    const body = [frame(progress), frame(sampling), frame(result)].join('');
    const fetch = withMcpTelemetry(
      async (request: Request) =>
        (await request.clone().text()).includes('"method"')
          ? new Response(chunked(body, 5), { headers: sseHeaders })
          : new Response(null, { status: 202 }),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    const response = await fetch(post(call));
    expect(await response.text()).toBe(body);
    await fetch(post({ jsonrpc: '2.0', id: 's1', result: { role: 'assistant', content: { type: 'text', text: 'short' }, model: 'm' } }));
    const events = await c.settle();
    const tool = operation(events, 'tools/call');
    expect(tool.finish).toMatchObject({ outcome: 'ok' });
    expect(tool.messages.map((message) => message.content?.parts[0])).toEqual([
      { kind: 'data', json: { doc: 'a' }, truncated: false },
      { kind: 'text', text: 'résumé ✓', truncated: false },
    ]);
    const callback = operation(events, 'sampling/createMessage');
    expect(callback.start).toMatchObject({ direction: 'outbound', kind: 'callback', conversation_ref: 'sse-1' });
    expect(callback.messages.map((message) => message.role)).toEqual(['caller', 'agent']);
    expect(callback.finish).toMatchObject({ outcome: 'ok' });
    expectValid(c.batches);
  });

  it('records transport_error when a plain stream ends without the response', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(async () => new Response(frame(progress), { headers: sseHeaders }), {
      recorder: c.recorder,
      waitUntil: c.schedule,
    });
    await (await fetch(post(call))).text();
    expect(operation(await c.settle(), 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
  });

  it('keeps a request pending across a resumable stream and finishes it from the resumed GET stream', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(
      async (request: Request) =>
        request.method === 'GET'
          ? new Response(frame(result, 'e2'), { headers: sseHeaders })
          : new Response(`id: e0\ndata: \n\n${frame(progress, 'e1')}`, { headers: sseHeaders }),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    await (await fetch(post(call))).text();
    expect(operation(await c.settle(), 'tools/call').finish).toBeUndefined();
    await (await fetch(get({ ...session, 'last-event-id': 'e1' }))).text();
    expect(operation(await c.settle(), 'tools/call').finish).toMatchObject({ outcome: 'ok' });
  });

  it('records transport_error when the client disconnects or the upstream fails, and cancels upstream', async () => {
    const c = capture();
    let canceled = false;
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame(progress)));
      },
      cancel() {
        canceled = true;
      },
    });
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream died'));
      },
    });
    const streams = [hanging, failing];
    const fetch = withMcpTelemetry(async () => new Response(streams.shift()!, { headers: sseHeaders }), {
      recorder: c.recorder,
      waitUntil: c.schedule,
    });
    const reader = (await fetch(post(call))).body!.getReader();
    await reader.read();
    await reader.cancel('client went away');
    await expect((await fetch(post({ ...call, id: 2 }))).text()).rejects.toThrow('upstream died');
    const events = await c.settle();
    expect(canceled).toBe(true);
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'transport_error' });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'transport_error' });
  });

  it('observes server requests and task statuses on the standalone GET stream', async () => {
    const c = capture();
    const body = [
      frame(sampling),
      frame({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: { taskId: 'task-9', status: 'completed' } }),
      'data: not json\n\n',
    ].join('');
    const fetch = withMcpTelemetry(
      async (request: Request) =>
        request.headers.has('mcp-session-id') ? new Response(body, { headers: sseHeaders }) : new Response('no session', { status: 400 }),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    expect(await (await fetch(get())).text()).toBe(body);
    await (await fetch(get({}))).text();
    const events = await c.settle();
    expect(operation(events, 'sampling/createMessage').start).toMatchObject({
      direction: 'outbound',
      kind: 'callback',
      conversation_ref: 'sse-1',
    });
    expect(operation(events, 'notifications/tasks/status').tasks).toMatchObject([{ task_ref: 'task-9', state: 'completed' }]);
    expectValid(c.batches);
  });

  it('finishes a request from a JSON-RPC error event, and a stateless stream with ids still ends pending requests', async () => {
    const c = capture();
    const failure = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } };
    const bodies = [frame(failure), frame(progress, 'e1')];
    const fetch = withMcpTelemetry(async () => new Response(bodies.shift()!, { headers: sseHeaders }), {
      recorder: c.recorder,
      waitUntil: c.schedule,
    });
    await (await fetch(post(call))).text();
    const stateless = new Request('https://hand.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...call, id: 2 }),
    });
    await (await fetch(stateless)).text();
    const events = await c.settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'protocol_error', error: { code: 'invalid_params' } });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'transport_error' });
    expectValid(c.batches);
  });

  it('passes GET responses that are errors or not event streams through untouched', async () => {
    const c = capture();
    const responses = [new Response('nope', { status: 405 }), new Response('plain')];
    const fetch = withMcpTelemetry(async () => responses.shift()!, { recorder: c.recorder, waitUntil: c.schedule });
    expect((await fetch(get())).status).toBe(405);
    expect(await (await fetch(get())).text()).toBe('plain');
    expect(await c.settle()).toEqual([]);
  });

  it('keeps a request pending when the client drops a resumable stream, and finishes it from the resumed GET', async () => {
    const c = capture();
    mcpSessions(c.recorder).set('sse-1', newSession('sse-1'));
    const fetch = withMcpTelemetry(
      async (request: Request) =>
        request.method === 'GET'
          ? new Response(frame(result, 'e2'), { headers: sseHeaders })
          : new Response(new ReadableStream({ start: (controller) => controller.enqueue(encoder.encode(frame(progress, 'e1'))) }), {
              headers: sseHeaders,
            }),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    const reader = (await fetch(post(call))).body!.getReader();
    await reader.read();
    await reader.cancel('client reconnects');
    expect(operation(await c.settle(), 'tools/call').finish).toBeUndefined();
    await (await fetch(get({ ...session, 'last-event-id': 'e1' }))).text();
    expect(operation(await c.settle(), 'tools/call').finish).toMatchObject({ outcome: 'ok' });
  });

  it('finishes a stream it could not read as ok, like A2A, so no operation is left open', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(
      async () => {
        const locked = new Response(frame(result), { headers: sseHeaders });
        locked.body!.getReader();
        return locked;
      },
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    await fetch(post(call));
    expect(operation(await c.settle(), 'tools/call').finish).toMatchObject({ outcome: 'ok' });
  });

  it('closes a stateless stream: its callbacks cannot be answered later', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(async () => new Response(frame(sampling) + frame(result), { headers: sseHeaders }), {
      recorder: c.recorder,
      waitUntil: c.schedule,
    });
    const stateless = new Request('https://hand.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call),
    });
    await (await fetch(stateless)).text();
    const events = await c.settle();
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'sampling/createMessage').finish).toMatchObject({ outcome: 'transport_error' });
  });

  it('records the stream event count and the time to first byte on finishes', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(async () => new Response(frame(progress) + frame(result), { headers: sseHeaders }), {
      recorder: c.recorder,
      waitUntil: c.schedule,
    });
    await (await fetch(post(call))).text();
    const finish = operation(await c.settle(), 'tools/call').finish!;
    expect(finish).toMatchObject({ outcome: 'ok', stream_events: 2 });
    expect(finish.first_byte_ms).toBeGreaterThanOrEqual(0);
  });
});
