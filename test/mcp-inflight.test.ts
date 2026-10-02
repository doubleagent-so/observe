import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OperationHandle, Recorder } from '../src/index';
import { instrumentMcpTransport, mcpOperation, withMcpTelemetry, type McpHandlerExtra } from '../src/mcp/index';
import { trackInflight } from '../src/mcp/inflight';
import { flightsServer, samplingClient } from './mcp-fixtures';
import { capture, operation } from './support';

/** A server whose `probe` tool records what `mcpOperation` returns, by tag, and remembers the handler's extra. */
function probeServer(recorder: Recorder, found: Map<string, OperationHandle | undefined>, extras: McpHandlerExtra[]): McpServer {
  const server = flightsServer();
  server.registerTool('probe', { description: 'Finds its own operation', inputSchema: { tag: z.string() } }, async ({ tag }, extra) => {
    found.set(tag, mcpOperation(recorder, extra));
    extras.push(extra);
    return { content: [{ type: 'text', text: tag }] };
  });
  return server;
}

/** Collects the handle of every tools/call operation by its `tag` argument. */
function byTag(): { seen: Map<string, OperationHandle>; onOperation: (op: OperationHandle, info: { params?: unknown }) => void } {
  const seen = new Map<string, OperationHandle>();
  return {
    seen,
    onOperation: (op, info) => {
      const tag = (info.params as { arguments?: { tag?: string } } | undefined)?.arguments?.tag;
      if (tag) seen.set(tag, op);
    },
  };
}

describe('mcpOperation', () => {
  it('returns the handler its own operation over stdio-like transports, and nothing once it finished', async () => {
    const c = capture();
    const found = new Map<string, OperationHandle | undefined>();
    const extras: McpHandlerExtra[] = [];
    const { seen, onOperation } = byTag();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await probeServer(c.recorder, found, extras).connect(
      instrumentMcpTransport(serverSide, { recorder: c.recorder, role: 'server', binding: 'stdio', onOperation }),
    );
    const client = samplingClient();
    await client.connect(clientSide);
    await client.callTool({ name: 'probe', arguments: { tag: 'a' } });
    expect(found.get('a')).toBeDefined();
    expect(found.get('a')).toBe(seen.get('a'));
    expect(mcpOperation(c.recorder, extras[0])).toBeUndefined();
    const events = await c.settle();
    expect(operation(events, 'tools/call').start.operation_id).toBe(found.get('a')!.operationId);
  });

  it('finds the operation in a stateful session and in concurrent stateless requests that reuse ids', async () => {
    const c = capture();
    const found = new Map<string, OperationHandle | undefined>();
    const { seen, onOperation } = byTag();

    const stateful = instrumentMcpTransport(new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'session-1' }), {
      recorder: c.recorder,
      role: 'server',
      binding: 'streamable-http',
      onOperation,
    });
    const ready = probeServer(c.recorder, found, []).connect(stateful);
    const statefulFetch: FetchLike = async (input, init) => {
      await ready;
      return stateful.handleRequest(new Request(input, init));
    };
    const statelessFetch: FetchLike = async (input, init) => {
      const transport = instrumentMcpTransport(new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined }), {
        recorder: c.recorder,
        role: 'server',
        binding: 'streamable-http',
        onOperation,
      });
      await probeServer(c.recorder, found, []).connect(transport);
      return transport.handleRequest(new Request(input, init));
    };
    const connect = async (fetch: FetchLike): Promise<Client> => {
      const client = samplingClient();
      await client.connect(new StreamableHTTPClientTransport(new URL('https://flights.example/mcp'), { fetch }));
      return client;
    };

    const one = await connect(statefulFetch);
    await one.callTool({ name: 'probe', arguments: { tag: 'stateful' } });
    const [left, right] = await Promise.all([connect(statelessFetch), connect(statelessFetch)]);
    await Promise.all([
      left.callTool({ name: 'probe', arguments: { tag: 'left' } }),
      right.callTool({ name: 'probe', arguments: { tag: 'right' } }),
    ]);
    for (const client of [one, left, right]) await client.close();
    await stateful.close();

    for (const tag of ['stateful', 'left', 'right']) {
      expect(found.get(tag), tag).toBeDefined();
      expect(found.get(tag), tag).toBe(seen.get(tag));
    }
    expect(found.get('left')).not.toBe(found.get('right'));
  });

  it('returns undefined rather than guessing when two connections share a key, and for unknown recorders', () => {
    const c = capture();
    const a = c.recorder.startOperation({
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'stdio' },
      direction: 'inbound',
      method: 'tools/call',
      kind: 'tool',
    });
    const b = c.recorder.startOperation({
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'stdio' },
      direction: 'inbound',
      method: 'tools/call',
      kind: 'tool',
    });
    const releaseA = trackInflight(c.recorder, {}, 1, a);
    expect(mcpOperation(c.recorder, { requestId: 1 })).toBe(a);
    const releaseB = trackInflight(c.recorder, {}, 1, b);
    expect(mcpOperation(c.recorder, { requestId: 1 })).toBeUndefined();
    releaseA();
    releaseB();
    expect(mcpOperation(c.recorder, { requestId: 1 })).toBeUndefined();
    const releaseSession = trackInflight(c.recorder, { sessionId: 's1' }, '1', a);
    expect(mcpOperation(c.recorder, { sessionId: 's1', requestId: '1' })).toBe(a);
    // The JSON-RPC ids "1" and 1 are different requests.
    expect(mcpOperation(c.recorder, { sessionId: 's1', requestId: 1 })).toBeUndefined();
    releaseSession();
    expect(mcpOperation(c.recorder, { sessionId: 's1', requestId: '1' })).toBeUndefined();
    expect(mcpOperation(capture().recorder, { requestId: 1 })).toBeUndefined();
  });

  it('lets a hand-rolled handler behind withMcpTelemetry find its operation', async () => {
    const c = capture();
    const found: (OperationHandle | undefined)[] = [];
    const fetch = withMcpTelemetry(
      async (request: Request) => {
        found.push(
          mcpOperation(c.recorder, { sessionId: request.headers.get('mcp-session-id') ?? undefined, requestId: 1, requestInfo: request }),
        );
        return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [] } });
      },
      { recorder: c.recorder, waitUntil: c.schedule },
    );
    const call = (headers: Record<string, string>) =>
      fetch(
        new Request('https://hand.example/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } }),
        }),
      );
    await call({ 'mcp-session-id': 'hand-1' });
    await call({});
    const events = await c.settle();
    expect(found.map((op) => op?.operationId)).toEqual([0, 1].map((nth) => operation(events, 'tools/call', nth).start.operation_id));
  });

  it("never hands out another live request's operation after a shared key is partly released", () => {
    const c = capture();
    const start = () =>
      c.recorder.startOperation({
        protocol: { name: 'mcp', version: '2025-11-25', binding: 'stdio' },
        direction: 'inbound',
        method: 'ping',
        kind: 'management',
      });
    const [a, b, d] = [start(), start(), start()];
    const releaseA = trackInflight(c.recorder, {}, 7, a);
    const releaseB = trackInflight(c.recorder, {}, 7, b);
    releaseA();
    expect(mcpOperation(c.recorder, { requestId: 7 })).toBe(b);
    const releaseD = trackInflight(c.recorder, {}, 7, d);
    expect(mcpOperation(c.recorder, { requestId: 7 })).toBeUndefined();
    releaseB();
    expect(mcpOperation(c.recorder, { requestId: 7 })).toBe(d);
    releaseD();
    releaseD();
    expect(mcpOperation(c.recorder, { requestId: 7 })).toBeUndefined();
    const request = {};
    const releaseFirst = trackInflight(c.recorder, { request }, 1, a);
    const releaseSecond = trackInflight(c.recorder, { request }, 1, b);
    expect(mcpOperation(c.recorder, { requestId: 1, requestInfo: request })).toBeUndefined();
    releaseFirst();
    expect(mcpOperation(c.recorder, { requestId: 1, requestInfo: request })).toBe(b);
    releaseSecond();
    expect(mcpOperation(c.recorder, { requestId: 1, requestInfo: request })).toBeUndefined();
    expect(mcpOperation(c.recorder, undefined as unknown as { requestId: number })).toBeUndefined();
    expect(mcpOperation(c.recorder, { requestId: {} as unknown as number })).toBeUndefined();
  });

  it('releases a request when it is cancelled, evicted or its connection closes', async () => {
    const c = capture();
    const { createMcpEngine } = await import('../src/mcp/engine');
    const { MAX_PENDING, newSession } = await import('../src/mcp/session');
    const engine = createMcpEngine({ recorder: c.recorder, role: 'server', binding: 'stdio', log: () => {} });
    const session = newSession('s9');
    const scope = { sessionId: 's9' };
    const request = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
    engine.observe('peer', request(1), { session, scope });
    expect(mcpOperation(c.recorder, { sessionId: 's9', requestId: 1 })).toBeDefined();
    engine.observe('peer', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { session, scope });
    expect(mcpOperation(c.recorder, { sessionId: 's9', requestId: 1 })).toBeUndefined();
    for (let id = 2; id <= MAX_PENDING + 2; id++) engine.observe('peer', request(id), { session, scope });
    expect(mcpOperation(c.recorder, { sessionId: 's9', requestId: 2 })).toBeUndefined();
    expect(mcpOperation(c.recorder, { sessionId: 's9', requestId: 3 })).toBeDefined();
    engine.close(session);
    expect(mcpOperation(c.recorder, { sessionId: 's9', requestId: 3 })).toBeUndefined();
    engine.observe('self', request(5), { session, scope });
    expect(mcpOperation(c.recorder, { sessionId: 's9', requestId: 5 })).toBeUndefined();
  });
});
