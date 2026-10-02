import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpEngine, type McpOperationInfo, type StartedRequest } from '../src/mcp/engine';
import { MAX_PENDING, mcpSessions, newSession } from '../src/mcp/session';
import { capture, expectValid, operation, starts, subjectHash } from './support';

const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const ok = (id: number | string, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: number | string, code: number) => ({ jsonrpc: '2.0', id, error: { code, message: 'x' } });
const note = (method: string, params?: unknown) => ({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
const quiet = () => {};

function server(binding: 'streamable-http' | 'stdio' = 'streamable-http') {
  const c = capture();
  const engine = createMcpEngine({ recorder: c.recorder, role: 'server', binding, log: (event) => void c.logs.push(event) });
  return { ...c, engine };
}

afterEach(() => vi.useRealTimers());

describe('server role', () => {
  it('pairs requests per direction and carries initialize facts on later operations', async () => {
    const { engine, settle, batches } = server();
    const session = newSession('session-1');
    engine.observe(
      'peer',
      req(0, 'initialize', {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'claude-ai', version: '0.1.0' },
        capabilities: { sampling: {}, elicitation: {} },
      }),
      { session },
    );
    engine.observe('self', ok(0, { protocolVersion: '2025-06-18', serverInfo: { name: 'flights', version: '1' }, capabilities: {} }), {
      session,
    });
    engine.observe('peer', req(1, 'tools/call', { name: 'search', arguments: { to: 'Lisbon' } }), {
      session,
      authInfo: { token: 'secret-token', clientId: 'svc-1', scopes: [] },
    });
    engine.observe(
      'self',
      req(1, 'sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: 'summarize' } }], maxTokens: 5 }),
      { session },
    );
    engine.observe('peer', ok(1, { role: 'assistant', content: { type: 'text', text: 'sampled' }, model: 'm' }), { session });
    engine.observe('self', ok(1, { content: [{ type: 'text', text: 'found' }] }), { session });
    const events = await settle();

    const init = operation(events, 'initialize');
    expect(init.start).toMatchObject({
      direction: 'inbound',
      kind: 'discovery',
      conversation_ref: 'session-1',
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'streamable-http' },
      mcp: { request_id: '0', client_info: { name: 'claude-ai', version: '0.1.0' }, capabilities: ['sampling', 'elicitation'] },
    });
    const tool = operation(events, 'tools/call');
    expect(tool.start).toMatchObject({
      direction: 'inbound',
      kind: 'tool',
      target: 'search',
      protocol: { version: '2025-06-18' },
      mcp: { request_id: '1' },
      counterparty: {
        client_info: { name: 'claude-ai', version: '0.1.0' },
        authenticated: { issuer: 'mcp', subject_hash: await subjectHash('mcp', 'svc-1') },
        advertised_protocols: [
          { name: 'mcp', versions: ['2025-11-25'], bindings: ['streamable-http'], capabilities: ['sampling', 'elicitation'] },
        ],
      },
    });
    expect(tool.start.mcp).not.toHaveProperty('client_info');
    expect(tool.messages.map((message) => [message.role, message.content?.parts])).toEqual([
      ['caller', [{ kind: 'data', json: { to: 'Lisbon' }, truncated: false }]],
      ['agent', [{ kind: 'text', text: 'found', truncated: false }]],
    ]);
    expect(tool.finish).toMatchObject({ outcome: 'ok' });
    const sampling = operation(events, 'sampling/createMessage');
    expect(sampling.start).toMatchObject({ direction: 'outbound', kind: 'callback', conversation_ref: 'session-1' });
    expect(sampling.messages.map((message) => message.role)).toEqual(['caller', 'agent']);
    expect(sampling.finish).toMatchObject({ outcome: 'ok' });
    expect(JSON.stringify(batches)).not.toMatch(/svc-1|secret-token/);
    expectValid(batches);
  });

  it('records tool errors and protocol errors and ignores unknown, duplicate and malformed messages', async () => {
    const { engine, settle, batches } = server();
    const session = newSession('session-1');
    engine.observe(
      'peer',
      [
        req(2, 'tools/call', { name: 'broken' }),
        req(3, 'resources/read', { uri: 'docs://missing?x=1' }),
        note('notifications/initialized'),
      ],
      {
        session,
      },
    );
    engine.observe('self', [ok(2, { content: [{ type: 'text', text: 'nope' }], isError: true }), fail(3, -32002)], { session });
    engine.observe('self', ok(2, { content: [] }), { session });
    engine.observe('self', ok(99, {}), { session });
    engine.observe('self', { jsonrpc: '2.0', id: null, error: { code: -32700 } }, { session });
    engine.observe('peer', 'garbage', { session });
    engine.observe('peer', [null, 7], { session });
    const events = await settle();
    expect(starts(events)).toHaveLength(2);
    const broken = operation(events, 'tools/call');
    expect(broken.finish).toMatchObject({ outcome: 'tool_error', error: { native_code: 'isError', code: 'tool_error' } });
    expect(broken.finishes).toBe(1);
    const read = operation(events, 'resources/read');
    expect(read.start.target).toBe('docs://missing');
    expect(read.finish).toMatchObject({ outcome: 'protocol_error', error: { native_code: '-32002', code: 'resource_not_found' } });
    expectValid(batches);
  });

  it('finishes cancelled requests in both directions and everything pending on close', async () => {
    const { engine, settle } = server();
    const session = newSession('session-1');
    engine.observe('peer', req(4, 'tools/call', { name: 'slow' }), { session });
    engine.observe('peer', note('notifications/cancelled', { requestId: 4, reason: 'user' }), { session });
    engine.observe('self', ok(4, { content: [] }), { session });
    engine.observe('self', req(5, 'roots/list'), { session });
    engine.observe('self', note('notifications/cancelled', { requestId: 5 }), { session });
    engine.observe('peer', note('notifications/cancelled', { requestId: 404 }), { session });
    engine.observe('peer', req(6, 'tools/call', { name: 'slower' }), { session });
    engine.observe('self', req(7, 'elicitation/create', { message: 'confirm?' }), { session });
    engine.close(session);
    const events = await settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'canceled' });
    expect(operation(events, 'tools/call', 0).finishes).toBe(1);
    expect(operation(events, 'roots/list').finish).toMatchObject({ outcome: 'canceled', direction: 'outbound' });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'transport_error' });
    expect(operation(events, 'elicitation/create').finish).toMatchObject({ outcome: 'transport_error' });
    expect(session.pending.size).toBe(0);
  });

  it('records MCP task states once per change on the linked operation', async () => {
    const { engine, settle, batches } = server();
    const session = newSession('session-1');
    engine.observe('peer', req(8, 'tools/call', { name: 'report', arguments: {}, task: { ttl: 60_000 } }), { session });
    engine.observe('self', ok(8, { task: { taskId: 'task-1', status: 'working', ttl: 60_000, createdAt: 'x', lastUpdatedAt: 'x' } }), {
      session,
    });
    engine.observe('self', note('notifications/tasks/status', { taskId: 'task-1', status: 'working' }), { session });
    engine.observe('self', note('notifications/tasks/status', { taskId: 'task-1', status: 'input_required' }), { session });
    engine.observe('peer', req(9, 'tasks/get', { taskId: 'task-1' }), { session });
    engine.observe('self', ok(9, { taskId: 'task-1', status: 'input_required' }), { session });
    engine.observe('peer', req(10, 'tasks/result', { taskId: 'task-1' }), { session });
    engine.observe('self', note('notifications/tasks/status', { taskId: 'task-1', status: 'completed' }), { session });
    engine.observe('self', ok(10, { content: [{ type: 'text', text: 'report ready' }] }), { session });
    engine.observe('self', note('notifications/tasks/status', { taskId: 'task-elsewhere', status: 'cancelled' }), { session });
    const events = await settle();
    const call = operation(events, 'tools/call');
    expect(call.tasks.map((task) => task.state)).toEqual(['working', 'input_required']);
    expect(call.finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tasks/get').start).toMatchObject({ kind: 'management', task_ref: 'task-1' });
    expect(operation(events, 'tasks/get').tasks).toEqual([]);
    const result = operation(events, 'tasks/result');
    expect(result.tasks.map((task) => task.state)).toEqual(['completed']);
    expect(result.messages[0]).toMatchObject({ role: 'agent' });
    const elsewhere = operation(events, 'notifications/tasks/status');
    expect(elsewhere.start).toMatchObject({ kind: 'management', direction: 'inbound', task_ref: 'task-elsewhere' });
    expect(elsewhere.tasks).toMatchObject([{ state: 'canceled', native_state: 'cancelled' }]);
    expect(elsewhere.finish).toMatchObject({ outcome: 'ok' });
    expectValid(batches);
  });

  it('cleans refs, uses version hints and bounds pending requests', async () => {
    const { engine, settle, batches } = server();
    const odd = newSession('has space');
    engine.observe('peer', req(1, 'ping'), { session: odd, versionHint: '2025-06-18' });
    engine.observe('peer', req(2, 'ping'), { session: odd, versionHint: 'bogus value!' });
    engine.observe('peer', req(3, 'ping'), { session: newSession(), versionHint: 'bogus value!' });
    const stdio = server('stdio');
    stdio.engine.observe('peer', req(1, 'ping'), { session: newSession() });
    const bounded = newSession('session-2');
    for (let id = 0; id <= MAX_PENDING; id++) engine.observe('peer', req(id, 'ping'), { session: bounded });
    engine.observe('self', ok(0, {}), { session: bounded });
    engine.observe('self', ok(MAX_PENDING, {}), { session: bounded });
    const events = await settle();
    const pings = starts(events);
    expect(pings[0]).not.toHaveProperty('conversation_ref');
    expect(pings[0].protocol.version).toBe('2025-06-18');
    // An invalid hint keeps the session's last valid one; a session without one uses the HTTP default.
    expect(pings[1].protocol.version).toBe('2025-06-18');
    expect(pings[2].protocol.version).toBe('2025-03-26');
    expect(starts(await stdio.settle())[0].protocol.version).toBe('unknown');
    // The evicted oldest request is finished as transport_error; the answered newest one ok.
    expect(events.filter((event) => event.type === 'operation.finished')).toHaveLength(2);
    expectValid(batches);
  });

  it('passes every operation to the hook and survives a throwing hook', async () => {
    const c = capture();
    const seen: McpOperationInfo[] = [];
    const engine = createMcpEngine({
      recorder: c.recorder,
      role: 'server',
      binding: 'stdio',
      onOperation: (_op, info) => void seen.push(info),
      log: quiet,
    });
    const session = newSession('s1');
    engine.observe('peer', req(1, 'tools/call', { name: 'search', arguments: { q: 1 } }), { session });
    expect(seen).toEqual([
      {
        method: 'tools/call',
        kind: 'tool',
        direction: 'inbound',
        target: 'search',
        requestId: 1,
        sessionId: 's1',
        params: { name: 'search', arguments: { q: 1 } },
      },
    ]);
    const logs: string[] = [];
    const throwing = createMcpEngine({
      recorder: c.recorder,
      role: 'server',
      binding: 'stdio',
      onOperation: () => {
        throw new Error('host bug');
      },
      log: (event) => void logs.push(event),
    });
    throwing.observe('peer', req(2, 'tools/call', { name: 'search' }), { session });
    throwing.observe('self', ok(2, { content: [] }), { session });
    expect(logs).toEqual(['agent_telemetry_hook_failed']);
    expect(operation(await c.settle(), 'tools/call', 1).finish).toMatchObject({ outcome: 'ok' });
  });

  it('honours an explicit start time and host evidence', async () => {
    const { engine, settle } = server();
    const session = newSession('s1');
    engine.observe('peer', req(1, 'ping'), { session, startedAt: Date.now() - 5_000, counterparty: { declared_name: 'hand-client' } });
    engine.observe('self', ok(1, {}), { session });
    const ping = operation(await settle(), 'ping');
    expect(ping.start.counterparty).toEqual({ declared_name: 'hand-client' });
    expect(ping.finish!.duration_ms).toBeGreaterThanOrEqual(5_000);
  });

  it('starts unpaired operations for the fetch wrapper', async () => {
    const { engine, settle } = server();
    const session = newSession('s1');
    engine.operation('peer', 'session/delete', 'management', { session }).finish({ outcome: 'ok' });
    const started: StartedRequest[] = [];
    engine.observe('peer', req(1, 'ping'), { session, started });
    engine.finish(session, [...started, { key: 'peer:missing', op: started[0].op }], { outcome: 'auth_rejected' });
    const events = await settle();
    expect(operation(events, 'session/delete').start).toMatchObject({ kind: 'management', direction: 'inbound', conversation_ref: 's1' });
    expect(operation(events, 'ping').finish).toMatchObject({ outcome: 'auth_rejected' });
  });
});

describe('client role', () => {
  it('records outbound calls with the server as counterparty and inbound callbacks', async () => {
    const c = capture();
    const engine = createMcpEngine({
      recorder: c.recorder,
      role: 'client',
      binding: 'stdio',
      serverUrl: 'https://flights.example/mcp',
      log: quiet,
    });
    const session = newSession('conn-1');
    engine.observe(
      'self',
      req(0, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'me', version: '1' }, capabilities: {} }),
      { session },
    );
    engine.observe('peer', ok(0, { protocolVersion: '2025-11-25', serverInfo: { name: 'flights', version: '2' }, capabilities: {} }), {
      session,
    });
    engine.observe('self', req(1, 'tools/call', { name: 'search', arguments: {} }), { session });
    engine.observe('peer', req(0, 'sampling/createMessage', { messages: [], maxTokens: 1 }), { session });
    engine.observe('self', ok(0, { role: 'assistant', content: { type: 'text', text: 'x' }, model: 'm' }), { session });
    engine.observe('peer', ok(1, { content: [] }), { session });
    const other = createMcpEngine({ recorder: c.recorder, role: 'client', binding: 'stdio', serverUrl: 'not a url', log: quiet });
    other.observe('self', req(0, 'ping'), { session: newSession() });
    const events = await c.settle();
    expect(operation(events, 'initialize').start).toMatchObject({
      direction: 'outbound',
      counterparty: { card_url: 'https://flights.example' },
      mcp: { request_id: '0' },
    });
    expect(operation(events, 'initialize').start.mcp).not.toHaveProperty('client_info');
    expect(operation(events, 'tools/call').start).toMatchObject({
      direction: 'outbound',
      protocol: { version: '2025-11-25' },
      counterparty: { declared_name: 'flights', card_url: 'https://flights.example' },
    });
    expect(operation(events, 'sampling/createMessage').start).toMatchObject({ direction: 'inbound', kind: 'callback' });
    expect(operation(events, 'sampling/createMessage').finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'ping').start.counterparty).toEqual({});
    expectValid(c.batches);
  });
});

describe('edge cases', () => {
  it('pairs the JSON-RPC ids 1 and "1" apart, as distinct requests', async () => {
    const { engine, settle } = server();
    const session = newSession('s1');
    const started: StartedRequest[] = [];
    engine.observe('peer', [req(1, 'tools/call', { name: 'number' }), req('1', 'tools/call', { name: 'string' })], { session, started });
    expect(started.map((entry) => entry.key)).toEqual(['peer:1', 'peer:"1"']);
    engine.observe('peer', note('notifications/cancelled', { requestId: '1' }), { session });
    engine.observe('self', ok(1, { content: [] }), { session });
    const events = await settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'canceled' });
  });

  it('never cancels a request from a cancellation without a usable request id', async () => {
    const { engine, settle } = server();
    const session = newSession('s1');
    engine.observe('peer', req('undefined', 'tools/call', { name: 'a' }), { session });
    engine.observe('peer', req('[object Object]', 'tools/call', { name: 'b' }), { session });
    engine.observe('peer', note('notifications/cancelled', {}), { session });
    engine.observe('peer', note('notifications/cancelled', { requestId: {} }), { session });
    engine.observe('peer', note('notifications/cancelled'), { session });
    expect(session.pending.size).toBe(2);
    engine.observe('self', ok('undefined', { content: [] }), { session });
    engine.observe('self', ok('[object Object]', { content: [] }), { session });
    const events = await settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'ok' });
  });

  it('keeps task dedupe apart for a server and a client sharing one recorder', async () => {
    const c = capture();
    const asServer = createMcpEngine({ recorder: c.recorder, role: 'server', binding: 'stdio', log: quiet });
    const asClient = createMcpEngine({ recorder: c.recorder, role: 'client', binding: 'stdio', log: quiet });
    const serverSide = newSession('s1');
    const clientSide = newSession('c1');
    asClient.observe('self', req(1, 'tools/call', { name: 'report' }), { session: clientSide });
    asServer.observe('peer', req(1, 'tools/call', { name: 'report' }), { session: serverSide });
    asServer.observe('self', ok(1, { task: { taskId: 'task-1', status: 'working' } }), { session: serverSide });
    asClient.observe('peer', ok(1, { task: { taskId: 'task-1', status: 'working' } }), { session: clientSide });
    const events = await c.settle();
    expect(operation(events, 'tools/call', 0).tasks).toHaveLength(1);
    expect(operation(events, 'tools/call', 1).tasks).toHaveLength(1);
    expect(operation(events, 'tools/call', 0).start.direction).toBe('outbound');
  });

  it('logs and skips a message whose recording fails, and keeps going', async () => {
    const c = capture();
    const logs: string[] = [];
    const engine = createMcpEngine({ recorder: c.recorder, role: 'server', binding: 'stdio', log: (event) => void logs.push(event) });
    const session = newSession('s1');
    const hostile = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } };
    Object.defineProperty(hostile.params, 'arguments', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    engine.observe('peer', [hostile, req(2, 'ping')], { session });
    engine.observe('self', ok(2, {}), { session });
    expect(logs).toEqual(['agent_telemetry_event_failed']);
    const events = await c.settle();
    expect(starts(events).map((event) => event.method)).toEqual(['ping']);
    expect(operation(events, 'ping').finish).toMatchObject({ outcome: 'ok' });
  });

  it('drops an invalid method name and an overlong issuer', async () => {
    const c = capture();
    const engine = createMcpEngine({ recorder: c.recorder, role: 'server', binding: 'stdio', issuer: 'i'.repeat(300), log: quiet });
    const session = newSession('s1');
    engine.observe('peer', req(1, 'bad method name', {}), { session, authInfo: { clientId: 'svc' } });
    const events = await c.settle();
    expect(starts(events)[0]).toMatchObject({ method: 'unknown', kind: 'other' });
    expect(starts(events)[0].counterparty.authenticated?.issuer).toHaveLength(256);
    expectValid(c.batches);
  });
});

describe('review fixes', () => {
  it('finishes a displaced request whose id was reused and treats the reused id as the newest', async () => {
    const { engine, settle, batches } = server();
    const session = newSession('s1');
    engine.observe('peer', req(1, 'tools/call', { name: 'first' }), { session });
    engine.observe('peer', req(1, 'tools/call', { name: 'second' }), { session });
    engine.observe('self', ok(1, { content: [] }), { session });
    const crowded = newSession('s2');
    for (let id = 0; id < MAX_PENDING; id++) engine.observe('peer', req(id, 'ping'), { session: crowded });
    engine.observe('peer', req(0, 'tools/call', { name: 'reused' }), { session: crowded });
    engine.observe('peer', req(MAX_PENDING, 'ping'), { session: crowded });
    engine.observe('self', ok(0, { content: [] }), { session: crowded });
    const events = await settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({
      outcome: 'protocol_error',
      error: { native_code: 'duplicate_request_id', code: 'duplicate_request_id' },
    });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'tools/call', 2).finish).toMatchObject({ outcome: 'ok' });
    expect(operation(events, 'ping', 0).finish).toMatchObject({ outcome: 'protocol_error' });
    expect(crowded.pending.has('peer:1')).toBe(false);
    expect(crowded.pending.size).toBe(MAX_PENDING - 1);
    expectValid(batches);
  });

  it('records the authenticated principal per request and drops an overlong client ID', async () => {
    const { engine, settle } = server();
    const session = newSession('s1');
    engine.observe('peer', req(1, 'ping'), { session, authInfo: { clientId: 'svc-1' } });
    engine.observe('peer', req(2, 'ping'), { session });
    engine.observe('peer', req(3, 'ping'), { session, authInfo: { clientId: 'x'.repeat(300) } });
    const pings = starts(await settle());
    expect(pings[0].counterparty.authenticated).toEqual({ issuer: 'mcp', subject_hash: await subjectHash('mcp', 'svc-1') });
    expect(pings[1].counterparty).not.toHaveProperty('authenticated');
    expect(pings[2].counterparty).not.toHaveProperty('authenticated');
  });

  it('keeps the last version hint for requests the server sends without one', async () => {
    const { engine, settle } = server();
    const session = newSession();
    engine.observe('peer', req(1, 'tools/call', { name: 'ask' }), { session, versionHint: '2025-06-18' });
    engine.observe('self', req(0, 'sampling/createMessage', { messages: [], maxTokens: 1 }), { session });
    engine.observe('peer', req(2, 'ping'), { session, versionHint: 'not valid!' });
    const versions = starts(await settle()).map((event) => event.protocol.version);
    expect(versions).toEqual(['2025-06-18', '2025-06-18', '2025-06-18']);
  });

  it('records only the server URL origin: no credentials, path, query or fragment', async () => {
    const c = capture();
    const engine = createMcpEngine({
      recorder: c.recorder,
      role: 'client',
      binding: 'streamable-http',
      serverUrl: 'https://user:pass@flights.example/mcp?api_key=secret#frag',
      log: quiet,
    });
    engine.observe('self', req(1, 'ping'), { session: newSession() });
    const events = await c.settle();
    expect(starts(events)[0].counterparty).toEqual({ card_url: 'https://flights.example' });
    expect(JSON.stringify(c.batches)).not.toMatch(/secret|pass|frag/);
  });

  it('never lets a throwing log escape the engine', () => {
    const c = capture();
    const engine = createMcpEngine({
      recorder: c.recorder,
      role: 'server',
      binding: 'stdio',
      onOperation: () => {
        throw new Error('hook');
      },
      log: () => {
        throw new Error('log');
      },
    });
    expect(() => engine.observe('peer', req(1, 'ping'), { session: newSession() })).not.toThrow();
  });
});

describe('mcpSessions', () => {
  it('keeps one bounded session cache per recorder', () => {
    const a = capture().recorder;
    expect(mcpSessions(a)).toBe(mcpSessions(a));
    expect(mcpSessions(a)).not.toBe(mcpSessions(capture().recorder));
    expect(mcpSessions(a).limit).toBe(10_000);
    expect(newSession()).toEqual({ capabilities: [], pending: new Map() });
    expect(newSession('s')).toMatchObject({ id: 's' });
  });

  it('never lets one request finish another that reused its id (explicit finish and paired responses)', async () => {
    const { engine, settle } = server();
    const session = newSession('s1');
    const first: StartedRequest[] = [];
    const second: StartedRequest[] = [];
    engine.observe('peer', req(1, 'tools/call', { name: 'a' }), { session, started: first });
    engine.observe('peer', req(1, 'tools/call', { name: 'b' }), { session, started: second });
    engine.finish(session, first, { outcome: 'ok' });
    engine.observe('self', ok(1, { content: [{ type: 'text', text: 'for a' }] }), { session, answering: first });
    expect(session.pending.size).toBe(1);
    engine.observe('self', ok(1, { content: [{ type: 'text', text: 'for b' }] }), { session, answering: second });
    const events = await settle();
    expect(operation(events, 'tools/call', 0).finish).toMatchObject({ outcome: 'protocol_error', error: { code: 'duplicate_request_id' } });
    const b = operation(events, 'tools/call', 1);
    expect(b.finishes).toBe(1);
    expect(b.finish).toMatchObject({ outcome: 'ok' });
    expect(b.messages.at(-1)?.content?.parts).toEqual([{ kind: 'text', text: 'for b', truncated: false }]);
  });

  it('keeps a reused id ambiguous for mcpOperation until both requests are gone', async () => {
    const { mcpOperation } = await import('../src/mcp/inflight');
    const { engine, recorder } = server();
    const session = newSession('s1');
    const scope = { sessionId: 's1' };
    engine.observe('peer', req(1, 'ping'), { session, scope });
    expect(mcpOperation(recorder, { sessionId: 's1', requestId: 1 })).toBeDefined();
    engine.observe('peer', req(1, 'ping'), { session, scope });
    expect(mcpOperation(recorder, { sessionId: 's1', requestId: 1 })).toBeUndefined();
    engine.observe('self', ok(1, {}), { session });
    expect(mcpOperation(recorder, { sessionId: 's1', requestId: 1 })).toBeUndefined();
    engine.observe('peer', req(1, 'ping'), { session, scope });
    expect(mcpOperation(recorder, { sessionId: 's1', requestId: 1 })).toBeDefined();
  });

  it('finishes pending requests older than an hour, lazily, as transport_error', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12) });
    const { engine, settle } = server();
    const session = newSession('s1');
    engine.observe('peer', req(1, 'tools/call', { name: 'stuck' }), { session });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 13, 0, 0, 1));
    engine.observe('peer', req(2, 'ping'), { session });
    expect([...session.pending.keys()]).toEqual(['peer:2']);
    vi.useRealTimers();
    expect(operation(await settle(), 'tools/call').finish).toMatchObject({ outcome: 'transport_error' });
  });

  it('finishes the pending requests of a session the cache evicts', async () => {
    const { engine, settle, recorder } = server();
    const sessions = mcpSessions(recorder);
    const evicted = newSession('old');
    sessions.set('old', evicted);
    engine.observe('peer', req(1, 'ping'), { session: evicted, scope: { sessionId: 'old' } });
    for (let index = 0; index < sessions.limit; index++) sessions.set(`s${index}`, newSession(`s${index}`));
    expect(sessions.get('old')).toBeUndefined();
    expect(evicted.pending.size).toBe(0);
    expect(operation(await settle(), 'ping').finish).toMatchObject({ outcome: 'transport_error' });
  });
});
