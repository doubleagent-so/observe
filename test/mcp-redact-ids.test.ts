import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpEngine } from '../src/mcp/engine';
import { instrumentMcpTransport, withMcpTelemetry, type McpRedactIds } from '../src/mcp/index';
import { newSession } from '../src/mcp/session';
import { flightsServer, samplingClient } from './mcp-fixtures';
import { capture, expectValid, operation, starts } from './support';

const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const ok = (id: number | string, result: unknown) => ({ jsonrpc: '2.0', id, result });
const note = (method: string, params?: unknown) => ({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });

function server(redactIds?: McpRedactIds) {
  const c = capture();
  const engine = createMcpEngine({
    recorder: c.recorder,
    role: 'server',
    binding: 'streamable-http',
    ...(redactIds ? { redactIds } : {}),
    log: (event) => void c.logs.push(event),
  });
  return { ...c, engine };
}

/** initialize, a tool call that creates a task, its status notifications, tasks/get and a task this side never saw. */
function conversation(engine: ReturnType<typeof server>['engine']) {
  const session = newSession('session-1');
  engine.observe('peer', req(0, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'acme-bot', version: '2.1.0' } }), {
    session,
  });
  engine.observe('self', ok(0, { protocolVersion: '2025-11-25', serverInfo: { name: 'flights' }, capabilities: {} }), { session });
  engine.observe('peer', req('call-7', 'tools/call', { name: 'report', arguments: {}, task: { ttl: 60_000 } }), { session });
  engine.observe('self', ok('call-7', { task: { taskId: 'task-1', status: 'working' } }), { session });
  engine.observe('self', note('notifications/tasks/status', { taskId: 'task-1', status: 'input_required' }), { session });
  engine.observe('peer', req(9, 'tasks/get', { taskId: 'task-1' }), { session });
  engine.observe('self', ok(9, { taskId: 'task-1', status: 'input_required' }), { session });
  engine.observe('self', note('notifications/tasks/status', { taskId: 'task-elsewhere', status: 'completed' }), { session });
}

describe('redactIds', () => {
  it('records the ids as sent when no redaction is set', async () => {
    const { engine, settle, batches } = server();
    conversation(engine);
    const events = await settle();
    expect(operation(events, 'initialize').start.mcp).toMatchObject({
      request_id: '0',
      client_info: { name: 'acme-bot', version: '2.1.0' },
    });
    expect(operation(events, 'tools/call').start).toMatchObject({
      mcp: { request_id: 'call-7' },
      counterparty: { client_info: { name: 'acme-bot' } },
    });
    expect(operation(events, 'tools/call').tasks[0]).toMatchObject({ task_ref: 'task-1' });
    expect(operation(events, 'tasks/get').start).toMatchObject({ task_ref: 'task-1' });
    expectValid(batches);
  });

  it('records what each function returns, the same task wherever its id appears, and links its states', async () => {
    const seen: unknown[] = [];
    const { engine, settle, batches } = server({
      requestId: (id) => (seen.push(id), `r-${id.length}`),
      clientInfo: (info) => (seen.push(info), { name: 'bot' }),
      taskId: (id) => (seen.push(id), `t-${id.length}`),
    });
    conversation(engine);
    const events = await settle();

    expect(seen).toContainEqual({ name: 'acme-bot', version: '2.1.0' });
    expect(seen).toContain('0');
    expect(seen).toContain('call-7');
    const init = operation(events, 'initialize').start;
    expect(init.mcp).toMatchObject({ request_id: 'r-1', client_info: { name: 'bot' } });
    const call = operation(events, 'tools/call');
    expect(call.start).toMatchObject({ mcp: { request_id: 'r-6' }, counterparty: { client_info: { name: 'bot' } } });
    expect(call.tasks.map((task) => [task.task_ref, task.state])).toEqual([
      ['t-6', 'working'],
      ['t-6', 'input_required'],
    ]);
    expect(operation(events, 'tasks/get').start).toMatchObject({ task_ref: 't-6' });
    expect(operation(events, 'notifications/tasks/status').start).toMatchObject({ task_ref: 't-14' });
    const text = JSON.stringify(events);
    for (const raw of ['acme-bot', 'call-7', 'task-1', 'task-elsewhere']) expect(text).not.toContain(raw);
    expectValid(batches);
  });

  it('drops a field whose function returns undefined or a value the wire would reject', async () => {
    const { engine, settle, batches } = server({
      requestId: () => undefined,
      clientInfo: () => ({ name: 'bad\nname' }),
      taskId: () => 'x'.repeat(10_000),
    });
    conversation(engine);
    const events = await settle();
    expect(operation(events, 'initialize').start).not.toHaveProperty('mcp');
    const call = operation(events, 'tools/call');
    expect(call.start).not.toHaveProperty('mcp');
    expect(call.start.counterparty ?? {}).not.toHaveProperty('client_info');
    expect(call.tasks).toEqual([]);
    expect(operation(events, 'tasks/get').start).not.toHaveProperty('task_ref');
    expect(starts(events).map((event) => event.method)).not.toContain('notifications/tasks/status');
    expectValid(batches);
  });

  it('drops the field and logs when a function throws, and keeps recording', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const { engine, settle, batches, logs } = server({ requestId: boom, clientInfo: boom, taskId: boom });
    conversation(engine);
    const events = await settle();
    expect(logs).toContain('agent_telemetry_redact_failed');
    expect(operation(events, 'initialize').start.mcp ?? {}).not.toHaveProperty('request_id');
    expect(operation(events, 'tools/call').start.counterparty).not.toHaveProperty('client_info');
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'ok' });
    expect(JSON.stringify(events)).not.toContain('task-1');
    expectValid(batches);
  });

  it('leaves a field alone when only the others are redacted', async () => {
    const { engine, settle } = server({ taskId: (id) => `t-${id.length}` });
    conversation(engine);
    const events = await settle();
    expect(operation(events, 'tools/call').start).toMatchObject({
      mcp: { request_id: 'call-7' },
      counterparty: { client_info: { name: 'acme-bot' } },
    });
    expect(operation(events, 'tasks/get').start).toMatchObject({ task_ref: 't-6' });
  });
});

const hidden: McpRedactIds = { requestId: () => 'r', clientInfo: () => ({ name: 'client' }) };

describe('redactIds on the wrappers', () => {
  it('instrumentMcpTransport records the redacted ids', async () => {
    const { recorder, settle, batches } = capture();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await flightsServer().connect(instrumentMcpTransport(serverSide, { recorder, role: 'server', binding: 'stdio', redactIds: hidden }));
    const client = samplingClient('acme-bot', '2.1.0');
    await client.connect(clientSide);
    await client.listTools();
    await client.close();
    const events = await settle();
    expect(operation(events, 'tools/list').start).toMatchObject({
      mcp: { request_id: 'r' },
      counterparty: { client_info: { name: 'client' } },
    });
    expect(JSON.stringify(events)).not.toContain('acme-bot');
    expectValid(batches);
  });

  it('withMcpTelemetry records the redacted ids', async () => {
    const { recorder, settle, batches } = capture();
    const handler = async (request: Request) => {
      const { id } = (await request.json()) as { id: number };
      const result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'hand' } };
      return Response.json({ jsonrpc: '2.0', id, result }, { headers: { 'mcp-session-id': 'hand-1' } });
    };
    const wrapped = withMcpTelemetry(handler, { recorder, redactIds: hidden });
    const body = req(0, 'initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'acme-bot', version: '2.1.0' },
      capabilities: {},
    });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    await wrapped(new Request('https://hand.example/mcp', { method: 'POST', headers, body: JSON.stringify(body) }));
    const events = await settle();
    expect(operation(events, 'initialize').start.mcp).toMatchObject({ request_id: 'r', client_info: { name: 'client' } });
    expect(JSON.stringify(events)).not.toContain('acme-bot');
    expectValid(batches);
  });
});
