import { ServerCallContext, type A2ARequestHandler, type TaskStore } from '@a2a-js/sdk/server';
import { describe, expect, it, vi } from 'vitest';
import { a2aTelemetryInterceptor, instrumentA2AHandler, instrumentTaskStore, withA2ATelemetry } from '../src/a2a/index';
import { createRecorder, type Recorder } from '../src/index';
import { observeSse } from '../src/sse';

/** A host logger that always throws: it must never reach the host's request, stream or SDK call. */
const throwingLog = () => {
  throw new Error('logger broke');
};

/** A recorder whose every call throws, so each entry point has to log. */
const brokenRecorder = {
  startOperation() {
    throw new TypeError('start');
  },
  abandonTask() {
    throw new TypeError('abandon');
  },
  transaction() {
    throw new TypeError('transaction');
  },
  flush: async () => {},
  shutdown: async () => {},
  stats: () => ({ buffered: 0, dropped: 0, sent: 0, rejected: 0, disabled: false }),
} as unknown as Recorder;

const rpc = (body: unknown) =>
  new Request('https://agent.example/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', parts: [] } },
      ...(body as object),
    }),
  });

const sseBody = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';

function quietRecorder(): Recorder {
  const fetch = (async () => Response.json({ accepted: 0, rejected: [] }, { status: 202 })) as typeof globalThis.fetch;
  return createRecorder({ key: 'ak_test_x', endpoint: 'https://api.test', fetch, flushIntervalMs: 0, log: () => {} });
}

describe('a throwing host logger', () => {
  it('never escapes the fetch wrapper, unary or streaming', async () => {
    const unary = withA2ATelemetry(async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }), {
      recorder: brokenRecorder,
      identify: () => {
        throw new Error('identify broke');
      },
      waitUntil: () => {
        throw new Error('waitUntil broke');
      },
      log: throwingLog,
    });
    expect(await (await unary(rpc({}))).json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    const streaming = withA2ATelemetry(async () => new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } }), {
      recorder: quietRecorder(),
      log: throwingLog,
    });
    expect(await (await streaming(rpc({}))).text()).toBe(sseBody);
  });

  it('never errors an SSE stream whose observer fails', async () => {
    // Only the end fails, so its failure is the stream's first and is logged.
    const observer = {
      event() {},
      end() {
        throw new Error('end');
      },
    };
    const response = observeSse(new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } }), observer, throwingLog);
    expect(await response.text()).toBe(sseBody);
  });

  it('never escapes the SDK server wrappers', async () => {
    const task = { id: 't1', contextId: 'c1', status: { state: 2 } };
    const handler = instrumentA2AHandler({ sendMessage: async () => task } as unknown as A2ARequestHandler, {
      recorder: brokenRecorder,
      log: throwingLog,
    });
    await expect(handler.sendMessage({ message: { messageId: 'm1' } } as never, new ServerCallContext())).resolves.toBe(task);
    const store = instrumentTaskStore(
      { save: async () => {}, load: async () => undefined, list: async () => ({}) } as unknown as TaskStore,
      { recorder: brokenRecorder, log: throwingLog, abandonOpenTasksOnShutdown: true },
    );
    await expect(store.save(task as never, new ServerCallContext())).resolves.toBeUndefined();
    await expect(store.abandonOpenTasks()).resolves.toBeUndefined();
  });

  it('never escapes the SDK client interceptor', async () => {
    const interceptor = a2aTelemetryInterceptor({ recorder: brokenRecorder, log: throwingLog });
    const options = {};
    await expect(interceptor.before({ input: { method: 'sendMessage', value: {} }, options })).resolves.toBeUndefined();
    await expect(interceptor.after({ result: { value: {} }, options })).resolves.toBeUndefined();
  });
});

describe('failures the wrappers used to swallow', () => {
  it('logs an SDK error whose reason cannot be read, and a context whose extensions cannot be read', async () => {
    const log = vi.fn();
    const hostile = {};
    Object.defineProperty(hostile, 'reason', {
      get() {
        throw new RangeError('hostile');
      },
    });
    const failing = instrumentA2AHandler({ getTask: async () => Promise.reject(hostile) } as unknown as A2ARequestHandler, {
      recorder: quietRecorder(),
      log,
    });
    await expect(failing.getTask({ id: 't1' } as never, new ServerCallContext())).rejects.toBe(hostile);
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'RangeError' });
    log.mockClear();
    const context = {
      get activatedExtensions(): never {
        throw new SyntaxError('hostile');
      },
    };
    const handler = instrumentA2AHandler({ getTask: async () => ({ id: 't1' }) } as unknown as A2ARequestHandler, {
      recorder: quietRecorder(),
      log,
    });
    await handler.getTask({ id: 't1' } as never, context as never);
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'SyntaxError' });
  });

  it('logs a unary response body the fetch wrapper cannot read, but not one that is simply not JSON', async () => {
    const log = vi.fn();
    const pending: Promise<unknown>[] = [];
    const json = { 'content-type': 'application/json' };
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new RangeError('stream broke'));
      },
    });
    const bodies = [() => new Response('not json', { headers: json }), () => new Response(broken, { headers: json })];
    let call = 0;
    const wrapped = withA2ATelemetry(async () => bodies[call++](), {
      recorder: quietRecorder(),
      waitUntil: (promise) => void pending.push(promise),
      log,
    });
    await wrapped(rpc({}));
    await Promise.all(pending.splice(0));
    expect(log).not.toHaveBeenCalled();
    await wrapped(rpc({}));
    await Promise.all(pending.splice(0));
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'RangeError' });
  });
});
