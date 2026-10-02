import { describe, expect, it } from 'vitest';
import { createRecorder, validateBatch } from '../src/index';
import {
  a2aBinding,
  a2aError,
  a2aExtensions,
  a2aKind,
  a2aObservations,
  a2aParts,
  a2aRequestBlock,
  a2aRequestRefs,
  a2aRole,
  a2aTaskState,
  a2aVersion,
} from '../src/a2a/mapping';

describe('the a2a block', () => {
  it('reads extension URIs from a header value or a list, keeping only what the validator accepts', () => {
    expect(a2aExtensions(' https://ext.test/a , https://ext.test/b,,https://ext.test/a ')).toEqual([
      'https://ext.test/a',
      'https://ext.test/b',
    ]);
    expect(a2aExtensions(['https://ext.test/a', 7, '', 'with\tcontrol', 'x'.repeat(513)])).toEqual(['https://ext.test/a']);
    expect(a2aExtensions(null)).toEqual([]);
    expect(a2aExtensions(Array.from({ length: 40 }, (_, index) => `e${index}`))).toHaveLength(16);
    const long = Array.from({ length: 16 }, (_, index) => `https://ext.test/${index}/${'x'.repeat(480)}`);
    const kept = a2aExtensions(long);
    expect(kept.length).toBeLessThan(16);
    expect(kept.join('').length).toBeLessThanOrEqual(1024);
  });

  it('builds the request block from the caller message and the requested extensions', () => {
    const message = { messageId: 'm1', referenceTaskIds: ['t-1', 'bad id', 't-2', 5], parts: [] };
    expect(a2aRequestBlock({ message }, ['https://ext.test/a'])).toEqual({
      message_id: 'm1',
      reference_task_ids: ['t-1', 't-2'],
      extensions_requested: ['https://ext.test/a'],
    });
    expect(a2aRequestBlock({ message: { messageId: 'bad id', referenceTaskIds: [] } }, [])).toBeUndefined();
    expect(a2aRequestBlock({ id: 't1' }, [])).toBeUndefined();
    expect(a2aRequestBlock(undefined, ['https://ext.test/a'])).toEqual({ extensions_requested: ['https://ext.test/a'] });
    const many = Array.from({ length: 40 }, (_, index) => `task-${index}`);
    expect(a2aRequestBlock({ message: { referenceTaskIds: many } }, [])?.reference_task_ids).toEqual(many.slice(0, 16));
  });

  it('only builds blocks the validator accepts, within the envelope limit', async () => {
    let body = '';
    const recorder = createRecorder({
      key: 'ak_test_x',
      flushIntervalMs: 0,
      fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        body = String(init.body);
        return Response.json({ accepted: 1, rejected: [] }, { status: 202 });
      }) as typeof fetch,
    });
    const longIds = Array.from({ length: 16 }, (_, index) => `${index}`.padEnd(256, 'r'));
    const longExtensions = Array.from({ length: 16 }, (_, index) => `https://ext.test/${index}/${'x'.repeat(490)}`);
    const a2a = a2aRequestBlock({ message: { messageId: 'm'.repeat(256), referenceTaskIds: longIds } }, a2aExtensions(longExtensions));
    const op = recorder.startOperation({
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      counterparty: { card_url: `https://agent.test/${'c'.repeat(2000)}` },
      ...(a2a ? { a2a } : {}),
    });
    op.finish({ outcome: 'ok', a2a: { extensions_activated: a2aExtensions(longExtensions) } });
    await recorder.flush();
    expect(validateBatch(JSON.parse(body), Date.now())).toMatchObject({ ok: true, rejected: [] });
  });
});

describe('methods', () => {
  it('maps 1.0 and 0.3 methods to kinds, versions and bindings', () => {
    for (const method of ['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']) expect(a2aKind(method)).toBe('message');
    for (const method of [
      'GetTask',
      'ListTasks',
      'CancelTask',
      'SubscribeToTask',
      'CreateTaskPushNotificationConfig',
      'tasks/get',
      'tasks/cancel',
      'tasks/resubscribe',
      'tasks/pushNotificationConfig/set',
    ])
      expect(a2aKind(method)).toBe('management');
    for (const method of ['GetExtendedAgentCard', 'agent/getAuthenticatedExtendedCard', 'GetAgentCard'])
      expect(a2aKind(method)).toBe('discovery');
    expect(a2aKind('Mystery')).toBe('other');
    expect(a2aVersion('SendMessage')).toBe('1.0');
    expect(a2aVersion('message/send')).toBe('0.3');
    expect(a2aVersion('SendMessage', '1.0.1')).toBe('1.0.1');
    expect(a2aVersion('SendMessage', 'not a version!')).toBe('1.0');
    expect(a2aBinding('SendStreamingMessage')).toBe('sse');
    expect(a2aBinding('tasks/resubscribe')).toBe('sse');
    expect(a2aBinding('SendMessage')).toBe('jsonrpc-http');
  });
});

describe('states and roles', () => {
  it('normalizes wire strings and SDK enums identically', () => {
    expect(a2aTaskState('TASK_STATE_INPUT_REQUIRED')).toEqual({ state: 'input_required', nativeState: 'TASK_STATE_INPUT_REQUIRED' });
    expect(a2aTaskState('input-required')).toEqual({ state: 'input_required', nativeState: 'input-required' });
    expect(a2aTaskState(6)).toEqual({ state: 'input_required', nativeState: 'TASK_STATE_INPUT_REQUIRED' });
    expect(a2aTaskState(3).state).toBe('completed');
    expect(a2aTaskState('canceled').state).toBe('canceled');
    expect(a2aTaskState('TASK_STATE_AUTH_REQUIRED').state).toBe('auth_required');
    expect(a2aTaskState(99)).toEqual({ state: 'unknown', nativeState: '99' });
    expect(a2aTaskState('working\r\n')).toEqual({ state: 'working', nativeState: 'working' });
    expect(a2aTaskState('\n')).toEqual({ state: 'unknown', nativeState: 'unknown' });
    expect(a2aTaskState(`TASK_STATE_${'X'.repeat(100)}`).nativeState).toHaveLength(64);
    expect(a2aRole('ROLE_USER')).toBe('caller');
    expect(a2aRole('user')).toBe('caller');
    expect(a2aRole(1)).toBe('caller');
    expect(a2aRole('agent')).toBe('agent');
    expect(a2aRole(2)).toBe('agent');
  });
});

describe('parts', () => {
  it('maps text, data and file parts from every shape without bytes or URLs', () => {
    const expected = [
      { kind: 'text', text: 'hi' },
      { kind: 'data', json: { a: 1 } },
      { kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', bytes: 3 },
      { kind: 'file', name: 'b.png', mediaType: 'image/png' },
    ];
    expect(
      a2aParts([
        { text: 'hi' },
        { data: { a: 1 } },
        { raw: 'YWJj', filename: 'a.pdf', mediaType: 'application/pdf' },
        { url: 'https://x/b.png', filename: 'b.png', mediaType: 'image/png' },
      ]),
    ).toEqual(expected);
    expect(
      a2aParts([
        { kind: 'text', text: 'hi' },
        { kind: 'data', data: { a: 1 } },
        { kind: 'file', file: { name: 'a.pdf', mimeType: 'application/pdf', bytes: 'YWJj' } },
        { kind: 'file', file: { name: 'b.png', mimeType: 'image/png', uri: 'https://x/b.png' } },
      ]),
    ).toEqual(expected);
    expect(
      a2aParts([
        { content: { $case: 'text', value: 'hi' } },
        { content: { $case: 'data', value: { a: 1 } } },
        { content: { $case: 'raw', value: new Uint8Array([97, 98, 99]) }, filename: 'a.pdf', mediaType: 'application/pdf' },
        { content: { $case: 'url', value: 'https://x/b.png' }, filename: 'b.png', mediaType: 'image/png' },
      ]),
    ).toEqual(expected);
    expect(
      a2aParts([
        { raw: 'YWJj', filename: 'a\u0000.pdf\n' },
        { url: 'https://x/a', filename: '\u001b' },
      ]),
    ).toEqual([{ kind: 'file', name: 'a.pdf', bytes: 3 }, { kind: 'file' }]);
    expect(a2aParts('nope')).toEqual([]);
    expect(a2aParts([null, 7, { unknown: true }])).toEqual([]);
    expect(JSON.stringify(a2aParts([{ url: 'https://secret.example/file' }]))).not.toContain('secret');
  });

  it('keeps only the essence of a media type and drops one the validator would reject', () => {
    expect(
      a2aParts([
        { raw: 'YWJj', mediaType: 'Text/Plain; charset=utf-8' },
        { url: 'https://x/a', mediaType: ' application/vnd.api+json ;q=1' },
        { kind: 'file', file: { mimeType: 'not a media type', bytes: 'YWJj' } },
        { content: { $case: 'url', value: 'https://x/b' }, mediaType: `image/${'x'.repeat(200)}` },
        { url: 'https://x/c', mediaType: ';charset=utf-8' },
      ]),
    ).toEqual([
      { kind: 'file', mediaType: 'text/plain', bytes: 3 },
      { kind: 'file', mediaType: 'application/vnd.api+json' },
      { kind: 'file', bytes: 3 },
      { kind: 'file' },
      { kind: 'file' },
    ]);
  });

  it('records parameterised media types as valid events', async () => {
    let body = '';
    const recorder = createRecorder({
      key: 'ak_test_x',
      flushIntervalMs: 0,
      fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        body = String(init.body);
        return Response.json({ accepted: 1, rejected: [] }, { status: 202 });
      }) as typeof fetch,
    });
    const op = recorder.startOperation({
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
    });
    op.message({ role: 'caller', parts: a2aParts([{ raw: 'YWJj', filename: 'a.txt', mediaType: 'text/plain; charset=utf-8' }]) });
    await recorder.flush();
    expect(validateBatch(JSON.parse(body), Date.now())).toMatchObject({ ok: true, rejected: [] });
  });
});

describe('public surface', () => {
  it('keeps the id limit internal', async () => {
    expect(Object.keys(await import('../src/a2a/index'))).not.toContain('MAX_ID');
  });
});

describe('edge cases', () => {
  it('ignores unknown or malformed shapes without throwing', () => {
    expect(a2aParts([{ content: { $case: 'mystery', value: 1 } }, { kind: 'text' }, { kind: 'file' }])).toEqual([]);
    expect(a2aParts([{ content: { $case: 'raw', value: 'not bytes' } }])).toEqual([{ kind: 'file' }]);
    expect(a2aObservations({ kind: 'message', messageId: 'm1', role: 'user', parts: [] })).toHaveLength(1);
    expect(a2aObservations({ kind: 'artifact-update', taskId: 't1', artifact: { artifactId: 'a1', parts: [] } })).toHaveLength(1);
    expect(a2aObservations({ kind: 'artifact-update', taskId: 't1' })).toEqual([]);
    expect(a2aObservations({ kind: 'status-update', status: {} })).toEqual([]);
    expect(a2aObservations({ task: {} })).toEqual([]);
    expect(a2aObservations({ message: 'bad' })).toEqual([]);
    expect(a2aObservations({ unrelated: true })).toEqual([]);
    expect(a2aObservations({ task: { id: 't1' } })).toEqual([{ type: 'task', taskRef: 't1', state: 'unknown', nativeState: 'unknown' }]);
    expect(a2aRequestRefs({ message: 'bad', taskId: 't2' })).toEqual({ taskRef: 't2' });
    expect(a2aRequestRefs({ name: 'other' })).toEqual({});
    expect(a2aVersion('SendMessage', null)).toBe('1.0');
    expect(a2aTaskState('weird').state).toBe('unknown');
  });
});

describe('errors', () => {
  it('names known JSON-RPC codes and keeps the native code', () => {
    expect(a2aError({ code: -32001, message: 'Task not found' })).toEqual({ nativeCode: '-32001', code: 'task_not_found' });
    expect(a2aError({ code: -32601 })).toEqual({ nativeCode: '-32601', code: 'method_not_found' });
    expect(a2aError({ code: -31000 })).toEqual({ nativeCode: '-31000', code: 'jsonrpc_error' });
    expect(a2aError('weird')).toEqual({ nativeCode: 'unknown', code: 'jsonrpc_error' });
  });
});

describe('observations', () => {
  const v1Task = {
    id: 't1',
    contextId: 'c1',
    status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'm2', role: 'ROLE_AGENT', parts: [{ text: 'done' }] } },
    artifacts: [{ artifactId: 'a1', name: 'result', parts: [{ data: { ok: true } }] }],
  };

  it('extracts task states and agent messages from 1.0 results', () => {
    expect(a2aObservations({ task: v1Task })).toEqual([
      { type: 'task', taskRef: 't1', contextRef: 'c1', state: 'completed', nativeState: 'TASK_STATE_COMPLETED' },
      {
        type: 'message',
        taskRef: 't1',
        contextRef: 'c1',
        message: { role: 'agent', messageId: 'm2', artifact: false, parts: [{ kind: 'text', text: 'done' }] },
      },
      {
        type: 'message',
        taskRef: 't1',
        contextRef: 'c1',
        message: { role: 'agent', messageId: 'a1', artifact: true, parts: [{ kind: 'data', json: { ok: true } }] },
      },
    ]);
    expect(a2aObservations({ message: { messageId: 'm3', contextId: 'c1', role: 'ROLE_AGENT', parts: [{ text: 'hi' }] } })).toEqual([
      {
        type: 'message',
        contextRef: 'c1',
        message: { role: 'agent', messageId: 'm3', artifact: false, parts: [{ kind: 'text', text: 'hi' }] },
      },
    ]);
  });

  it('extracts the same from 0.3 results and stream events', () => {
    const v03 = { kind: 'task', id: 't1', contextId: 'c1', status: { state: 'completed' } };
    expect(a2aObservations(v03)).toEqual([{ type: 'task', taskRef: 't1', contextRef: 'c1', state: 'completed', nativeState: 'completed' }]);
    expect(a2aObservations({ kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'working' } })).toEqual([
      { type: 'task', taskRef: 't1', contextRef: 'c1', state: 'working', nativeState: 'working' },
    ]);
    expect(a2aObservations({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } })[0]).toMatchObject({
      state: 'working',
    });
    expect(
      a2aObservations({ artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { artifactId: 'a9', parts: [{ text: 'chunk' }] } } }),
    ).toEqual([
      {
        type: 'message',
        taskRef: 't1',
        contextRef: 'c1',
        message: { role: 'agent', messageId: 'a9', artifact: true, parts: [{ kind: 'text', text: 'chunk' }] },
      },
    ]);
  });

  it('extracts the same from SDK in-process objects', () => {
    expect(
      a2aObservations({ payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: { state: 2 } } } })[0],
    ).toMatchObject({ state: 'working', nativeState: 'TASK_STATE_WORKING' });
    expect(a2aObservations({ id: 't1', contextId: 'c1', status: { state: 3 }, artifacts: [] })).toEqual([
      { type: 'task', taskRef: 't1', contextRef: 'c1', state: 'completed', nativeState: 'TASK_STATE_COMPLETED' },
    ]);
    expect(a2aObservations(null)).toEqual([]);
  });

  it('reads request references and the caller message', () => {
    expect(
      a2aRequestRefs({ message: { messageId: 'm1', contextId: 'c1', taskId: 't1', role: 'ROLE_USER', parts: [{ text: 'q' }] } }),
    ).toEqual({
      contextRef: 'c1',
      taskRef: 't1',
      message: { role: 'caller', messageId: 'm1', artifact: false, parts: [{ kind: 'text', text: 'q' }] },
    });
    expect(a2aRequestRefs({ id: 't7' })).toEqual({ taskRef: 't7' });
    expect(a2aRequestRefs({ name: 'tasks/t8' })).toEqual({ taskRef: 't8' });
    expect(a2aRequestRefs(undefined)).toEqual({});
  });
});

describe('hostile input', () => {
  it('maps a long run of padding in linear time', () => {
    const started = performance.now();
    const parts = a2aParts([{ raw: `${'='.repeat(1024 * 1024)}x` }]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(parts).toHaveLength(1);
    expect(a2aParts([{ raw: 'YWJj==' }])).toEqual([{ kind: 'file', bytes: 3 }]);
  });

  it('does not resolve prototype keys as task states', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'TASK_STATE_CONSTRUCTOR']) expect(a2aTaskState(name).state).toBe('unknown');
  });

  it('drops ids longer than 256 characters instead of truncating them', () => {
    const long = 'x'.repeat(300);
    const ok = 'y'.repeat(256);
    expect(a2aRequestRefs({ id: long })).toEqual({});
    expect(a2aRequestRefs({ id: ok })).toEqual({ taskRef: ok });
    expect(a2aRequestRefs({ name: `tasks/${long}` })).toEqual({});
    expect(a2aObservations({ task: { id: long, status: { state: 'working' } } })).toEqual([]);
    expect(a2aObservations({ message: { messageId: long, contextId: long, role: 'user', parts: [] } })).toEqual([
      { type: 'message', message: { role: 'caller', artifact: false, parts: [] } },
    ]);
  });

  it('drops ids the validator rejects: spaces, controls and non-ASCII characters', () => {
    for (const bad of ['has space', 'tâche', 'ünï', 'tab\there', 'line\nbreak', '', 'emoji😀'])
      expect(a2aRequestRefs({ message: { messageId: bad, contextId: bad, taskId: bad, role: 'user', parts: [] } })).toEqual({
        message: { role: 'caller', artifact: false, parts: [] },
      });
    expect(a2aRequestRefs({ id: 'task one' })).toEqual({});
    expect(a2aRequestRefs({ name: 'tasks/task one/pushNotificationConfigs/p1' })).toEqual({});
    expect(a2aObservations({ task: { id: 'task one', status: { state: 'working' } } })).toEqual([]);
    expect(a2aObservations({ task: { id: 't1', contextId: 'cöntext', status: { state: 'working' } } })).toEqual([
      { type: 'task', taskRef: 't1', state: 'working', nativeState: 'working' },
    ]);
    expect(a2aRequestRefs({ id: '!~printable-ASCII' })).toEqual({ taskRef: '!~printable-ASCII' });
  });

  it('never stringifies arbitrary objects or throws on odd values', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    expect(a2aTaskState(bare)).toEqual({ state: 'unknown', nativeState: 'unknown' });
    expect(a2aTaskState({ toString: () => 'x' }).nativeState).toBe('unknown');
    expect(a2aTaskState(null).state).toBe('unknown');
    expect(a2aObservations({ task: { id: 7, status: { state: bare } } })).toEqual([]);
    expect(a2aObservations({ task: { id: 't1', status: { state: bare } } })[0]).toMatchObject({ state: 'unknown' });
    expect(a2aObservations(bare)).toEqual([]);
    expect(a2aRequestRefs({ id: 5, message: bare })).toEqual({ message: { role: 'caller', artifact: false, parts: [] } });
    expect(a2aVersion(42 as unknown as string)).toBe('1.0');
    let nested: unknown = 'leaf';
    for (let index = 0; index < 50_000; index++) nested = { child: nested };
    expect(a2aParts([{ data: nested }])).toHaveLength(1);
    expect(a2aObservations(nested)).toEqual([]);
  });

  it('only unwraps whitelisted payload cases', () => {
    expect(a2aObservations({ payload: { $case: 'task', value: { id: 't1', status: { state: 3 } } } })).toHaveLength(1);
    expect(a2aObservations({ payload: { $case: 'constructor', value: {} } })).toEqual([]);
    expect(a2aObservations({ payload: { $case: 'payload', value: { payload: { $case: 'payload' } } } })).toEqual([]);
    expect(a2aObservations({ payload: {} })).toEqual([]);
  });

  it('treats an unspecified request role as the caller and a result role as the agent', () => {
    for (const role of [undefined, 0, 'ROLE_UNSPECIFIED'])
      expect(a2aRequestRefs({ message: { messageId: 'm', role, parts: [] } }).message?.role).toBe('caller');
    expect(a2aRequestRefs({ message: { messageId: 'm', role: 'ROLE_AGENT', parts: [] } }).message?.role).toBe('agent');
    for (const role of [undefined, 0])
      expect(a2aObservations({ message: { messageId: 'm', role, parts: [] } })[0]).toMatchObject({ message: { role: 'agent' } });
  });
});
