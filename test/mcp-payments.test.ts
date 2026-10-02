import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '../src/index';
import { instrumentMcpTransport, mcpOperation, withMcpTelemetry } from '../src/mcp/index';
import { flightsServer, samplingClient } from './mcp-fixtures';
import { capture, expectValid, operation } from './support';

const payment = { x402Version: 1, scheme: 'exact', network: 'base', payload: { authorization: { value: '250000' } } };
const metaSettlement = { success: true, transaction: '0xmeta', network: 'base' };
const headerSettlement = { success: true, transaction: '0xheader', network: 'base' };
const b64 = (value: unknown) => btoa(JSON.stringify(value));
const charges = (events: AgentEvent[]) => events.filter((event) => event.type === 'transaction.recorded');

describe('paid MCP tools', () => {
  it('records x402 _meta evidence through the transport wrapper, and handler charges via mcpOperation', async () => {
    const c = capture();
    const server = flightsServer();
    server.registerTool('paid', { description: 'Paid search', inputSchema: { q: z.string() } }, async () => ({
      content: [{ type: 'text', text: 'paid result' }],
      _meta: { 'x402/payment-response': metaSettlement },
    }));
    server.registerTool('metered', { description: 'Charges per call' }, async (extra) => {
      mcpOperation(c.recorder, extra)?.charge({ amount: 25, currency: 'USD', method: 'credits', status: 'settled', basis: 'reported' });
      return { content: [{ type: 'text', text: 'metered result' }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(instrumentMcpTransport(serverSide, { recorder: c.recorder, role: 'server', binding: 'stdio' }));
    const client = samplingClient();
    await client.connect(clientSide);
    await client.callTool({ name: 'paid', arguments: { q: 'a' }, _meta: { 'x402/payment': payment } });
    await client.callTool({ name: 'metered' });
    const events = await c.settle();
    const paid = operation(events, 'tools/call', 0);
    const metered = operation(events, 'tools/call', 1);
    expect(charges(events)).toMatchObject([
      {
        operation_id: paid.start.operation_id,
        amount: 250_000,
        currency: 'USDC',
        method: 'x402',
        external_ref: '0xmeta',
        status: 'settled',
        basis: 'reported',
      },
      { operation_id: metered.start.operation_id, amount: 25, currency: 'USD', method: 'credits' },
    ]);
    const order = events.filter((event) => event.operation_id === paid.start.operation_id).map((event) => event.type);
    expect(order.indexOf('transaction.recorded')).toBeLessThan(order.indexOf('operation.finished'));
    expectValid(c.batches);
  });

  it('records header evidence once in the fetch wrapper, and lets _meta win when both are present', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(
      async (request: Request) => {
        const body = (await request.json()) as { id: number; params: { name: string } }[];
        const results = body.map((message) => ({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [], ...(message.params.name === 'both' ? { _meta: { 'x402/payment-response': metaSettlement } } : {}) },
        }));
        return new Response(JSON.stringify(results), {
          headers: { 'content-type': 'application/json', 'x-payment-response': b64(headerSettlement) },
        });
      },
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    const call = (name: string, id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, ...(name === 'both' ? { _meta: { 'x402/payment': payment } } : {}) },
    });
    const post = (body: unknown) =>
      fetch(
        new Request('https://hand.example/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-payment': b64(payment) },
          body: JSON.stringify(body),
        }),
      );
    await post([call('header', 1), call('second', 2)]);
    await post([call('both', 3)]);
    const events = await c.settle();
    expect(charges(events)).toMatchObject([
      { operation_id: operation(events, 'tools/call', 0).start.operation_id, external_ref: '0xheader' },
      { operation_id: operation(events, 'tools/call', 2).start.operation_id, external_ref: '0xmeta' },
    ]);
    expect(charges(events)).toHaveLength(2);
    expectValid(c.batches);
  });

  it('records nothing for malformed or incomplete evidence, and nothing on cancel', async () => {
    const c = capture();
    const server = flightsServer();
    server.registerTool('odd', { description: 'Malformed settlement' }, async () => ({
      content: [],
      _meta: { 'x402/payment-response': 'junk' },
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(instrumentMcpTransport(serverSide, { recorder: c.recorder, role: 'server', binding: 'stdio' }));
    const client = samplingClient();
    await client.connect(clientSide);
    await client.callTool({ name: 'odd', _meta: { 'x402/payment': payment } });
    // An unknown tool is an error result or a rejection depending on the SDK version; either way nothing is charged.
    try {
      await client.callTool({ name: 'paid-nothing-here', _meta: { 'x402/payment': { payload: { authorization: { value: '1.5' } } } } });
    } catch {
      // Expected on SDKs that reject unknown tools.
    }
    expect(charges(await c.settle())).toEqual([]);
  });

  it('charges header evidence on SSE responses and on a 402, and nothing on a cancel without a settlement', async () => {
    const c = capture();
    const sse = (body: string) =>
      new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-payment-response': b64(headerSettlement) } });
    const responses = [
      sse(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } })}\n\n`),
      new Response('payment required', { status: 402, headers: { 'x-payment-response': b64(headerSettlement) } }),
    ];
    const fetch = withMcpTelemetry(async () => responses.shift()!, { recorder: c.recorder, waitUntil: c.schedule });
    const post = (id: number) =>
      fetch(
        new Request('https://hand.example/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-payment': b64(payment) },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search' } }),
        }),
      );
    await (await post(1)).text();
    await post(2);
    const events = await c.settle();
    // A settlement header proves the money moved, whatever the status (401 and 403 aside).
    expect(charges(events)).toMatchObject([
      { operation_id: operation(events, 'tools/call', 0).start.operation_id, external_ref: '0xheader' },
      { operation_id: operation(events, 'tools/call', 1).start.operation_id, external_ref: '0xheader' },
    ]);
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'protocol_error', error: { code: 'http_error' } });

    const cancelled = capture();
    const { createMcpEngine } = await import('../src/mcp/engine');
    const { newSession } = await import('../src/mcp/session');
    const engine = createMcpEngine({ recorder: cancelled.recorder, role: 'server', binding: 'stdio', log: () => {} });
    const session = newSession('s1');
    engine.observe(
      'peer',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', _meta: { 'x402/payment': payment } } },
      { session },
    );
    engine.observe('peer', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { session });
    engine.observe(
      'self',
      { jsonrpc: '2.0', id: 1, result: { content: [], _meta: { 'x402/payment-response': metaSettlement } } },
      { session },
    );
    engine.observe(
      'peer',
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'y', _meta: { 'x402/payment': payment } } },
      { session },
    );
    engine.close(session);
    expect(charges(await cancelled.settle())).toEqual([]);
  });

  it('charges a JSON-RPC error response that still carries header evidence, once', async () => {
    const c = capture();
    const fetch = withMcpTelemetry(
      async () =>
        Response.json(
          { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'failed after settling' } },
          { headers: { 'x-payment-response': b64({ success: false, network: 'base' }) } },
        ),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    await fetch(
      new Request('https://hand.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-payment': b64(payment) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } }),
      }),
    );
    const events = await c.settle();
    expect(charges(events)).toMatchObject([{ status: 'failed', amount: 250_000 }]);
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'protocol_error' });
    expectValid(c.batches);
  });

  it('records a settled header payment even when the SSE stream then breaks', async () => {
    const c = capture();
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream broke'));
      },
    });
    const fetch = withMcpTelemetry(
      async () => new Response(failing, { headers: { 'content-type': 'text/event-stream', 'x-payment-response': b64(headerSettlement) } }),
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    const response = await fetch(
      new Request('https://hand.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-payment': b64(payment) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } }),
      }),
    );
    await expect(response.text()).rejects.toThrow('stream broke');
    const events = await c.settle();
    expect(charges(events)).toMatchObject([{ external_ref: '0xheader', status: 'settled' }]);
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
  });

  describe('settlement headers charge on every exit', () => {
    const metaCall = (id: number, method = 'tools/call') => ({
      jsonrpc: '2.0',
      id,
      method,
      params: { name: 'search', _meta: { 'x402/payment': payment } },
    });
    const sessionHeaders = { 'mcp-session-id': 'paid-1' };
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new Request('https://hand.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-payment': b64(payment), ...sessionHeaders, ...headers },
        body: JSON.stringify(body),
      });
    // A resumable stream that closes before the response: the request stays pending, with header evidence.
    const resumable = () =>
      new Response('id: e1\ndata: \n\n', { headers: { 'content-type': 'text/event-stream', 'x-payment-response': b64(headerSettlement) } });

    it('charges the header settlement when the client cancels the call', async () => {
      const c = capture();
      const responses = [resumable(), new Response(null, { status: 202 })];
      const fetch = withMcpTelemetry(async () => responses.shift()!, { recorder: c.recorder, waitUntil: c.schedule });
      await (await fetch(request(metaCall(1)))).text();
      await fetch(request({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }));
      const events = await c.settle();
      expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'canceled' });
      expect(charges(events)).toMatchObject([
        { operation_id: operation(events, 'tools/call').start.operation_id, external_ref: '0xheader' },
      ]);
    });

    it('charges the header settlement when the session is deleted after a resumable drop', async () => {
      const c = capture();
      const responses = [resumable(), new Response(null, { status: 200 })];
      const fetch = withMcpTelemetry(async () => responses.shift()!, { recorder: c.recorder, waitUntil: c.schedule });
      await (await fetch(request(metaCall(1)))).text();
      await fetch(new Request('https://hand.example/mcp', { method: 'DELETE', headers: sessionHeaders }));
      const events = await c.settle();
      expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
      expect(charges(events)).toHaveLength(1);
    });

    it('charges a 500 that carries a settlement, and records a failed settlement on a 402', async () => {
      const c = capture();
      const responses = [
        new Response('boom', { status: 500, headers: { 'x-payment-response': b64(headerSettlement) } }),
        new Response('pay first', { status: 402, headers: { 'x-payment-response': b64({ success: false, network: 'base' }) } }),
        new Response('who are you', { status: 401, headers: { 'x-payment-response': b64(headerSettlement) } }),
      ];
      const fetch = withMcpTelemetry(async () => responses.shift()!, { recorder: c.recorder, waitUntil: c.schedule });
      for (const id of [1, 2, 3])
        await fetch(request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search' } }, { 'mcp-session-id': `s${id}` }));
      const events = await c.settle();
      expect(charges(events)).toMatchObject([
        { operation_id: operation(events, 'tools/call', 0).start.operation_id, status: 'settled' },
        { operation_id: operation(events, 'tools/call', 1).start.operation_id, status: 'failed' },
      ]);
      expect(charges(events)).toHaveLength(2);
    });

    it('charges a call once when _meta and header evidence both arrive', async () => {
      const c = capture();
      const fetch = withMcpTelemetry(
        async () =>
          Response.json(
            { jsonrpc: '2.0', id: 1, result: { content: [], _meta: { 'x402/payment-response': metaSettlement } } },
            { headers: { 'x-payment-response': b64(headerSettlement) } },
          ),
        { recorder: c.recorder, waitUntil: c.schedule },
      );
      await fetch(request(metaCall(1)));
      expect(charges(await c.settle())).toMatchObject([{ external_ref: '0xmeta' }]);
    });
  });
});
