import { describe, expect, it } from 'vitest';
import { createRecorder, validateBatch } from '../src/index';
import {
  TOOL_ERROR,
  bounded,
  httpUrl,
  isToolError,
  mcpCapabilities,
  mcpError,
  mcpKind,
  mcpMessage,
  mcpParts,
  mcpPeerInfo,
  mcpRequestId,
  mcpRequestMessages,
  mcpResultMessages,
  mcpTarget,
  mcpTask,
  mcpTaskState,
  mcpVersion,
  nativeRef,
} from '../src/mcp/mapping';

describe('mcpKind', () => {
  it('maps every method in the spec table', () => {
    const table: Record<string, string> = {
      initialize: 'discovery',
      'tools/list': 'discovery',
      'resources/list': 'discovery',
      'resources/templates/list': 'discovery',
      'prompts/list': 'discovery',
      'tools/call': 'tool',
      'resources/read': 'resource',
      'prompts/get': 'prompt',
      'sampling/createMessage': 'callback',
      'elicitation/create': 'callback',
      'roots/list': 'callback',
      ping: 'management',
      'logging/setLevel': 'management',
      'completion/complete': 'management',
      'resources/subscribe': 'management',
      'resources/unsubscribe': 'management',
      'tasks/get': 'management',
      'tasks/result': 'management',
      'tasks/list': 'management',
      'tasks/cancel': 'management',
      'vendor/thing': 'other',
      constructor: 'other',
    };
    for (const [method, kind] of Object.entries(table)) expect(mcpKind(method), method).toBe(kind);
  });
});

describe('mcpTarget', () => {
  it('uses tool and prompt names and resource URIs without query or fragment', () => {
    expect(mcpTarget('tools/call', { name: 'search' })).toBe('search');
    expect(mcpTarget('prompts/get', { name: 'plan' })).toBe('plan');
    expect(mcpTarget('resources/read', { uri: 'https://x.example/a/b?token=secret#frag' })).toBe('https://x.example/a/b');
    expect(mcpTarget('resources/read', { uri: `docs://${'a'.repeat(200)}` })).toHaveLength(128);
    expect(mcpTarget('tools/call', { name: 'bad\nname' })).toBeUndefined();
    expect(mcpTarget('tools/call', {})).toBeUndefined();
    expect(mcpTarget('ping', { name: 'x' })).toBeUndefined();
    expect(mcpTarget('tools/call', null)).toBeUndefined();
  });
});

describe('mcpParts', () => {
  it('maps every content kind to parts without bytes or URIs', () => {
    const parts = mcpParts([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'file:///secret/notes.md', mimeType: 'text/markdown; charset=utf-8', text: '# notes' } },
      { type: 'resource', resource: { uri: 'file:///secret/a.bin', mimeType: 'application/octet-stream', blob: 'AAECAw==' } },
      { type: 'resource_link', uri: 'https://secret.example/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 2048 },
      { type: 'tool_use', id: 'x', name: 'y', input: {} },
      { type: 'resource', resource: { uri: 'file:///secret/empty' } },
      null,
    ]);
    expect(parts).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'file', mediaType: 'image/png', bytes: 5 },
      { kind: 'file', mediaType: 'audio/wav', bytes: 3 },
      { kind: 'text', text: '# notes', mediaType: 'text/markdown' },
      { kind: 'file', mediaType: 'application/octet-stream', bytes: 4 },
      { kind: 'file', name: 'report.pdf', mediaType: 'application/pdf', bytes: 2048 },
    ]);
    expect(JSON.stringify(parts)).not.toContain('secret');
    expect(mcpParts({ type: 'text', text: 'single' })).toEqual([{ kind: 'text', text: 'single' }]);
    expect(mcpParts(undefined)).toEqual([]);
    expect(mcpParts([{ type: 'image', data: 'AAAA', mimeType: 'not a type' }])).toEqual([{ kind: 'file', bytes: 3 }]);
    expect(mcpParts([{ type: 'resource_link', name: 'x', size: -1 }])).toEqual([{ kind: 'file', name: 'x' }]);
  });
});

describe('messages', () => {
  it('maps tool arguments and sampling messages from requests', () => {
    expect(mcpRequestMessages('tools/call', { name: 'search', arguments: { to: 'Lisbon' } })).toEqual([
      { role: 'caller', parts: [{ kind: 'data', json: { to: 'Lisbon' } }] },
    ]);
    expect(mcpRequestMessages('tools/call', { name: 'search' })).toEqual([]);
    expect(
      mcpRequestMessages('sampling/createMessage', {
        messages: [
          { role: 'user', content: { type: 'text', text: 'summarize' } },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          'junk',
        ],
        maxTokens: 5,
      }),
    ).toEqual([
      { role: 'caller', parts: [{ kind: 'text', text: 'summarize' }] },
      { role: 'agent', parts: [{ kind: 'text', text: 'ok' }] },
    ]);
    expect(mcpRequestMessages('ping', {})).toEqual([]);
    expect(mcpRequestMessages('tools/call', 'nope')).toEqual([]);
  });

  it('maps results of tools, tasks, prompts, resources and sampling', () => {
    expect(mcpResultMessages('tools/call', { content: [{ type: 'text', text: '3 flights' }], structuredContent: { count: 3 } })).toEqual([
      {
        role: 'agent',
        parts: [
          { kind: 'text', text: '3 flights' },
          { kind: 'data', json: { count: 3 } },
        ],
      },
    ]);
    expect(mcpResultMessages('tools/call', { task: { taskId: 't1', status: 'working' } })).toEqual([]);
    expect(mcpResultMessages('tasks/result', { content: [{ type: 'text', text: 'done' }] })).toEqual([
      { role: 'agent', parts: [{ kind: 'text', text: 'done' }] },
    ]);
    expect(mcpResultMessages('prompts/get', { messages: [{ role: 'user', content: { type: 'text', text: 'Plan a trip' } }] })).toEqual([
      { role: 'caller', parts: [{ kind: 'text', text: 'Plan a trip' }] },
    ]);
    expect(
      mcpResultMessages('resources/read', {
        contents: [
          { uri: 'docs://guide', mimeType: 'text/markdown', text: '# Guide' },
          { uri: 'docs://img', mimeType: 'image/png', blob: 'AAAA' },
        ],
      }),
    ).toEqual([
      {
        role: 'agent',
        parts: [
          { kind: 'text', text: '# Guide', mediaType: 'text/markdown' },
          { kind: 'file', mediaType: 'image/png', bytes: 3 },
        ],
      },
    ]);
    expect(mcpResultMessages('resources/read', { contents: [] })).toEqual([]);
    expect(
      mcpResultMessages('sampling/createMessage', { role: 'assistant', content: { type: 'text', text: 'sampled' }, model: 'm' }),
    ).toEqual([{ role: 'agent', parts: [{ kind: 'text', text: 'sampled' }] }]);
    expect(mcpResultMessages('tools/list', { tools: [] })).toEqual([]);
    expect(mcpResultMessages('tools/call', null)).toEqual([]);
  });
});

describe('outcomes and errors', () => {
  it('names JSON-RPC and MCP error codes and detects tool errors', () => {
    expect(mcpError({ code: -32602, message: 'bad' })).toEqual({ nativeCode: '-32602', code: 'invalid_params' });
    expect(mcpError({ code: -32002 })).toEqual({ nativeCode: '-32002', code: 'resource_not_found' });
    // Servers use the implementation-defined range for anything; only the native code says more.
    expect(mcpError({ code: -32000 })).toEqual({ nativeCode: '-32000', code: 'jsonrpc_error' });
    expect(mcpError({ code: -32001 })).toEqual({ nativeCode: '-32001', code: 'jsonrpc_error' });
    expect(mcpError({ code: -32042 })).toEqual({ nativeCode: '-32042', code: 'url_elicitation_required' });
    expect(mcpError({ code: 42 })).toEqual({ nativeCode: '42', code: 'jsonrpc_error' });
    expect(mcpError('weird')).toEqual({ nativeCode: 'unknown', code: 'jsonrpc_error' });
    expect(isToolError('tools/call', { content: [], isError: true })).toBe(true);
    expect(isToolError('tasks/result', { content: [], isError: true })).toBe(true);
    expect(isToolError('tools/call', { content: [] })).toBe(false);
    expect(isToolError('prompts/get', { isError: true })).toBe(false);
    expect(TOOL_ERROR).toEqual({ nativeCode: 'isError', code: 'tool_error' });
  });
});

describe('tasks', () => {
  it('normalizes MCP task statuses and reads task results and notifications', () => {
    expect(mcpTaskState('cancelled')).toEqual({ state: 'canceled', nativeState: 'cancelled' });
    expect(mcpTaskState('input_required')).toEqual({ state: 'input_required', nativeState: 'input_required' });
    expect(mcpTaskState('working').state).toBe('working');
    expect(mcpTaskState('completed').state).toBe('completed');
    expect(mcpTaskState('failed').state).toBe('failed');
    expect(mcpTaskState('constructor')).toEqual({ state: 'unknown', nativeState: 'constructor' });
    expect(mcpTaskState(7)).toEqual({ state: 'unknown', nativeState: 'unknown' });
    expect(mcpTask({ task: { taskId: 't1', status: 'working', ttl: null } })).toEqual({
      taskRef: 't1',
      state: 'working',
      nativeState: 'working',
    });
    expect(mcpTask({ taskId: 't1', status: 'completed' })).toEqual({ taskRef: 't1', state: 'completed', nativeState: 'completed' });
    expect(mcpTask({ taskId: 'has space', status: 'completed' })).toBeNull();
    expect(mcpTask({ taskId: 't1' })).toBeNull();
    expect(mcpTask({ content: [] })).toBeNull();
    expect(mcpTask(null)).toBeNull();
  });
});

describe('small readers', () => {
  it('reads capabilities, peer info, versions, ids, refs and URLs within wire limits', () => {
    expect(mcpCapabilities({ sampling: {}, roots: { listChanged: true }, experimental: {}, tasks: {}, elicitation: null })).toEqual([
      'sampling',
      'roots',
      'tasks',
    ]);
    expect(mcpCapabilities(null)).toEqual([]);
    expect(mcpPeerInfo({ name: 'claude-ai', version: '0.1.0', title: 'Claude' })).toEqual({ name: 'claude-ai', version: '0.1.0' });
    expect(mcpPeerInfo({ name: 'n'.repeat(300) })!.name).toHaveLength(128);
    expect(mcpPeerInfo({ version: '1' })).toBeUndefined();
    expect(mcpVersion('2025-11-25')).toBe('2025-11-25');
    expect(mcpVersion(' 2025-06-18 ')).toBe('2025-06-18');
    expect(mcpVersion('not a version!')).toBeUndefined();
    expect(mcpVersion(null)).toBeUndefined();
    expect(mcpRequestId(0)).toBe('0');
    expect(mcpRequestId('abc')).toBe('abc');
    expect(mcpRequestId('x'.repeat(200))).toHaveLength(128);
    expect(mcpRequestId(null)).toBeUndefined();
    expect(mcpRequestId(Number.NaN)).toBeUndefined();
    expect(nativeRef('session-1')).toBe('session-1');
    expect(nativeRef('has space')).toBeUndefined();
    expect(nativeRef('')).toBeUndefined();
    expect(httpUrl('https://flights.example/mcp')).toBe('https://flights.example/mcp');
    expect(httpUrl('ftp://x.example/')).toBeUndefined();
    expect(httpUrl('not a url')).toBeUndefined();
    expect(httpUrl(`https://x.example/${'a'.repeat(2048)}`)).toBeUndefined();
    expect(bounded('ok', 1)).toBe('o');
    expect(bounded('', 5)).toBeUndefined();
    expect(bounded(5, 5)).toBeUndefined();
  });

  it('classifies JSON-RPC messages', () => {
    expect(mcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })).toEqual({
      type: 'request',
      id: 1,
      method: 'tools/call',
      params: { name: 'x' },
    });
    expect(mcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      type: 'notification',
      method: 'notifications/initialized',
      params: undefined,
    });
    expect(mcpMessage({ jsonrpc: '2.0', id: 'a', result: {} })).toEqual({ type: 'result', id: 'a', result: {} });
    expect(mcpMessage({ jsonrpc: '2.0', id: null, error: { code: -32700 } })).toEqual({ type: 'error', id: null, error: { code: -32700 } });
    expect(mcpMessage({ id: 1, method: 'x' })).toBeNull();
    expect(mcpMessage({ jsonrpc: '2.0', id: 1 })).toBeNull();
    expect(mcpMessage([{ jsonrpc: '2.0', id: 1, method: 'x' }])).toBeNull();
    expect(mcpMessage('x')).toBeNull();
  });
});

describe('wire safety', () => {
  it('keeps only the scheme of opaque URIs, which can carry personal data', () => {
    const target = (uri: string) => mcpTarget('resources/read', { uri });
    expect(target('mailto:alice@example.com')).toBe('mailto:');
    expect(target('tel:+15551234567')).toBe('tel:');
    expect(target('data:text/plain;base64,c2VjcmV0')).toBe('data:');
    expect(target('https:user:pw@host/x')).toBe('https:');
    expect(target('urn:isbn:0451450523?x=1#y')).toBe('urn:isbn:0451450523');
  });

  it('drops every userinfo from hierarchical URIs, even with @, # or ? inside it', () => {
    const target = (uri: string) => mcpTarget('resources/read', { uri });
    expect(target('https://user:p@ss@host/x')).toBe('https://host/x');
    // The authority ends at the first `/`, `?` or `#`; an `@` after it means a userinfo may have been split: scheme only.
    expect(target('https://user:pa#ss@host/x')).toBe('https:');
    expect(target('https://user:pa?ss@host/x')).toBe('https:');
    expect(target('https://host/x?email=a@b')).toBe('https:');
    expect(target('https://user%40corp:pw@host/x')).toBe('https://host/x');
    expect(target('https://user:pw%40host/x')).toBe('https://host/x');
    expect(target('https://host/a%40b')).toBe('https://host');
    expect(target('https://host:8443/a')).toBe('https://host:8443/a');
    expect(target('https://host?q=a')).toBe('https://host');
    expect(target('https://host/a@b?x=1')).toBe('https://host');
    expect(target('https://user/x:pw@host/y')).toBe('https:');
    expect(target('urn:mail:alice@example.com')).toBe('urn:');
    // Local paths name the host's files and users: only the scheme is kept.
    expect(target('file:///secret/notes.md')).toBe('file:');
    expect(target('FILE://host/c$/users/alice/notes.md')).toBe('FILE:');
    expect(target('relative/path?x')).toBe('relative/path');
    expect(target('user@host/path')).toBeUndefined();
  });

  it('never puts URI credentials in a resource target', () => {
    expect(mcpTarget('resources/read', { uri: 'https://user:pa55@x.example/doc?sig=1' })).toBe('https://x.example/doc');
    expect(mcpTarget('resources/read', { uri: 'postgres://admin@db.example/table' })).toBe('postgres://db.example/table');
    expect(mcpTarget('resources/read', { uri: 'docs://guide/intro' })).toBe('docs://guide/intro');
    expect(mcpTarget('resources/read', { uri: '?only-query' })).toBeUndefined();
    expect(mcpTarget('resources/read', { uri: 7 })).toBeUndefined();
  });

  it('never cuts a surrogate pair in half', () => {
    expect(bounded('ab😀', 3)).toBe('ab');
    expect(bounded('ab😀', 4)).toBe('ab😀');
  });

  it('counts base64 bytes across line breaks and drops sizes the validator rejects', () => {
    expect(mcpParts([{ type: 'image', data: 'aGVs\nbG8=', mimeType: 'image/png' }])).toEqual([
      { kind: 'file', mediaType: 'image/png', bytes: 5 },
    ]);
    expect(mcpParts([{ type: 'resource_link', name: 'huge', size: 2 ** 41 }])).toEqual([{ kind: 'file', name: 'huge' }]);
    expect(mcpParts([{ type: 'resource_link', name: 'half', size: 1.5 }])).toEqual([{ kind: 'file', name: 'half' }]);
    expect(
      mcpParts([
        { type: 'text', text: 7 },
        { type: 'resource', resource: 'x' },
      ]),
    ).toEqual([]);
  });

  it('keeps task states and error codes within the wire limits', () => {
    expect(mcpTaskState('x'.repeat(100)).nativeState).toHaveLength(64);
    expect(mcpError({ code: Number.POSITIVE_INFINITY })).toEqual({ nativeCode: 'unknown', code: 'jsonrpc_error' });
    expect(mcpError({ code: '-32602' })).toEqual({ nativeCode: 'unknown', code: 'jsonrpc_error' });
  });

  it('keeps every mapped event valid on the wire', async () => {
    const batches: unknown[] = [];
    const recorder = createRecorder({
      key: 'ak_test_x',
      flushIntervalMs: 0,
      fetch: (async (_url: unknown, init: RequestInit) => {
        batches.push(JSON.parse(String(init.body)));
        return Response.json({ accepted: 0, rejected: [] }, { status: 202 });
      }) as typeof fetch,
    });
    const params = { name: 'search', arguments: { q: 'x' } };
    const target = mcpTarget('resources/read', { uri: `https://u:p@x.example/${'a'.repeat(200)}?t=1` });
    const op = recorder.startOperation({
      protocol: { name: 'mcp', version: mcpVersion(' 2025-11-25 ')!, binding: 'streamable-http' },
      direction: 'inbound',
      method: 'tools/call',
      kind: mcpKind('tools/call'),
      ...(target ? { target } : {}),
      mcp: {
        request_id: mcpRequestId('r'.repeat(300))!,
        client_info: mcpPeerInfo({ name: 'c'.repeat(300), version: 'v'.repeat(100) })!,
        capabilities: mcpCapabilities({ sampling: {}, tasks: {} }),
      },
    });
    for (const message of mcpRequestMessages('tools/call', params)) op.message(message);
    const result = {
      content: [
        { type: 'resource', resource: { uri: 'file:///x', mimeType: 'Text/Markdown; charset=utf-8', text: '# x' } },
        { type: 'image', data: 'AAAA', mimeType: 'image/png; q=1' },
        { type: 'resource_link', name: 'n'.repeat(400), mimeType: 'bad type', size: 3 },
      ],
      isError: true,
    };
    for (const message of mcpResultMessages('tools/call', result)) op.message(message);
    op.taskState(mcpTask({ task: { taskId: 'task-1', status: 'cancelled' } })!);
    op.finish(isToolError('tools/call', result) ? { outcome: 'tool_error', error: TOOL_ERROR } : { outcome: 'ok' });
    await recorder.flush();
    expect(batches).toHaveLength(1);
    expect(validateBatch(batches[0], Date.now())).toMatchObject({ ok: true, rejected: [] });
  });
});
