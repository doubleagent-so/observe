import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { Recorder } from '../src/index';
import { instrumentMcpTransport, type OnOperation } from '../src/mcp/index';
import { flightsServer, samplingClient } from './mcp-fixtures';
import { capture, expectValid, operation, starts, subjectHash } from './support';

interface SessionOptions {
  serverRecorder?: Recorder;
  clientRecorder?: Recorder;
  auth?: boolean;
  onOperation?: OnOperation;
}

/** Records every message as it goes on the wire; optionally attaches authInfo to client → server messages. */
function tap(transport: InMemoryTransport, wire: string[], auth: boolean): void {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    wire.push(JSON.stringify(message));
    return send(message, auth ? { ...options, authInfo: { token: 'secret-token', clientId: 'svc-1', scopes: [] } } : options);
  };
}

async function connect(options: SessionOptions = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const wire: string[] = [];
  tap(clientSide, wire, options.auth ?? false);
  tap(serverSide, wire, false);
  const server = flightsServer();
  await server.connect(
    options.serverRecorder
      ? instrumentMcpTransport(serverSide, {
          recorder: options.serverRecorder,
          role: 'server',
          binding: 'stdio',
          issuer: 'https://idp.example',
          onOperation: options.onOperation,
        })
      : serverSide,
  );
  const client = samplingClient();
  await client.connect(
    options.clientRecorder
      ? instrumentMcpTransport(clientSide, {
          recorder: options.clientRecorder,
          role: 'client',
          binding: 'stdio',
          serverUrl: 'https://flights.example/mcp',
        })
      : clientSide,
  );
  return { client, wire };
}

async function script(client: Client): Promise<unknown[]> {
  return [
    await client.listTools(),
    await client.callTool({ name: 'search', arguments: { to: 'Lisbon' } }),
    await client.callTool({ name: 'fail' }),
    await client.readResource({ uri: 'docs://guide?lang=en' }),
    await client.getPrompt({ name: 'plan', arguments: { city: 'Porto' } }),
    await client.callTool({ name: 'ask' }),
  ];
}

/** Resolves when the server has started the `slow` tool call. */
function slowStarted(): { onOperation: OnOperation; started: Promise<void> } {
  let resolve!: () => void;
  const started = new Promise<void>((done) => {
    resolve = done;
  });
  return { started, onOperation: (_op, info) => void (info.target === 'slow' && resolve()) };
}

describe('instrumentMcpTransport with the SDK', () => {
  it('records a server session: initialize, discovery, tools, resource, prompt and a sampling callback', async () => {
    const server = capture();
    const client = capture();
    const { client: mcp } = await connect({ serverRecorder: server.recorder, clientRecorder: client.recorder });
    await script(mcp);
    const events = await server.settle();

    const init = operation(events, 'initialize');
    expect(init.start).toMatchObject({
      direction: 'inbound',
      kind: 'discovery',
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'stdio' },
      mcp: { request_id: '0', client_info: { name: 'claude-test', version: '0.9.0' }, capabilities: ['sampling'] },
      counterparty: {
        client_info: { name: 'claude-test', version: '0.9.0' },
        advertised_protocols: [{ name: 'mcp', versions: ['2025-11-25'], bindings: ['stdio'], capabilities: ['sampling'] }],
      },
    });
    expect(init.start.conversation_ref).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Set(starts(events).map((event) => event.conversation_ref))).toEqual(new Set([init.start.conversation_ref]));
    expect(operation(events, 'tools/list').start.kind).toBe('discovery');

    const search = operation(events, 'tools/call', 0);
    expect(search.start).toMatchObject({ kind: 'tool', target: 'search', counterparty: { client_info: { name: 'claude-test' } } });
    expect(search.messages.map((message) => [message.role, message.content?.parts])).toEqual([
      ['caller', [{ kind: 'data', json: { to: 'Lisbon' }, truncated: false }]],
      [
        'agent',
        [
          { kind: 'text', text: '3 flights to Lisbon', truncated: false },
          { kind: 'data', json: { count: 3 }, truncated: false },
        ],
      ],
    ]);
    expect(search.finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({
      outcome: 'tool_error',
      error: { native_code: 'isError', code: 'tool_error' },
    });
    expect(operation(events, 'resources/read').start.target).toBe('docs://guide');
    expect(operation(events, 'resources/read').messages[0].parts).toEqual([{ kind: 'text', media_type: 'text/markdown', bytes: 7 }]);
    expect(operation(events, 'prompts/get').start.target).toBe('plan');
    expect(operation(events, 'prompts/get').messages[0]).toMatchObject({ role: 'caller' });
    const sampling = operation(events, 'sampling/createMessage');
    expect(sampling.start).toMatchObject({ direction: 'outbound', kind: 'callback' });
    expect(sampling.finish).toMatchObject({ outcome: 'ok' });
    expectValid(server.batches);

    const outbound = await client.settle();
    expect(operation(outbound, 'initialize').start).toMatchObject({
      direction: 'outbound',
      counterparty: { card_url: 'https://flights.example' },
    });
    expect(operation(outbound, 'tools/call').start).toMatchObject({
      direction: 'outbound',
      counterparty: { declared_name: 'flights', card_url: 'https://flights.example' },
    });
    expect(operation(outbound, 'sampling/createMessage').start).toMatchObject({ direction: 'inbound', kind: 'callback' });
    expectValid(client.batches);
  });

  it('delivers the same messages in the same order, and the same results, as an uninstrumented session', async () => {
    const plain = await connect();
    const plainResults = await script(plain.client);
    const observed = await connect({ serverRecorder: capture().recorder, clientRecorder: capture().recorder });
    const observedResults = await script(observed.client);
    expect(observed.wire).toEqual(plain.wire);
    expect(observedResults).toEqual(plainResults);
  });

  it('hands the SDK the very same message object and returns its handler', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const wrapped = instrumentMcpTransport(serverSide, { recorder: capture().recorder, role: 'server', binding: 'stdio' });
    const received: unknown[][] = [];
    const handler = (...args: unknown[]) => void received.push(args);
    wrapped.onmessage = handler;
    expect(wrapped.onmessage).toBe(handler);
    await wrapped.start();
    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
    await clientSide.send(message);
    expect(received[0][0]).toBe(message);
  });

  it('records a cancelled tool call as canceled on both sides', async () => {
    const server = capture();
    const client = capture();
    const { started, onOperation } = slowStarted();
    const { client: mcp } = await connect({ serverRecorder: server.recorder, clientRecorder: client.recorder, onOperation });
    const controller = new AbortController();
    const call = mcp.callTool({ name: 'slow' }, undefined, { signal: controller.signal });
    await started;
    controller.abort('user stopped');
    await expect(call).rejects.toThrow();
    expect(operation(await server.settle(), 'tools/call').finish).toMatchObject({ outcome: 'canceled' });
    expect(operation(await client.settle(), 'tools/call').finish).toMatchObject({ outcome: 'canceled' });
  });

  it('finishes a pending request as transport_error when the connection closes', async () => {
    const server = capture();
    const client = capture();
    const { started, onOperation } = slowStarted();
    const { client: mcp } = await connect({ serverRecorder: server.recorder, clientRecorder: client.recorder, onOperation });
    const call = mcp.callTool({ name: 'slow' });
    await started;
    await mcp.close();
    await expect(call).rejects.toThrow();
    expect(operation(await server.settle(), 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
    expect(operation(await client.settle(), 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
  });

  it('records the authenticated client from authInfo without sending the token or the raw client ID', async () => {
    const server = capture();
    const { client: mcp } = await connect({ serverRecorder: server.recorder, auth: true });
    await mcp.callTool({ name: 'search', arguments: { to: 'Faro' } });
    const events = await server.settle();
    expect(operation(events, 'tools/call').start.counterparty.authenticated).toEqual({
      issuer: 'https://idp.example',
      subject_hash: await subjectHash('https://idp.example', 'svc-1'),
    });
    expect(JSON.stringify(server.batches)).not.toMatch(/svc-1|secret-token/);
  });

  it('keeps the session working when the onOperation hook throws', async () => {
    const server = capture();
    const { client: mcp } = await connect({
      serverRecorder: server.recorder,
      onOperation: () => {
        throw new Error('host bug');
      },
    });
    await expect(mcp.callTool({ name: 'search', arguments: { to: 'Faro' } })).resolves.toMatchObject({ structuredContent: { count: 3 } });
    expect(operation(await server.settle(), 'tools/call').finish).toMatchObject({ outcome: 'ok' });
  });

  it('wraps transports with accessors, private state and extra methods', async () => {
    class SessionTransport {
      readonly #inner: InMemoryTransport;
      constructor(inner: InMemoryTransport) {
        this.#inner = inner;
      }
      get sessionId(): string {
        return 'sess-1';
      }
      get onmessage(): InMemoryTransport['onmessage'] {
        return this.#inner.onmessage;
      }
      set onmessage(handler: InMemoryTransport['onmessage']) {
        this.#inner.onmessage = handler;
      }
      get onclose(): InMemoryTransport['onclose'] {
        return this.#inner.onclose;
      }
      set onclose(handler: InMemoryTransport['onclose']) {
        this.#inner.onclose = handler;
      }
      start(): Promise<void> {
        return this.#inner.start();
      }
      send(message: JSONRPCMessage): Promise<void> {
        return this.#inner.send(message);
      }
      close(): Promise<void> {
        return this.#inner.close();
      }
      describe(): string {
        return this.#inner ? 'reachable' : 'lost';
      }
    }
    const server = capture();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const wrapped = instrumentMcpTransport(new SessionTransport(serverSide), {
      recorder: server.recorder,
      role: 'server',
      binding: 'streamable-http',
    });
    expect(wrapped).toBeInstanceOf(SessionTransport);
    expect(wrapped.constructor).toBe(SessionTransport);
    expect(wrapped.describe()).toBe('reachable');
    await flightsServer().connect(wrapped);
    const client = samplingClient();
    await client.connect(clientSide);
    await client.callTool({ name: 'search', arguments: { to: 'Faro' } });
    const events = await server.settle();
    expect(new Set(starts(events).map((event) => event.conversation_ref))).toEqual(new Set(['sess-1']));
    expectValid(server.batches);
  });

  it('finishes a request as transport_error when sending it fails, and rethrows the same error', async () => {
    const c = capture();
    const failure = new Error('pipe closed');
    const broken = {
      async send(_message: unknown): Promise<void> {
        throw failure;
      },
    };
    const wrapped = instrumentMcpTransport(broken, { recorder: c.recorder, role: 'client', binding: 'stdio' });
    await expect(wrapped.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } })).rejects.toBe(failure);
    expect(operation(await c.settle(), 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
  });

  it('delivers every message and runs the session when recording itself throws', async () => {
    const c = capture();
    const broken = new Proxy(c.recorder, {
      get(target, property) {
        if (property === 'startOperation')
          return () => {
            throw new Error('recorder bug');
          };
        return Reflect.get(target, property, target);
      },
    });
    const logs: string[] = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const log = (event: string) => void logs.push(event);
    await flightsServer().connect(instrumentMcpTransport(serverSide, { recorder: broken, role: 'server', binding: 'stdio', log }));
    const client = samplingClient();
    await client.connect(instrumentMcpTransport(clientSide, { recorder: broken, role: 'client', binding: 'stdio', log }));
    await expect(client.callTool({ name: 'search', arguments: { to: 'Faro' } })).resolves.toMatchObject({
      structuredContent: { count: 3 },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(new Set(logs)).toEqual(new Set(['agent_telemetry_event_failed']));
  });

  it('logs a failing finish on close and still calls the SDK handler', () => {
    const c = capture();
    const failingFinish = new Proxy(c.recorder, {
      get(target, property) {
        if (property !== 'startOperation') return Reflect.get(target, property, target);
        return (...args: Parameters<Recorder['startOperation']>) => ({
          ...target.startOperation(...args),
          finish: () => {
            throw new Error('finish bug');
          },
        });
      },
    });
    let close!: () => void;
    const stub = {
      async send(_message: unknown): Promise<void> {},
      set onclose(handler: () => void) {
        close = handler;
      },
      get onclose() {
        return close;
      },
    };
    const logs: string[] = [];
    const wrapped = instrumentMcpTransport(stub, {
      recorder: failingFinish,
      role: 'client',
      binding: 'stdio',
      log: (event) => void logs.push(event),
    });
    let closed = false;
    wrapped.onclose = () => {
      closed = true;
    };
    void wrapped.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    close();
    expect(closed).toBe(true);
    expect(logs).toEqual(['agent_telemetry_event_failed']);
  });

  it('forwards other property writes, reads and `in` checks to the original transport', () => {
    const original = { extra: 1, async send(_message: unknown): Promise<void> {} };
    const wrapped = instrumentMcpTransport(original, { recorder: capture().recorder, role: 'server', binding: 'other' });
    (wrapped as { extra: number }).extra = 2;
    expect(original.extra).toBe(2);
    expect('extra' in wrapped).toBe(true);
    expect(wrapped.extra).toBe(2);
  });

  it('finishes pending requests once even when the transport reports close twice', async () => {
    const c = capture();
    let close!: () => void;
    const stub = {
      async send(_message: unknown): Promise<void> {},
      set onclose(handler: () => void) {
        close = handler;
      },
      get onclose() {
        return close;
      },
    };
    const wrapped = instrumentMcpTransport(stub, { recorder: c.recorder, role: 'client', binding: 'stdio' });
    let closes = 0;
    wrapped.onclose = () => void closes++;
    await wrapped.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    close();
    close();
    expect(closes).toBe(2);
    expect(operation(await c.settle(), 'ping').finishes).toBe(1);
  });

  it('reads the protocol version header from Headers objects and header arrays', async () => {
    const c = capture();
    let deliver!: (message: unknown, extra: unknown) => void;
    const stub = {
      async send(_message: unknown): Promise<void> {},
      set onmessage(handler: (message: unknown, extra: unknown) => void) {
        deliver = handler;
      },
      get onmessage() {
        return deliver;
      },
    };
    instrumentMcpTransport(stub, { recorder: c.recorder, role: 'server', binding: 'streamable-http' });
    deliver({ jsonrpc: '2.0', id: 1, method: 'ping' }, { requestInfo: { headers: new Headers({ 'mcp-protocol-version': '2025-06-18' }) } });
    deliver({ jsonrpc: '2.0', id: 2, method: 'ping' }, { requestInfo: { headers: { 'mcp-protocol-version': ['2024-11-05'] } } });
    deliver({ jsonrpc: '2.0', id: 3, method: 'ping' }, { requestInfo: 'junk' });
    deliver({ jsonrpc: '2.0', id: 4, method: 'ping' }, { requestInfo: { headers: 'junk' } });
    deliver({ jsonrpc: '2.0', id: 5, method: 'ping' }, { requestInfo: { headers: { 'mcp-protocol-version': [7] } } });
    deliver({ jsonrpc: '2.0', id: 6, method: 'ping' }, { requestInfo: { headers: { 'MCP-Protocol-Version': '2025-11-25' } } });
    const headersLike = { get: (name: string) => (name === 'mcp-protocol-version' ? '2025-06-18' : null) };
    deliver({ jsonrpc: '2.0', id: 7, method: 'ping' }, { requestInfo: { headers: headersLike } });
    const versions = starts(await c.settle()).map((event) => event.protocol.version);
    // The last valid hint is kept for messages without one.
    expect(versions).toEqual(['2025-06-18', '2024-11-05', '2024-11-05', '2024-11-05', '2024-11-05', '2025-11-25', '2025-06-18']);
  });

  it('delivers every message and resolves send when both the recorder and the host log throw', async () => {
    const c = capture();
    const broken = new Proxy(c.recorder, {
      get(target, property) {
        if (property === 'startOperation')
          return () => {
            throw new Error('recorder bug');
          };
        return Reflect.get(target, property, target);
      },
    });
    const log = () => {
      throw new Error('log bug');
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await flightsServer().connect(instrumentMcpTransport(serverSide, { recorder: broken, role: 'server', binding: 'stdio', log }));
    const client = samplingClient();
    const wrapped = instrumentMcpTransport(clientSide, { recorder: broken, role: 'client', binding: 'stdio', log });
    await client.connect(wrapped);
    await expect(client.callTool({ name: 'search', arguments: { to: 'Faro' } })).resolves.toMatchObject({
      structuredContent: { count: 3 },
    });
    await expect(wrapped.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).resolves.toBeUndefined();
  });
});
