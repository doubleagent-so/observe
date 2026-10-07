import { describe, expect, it } from 'vitest';
import { createRecorder, validateBatch, type EventBatch } from '../src/index';
import { withA2ATelemetry } from '../src/a2a/index';
import { finishingWith } from '../src/a2a/fetch';
import type {
  AgentEvent,
  ChargeInput,
  CostInput,
  FinishInput,
  MessageInput,
  OperationHandle,
  Recorder,
  TaskStateInput,
} from '../src/index';

function setup() {
  const batches: EventBatch[] = [];
  const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const batch = JSON.parse(String(init.body)) as EventBatch;
    batches.push(batch);
    return Response.json({ accepted: batch.events.length, content_dropped: 0, rejected: [] }, { status: 202 });
  }) as typeof globalThis.fetch;
  const recorder = createRecorder({ key: 'ak_test_x', endpoint: 'https://api.test', fetch, flushIntervalMs: 0, log: () => {} });
  const pending: Promise<unknown>[] = [];
  const schedule = (promise: Promise<unknown>) => {
    pending.push(promise);
  };
  const ctx = { waitUntil: schedule };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
    await recorder.flush();
  };
  const events = () => batches.flatMap((batch) => batch.events);
  return { recorder, ctx, schedule, settle, events, batches };
}

const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
  new Request('https://agent.example/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const sendParams = { message: { messageId: 'm1', contextId: 'c1', role: 'ROLE_USER', parts: [{ text: 'find flights' }] } };
const completedTask = {
  task: {
    id: 't1',
    contextId: 'c1',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ artifactId: 'a1', parts: [{ data: { results: 3 } }] }],
  },
};

describe('withA2ATelemetry', () => {
  it('records a unary SendMessage with caller and agent messages and the task state, leaving the response untouched', async () => {
    const { recorder, ctx, settle, events, batches } = setup();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask });
    const fetchHandler = withA2ATelemetry(
      async (_request: Request, _env: unknown, _ctx: unknown) => new Response(body, { headers: { 'content-type': 'application/json' } }),
      { recorder, waitUntil: true, identify: () => ({ declared_name: 'tester' }) },
    );
    const response = await fetchHandler(
      rpc('SendMessage', sendParams, { 'a2a-version': '1.0', 'a2a-extensions': 'https://ext.example/v1' }),
      {},
      ctx,
    );
    expect(await response.text()).toBe(body);
    await settle();
    expect(events().map((event) => event.type)).toEqual([
      'operation.started',
      'message.observed',
      'task.state_changed',
      'message.observed',
      'operation.finished',
    ]);
    expect(events()[0]).toMatchObject({
      method: 'SendMessage',
      kind: 'message',
      conversation_ref: 'c1',
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      counterparty: { declared_name: 'tester' },
      a2a: { extensions_requested: ['https://ext.example/v1'] },
    });
    expect(events()[1]).toMatchObject({ role: 'caller' });
    expect(events()[2]).toMatchObject({ task_ref: 't1', state: 'completed', native_state: 'TASK_STATE_COMPLETED' });
    expect(events()[3]).toMatchObject({ role: 'agent', artifact: true });
    expect(events()[4]).toMatchObject({ outcome: 'ok' });
    for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
  });

  it('links a first message without contextId to the conversation the agent assigns', async () => {
    const { recorder, ctx, settle, events } = setup();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask });
    const fetchHandler = withA2ATelemetry(
      async (_request: Request, _env: unknown, _ctx: unknown) => new Response(body, { headers: { 'content-type': 'application/json' } }),
      { recorder, waitUntil: true },
    );
    const { contextId: _omitted, ...message } = sendParams.message;
    await fetchHandler(rpc('SendMessage', { message }), {}, ctx);
    await settle();
    expect(events().map((event) => [event.type, event.conversation_ref])).toEqual([
      ['operation.started', undefined],
      ['message.observed', undefined],
      ['task.state_changed', 'c1'],
      ['message.observed', 'c1'],
      ['operation.finished', undefined],
    ]);
  });

  it('records JSON-RPC errors in HTTP 200 as protocol errors and 401 as auth_rejected', async () => {
    const { recorder, schedule, settle, events } = setup();
    const errorHandler = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'nope' } }), {
      recorder,
      waitUntil: schedule,
    });
    await errorHandler(rpc('GetTask', { id: 't9' }));
    const deniedHandler = withA2ATelemetry(async () => new Response('no', { status: 401 }), { recorder, waitUntil: schedule });
    await deniedHandler(rpc('tasks/get', { id: 't9' }));
    await settle();
    const finished = events().filter((event) => event.type === 'operation.finished');
    expect(finished[0]).toMatchObject({ outcome: 'protocol_error', error: { native_code: '-32001', code: 'task_not_found' } });
    expect(finished[1]).toMatchObject({ outcome: 'auth_rejected' });
    expect(events().filter((event) => event.type === 'operation.started' && event.method === 'GetTask')[1]).toMatchObject({
      kind: 'management',
      task_ref: 't9',
      protocol: { version: '0.3' },
    });
  });

  it('records Agent Card fetches as discovery', async () => {
    const { recorder, schedule, settle, events } = setup();
    const handler = withA2ATelemetry(async () => Response.json({ name: 'Agent' }), { recorder, waitUntil: schedule });
    await handler(new Request('https://agent.example/.well-known/agent-card.json'));
    await settle();
    expect(events()[0]).toMatchObject({ method: 'GetAgentCard', kind: 'discovery' });
    expect(events()[1]).toMatchObject({ outcome: 'ok' });
  });

  it('passes through non-A2A requests, invalid JSON and other paths untouched and unrecorded', async () => {
    const { recorder, schedule, settle, events } = setup();
    const seen: string[] = [];
    const handler = withA2ATelemetry(
      async (request: Request) => {
        seen.push(await request.text());
        return new Response('ok');
      },
      { recorder, waitUntil: schedule },
    );
    await handler(
      new Request('https://agent.example/a2a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }),
    );
    await handler(
      new Request('https://agent.example/a2a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hello":1}' }),
    );
    await handler(new Request('https://agent.example/health'));
    await settle();
    expect(seen).toEqual(['{not json', '{"hello":1}', '']);
    expect(events()).toEqual([]);
  });

  it('records oversized bodies and batches as unknown without parsing, and the handler still gets the body', async () => {
    const { recorder, schedule, settle, events } = setup();
    const lengths: number[] = [];
    const handler = withA2ATelemetry(
      async (request: Request) => {
        lengths.push((await request.text()).length);
        return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
      },
      { recorder, waitUntil: schedule },
    );
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { pad: 'x'.repeat(1024 * 1024) } });
    await handler(new Request('https://agent.example/a2a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }));
    await handler(
      new Request('https://agent.example/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[{"jsonrpc":"2.0","method":"SendMessage"}]',
      }),
    );
    await settle();
    expect(lengths[0]).toBe(big.length);
    expect(
      events()
        .filter((event) => event.type === 'operation.started')
        .map((event) => event.method),
    ).toEqual(['unknown', 'unknown']);
  });

  it('rethrows handler errors unchanged after recording an internal error', async () => {
    const { recorder, schedule, settle, events } = setup();
    const boom = new Error('boom');
    const handler = withA2ATelemetry(
      async () => {
        throw boom;
      },
      { recorder, waitUntil: schedule },
    );
    await expect(handler(rpc('SendMessage', sendParams))).rejects.toBe(boom);
    await settle();
    expect(events().at(-1)).toMatchObject({
      type: 'operation.finished',
      outcome: 'protocol_error',
      error: { native_code: 'exception', code: 'internal_error' },
    });
  });

  it('never lets identify or telemetry failures affect the response', async () => {
    const { recorder, schedule, settle } = setup();
    const handler = withA2ATelemetry(async () => new Response('fine', { headers: { 'content-type': 'application/json' } }), {
      recorder,
      waitUntil: schedule,
      identify: () => {
        throw new Error('identify broke');
      },
    });
    const response = await handler(rpc('SendMessage', sendParams));
    expect(await response.text()).toBe('fine');
    await settle();
  });

  it('records failed Agent Card fetches on a custom path as protocol errors', async () => {
    const { recorder, schedule, settle, events } = setup();
    const handler = withA2ATelemetry(async () => new Response('gone', { status: 404 }), {
      recorder,
      waitUntil: schedule,
      cardPath: '/card.json',
    });
    await handler(new Request('https://agent.example/card.json'));
    await handler(new Request('https://agent.example/.well-known/agent-card.json'));
    await settle();
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ outcome: 'protocol_error', error: { native_code: '404', code: 'http_error' } });
  });

  it('runs background work detached without waitUntil and when no argument has waitUntil', async () => {
    const { recorder, settle, events } = setup();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask });
    const detached = withA2ATelemetry(async () => new Response(body), { recorder });
    const noCtx = withA2ATelemetry(async (_request: Request, _env: unknown) => new Response(body), { recorder, waitUntil: true });
    await detached(rpc('SendMessage', sendParams));
    await noCtx(rpc('SendMessage', sendParams), {});
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await settle();
    const finished = events().filter((event) => event.type === 'operation.finished');
    expect(finished.map((event) => event.outcome)).toEqual(['ok', 'ok']);
    expect(events().filter((event) => event.type === 'task.state_changed')).toHaveLength(1);
  });

  it('records declared-oversize bodies and invalid method names as unknown, and skips empty batches', async () => {
    const { recorder, schedule, settle, events } = setup();
    const handler = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }), {
      recorder,
      waitUntil: schedule,
    });
    const post = (body: string, headers: Record<string, string> = {}) =>
      new Request('https://agent.example/a2a', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    await handler(post('{}', { 'content-length': String(2 * 1024 * 1024) }));
    await handler(post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bad method!' })));
    await handler(post('[]'));
    await settle();
    const started = events().filter((event) => event.type === 'operation.started');
    expect(started.map((event) => [event.method, event.kind])).toEqual([
      ['unknown', 'other'],
      ['unknown', 'other'],
    ]);
  });

  it('passes the request through when the recorder fails to start an operation', async () => {
    const { recorder } = setup();
    const logged: string[] = [];
    const broken = {
      ...recorder,
      startOperation: () => {
        throw new TypeError('broken');
      },
    };
    const handler = withA2ATelemetry(async () => new Response('fine'), { recorder: broken, log: (event) => logged.push(event) });
    expect(await (await handler(rpc('SendMessage', sendParams))).text()).toBe('fine');
    expect(logged).toEqual(['agent_telemetry_event_failed']);
  });

  describe('request reads', () => {
    it('passes through without telemetry when the request body is already used', async () => {
      const { recorder, schedule, settle, events } = setup();
      const logged: string[] = [];
      const handler = withA2ATelemetry(async () => new Response('handled'), {
        recorder,
        waitUntil: schedule,
        log: (event) => logged.push(event),
      });
      const request = rpc('SendMessage', sendParams);
      await request.text();
      expect(await (await handler(request)).text()).toBe('handled');
      await settle();
      expect(events()).toEqual([]);
      expect(logged).toEqual(['agent_telemetry_event_failed']);
    });

    it('passes through when the request body stream errors mid-read', async () => {
      const { recorder, schedule, settle, events } = setup();
      const logged: string[] = [];
      const handler = withA2ATelemetry(async () => new Response('handled'), {
        recorder,
        waitUntil: schedule,
        log: (event) => logged.push(event),
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
          controller.error(new Error('socket reset'));
        },
      });
      const request = new Request('https://agent.example/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit);
      expect(await (await handler(request)).text()).toBe('handled');
      await settle();
      expect(events()).toEqual([]);
      expect(logged).toEqual(['agent_telemetry_event_failed']);
    });
  });

  describe('response reads', () => {
    const finished = (events: () => EventBatch['events']) => events().filter((event) => event.type === 'operation.finished');

    it('finishes oversize responses from content-length without parsing them', async () => {
      const { recorder, schedule, settle, events } = setup();
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask });
      const declared = String(5 * 1024 * 1024);
      const handler = withA2ATelemetry(
        async () => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': declared } }),
        { recorder, waitUntil: schedule },
      );
      const response = await handler(rpc('SendMessage', sendParams));
      expect(await response.text()).toBe(body);
      await settle();
      expect(events().some((event) => event.type === 'task.state_changed')).toBe(false);
      expect(finished(events)).toEqual([expect.objectContaining({ outcome: 'ok', response_bytes: Number(declared) })]);
    });

    it('stops reading streamed responses past 4 MiB and leaves the client stream intact', async () => {
      const { recorder, schedule, settle, events } = setup();
      const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
      const total = 6;
      const handler = withA2ATelemetry(
        async () => {
          let sent = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent === 0) controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"pad":"'));
              if (sent++ < total) controller.enqueue(chunk);
              else {
                controller.enqueue(new TextEncoder().encode('"}}'));
                controller.close();
              }
            },
          });
          return new Response(stream, { headers: { 'content-type': 'application/json' } });
        },
        { recorder, waitUntil: schedule },
      );
      const response = await handler(rpc('SendMessage', sendParams));
      await settle();
      expect((await response.text()).length).toBeGreaterThan(total * chunk.byteLength);
      const [finish] = finished(events);
      expect(finish).toMatchObject({ outcome: 'ok' });
      expect(finish).not.toHaveProperty('response_bytes');
    });

    it('counts response bytes, not characters', async () => {
      const { recorder, schedule, settle, events } = setup();
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { note: 'café ✓ 日本' } });
      const handler = withA2ATelemetry(async () => new Response(body, { headers: { 'content-type': 'application/json' } }), {
        recorder,
        waitUntil: schedule,
      });
      await handler(rpc('SendMessage', sendParams));
      await settle();
      expect(finished(events)[0]).toMatchObject({ outcome: 'ok', response_bytes: new TextEncoder().encode(body).byteLength });
    });

    it('records ok without an unhandled rejection when the response cannot be cloned in detached mode', async () => {
      const { recorder, settle, events } = setup();
      const handler = withA2ATelemetry(
        async () => {
          const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
          await response.text();
          return response;
        },
        { recorder },
      );
      await handler(rpc('SendMessage', sendParams));
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      await settle();
      expect(finished(events)).toEqual([expect.objectContaining({ outcome: 'ok' })]);
    });
  });

  describe('scheduling', () => {
    it('logs once per wrapper when waitUntil is true but no argument has waitUntil', async () => {
      const { recorder, settle } = setup();
      const logged: string[] = [];
      const handler = withA2ATelemetry(async (_request: Request, _env: unknown) => Response.json({}), {
        recorder,
        waitUntil: true,
        log: (event) => logged.push(event),
      });
      await handler(rpc('SendMessage', sendParams), {});
      await handler(rpc('SendMessage', sendParams), {});
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      await settle();
      expect(logged).toEqual(['agent_telemetry_no_waituntil']);
    });

    it('never lets a throwing waitUntil replace the handler error or reject a response', async () => {
      const { recorder } = setup();
      const logged: string[] = [];
      const waitUntil = () => {
        throw new Error('waitUntil broke');
      };
      const boom = new Error('boom');
      const failing = withA2ATelemetry(
        async () => {
          throw boom;
        },
        { recorder, waitUntil, log: (event) => logged.push(event) },
      );
      await expect(failing(rpc('SendMessage', sendParams))).rejects.toBe(boom);
      const working = withA2ATelemetry(async () => Response.json({}), { recorder, waitUntil, log: (event) => logged.push(event) });
      expect(await (await working(rpc('SendMessage', sendParams))).json()).toEqual({});
      expect(logged).toEqual(['agent_telemetry_schedule_failed', 'agent_telemetry_schedule_failed']);
    });
  });

  describe('HTTP errors on POST', () => {
    const finishedFor = async (response: () => Response) => {
      const { recorder, schedule, settle, events, batches } = setup();
      const handler = withA2ATelemetry(async () => response(), { recorder, waitUntil: schedule });
      await handler(rpc('SendMessage', sendParams));
      await settle();
      for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
      return events().filter((event) => event.type === 'operation.finished');
    };

    it('records an error status without a JSON-RPC error as an HTTP error, whatever the body', async () => {
      const cases: [() => Response, string][] = [
        [() => new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }), '502'],
        [() => new Response('<h1>Server error</h1>', { status: 500 }), '500'],
        [() => new Response('not here', { status: 404 }), '404'],
        [() => new Response('too big', { status: 413 }), '413'],
        [() => Response.json({ message: 'slow down' }, { status: 429 }), '429'],
        [() => Response.json({ jsonrpc: '2.0', id: 1, result: completedTask }, { status: 503 }), '503'],
        [() => new Response(null, { status: 500 }), '500'],
        [() => new Response('x', { status: 500, headers: { 'content-length': String(5 * 1024 * 1024) } }), '500'],
      ];
      for (const [response, status] of cases) {
        const finished = await finishedFor(response);
        expect(finished).toMatchObject([{ outcome: 'protocol_error', error: { native_code: status, code: 'http_error' } }]);
      }
    });

    it('keeps the JSON-RPC error of an error status, and auth_rejected for 401 and 403', async () => {
      expect(await finishedFor(() => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32600 } }, { status: 400 }))).toMatchObject([
        { outcome: 'protocol_error', error: { native_code: '-32600', code: 'invalid_request' } },
      ]);
      expect(await finishedFor(() => new Response('<html>denied</html>', { status: 403 }))).toMatchObject([{ outcome: 'auth_rejected' }]);
      expect(await finishedFor(() => Response.json({ error: 'login' }, { status: 401 }))).toMatchObject([{ outcome: 'auth_rejected' }]);
    });

    it('records the scopes a 403 insufficient_scope challenge asks for', async () => {
      const headers = { 'www-authenticate': 'Bearer error="insufficient_scope", scope="tasks:write"' };
      expect(await finishedFor(() => new Response('denied', { status: 403, headers }))).toMatchObject([
        { outcome: 'auth_rejected', insufficient_scope: { required: ['tasks:write'] } },
      ]);
      const [unauthorized] = await finishedFor(() => new Response('login', { status: 401, headers }));
      expect(unauthorized).not.toHaveProperty('insufficient_scope');
    });

    it('records an event-stream error status as an HTTP error and passes the stream through unchanged', async () => {
      const { recorder, schedule, settle, events, batches } = setup();
      const body = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask })}\n\n`;
      const handler = withA2ATelemetry(
        async () => new Response(body, { status: 503, headers: { 'content-type': 'text/event-stream', 'x-trace': 'abc' } }),
        { recorder, waitUntil: schedule },
      );
      const response = await handler(rpc('SendStreamingMessage', sendParams));
      expect(response.status).toBe(503);
      expect(response.headers.get('x-trace')).toBe('abc');
      expect(await response.text()).toBe(body);
      await settle();
      for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
      expect(events().map((event) => event.type)).toEqual(['operation.started', 'message.observed', 'operation.finished']);
      expect(events().at(-1)).toMatchObject({ outcome: 'protocol_error', error: { native_code: '503', code: 'http_error' } });
    });

    it('observes nothing from the body of an error status', async () => {
      const { recorder, schedule, settle, events } = setup();
      const handler = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, result: completedTask }, { status: 500 }), {
        recorder,
        waitUntil: schedule,
      });
      await handler(rpc('SendMessage', sendParams));
      await settle();
      expect(events().map((event) => event.type)).toEqual(['operation.started', 'message.observed', 'operation.finished']);
    });
  });

  describe('ids the validator rejects', () => {
    it('records the operation without refs whose ids contain spaces or non-ASCII characters', async () => {
      const { recorder, schedule, settle, events, batches } = setup();
      const result = { task: { ...completedTask.task, id: 'task one', contextId: 'cöntext' } };
      const handler = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, result }), { recorder, waitUntil: schedule });
      const message = { messageId: 'message one', contextId: 'context one', taskId: 'tâche', role: 'ROLE_USER', parts: [{ text: 'hi' }] };
      await handler(rpc('SendMessage', { message }));
      await handler(rpc('GetTask', { id: 'ünï' }));
      await handler(rpc('tasks/get', { id: 'has\ttab' }));
      await settle();
      for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
      const started = events().filter((event) => event.type === 'operation.started');
      expect(started).toHaveLength(3);
      for (const event of events()) {
        expect(event).not.toHaveProperty('conversation_ref');
        expect(event).not.toHaveProperty('task_ref');
      }
      const caller = events().find((event) => event.type === 'message.observed');
      expect(caller).toMatchObject({ role: 'caller', message_id: expect.stringMatching(/^[0-9A-Z]{26}$/) });
      expect(events().filter((event) => event.type === 'task.state_changed')).toEqual([]);
      expect(
        events()
          .filter((event) => event.type === 'operation.finished')
          .map((event) => event.outcome),
      ).toEqual(['ok', 'ok', 'ok']);
    });
  });

  describe('method names', () => {
    const startedFor = async (methods: string[], headers: Record<string, string> = {}) => {
      const { recorder, schedule, settle, events, batches } = setup();
      const handler = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }), { recorder, waitUntil: schedule });
      for (const method of methods) {
        await handler(rpc(method, {}, headers));
      }
      await settle();
      for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
      return events()
        .filter((event) => event.type === 'operation.started')
        .map((event) => [event.method, event.kind, event.protocol.version, event.protocol.binding]);
    };

    it('records 0.3 wire methods under their canonical 1.0 names, keeping the 0.3 version and binding', async () => {
      expect(
        await startedFor([
          'message/send',
          'message/stream',
          'tasks/get',
          'tasks/list',
          'tasks/cancel',
          'tasks/resubscribe',
          'tasks/pushNotificationConfig/set',
          'tasks/pushNotificationConfig/get',
          'tasks/pushNotificationConfig/list',
          'tasks/pushNotificationConfig/delete',
          'agent/getAuthenticatedExtendedCard',
        ]),
      ).toEqual([
        ['SendMessage', 'message', '0.3', 'jsonrpc-http'],
        ['SendStreamingMessage', 'message', '0.3', 'sse'],
        ['GetTask', 'management', '0.3', 'jsonrpc-http'],
        ['ListTasks', 'management', '0.3', 'jsonrpc-http'],
        ['CancelTask', 'management', '0.3', 'jsonrpc-http'],
        ['SubscribeToTask', 'management', '0.3', 'sse'],
        ['CreateTaskPushNotificationConfig', 'management', '0.3', 'jsonrpc-http'],
        ['GetTaskPushNotificationConfig', 'management', '0.3', 'jsonrpc-http'],
        ['ListTaskPushNotificationConfigs', 'management', '0.3', 'jsonrpc-http'],
        ['DeleteTaskPushNotificationConfig', 'management', '0.3', 'jsonrpc-http'],
        ['GetExtendedAgentCard', 'discovery', '0.3', 'jsonrpc-http'],
      ]);
    });

    it('keeps 1.0 methods, and the native name of an unknown method, sanitized as before', async () => {
      expect(
        await startedFor(
          ['SendMessage', 'SendStreamingMessage', 'GetTask', 'GetExtendedAgentCard', 'custom/doThing', 'Ping', 'bad method!'],
          {
            'a2a-version': '1.0',
          },
        ),
      ).toEqual([
        ['SendMessage', 'message', '1.0', 'jsonrpc-http'],
        ['SendStreamingMessage', 'message', '1.0', 'sse'],
        ['GetTask', 'management', '1.0', 'jsonrpc-http'],
        ['GetExtendedAgentCard', 'discovery', '1.0', 'jsonrpc-http'],
        ['custom/doThing', 'other', '1.0', 'jsonrpc-http'],
        ['Ping', 'other', '1.0', 'jsonrpc-http'],
        ['unknown', 'other', '1.0', 'jsonrpc-http'],
      ]);
    });
  });

  describe('the a2a block', () => {
    it('records the message id, reference tasks and requested extensions, and the extensions the response activates', async () => {
      const { recorder, ctx, settle, events, batches } = setup();
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask });
      const handler = withA2ATelemetry(
        async (_request: Request, _env: unknown, _ctx: unknown) =>
          new Response(body, { headers: { 'content-type': 'application/json', 'a2a-extensions': 'https://ext.example/v1' } }),
        { recorder, waitUntil: true },
      );
      const message = { ...sendParams.message, referenceTaskIds: ['t-old', 'not valid'] };
      await handler(rpc('SendMessage', { message }, { 'a2a-extensions': 'https://ext.example/v1, https://ext.example/v2' }), {}, ctx);
      await settle();
      for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
      const started = events().find((event) => event.type === 'operation.started');
      expect(started?.a2a).toEqual({
        message_id: 'm1',
        reference_task_ids: ['t-old'],
        extensions_requested: ['https://ext.example/v1', 'https://ext.example/v2'],
      });
      const finished = events().find((event) => event.type === 'operation.finished');
      expect(finished?.a2a).toEqual({ extensions_activated: ['https://ext.example/v1'] });
      expect(
        events()
          .filter((event) => event.type !== 'operation.started' && event.type !== 'operation.finished')
          .some((event) => event.a2a),
      ).toBe(false);
    });

    it('reads the 0.3 X-A2A-Extensions header both ways and leaves out an empty block', async () => {
      const { recorder, schedule, settle, events } = setup();
      const handler = withA2ATelemetry(
        async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'x-a2a-extensions': 'https://ext.example/old' } }),
        { recorder, waitUntil: schedule },
      );
      await handler(rpc('tasks/get', { id: 't1' }, { 'x-a2a-extensions': 'https://ext.example/old' }));
      const plain = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }), { recorder, waitUntil: schedule });
      await plain(rpc('GetTask', { id: 't1' }));
      await settle();
      const [first, , second] = events().filter((event) => event.type === 'operation.started' || event.type === 'operation.finished');
      expect(first.a2a).toEqual({ extensions_requested: ['https://ext.example/old'] });
      expect(events()[1].a2a).toEqual({ extensions_activated: ['https://ext.example/old'] });
      expect(second).not.toHaveProperty('a2a');
      expect(events().at(-1)).not.toHaveProperty('a2a');
    });

    it('records activated extensions on streamed and immediately finished responses', async () => {
      const { recorder, schedule, settle, events } = setup();
      const activated = { 'a2a-extensions': 'https://ext.example/v1' };
      const stream = withA2ATelemetry(
        async () =>
          new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: completedTask })}\n\n`, {
            headers: { 'content-type': 'text/event-stream', ...activated },
          }),
        { recorder, waitUntil: schedule },
      );
      await (await stream(rpc('SendStreamingMessage', sendParams))).text();
      const denied = withA2ATelemetry(async () => new Response('no', { status: 401, headers: activated }), {
        recorder,
        waitUntil: schedule,
      });
      await denied(rpc('SendMessage', sendParams));
      await settle();
      const finished = events().filter((event) => event.type === 'operation.finished');
      expect(finished.map((event) => [event.outcome, event.a2a])).toEqual([
        ['ok', { extensions_activated: ['https://ext.example/v1'] }],
        ['auth_rejected', { extensions_activated: ['https://ext.example/v1'] }],
      ]);
    });
  });

  describe('payment evidence', () => {
    const b64 = (value: unknown) => btoa(JSON.stringify(value));
    const working = { jsonrpc: '2.0', id: 1, result: { task: { id: 't-9', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } } };
    const paid = (value: string) => ({
      'x-payment': b64({ x402Version: 1, network: 'base', payload: { signature: '0xsig', authorization: { value } } }),
    });
    const settlement = b64({ success: true, transaction: '0xabc', network: 'base' });
    const json = { 'content-type': 'application/json' };
    const charges = (events: AgentEvent[]) => events.filter((event) => event.type === 'transaction.recorded');

    it('records x402 settlement evidence as a charge on the task the response carries, before the finish', async () => {
      const { recorder, ctx, settle, events, batches } = setup();
      const body = JSON.stringify(working);
      const handler = withA2ATelemetry(
        async (_request: Request, _env: unknown, _ctx: unknown) =>
          new Response(body, { headers: { ...json, 'x-payment-response': settlement } }),
        { recorder, waitUntil: true },
      );
      const response = await handler(rpc('SendMessage', sendParams, paid('250000')), {}, ctx);
      expect(await response.text()).toBe(body);
      expect(response.headers.get('x-payment-response')).toBe(settlement);
      await settle();
      const types = events().map((event) => event.type);
      expect(types.indexOf('transaction.recorded')).toBeLessThan(types.indexOf('operation.finished'));
      expect(charges(events())).toEqual([
        expect.objectContaining({
          task_ref: 't-9',
          operation_id: events()[0].operation_id,
          amount: 250_000,
          currency: 'USDC',
          method: 'x402',
          network: 'base',
          external_ref: '0xabc',
          status: 'settled',
          basis: 'reported',
          kind: 'charge',
        }),
      ]);
      expect(JSON.stringify(events())).not.toContain('0xsig');
      for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
    });

    it("falls back to the request's task when the response carries none", async () => {
      const { recorder, schedule, settle, events } = setup();
      const message = { jsonrpc: '2.0', id: 1, result: { message: { messageId: 'r1', role: 'ROLE_AGENT', parts: [{ text: 'ok' }] } } };
      const handler = withA2ATelemetry(async () => Response.json(message, { headers: { 'x-payment-response': settlement } }), {
        recorder,
        waitUntil: schedule,
      });
      const params = { message: { ...sendParams.message, taskId: 't-req' } };
      await handler(rpc('SendMessage', params, paid('10')));
      await settle();
      expect(charges(events())).toMatchObject([{ task_ref: 't-req', amount: 10 }]);
    });

    it('records the charge on the operation alone without a task, and on JSON-RPC errors and unreadable bodies', async () => {
      const responses: (() => Response)[] = [
        () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'x-payment-response': settlement } }),
        () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603 } }, { headers: { 'x-payment-response': settlement } }),
        () => new Response('not json', { headers: { ...json, 'x-payment-response': settlement } }),
        () =>
          new Response('x', {
            headers: { ...json, 'x-payment-response': settlement, 'content-length': String(5 * 1024 * 1024) },
          }),
      ];
      for (const response of responses) {
        const { recorder, schedule, settle, events, batches } = setup();
        const handler = withA2ATelemetry(async () => response(), { recorder, waitUntil: schedule });
        await handler(rpc('SendMessage', sendParams, paid('5')));
        await settle();
        const [charge] = charges(events());
        expect(charge).toMatchObject({ operation_id: events()[0].operation_id, amount: 5 });
        expect(charge).not.toHaveProperty('task_ref');
        expect(events().at(-1)?.type).toBe('operation.finished');
        for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
      }
    });

    it('charges a settlement header on any status but 401 and 403, a failed settlement as failed', async () => {
      const failed = b64({ success: false, network: 'base' });
      const cases: [Response, unknown][] = [
        [new Response('boom', { status: 500, headers: { 'x-payment-response': settlement } }), { status: 'settled', amount: 5 }],
        [new Response('pay first', { status: 402, headers: { 'x-payment-response': failed } }), { status: 'failed', amount: 5 }],
        [new Response('no', { status: 401, headers: { 'x-payment-response': settlement } }), undefined],
        [new Response('no', { status: 403, headers: { 'x-payment-response': settlement } }), undefined],
      ];
      for (const [response, expected] of cases) {
        const { recorder, schedule, settle, events } = setup();
        const handler = withA2ATelemetry(async () => response, { recorder, waitUntil: schedule });
        await handler(rpc('SendMessage', sendParams, paid('5')));
        await settle();
        if (expected) expect(charges(events())).toMatchObject([expected]);
        else expect(charges(events())).toEqual([]);
      }
    });

    it("records x402 evidence on the request's task for a streamed response, before the stream is read", async () => {
      const { recorder, ctx, settle, events } = setup();
      const params = { message: { messageId: 'm3', taskId: 't-3', contextId: 'c1', role: 'ROLE_USER', parts: [{ text: 'go' }] } };
      const update = { statusUpdate: { taskId: 't-4', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } };
      const stream = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: update })}\n\n`;
      const handler = withA2ATelemetry(
        async (_request: Request, _env: unknown, _ctx: unknown) =>
          new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-payment-response': settlement } }),
        { recorder, waitUntil: true },
      );
      const response = await handler(rpc('SendStreamingMessage', params, paid('1200')), {}, ctx);
      expect(await response.text()).toBe(stream);
      await settle();
      const types = events().map((event) => event.type);
      expect(types.indexOf('transaction.recorded')).toBeLessThan(types.indexOf('task.state_changed'));
      expect(charges(events())).toMatchObject([{ task_ref: 't-3', amount: 1200, method: 'x402', status: 'settled' }]);
    });

    it('records a failed settlement on an error status, but nothing for 401, 403 or GET', async () => {
      const failed = b64({ success: false, network: 'base' });
      const { recorder, schedule, settle, events } = setup();
      const unpaid = withA2ATelemetry(
        async () => Response.json({ error: 'payment' }, { status: 402, headers: { 'x-payment-response': failed } }),
        { recorder, waitUntil: schedule },
      );
      await unpaid(rpc('SendMessage', sendParams, paid('5')));
      const streamed = withA2ATelemetry(
        async () =>
          new Response('data: {}\n\n', { status: 402, headers: { 'content-type': 'text/event-stream', 'x-payment-response': failed } }),
        { recorder, waitUntil: schedule },
      );
      await (await streamed(rpc('SendStreamingMessage', sendParams, paid('6')))).text();
      for (const status of [401, 403]) {
        const denied = withA2ATelemetry(async () => new Response('no', { status, headers: { 'x-payment-response': settlement } }), {
          recorder,
          waitUntil: schedule,
        });
        await denied(rpc('SendMessage', sendParams, paid('7')));
      }
      const card = withA2ATelemetry(async () => Response.json({ name: 'a' }, { headers: { 'x-payment-response': settlement } }), {
        recorder,
        waitUntil: schedule,
      });
      await card(new Request('https://agent.example/.well-known/agent-card.json', { headers: paid('8') }));
      await settle();
      expect(charges(events()).map((event) => [event.amount, event.status])).toEqual([
        [5, 'failed'],
        [6, 'failed'],
      ]);
    });

    it('records nothing and changes nothing when evidence is malformed', async () => {
      const { recorder, ctx, settle, events } = setup();
      const body = JSON.stringify(working);
      const handler = withA2ATelemetry(
        async (_request: Request, _env: unknown, _ctx: unknown) =>
          new Response(body, { headers: { ...json, 'x-payment-response': 'garbage' } }),
        { recorder, waitUntil: true },
      );
      const response = await handler(rpc('SendMessage', sendParams, { 'x-payment': '%%%' }), {}, ctx);
      expect(await response.text()).toBe(body);
      await settle();
      expect(charges(events())).toEqual([]);
      expect(events().at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok' });
    });

    it('logs and records nothing when reading the evidence throws', async () => {
      const { recorder, schedule, settle, events } = setup();
      const logged: string[] = [];
      const handler = withA2ATelemetry(
        async () => {
          const response = Response.json(working);
          const get = response.headers.get.bind(response.headers);
          response.headers.get = (name: string) => {
            if (name === 'payment-response') throw new TypeError('exotic');
            return get(name);
          };
          return response;
        },
        { recorder, waitUntil: schedule, log: (event) => logged.push(event) },
      );
      await handler(rpc('SendMessage', sendParams, paid('5')));
      await settle();
      expect(charges(events())).toEqual([]);
      expect(events().at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok' });
      expect(logged).toEqual(['agent_telemetry_event_failed']);
    });

    it('charges once when a custom handle throws on finish', async () => {
      const { recorder, schedule, settle, events } = setup();
      let finishes = 0;
      const throwing: Recorder = {
        ...recorder,
        startOperation: (input) => {
          const op = recorder.startOperation(input);
          return {
            ...finishingWith(op, {}),
            finish: (result) => {
              finishes++;
              if (finishes === 1) throw new Error('boom');
              op.finish(result);
            },
          };
        },
      };
      const handler = withA2ATelemetry(async () => Response.json(working, { headers: { 'x-payment-response': settlement } }), {
        recorder: throwing,
        waitUntil: schedule,
      });
      await handler(rpc('SendMessage', sendParams, paid('5')));
      await settle();
      expect(finishes).toBe(2);
      expect(charges(events())).toHaveLength(1);
    });

    describe('over A2A metadata', () => {
      const payload = {
        x402Version: 2,
        accepted: { scheme: 'exact', network: 'eip155:8453', amount: '3000' },
        payload: { signature: '0xsig', authorization: { value: '3000' } },
      };
      const submitted = {
        message: {
          messageId: 'm-pay',
          taskId: 't-pay',
          contextId: 'c1',
          role: 'ROLE_USER',
          parts: [{ text: 'paying' }],
          metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload },
        },
      };
      const receiptStatus = (status: string, receipts: unknown) => ({
        state: 'TASK_STATE_COMPLETED',
        message: {
          messageId: 'm-receipt',
          role: 'ROLE_AGENT',
          parts: [{ text: 'paid' }],
          metadata: { 'x402.payment.status': status, 'x402.payment.receipts': receipts },
        },
      });
      const completed = receiptStatus('payment-completed', [{ success: true, transaction: '0xmeta', network: 'eip155:8453' }]);
      const unary =
        (status: unknown, headers: Record<string, string> = {}) =>
        async () =>
          Response.json({ jsonrpc: '2.0', id: 1, result: { task: { id: 't-done', contextId: 'c1', status } } }, { headers });
      const sse =
        (results: unknown[], headers: Record<string, string> = {}) =>
        async () =>
          new Response(results.map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream', ...headers },
          });
      const run = async (handlerFn: () => Promise<Response>, method = 'SendMessage', headers: Record<string, string> = {}) => {
        const { recorder, schedule, settle, events, batches } = setup();
        const handler = withA2ATelemetry(handlerFn, { recorder, waitUntil: schedule });
        await (await handler(rpc(method, submitted, headers))).text();
        await settle();
        for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
        return events();
      };

      it('charges a completed receipt in a unary result to its task, before the finish', async () => {
        const recorded = await run(unary(completed));
        const types = recorded.map((event) => event.type);
        expect(types.indexOf('transaction.recorded')).toBeLessThan(types.indexOf('operation.finished'));
        expect(charges(recorded)).toEqual([
          expect.objectContaining({
            task_ref: 't-done',
            amount: 3000,
            currency: 'USDC',
            network: 'eip155:8453',
            external_ref: '0xmeta',
            status: 'settled',
            basis: 'reported',
          }),
        ]);
        expect(JSON.stringify(recorded)).not.toContain('0xsig');
      });

      it('charges a failed receipt as failed', async () => {
        const failed = receiptStatus('payment-failed', [{ success: false, errorReason: 'insufficient_funds', network: 'eip155:8453' }]);
        expect(charges(await run(unary(failed)))).toMatchObject([{ task_ref: 't-done', amount: 3000, status: 'failed' }]);
      });

      it('charges the first receipt in a stream once, to its status update task', async () => {
        const update = (taskId: string, status: unknown) => ({ statusUpdate: { taskId, contextId: 'c1', status } });
        const recorded = await run(
          sse([update('t-pay', { state: 'TASK_STATE_WORKING' }), update('t-pay', completed), update('t-other', completed)]),
          'SendStreamingMessage',
        );
        expect(charges(recorded)).toMatchObject([{ task_ref: 't-pay', amount: 3000, external_ref: '0xmeta', status: 'settled' }]);
        const types = recorded.map((event) => event.type);
        expect(types.indexOf('transaction.recorded')).toBeLessThan(types.indexOf('operation.finished'));
      });

      it('records one charge, from the metadata, when the headers carry the same payment', async () => {
        const headers = { 'x-payment-response': settlement };
        expect(charges(await run(unary(completed, headers), 'SendMessage', paid('3000')))).toMatchObject([
          { external_ref: '0xmeta', amount: 3000 },
        ]);
        const update = { statusUpdate: { taskId: 't-pay', contextId: 'c1', status: completed } };
        expect(charges(await run(sse([update], headers), 'SendStreamingMessage', paid('3000')))).toMatchObject([
          { external_ref: '0xmeta', amount: 3000 },
        ]);
      });

      it('falls back to the headers when the metadata yields no charge', async () => {
        const headers = { 'x-payment-response': settlement };
        expect(charges(await run(unary({ state: 'TASK_STATE_WORKING' }, headers), 'SendMessage', paid('5')))).toMatchObject([
          { external_ref: '0xabc', amount: 5, task_ref: 't-done' },
        ]);
        const inProgress = { statusUpdate: { taskId: 't-pay', status: { state: 'TASK_STATE_WORKING' } } };
        expect(charges(await run(sse([inProgress], headers), 'SendStreamingMessage', paid('6')))).toMatchObject([
          { external_ref: '0xabc', amount: 6, task_ref: 't-pay' },
        ]);
      });

      it('records nothing for malformed metadata and leaves the operation intact', async () => {
        const cases = [
          receiptStatus('payment-completed', 'not a list'),
          receiptStatus('payment-completed', ['junk']),
          receiptStatus('payment-verified', [{ success: true }]),
        ];
        for (const status of cases) {
          const recorded = await run(unary(status));
          expect(charges(recorded)).toEqual([]);
          expect(recorded.at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok' });
        }
        const { recorder, schedule, settle, events } = setup();
        const handler = withA2ATelemetry(unary(completed), { recorder, waitUntil: schedule });
        const badPayload = {
          message: {
            ...submitted.message,
            metadata: { ...submitted.message.metadata, 'x402.payment.payload': { accepted: { amount: '1.5' } } },
          },
        };
        await handler(rpc('SendMessage', badPayload));
        await settle();
        expect(charges(events())).toEqual([]);
        expect(events().at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok' });
      });
    });

    it('still finishes the operation when a custom recorder throws on charge', async () => {
      const { recorder, schedule, settle, events } = setup();
      const logged: string[] = [];
      const throwing: Recorder = {
        ...recorder,
        startOperation: (input) => ({
          ...finishingWith(recorder.startOperation(input), {}),
          charge: () => {
            throw new Error('boom');
          },
        }),
      };
      const body = JSON.stringify(working);
      const handler = withA2ATelemetry(async () => new Response(body, { headers: { ...json, 'x-payment-response': settlement } }), {
        recorder: throwing,
        waitUntil: schedule,
        log: (event) => logged.push(event),
      });
      const response = await handler(rpc('SendMessage', sendParams, paid('5')));
      expect(await response.text()).toBe(body);
      await settle();
      expect(events().filter((event) => event.type === 'operation.finished')).toHaveLength(1);
      expect(logged).toContain('agent_telemetry_event_failed');
    });
  });
});

describe('finishingWith', () => {
  it('forwards every member of a class-based handle, reading operationId through its getter', () => {
    const calls: string[] = [];
    class Handle implements OperationHandle {
      #id = 'op-1';
      get operationId(): string {
        return this.#id;
      }
      rename(id: string): void {
        this.#id = id;
      }
      message(_input: MessageInput): void {
        calls.push(`message:${this.#id}`);
      }
      taskState(input: TaskStateInput): void {
        calls.push(`taskState:${input.state}:${this.#id}`);
      }
      cost(input: CostInput): void {
        calls.push(`cost:${input.category}:${this.#id}`);
      }
      charge(input: ChargeInput): string {
        calls.push(`charge:${input.amount}:${this.#id}`);
        return 'tx-1';
      }
      finish(input: FinishInput): void {
        calls.push(`finish:${input.outcome}:${JSON.stringify(input.a2a)}:${this.#id}`);
      }
    }
    const handle = new Handle();
    const wrapped = finishingWith(handle, { a2a: { extensions_activated: ['https://ext'] } });
    expect(wrapped.operationId).toBe('op-1');
    handle.rename('op-2');
    expect(wrapped.operationId).toBe('op-2');
    wrapped.message({ role: 'agent', parts: [] });
    wrapped.taskState({ taskRef: 't', state: 'working', nativeState: 'TASK_STATE_WORKING' });
    wrapped.cost({ category: 'model', amountMicros: 1, currency: 'USD', basis: 'estimated' });
    expect(wrapped.charge({ amount: 5, currency: 'USD', method: 'card', status: 'pending', basis: 'reported' })).toBe('tx-1');
    wrapped.finish({ outcome: 'ok' });
    expect(calls).toEqual([
      'message:op-2',
      'taskState:working:op-2',
      'cost:model:op-2',
      'charge:5:op-2',
      'finish:ok:{"extensions_activated":["https://ext"]}:op-2',
    ]);
  });
});
