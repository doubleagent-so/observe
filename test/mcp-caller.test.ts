import { describe, expect, it } from 'vitest';
import { createMcpEngine, type McpRedactIds } from '../src/mcp/engine';
import { mcpRequestPeer, mcpToolAccess } from '../src/mcp/mapping';
import { newSession } from '../src/mcp/session';
import { capture, expectValid, operation, starts } from './support';

const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const ok = (id: number, result: unknown) => ({ jsonrpc: '2.0', id, result });

function engineFor(role: 'server' | 'client', redactIds?: McpRedactIds) {
  const c = capture();
  const engine = createMcpEngine({
    recorder: c.recorder,
    role,
    binding: 'streamable-http',
    ...(redactIds ? { redactIds } : {}),
    log: (event) => void c.logs.push(event),
  });
  return { ...c, engine };
}

/** `_meta` of an MCP 2026-07-28 request. */
const meta = (name: string, version = '2026-07-28', capabilities: unknown = { sampling: {} }) => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name, version: '2.0', title: 'ignored' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  },
});

const TOOLS = {
  tools: [
    { name: 'search', annotations: { readOnlyHint: true } },
    { name: 'update', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'delete', annotations: {} },
    { name: 'plain' },
    { name: 7 },
    'not a tool',
  ],
};

describe('MCP 2026-07-28 per-request client facts', () => {
  it('reads clientInfo, version and capabilities from each request, without initialize', async () => {
    const { engine, settle, batches } = engineFor('server');
    const session = newSession();
    engine.observe('peer', req(1, 'tools/call', { name: 'search', ...meta('claude-code') }), { session });
    engine.observe('peer', req(2, 'tools/call', { name: 'search', ...meta('cursor', '2026-07-28', {}) }), { session });
    engine.observe('peer', req(3, 'tools/call', { name: 'search' }), { session });
    const [first, second, third] = starts(await settle());
    expect(first).toMatchObject({
      protocol: { version: '2026-07-28' },
      mcp: { request_id: '1', client_info: { name: 'claude-code', version: '2.0' }, capabilities: ['sampling'] },
      counterparty: {
        client_info: { name: 'claude-code', version: '2.0' },
        advertised_protocols: [{ name: 'mcp', versions: ['2026-07-28'], bindings: ['streamable-http'], capabilities: ['sampling'] }],
      },
    });
    expect(second.counterparty.client_info).toEqual({ name: 'cursor', version: '2.0' });
    expect(second.counterparty.advertised_protocols?.[0].capabilities).toEqual([]);
    // Per request: the next request without `_meta` does not inherit it.
    expect(third.counterparty).toEqual({});
    expect(third.mcp).toEqual({ request_id: '3' });
    expectValid(batches);
  });

  it('prefers the request facts over what initialize said for the session', async () => {
    const { engine, settle } = engineFor('server');
    const session = newSession('s1');
    engine.observe('peer', req(0, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'old' }, capabilities: {} }), {
      session,
    });
    engine.observe('peer', req(1, 'ping', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }), { session });
    engine.observe('peer', req(2, 'ping', meta('new')), { session });
    const events = await settle();
    expect(operation(events, 'ping', 0).start.counterparty).toMatchObject({
      client_info: { name: 'old' },
      advertised_protocols: [{ versions: ['2026-07-28'] }],
    });
    expect(operation(events, 'ping', 1).start.counterparty.client_info).toEqual({ name: 'new', version: '2.0' });
  });

  it('redacts request clientInfo like initialize, and ignores _meta in the client role', async () => {
    const redacted = engineFor('server', { clientInfo: ({ name }) => ({ name }) });
    redacted.engine.observe('peer', req(1, 'ping', meta('claude-code')), { session: newSession() });
    const [start] = starts(await redacted.settle());
    expect(start.counterparty.client_info).toEqual({ name: 'claude-code' });
    expect(start.mcp?.client_info).toEqual({ name: 'claude-code' });

    const throwing = engineFor('server', {
      clientInfo: () => {
        throw new Error('boom');
      },
    });
    throwing.engine.observe('peer', req(1, 'ping', meta('claude-code')), { session: newSession() });
    const [dropped] = starts(await throwing.settle());
    expect(dropped.counterparty).not.toHaveProperty('client_info');
    expect(dropped.mcp).toEqual({ request_id: '1', capabilities: ['sampling'] });
    expect(throwing.logs).toContain('agent_telemetry_redact_failed');

    const client = engineFor('client');
    client.engine.observe('self', req(1, 'ping', meta('me')), { session: newSession() });
    const [outbound] = starts(await client.settle());
    expect(outbound.counterparty).toEqual({});
  });

  it('maps only valid _meta facts', () => {
    expect(mcpRequestPeer({})).toBeNull();
    expect(mcpRequestPeer({ _meta: { 'io.modelcontextprotocol/clientInfo': { version: '1' } } })).toBeNull();
    expect(mcpRequestPeer({ _meta: { 'io.modelcontextprotocol/clientCapabilities': { roots: {}, tasks: null } } })).toEqual({
      capabilities: ['roots'],
    });
  });
});

describe('tool annotations as access', () => {
  it('maps annotations with the MCP defaults', () => {
    expect(TOOLS.tools.map(mcpToolAccess)).toEqual(['read', 'write', 'destructive', undefined, undefined, undefined]);
    expect(mcpToolAccess({ annotations: { readOnlyHint: false, destructiveHint: true } })).toBe('destructive');
  });

  it('server role: sets access on tools/call from the server’s own tools/list', async () => {
    const { engine, settle, batches } = engineFor('server');
    const session = newSession();
    engine.observe('peer', req(1, 'tools/call', { name: 'search' }), { session });
    engine.observe('self', ok(1, { content: [] }), { session });
    engine.observe('peer', req(2, 'tools/list'), { session });
    engine.observe('self', ok(2, TOOLS), { session });
    for (const [index, name] of ['search', 'update', 'delete', 'plain', 'unknown'].entries()) {
      engine.observe('peer', req(10 + index, 'tools/call', { name }), { session });
    }
    // A later listing without annotations forgets the access.
    engine.observe('peer', req(3, 'tools/list'), { session });
    engine.observe('self', ok(3, { tools: [{ name: 'search' }] }), { session });
    engine.observe('peer', req(20, 'tools/call', { name: 'search' }), { session: newSession() });
    const calls = starts(await settle()).filter((event) => event.method === 'tools/call');
    expect(calls.map((event) => event.access)).toEqual([undefined, 'read', 'write', 'destructive', undefined, undefined, undefined]);
    expectValid(batches);
  });

  it('client role: sets access on outbound tools/call from the remote server’s tools/list', async () => {
    const { engine, settle } = engineFor('client');
    const session = newSession();
    engine.observe('self', req(1, 'tools/list'), { session });
    engine.observe('peer', ok(1, TOOLS), { session });
    engine.observe('self', req(2, 'tools/call', { name: 'delete' }), { session });
    const call = operation(await settle(), 'tools/call').start;
    expect(call).toMatchObject({ direction: 'outbound', access: 'destructive' });
  });

  it('ignores a malformed tools/list result', async () => {
    const { engine, settle, logs } = engineFor('server');
    const session = newSession();
    engine.observe('peer', req(1, 'tools/list'), { session });
    engine.observe('self', ok(1, { tools: 'nope' }), { session });
    engine.observe('peer', req(2, 'tools/list'), { session });
    engine.observe('self', ok(2, null), { session });
    expect(operation(await settle(), 'tools/list', 1).finish).toMatchObject({ outcome: 'ok' });
    expect(logs).toEqual([]);
  });
});
