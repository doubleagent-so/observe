import { describe, expect, it, vi } from 'vitest';
import { mcpOperation, withMcpTelemetry } from '../src/mcp/index';
import { mcpSessions } from '../src/mcp/session';
import { capture, expectValid, operation, starts } from './support';

type Message = { id?: number | string; method?: string; params?: { name?: string; arguments?: { q?: string } } };

function answer(message: Message) {
  if (message.method === 'initialize')
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'hand', version: '1.0.0' } },
    };
  if (message.method === 'tools/call' && message.params?.name === 'search')
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `found ${message.params.arguments?.q}` }] } };
  if (message.method === 'tools/call')
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } };
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
}

/** A hand-rolled MCP JSON-RPC handler: no SDK, JSON responses, `hand-1` sessions, `slow` waits for `gate`. */
function handMade(gate: Promise<void> = Promise.resolve()) {
  const received: string[] = [];
  async function handler(request: Request): Promise<Response> {
    received.push(request.method === 'POST' ? await request.text() : request.method);
    if (request.headers.get('authorization') === 'Bearer bad') return new Response('unauthorized', { status: 401 });
    if (request.method === 'DELETE') return new Response(null, { status: 200 });
    if (request.method !== 'POST') return new Response('ok');
    let body: unknown;
    try {
      body = JSON.parse(received.at(-1)!);
    } catch {
      return new Response('bad', { status: 400 });
    }
    const messages = (Array.isArray(body) ? body : [body]) as Message[];
    const requests = messages.filter((message) => message.id !== undefined && message.method);
    if (!requests.length) return new Response(null, { status: 202 });
    if (requests.some((message) => message.params?.name === 'slow')) await gate;
    const responses = requests.map(answer);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (requests.some((message) => message.method === 'initialize')) headers['mcp-session-id'] = 'hand-1';
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers });
  }
  return { handler, received };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://hand.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = rpc(0, 'initialize', {
  protocolVersion: '2025-11-25',
  clientInfo: { name: 'hand-client', version: '2.0.0' },
  capabilities: { elicitation: {} },
});
const session = { 'mcp-session-id': 'hand-1', 'mcp-protocol-version': '2025-11-25' };

describe('withMcpTelemetry', () => {
  it('records initialize in its session and later calls with the cached client info, leaving responses untouched', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    const first = await fetch(post(initialize));
    expect(first.headers.get('mcp-session-id')).toBe('hand-1');
    const second = await fetch(post(rpc(1, 'tools/call', { name: 'search', arguments: { q: 'flights' } }), session));
    expect(await second.text()).toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'found flights' }] } }),
    );
    const events = await c.settle();
    expect(operation(events, 'initialize').start).toMatchObject({
      conversation_ref: 'hand-1',
      direction: 'inbound',
      kind: 'discovery',
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'streamable-http' },
      mcp: { request_id: '0', client_info: { name: 'hand-client', version: '2.0.0' }, capabilities: ['elicitation'] },
    });
    expect(operation(events, 'initialize').finish).toMatchObject({ outcome: 'ok' });
    const call = operation(events, 'tools/call');
    expect(call.start).toMatchObject({
      conversation_ref: 'hand-1',
      target: 'search',
      counterparty: { client_info: { name: 'hand-client' } },
    });
    expect(call.messages.map((message) => message.role)).toEqual(['caller', 'agent']);
    expect(call.finish).toMatchObject({ outcome: 'ok' });
    expectValid(c.batches);
  });

  it('records every request in a batch and pairs each response', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    await fetch(
      post([
        rpc(1, 'tools/call', { name: 'search', arguments: { q: 'a' } }),
        rpc(2, 'tools/call', { name: 'broken' }),
        rpc(3, 'resources/templates/list'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]),
    );
    const events = await c.settle();
    expect(starts(events).map((event) => event.method)).toEqual(['tools/call', 'tools/call', 'resources/templates/list']);
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'tool_error' });
    expect(operation(events, 'resources/templates/list').finish).toMatchObject({
      outcome: 'protocol_error',
      error: { native_code: '-32601', code: 'method_not_found' },
    });
    expectValid(c.batches);
  });

  it('records 401 as auth_rejected and other HTTP errors as protocol errors', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    await fetch(post([rpc(1, 'tools/call', { name: 'search' }), rpc(2, 'tools/list')], { authorization: 'Bearer bad' }));
    const failing = withMcpTelemetry(async () => new Response('gone', { status: 404 }), { recorder: c.recorder, waitUntil: c.schedule });
    await failing(post(rpc(3, 'ping'), session));
    const events = await c.settle();
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'auth_rejected' });
    expect(operation(events, 'tools/list').finish).toMatchObject({ outcome: 'auth_rejected' });
    expect(operation(events, 'ping').finish).toMatchObject({
      outcome: 'protocol_error',
      error: { native_code: '404', code: 'http_error' },
    });
  });

  it('records a 403 insufficient_scope challenge with the scopes the server asked for', async () => {
    const c = capture();
    const challenge =
      'Bearer error="insufficient_scope", scope="files:read files:write", resource_metadata="https://hand.example/.well-known/oauth-protected-resource"';
    const forbidden = withMcpTelemetry(async () => new Response('forbidden', { status: 403, headers: { 'www-authenticate': challenge } }), {
      recorder: c.recorder,
      waitUntil: c.schedule,
    });
    await forbidden(post(rpc(1, 'tools/call', { name: 'write_file' })));
    const plain = withMcpTelemetry(async () => new Response('forbidden', { status: 403 }), { recorder: c.recorder, waitUntil: c.schedule });
    await plain(post(rpc(2, 'tools/list')));
    const events = await c.settle();
    expect(operation(events, 'tools/call').finish).toMatchObject({
      outcome: 'auth_rejected',
      insufficient_scope: { required: ['files:read', 'files:write'] },
    });
    expect(operation(events, 'tools/list').finish).not.toHaveProperty('insufficient_scope');
    expectValid(c.batches);
  });

  it('records an oversized body as one unknown operation and still hands the handler the whole body', async () => {
    const c = capture();
    const { handler, received } = handMade();
    const fetch = withMcpTelemetry(handler, { recorder: c.recorder, waitUntil: c.schedule });
    const big = JSON.stringify(rpc(1, 'tools/call', { name: 'search', arguments: { q: 'x'.repeat(1024 * 1024) } }));
    await fetch(post(big));
    const events = await c.settle();
    expect(received[0]).toHaveLength(big.length);
    expect(starts(events).map((event) => [event.method, event.kind])).toEqual([['unknown', 'other']]);
    expect(operation(events, 'unknown').finish).toMatchObject({ outcome: 'ok' });
  });

  it('passes through invalid JSON, non-MCP bodies, other content types and other methods without recording', async () => {
    const c = capture();
    const { handler, received } = handMade();
    const fetch = withMcpTelemetry(handler, { recorder: c.recorder, waitUntil: c.schedule });
    await fetch(post('{not json'));
    await fetch(post('{"hello":1}'));
    await fetch(post('[]'));
    await fetch(post([rpc(1, 'ping'), { hello: 1 }]));
    await fetch(new Request('https://hand.example/mcp', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }));
    await fetch(new Request('https://hand.example/health'));
    await fetch(new Request('https://hand.example/mcp', { method: 'DELETE' }));
    expect(await c.settle()).toEqual([]);
    expect(received).toEqual(['{not json', '{"hello":1}', '[]', JSON.stringify([rpc(1, 'ping'), { hello: 1 }]), 'hi', 'GET', 'DELETE']);
  });

  it('rethrows handler errors after recording them as internal errors', async () => {
    const c = capture();
    const boom = new Error('boom');
    const fetch = withMcpTelemetry(
      async () => {
        throw boom;
      },
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    await expect(fetch(post(rpc(1, 'tools/call', { name: 'search' })))).rejects.toBe(boom);
    await expect(fetch(post(initialize))).rejects.toBe(boom);
    const events = await c.settle();
    const threw = { outcome: 'protocol_error', error: { code: 'internal_error', native_code: 'exception' } };
    expect(operation(events, 'tools/call').finish).toMatchObject(threw);
    expect(operation(events, 'initialize').finish).toMatchObject(threw);
  });

  it('never pairs concurrent stateless requests that reuse the same JSON-RPC id', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    await Promise.all([
      fetch(post(rpc(1, 'tools/call', { name: 'search', arguments: { q: 'a' } }))),
      fetch(post(rpc(1, 'tools/call', { name: 'broken' }))),
    ]);
    const events = await c.settle();
    const byTarget = Object.fromEntries(
      [0, 1].map((nth) => {
        const call = operation(events, 'tools/call', nth);
        return [call.start.target, call.finish!.outcome];
      }),
    );
    expect(byTarget).toEqual({ search: 'ok', broken: 'tool_error' });
  });

  it('records a session DELETE and forgets the session', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    await fetch(post(initialize));
    await fetch(new Request('https://hand.example/mcp', { method: 'DELETE', headers: session }));
    await fetch(post(rpc(1, 'tools/call', { name: 'search', arguments: { q: 'a' } }), session));
    const denied = await fetch(
      new Request('https://hand.example/mcp', { method: 'DELETE', headers: { ...session, authorization: 'Bearer bad' } }),
    );
    expect(denied.status).toBe(401);
    const events = await c.settle();
    expect(operation(events, 'session/delete', 0).start).toMatchObject({ kind: 'management', conversation_ref: 'hand-1' });
    expect(operation(events, 'session/delete', 0).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'session/delete', 1).finish).toMatchObject({ outcome: 'auth_rejected' });
    expect(operation(events, 'tools/call').start.counterparty).not.toHaveProperty('client_info');
  });

  it('records a cancellation that arrives in another POST and ignores the late response', async () => {
    const c = capture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler, received } = handMade(gate);
    const fetch = withMcpTelemetry(handler, { recorder: c.recorder, waitUntil: c.schedule });
    await fetch(post(initialize));
    const slow = fetch(post(rpc(5, 'tools/call', { name: 'slow' }), session));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await fetch(post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5, reason: 'user' } }, session));
    release();
    await slow;
    const call = operation(await c.settle(), 'tools/call');
    expect(call.finish).toMatchObject({ outcome: 'canceled' });
    expect(call.finishes).toBe(1);
  });

  it('merges host evidence, survives a failing identify and drops an invalid session header', async () => {
    const c = capture();
    const logs: string[] = [];
    const fetch = withMcpTelemetry(handMade().handler, {
      recorder: c.recorder,
      waitUntil: c.schedule,
      identify: () => ({ declared_name: 'hand-agent' }),
    });
    await fetch(post(initialize));
    await fetch(post(rpc(1, 'tools/call', { name: 'search' }), session));
    const broken = withMcpTelemetry(handMade().handler, {
      recorder: c.recorder,
      waitUntil: c.schedule,
      log: (event) => void logs.push(event),
      identify: () => {
        throw new Error('identify broke');
      },
    });
    await broken(post(rpc(2, 'ping'), { 'mcp-session-id': 'has space' }));
    const events = await c.settle();
    expect(operation(events, 'tools/call').start.counterparty).toMatchObject({
      declared_name: 'hand-agent',
      client_info: { name: 'hand-client' },
    });
    expect(operation(events, 'ping').start).not.toHaveProperty('conversation_ref');
    expect(logs).toContain('agent_telemetry_identify_failed');
    expectValid(c.batches);
  });

  it('finishes from the status when the JSON response is too large or not JSON, without reading past the limit', async () => {
    const c = capture();
    const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
    const responses = [
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: huge }] } }), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response('not json', { headers: { 'content-type': 'application/json' } }),
    ];
    const fetch = withMcpTelemetry(async () => responses.shift()!, { recorder: c.recorder, waitUntil: c.schedule });
    const first = await fetch(post(rpc(1, 'tools/call', { name: 'search' })));
    expect((await first.text()).length).toBeGreaterThan(4 * 1024 * 1024);
    await fetch(post(rpc(2, 'tools/call', { name: 'search' })));
    const events = await c.settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 0).messages.map((message) => message.role)).toEqual([]);
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'ok' });
  });

  it('records a client answer to a server callback that arrives in its own POST', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(async () => new Response(null, { status: 202 }), { recorder: c.recorder, waitUntil: c.schedule });
    await fetch(post({ jsonrpc: '2.0', id: 'unknown-callback', result: {} }, session));
    expect(await c.settle()).toEqual([]);
  });

  it('logs once when waitUntil is true but no handler argument has one, and still records', async () => {
    const c = capture();
    const logs: string[] = [];
    const fetch = withMcpTelemetry(async (_request: Request, _env: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result: {} }), {
      recorder: c.recorder,
      waitUntil: true,
      log: (event) => void logs.push(event),
    });
    await fetch(post(rpc(1, 'ping')), {});
    await fetch(post(rpc(2, 'ping')), {});
    await vi.waitFor(async () => expect(starts(await c.settle())).toHaveLength(2));
    expect(logs).toEqual(['agent_telemetry_no_waituntil']);
  });

  it('records an internal error for an oversized body or a DELETE whose handler throws, and rethrows', async () => {
    const c = capture();
    const boom = new Error('boom');
    const fetch = withMcpTelemetry(
      async () => {
        throw boom;
      },
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    await expect(fetch(post('x'.repeat(1024 * 1024 + 1)))).rejects.toBe(boom);
    await expect(fetch(new Request('https://hand.example/mcp', { method: 'DELETE', headers: session }))).rejects.toBe(boom);
    const events = await c.settle();
    expect(operation(events, 'unknown').finish).toMatchObject({ outcome: 'protocol_error', error: { code: 'internal_error' } });
    expect(operation(events, 'session/delete').finish).toMatchObject({ outcome: 'protocol_error', error: { code: 'internal_error' } });
  });

  it('passes a request through when its body cannot be read for telemetry', async () => {
    const c = capture();
    const logs: string[] = [];
    const seen: Request[] = [];
    const fetch = withMcpTelemetry(
      async (request: Request) => {
        seen.push(request);
        return new Response('ok');
      },
      { recorder: c.recorder, waitUntil: c.schedule, log: (event) => void logs.push(event) },
    );
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('stream broke'));
      },
    });
    const request = new Request('https://hand.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: failing,
      duplex: 'half',
    } as RequestInit);
    expect(await (await fetch(request)).text()).toBe('ok');
    expect(seen[0]).toBe(request);
    expect(logs).toEqual(['agent_telemetry_event_failed']);
    expect(await c.settle()).toEqual([]);
  });

  it('gives no handler an operation while two POSTs in one session share a request id', async () => {
    const c = capture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: unknown[] = [];
    let arrived = 0;
    const fetch = withMcpTelemetry(
      async (request: Request) => {
        const body = (await request.clone().json()) as Message;
        if (body.method === 'initialize') return handMade().handler(request);
        arrived++;
        await gate;
        seen.push(
          mcpOperation(c.recorder, { sessionId: request.headers.get('mcp-session-id') ?? undefined, requestId: 7, requestInfo: request }),
        );
        return Response.json({ jsonrpc: '2.0', id: 7, result: { content: [] } });
      },
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    await fetch(post(initialize));
    const both = Promise.all([
      fetch(post(rpc(7, 'tools/call', { name: 'a' }), session)),
      fetch(post(rpc(7, 'tools/call', { name: 'b' }), session)),
    ]);
    await vi.waitFor(() => expect(arrived).toBe(2));
    release();
    await both;
    expect(seen).toEqual([undefined, undefined]);
    const events = await c.settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'protocol_error', error: { code: 'duplicate_request_id' } });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 1).finishes).toBe(1);
  });

  it('keeps unknown session ids out of the shared cache unless the server accepts them', async () => {
    const c = capture();
    const statuses = [404, 404, 404, 200];
    const fetch = withMcpTelemetry(
      async () =>
        statuses.shift() === 404 ? new Response('no such session', { status: 404 }) : Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    for (const id of ['ghost-1', 'ghost-2', 'ghost-3']) await fetch(post(rpc(1, 'ping'), { 'mcp-session-id': id }));
    expect(mcpSessions(c.recorder).size).toBe(0);
    await fetch(post(rpc(1, 'ping'), { 'mcp-session-id': 'elsewhere-1' }));
    await c.settle();
    expect(mcpSessions(c.recorder).get('elsewhere-1')).toBeDefined();
  });

  it('applies what initialize said only when the server accepts it', async () => {
    const c = capture();
    const accepted = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    await accepted(post(initialize));
    const rejecting = withMcpTelemetry(async () => new Response('bad', { status: 400 }), { recorder: c.recorder, waitUntil: c.schedule });
    const impostor = rpc(9, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'impostor' }, capabilities: {} });
    await rejecting(post(impostor, session));
    await accepted(post(rpc(1, 'tools/call', { name: 'search' }), session));
    const events = await c.settle();
    expect(operation(events, 'tools/call').start.counterparty).toMatchObject({ client_info: { name: 'hand-client' } });
  });

  it('still answers when flushing or scheduling throws', async () => {
    const c = capture();
    const broken = new Proxy(c.recorder, {
      get(target, property) {
        if (property === 'flush')
          return () => {
            throw new Error('flush bug');
          };
        return Reflect.get(target, property, target);
      },
    });
    const fetch = withMcpTelemetry(handMade().handler, { recorder: broken, waitUntil: c.schedule, log: () => {} });
    expect((await fetch(post(rpc(1, 'tools/call', { name: 'search' })))).status).toBe(200);
    expect((await fetch(post(rpc(2, 'ping')))).status).toBe(200);
  });

  it('logs a response it cannot read, but not a response that is not JSON', async () => {
    const c = capture();
    const logs: string[] = [];
    const failing = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('broken body'));
        },
      });
    const responses = [new Response(failing(), { headers: { 'content-type': 'application/json' } }), new Response('not json')];
    const fetch = withMcpTelemetry(async () => responses.shift()!, {
      recorder: c.recorder,
      waitUntil: c.schedule,
      log: (event) => void logs.push(event),
    });
    const first = await fetch(post(rpc(1, 'ping')));
    await expect(first.text()).rejects.toThrow('broken body');
    await fetch(post(rpc(2, 'ping')));
    await c.settle();
    expect(logs).toEqual(['agent_telemetry_event_failed']);
  });

  it('records the response size and the time to first byte on finishes', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(handMade().handler, { recorder: c.recorder, waitUntil: c.schedule });
    const response = await fetch(post([rpc(1, 'tools/call', { name: 'search', arguments: { q: 'a' } }), rpc(2, 'ping')]));
    const bytes = new TextEncoder().encode(await response.text()).byteLength;
    const events = await c.settle();
    for (const method of ['tools/call', 'ping']) {
      const finish = operation(events, method).finish!;
      expect(finish.response_bytes, method).toBe(bytes);
      expect(finish.first_byte_ms, method).toBeGreaterThanOrEqual(0);
    }
  });
});
