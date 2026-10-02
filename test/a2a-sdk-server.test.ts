import type { AgentCard, Message, StreamResponse, Task } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
  type A2ARequestHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import { describe, expect, it, vi } from 'vitest';
import { createRecorder, validateBatch, type AgentEvent as TelemetryEvent, type EventBatch, type Recorder } from '../src/index';
import { instrumentA2AHandler, instrumentTaskStore } from '../src/a2a/index';

// ts-proto TaskState and Role values.
const SUBMITTED = 1;
const WORKING = 2;
const COMPLETED = 3;
const INPUT_REQUIRED = 6;
const USER = 1;
const AGENT = 2;

function setup() {
  const batches: EventBatch[] = [];
  const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const batch = JSON.parse(String(init.body)) as EventBatch;
    batches.push(batch);
    return Response.json({ accepted: batch.events.length, content_dropped: 0, rejected: [] }, { status: 202 });
  }) as typeof globalThis.fetch;
  const recorder = createRecorder({ key: 'ak_test_x', endpoint: 'https://api.test', fetch, flushIntervalMs: 0, log: () => {} });
  const events = async (): Promise<TelemetryEvent[]> => {
    await recorder.flush();
    return batches.flatMap((batch) => batch.events);
  };
  const valid = () => {
    for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
  };
  return { recorder, events, valid, batches };
}

const card = {
  name: 'Test agent',
  description: 'test',
  supportedInterfaces: [],
  provider: undefined,
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
  signatures: [],
} as unknown as AgentCard;

const textPart = (value: string) => ({ content: { $case: 'text' as const, value }, metadata: undefined, filename: '', mediaType: '' });

function userMessage(text: string, extra: Partial<Message> = {}): Message {
  return {
    messageId: `m-${Math.random()}`,
    contextId: 'c1',
    taskId: '',
    role: USER,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
    ...extra,
  } as Message;
}

const request = (message: Message, configuration?: { returnImmediately: boolean }) =>
  ({
    tenant: '',
    message,
    configuration: configuration
      ? { acceptedOutputModes: [], taskPushNotificationConfig: undefined, returnImmediately: configuration.returnImmediately }
      : undefined,
    metadata: undefined,
  }) as Parameters<A2ARequestHandler['sendMessage']>[0];

const status = (state: number) => ({ state, message: undefined, timestamp: undefined });

const taskOf = (rc: RequestContext, state: number): Task =>
  ({
    id: rc.taskId,
    contextId: rc.contextId,
    status: status(state),
    artifacts: [],
    history: [rc.userMessage],
    metadata: undefined,
  }) as unknown as Task;

const statusUpdate = (rc: RequestContext, state: number) =>
  AgentEvent.statusUpdate({ taskId: rc.taskId, contextId: rc.contextId, status: status(state), metadata: undefined } as never);

const artifactUpdate = (rc: RequestContext) =>
  AgentEvent.artifactUpdate({
    taskId: rc.taskId,
    contextId: rc.contextId,
    artifact: { artifactId: 'a1', name: '', description: '', parts: [textPart('3 flights')], metadata: undefined, extensions: [] },
    append: false,
    lastChunk: true,
    metadata: undefined,
  } as never);

type Script = (rc: RequestContext, bus: ExecutionEventBus) => Promise<void> | void;

function executor(script: Script): AgentExecutor {
  return {
    async execute(rc, bus) {
      await script(rc, bus);
      bus.finished();
    },
    async cancelTask() {},
  };
}

const completes: Script = (rc, bus) => {
  bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
  bus.publish(statusUpdate(rc, WORKING));
  bus.publish(artifactUpdate(rc));
  bus.publish(statusUpdate(rc, COMPLETED));
};

function server(script: Script, options: { issuer?: string } = {}) {
  const telemetry = setup();
  const base = new InMemoryTaskStore();
  const store = instrumentTaskStore(base, { recorder: telemetry.recorder });
  const handler = instrumentA2AHandler(new DefaultRequestHandler(card, store, executor(script)), {
    recorder: telemetry.recorder,
    ...options,
  });
  return { ...telemetry, base, store, handler };
}

/** The rejection reason of a promise expected to reject. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const ofType = <T extends TelemetryEvent['type']>(events: TelemetryEvent[], type: T) =>
  events.filter((event): event is Extract<TelemetryEvent, { type: T }> => event.type === type);

describe('instrumentA2AHandler', () => {
  it('records a blocking sendMessage on a task that completes, each state once', async () => {
    const { handler, events, valid } = server(completes);
    const result = (await handler.sendMessage(request(userMessage('find flights')), new ServerCallContext())) as Task;
    expect(result.status?.state).toBe(COMPLETED);
    const all = await events();
    expect(all.map((event) => event.type)).toEqual([
      'operation.started',
      'message.observed',
      'task.state_changed',
      'task.state_changed',
      'task.state_changed',
      'message.observed',
      'operation.finished',
    ]);
    expect(all[0]).toMatchObject({
      method: 'SendMessage',
      kind: 'message',
      conversation_ref: 'c1',
      direction: 'inbound',
      protocol: { name: 'a2a', version: '0.3', binding: 'jsonrpc-http' },
      counterparty: {},
    });
    expect(all[1]).toMatchObject({ role: 'caller', artifact: false });
    expect(ofType(all, 'task.state_changed').map((event) => event.state)).toEqual(['submitted', 'working', 'completed']);
    expect(ofType(all, 'task.state_changed').every((event) => event.task_ref === result.id)).toBe(true);
    expect(all[5]).toMatchObject({ role: 'agent', artifact: true });
    expect(all[6]).toMatchObject({ outcome: 'ok' });
    expect(new Set(all.map((event) => event.operation_id)).size).toBe(1);
    valid();
  });

  it('records a direct agent Message reply with no task events', async () => {
    const { handler, events, valid } = server((rc, bus) => {
      bus.publish(
        AgentEvent.message({
          messageId: 'reply-1',
          contextId: rc.contextId,
          taskId: '',
          role: AGENT,
          parts: [textPart('hello')],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        } as Message),
      );
    });
    const result = (await handler.sendMessage(request(userMessage('hi')), new ServerCallContext())) as Message;
    expect(result.messageId).toBe('reply-1');
    const all = await events();
    expect(all.map((event) => event.type)).toEqual(['operation.started', 'message.observed', 'message.observed', 'operation.finished']);
    expect(all[2]).toMatchObject({ role: 'agent', message_id: 'reply-1', artifact: false });
    valid();
  });

  it('links states saved after a non-blocking send returns to the send operation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler, base, events, valid } = server(async (rc, bus) => {
      bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
      await gate;
      bus.publish(statusUpdate(rc, WORKING));
      bus.publish(statusUpdate(rc, COMPLETED));
    });
    const context = new ServerCallContext();
    const result = (await handler.sendMessage(request(userMessage('later'), { returnImmediately: true }), context)) as Task;
    expect(result.status?.state).toBe(SUBMITTED);
    const early = await events();
    expect(early.at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok' });
    release();
    await vi.waitFor(async () => expect((await base.load(result.id, context))?.status?.state).toBe(COMPLETED));
    const all = await events();
    const states = ofType(all, 'task.state_changed');
    expect(states.map((event) => event.state)).toEqual(['submitted', 'working', 'completed']);
    expect(new Set(all.map((event) => event.operation_id)).size).toBe(1);
    expect(all.some((event) => event.type === 'operation.started' && event.method === 'task/update')).toBe(false);
    valid();
  });

  it('passes stream events through unchanged and in order, recording each state once', async () => {
    const instrumented = server(completes);
    const plain = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor(completes));
    const collect = async (source: AsyncGenerator<StreamResponse, void, undefined>) => {
      const out: StreamResponse[] = [];
      for await (const event of source) out.push(event);
      return out;
    };
    const message = userMessage('stream it');
    const seen = await collect(instrumented.handler.sendMessageStream(request(message), new ServerCallContext()));
    const expected = await collect(plain.sendMessageStream(request({ ...message }), new ServerCallContext()));
    const normalize = (list: StreamResponse[]) => {
      const taskId = (list[0]?.payload?.value as Task).id;
      return JSON.parse(JSON.stringify(list).replaceAll(taskId, 'TASK')) as unknown;
    };
    expect(seen.map((event) => event.payload?.$case)).toEqual(['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate']);
    expect(normalize(seen)).toEqual(normalize(expected));
    const all = await instrumented.events();
    expect(all[0]).toMatchObject({ method: 'SendStreamingMessage', kind: 'message', protocol: { binding: 'sse' } });
    expect(ofType(all, 'task.state_changed').map((event) => event.state)).toEqual(['submitted', 'working', 'completed']);
    expect(all.at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok', stream_events: 4 });
    instrumented.valid();
  });

  it('records transport_error when the consumer stops a stream early, and closes the inner stream', async () => {
    const { handler, events, valid } = server(completes);
    for await (const event of handler.sendMessageStream(request(userMessage('stop')), new ServerCallContext())) {
      expect(event.payload?.$case).toBe('task');
      break;
    }
    const all = await events();
    expect(all.at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'transport_error', stream_events: 1 });
    valid();

    // The inner generator is closed: its `finally` runs before the consumer's loop exits.
    const sdk = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor(completes));
    let closed = false;
    async function* tracked(source: AsyncGenerator<StreamResponse, void, undefined>) {
      try {
        yield* source;
      } finally {
        closed = true;
      }
    }
    const wrapped = instrumentA2AHandler(
      stubHandler({ sendMessageStream: (params, context) => tracked(sdk.sendMessageStream(params, context)) }),
      {
        recorder: setup().recorder,
      },
    );
    for await (const event of wrapped.sendMessageStream(request(userMessage('stop')), new ServerCallContext())) {
      expect(event.payload?.$case).toBe('task');
      break;
    }
    expect(closed).toBe(true);
  });

  it('finishes an early stop when closing the inner stream fails, passing the failure on as for-await would', async () => {
    const { recorder, events } = setup();
    const failure = new Error('close failed');
    async function* failsToClose(): AsyncGenerator<StreamResponse, void, undefined> {
      try {
        yield { payload: { $case: 'task', value: { id: 't1', contextId: 'c1', status: status(WORKING) } as unknown as Task } };
      } finally {
        // eslint-disable-next-line no-unsafe-finally -- the failure under test
        throw failure;
      }
    }
    const wrapped = instrumentA2AHandler(stubHandler({ sendMessageStream: () => failsToClose() }), { recorder });
    const consume = async () => {
      for await (const event of wrapped.sendMessageStream(request(userMessage('stop')), new ServerCallContext())) {
        expect(event.payload?.$case).toBe('task');
        break;
      }
    };
    expect(await caught(consume())).toBe(failure);
    expect((await events()).at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'transport_error', stream_events: 1 });
  });

  it('records a resumed input_required task as a second message operation on the same task', async () => {
    const { handler, events, valid } = server((rc, bus) => {
      if (!rc.task) {
        bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
        bus.publish(statusUpdate(rc, INPUT_REQUIRED));
        return;
      }
      bus.publish(AgentEvent.task({ ...rc.task, status: status(WORKING) } as Task));
      bus.publish(statusUpdate(rc, COMPLETED));
    });
    const context = new ServerCallContext();
    const first = (await handler.sendMessage(request(userMessage('book it')), context)) as Task;
    expect(first.status?.state).toBe(INPUT_REQUIRED);
    const second = (await handler.sendMessage(request(userMessage('aisle seat', { taskId: first.id })), context)) as Task;
    expect(second.status?.state).toBe(COMPLETED);
    const all = await events();
    const started = ofType(all, 'operation.started');
    expect(started.map((event) => event.method)).toEqual(['SendMessage', 'SendMessage']);
    expect(started[1]).toMatchObject({ task_ref: first.id });
    const states = ofType(all, 'task.state_changed');
    expect(states.map((event) => event.state)).toEqual(['submitted', 'input_required', 'working', 'completed']);
    expect(states.every((event) => event.task_ref === first.id)).toBe(true);
    expect(states.slice(2).every((event) => event.operation_id === started[1]!.operation_id)).toBe(true);
    valid();
  });

  it('rethrows the SDK task-not-found error unchanged and records task_not_found', async () => {
    const { handler, events, valid } = server(completes);
    const thrown = await caught(handler.getTask({ tenant: '', id: 'missing' } as never, new ServerCallContext()));
    expect(thrown).toBeInstanceOf(TaskNotFoundError);
    const all = await events();
    expect(all[0]).toMatchObject({ method: 'GetTask', kind: 'management', task_ref: 'missing' });
    expect(all.at(-1)).toMatchObject({
      type: 'operation.finished',
      outcome: 'protocol_error',
      error: { code: 'task_not_found', native_code: 'TASK_NOT_FOUND' },
    });
    valid();
  });

  it('records an authenticated SDK user by issuer and subject hash only', async () => {
    const { handler, events, valid, batches } = server(completes, { issuer: 'my-idp' });
    const context = new ServerCallContext({ user: { isAuthenticated: true, userName: 'svc-1' } });
    await handler.sendMessage(request(userMessage('as service')), context);
    const all = await events();
    expect(all[0]).toMatchObject({
      counterparty: { authenticated: { issuer: 'my-idp', subject_hash: expect.stringMatching(/^[0-9a-f]{64}$/) } },
    });
    expect(JSON.stringify(batches)).not.toContain('svc-1');
    valid();
  });

  it('defaults the issuer and ignores unauthenticated users', async () => {
    const { handler, events } = server(completes);
    await handler.sendMessage(request(userMessage('a')), new ServerCallContext({ user: { isAuthenticated: true, userName: 'u' } }));
    await handler.sendMessage(request(userMessage('b')), new ServerCallContext({ user: { isAuthenticated: false, userName: 'anon' } }));
    const started = ofType(await events(), 'operation.started');
    expect(started[0]).toMatchObject({ counterparty: { authenticated: { issuer: 'a2a-sdk' } } });
    expect(started[1]).toMatchObject({ counterparty: {} });
  });
});

/** A handler whose every method returns a fixed value, for the method table and failure paths. */
function stubHandler(overrides: Partial<A2ARequestHandler> = {}): A2ARequestHandler {
  const task = { id: 't1', contextId: 'c1', status: status(WORKING), artifacts: [], history: [], metadata: undefined } as unknown as Task;
  async function* events(): AsyncGenerator<StreamResponse, void, undefined> {
    yield { payload: { $case: 'task', value: task } };
    yield { payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: status(COMPLETED), metadata: undefined } } };
  }
  return {
    getAgentCard: async () => card,
    getAuthenticatedExtendedAgentCard: async () => card,
    sendMessage: async () => task,
    sendMessageStream: () => events(),
    getTask: async () => task,
    cancelTask: async () => task,
    listTasks: async () => ({ tasks: [task], nextPageToken: '', pageSize: 1, totalSize: 1 }) as never,
    resubscribe: () => events(),
    createTaskPushNotificationConfig: async (params) => params,
    getTaskPushNotificationConfig: async () => ({}) as never,
    listTaskPushNotificationConfigs: async () => ({ configs: [], nextPageToken: '' }) as never,
    deleteTaskPushNotificationConfig: async () => {},
    ...overrides,
  };
}

async function drain<T>(source: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of source) out.push(event);
  return out;
}

describe('instrumentA2AHandler method table', () => {
  it('records every handler method under its A2A method name and kind', async () => {
    const { recorder, events, valid } = setup();
    const handler = instrumentA2AHandler(stubHandler(), { recorder, binding: 'http-json' });
    const context = new ServerCallContext({ requestedVersion: '1.0' });
    const byTask = { tenant: '', id: 't1' } as never;
    await handler.getAgentCard();
    await handler.getAuthenticatedExtendedAgentCard({ tenant: '' } as never, context);
    await handler.sendMessage(request(userMessage('x')), context);
    await drain(handler.sendMessageStream(request(userMessage('y')), context));
    await handler.getTask(byTask, context);
    await handler.cancelTask(byTask, context);
    await handler.listTasks({ tenant: '' } as never, context);
    await drain(handler.resubscribe(byTask, context));
    await handler.createTaskPushNotificationConfig({ tenant: '', taskId: 't1', id: 'p1' } as never, context);
    await handler.getTaskPushNotificationConfig({ tenant: '', taskId: 't1', id: 'p1' } as never, context);
    await handler.listTaskPushNotificationConfigs({ tenant: '', taskId: 't1' } as never, context);
    await handler.deleteTaskPushNotificationConfig({ tenant: '', taskId: 't1', id: 'p1' } as never, context);
    const started = ofType(await events(), 'operation.started');
    expect(started.map((event) => [event.method, event.kind, event.protocol.binding, event.protocol.version])).toEqual([
      ['GetAgentCard', 'discovery', 'http-json', '0.3'],
      ['GetExtendedAgentCard', 'discovery', 'http-json', '1.0'],
      ['SendMessage', 'message', 'http-json', '1.0'],
      ['SendStreamingMessage', 'message', 'sse', '1.0'],
      ['GetTask', 'management', 'http-json', '1.0'],
      ['CancelTask', 'management', 'http-json', '1.0'],
      ['ListTasks', 'management', 'http-json', '1.0'],
      ['SubscribeToTask', 'management', 'sse', '1.0'],
      ['CreateTaskPushNotificationConfig', 'management', 'http-json', '1.0'],
      ['GetTaskPushNotificationConfig', 'management', 'http-json', '1.0'],
      ['ListTaskPushNotificationConfigs', 'management', 'http-json', '1.0'],
      ['DeleteTaskPushNotificationConfig', 'management', 'http-json', '1.0'],
    ]);
    expect(started.every((event) => event.direction === 'inbound')).toBe(true);
    valid();
  });

  it('falls back to 0.3 for a malformed requested version', async () => {
    const { recorder, events } = setup();
    const handler = instrumentA2AHandler(stubHandler(), { recorder });
    await handler.getTask({ tenant: '', id: 't1' } as never, new ServerCallContext({ requestedVersion: 'v<script>' }));
    expect((await events())[0]).toMatchObject({ protocol: { version: '0.3' } });
  });

  it('rethrows a stream error unchanged and records protocol_error with the events seen', async () => {
    const { recorder, events } = setup();
    const failure = new Error('boom');
    async function* failing(): AsyncGenerator<StreamResponse, void, undefined> {
      yield { payload: { $case: 'task', value: { id: 't1', contextId: 'c1', status: status(WORKING) } as Task } };
      throw failure;
    }
    const handler = instrumentA2AHandler(stubHandler({ resubscribe: () => failing() }), { recorder });
    const thrown = await caught(drain(handler.resubscribe({ tenant: '', id: 't1' } as never, new ServerCallContext())));
    expect(thrown).toBe(failure);
    expect((await events()).at(-1)).toMatchObject({
      outcome: 'protocol_error',
      stream_events: 1,
      error: { native_code: 'exception', code: 'internal_error' },
    });
  });

  it('records a handler throw that is not an A2A error as internal_error, rethrowing it unchanged', async () => {
    const { recorder, events, valid } = setup();
    const failure = new TypeError('bug');
    const numeric = { code: -32001, message: 'not an A2AError' };
    const handler = instrumentA2AHandler(
      stubHandler({ getTask: async () => Promise.reject(failure), cancelTask: async () => Promise.reject(numeric) }),
      { recorder },
    );
    expect(await caught(handler.getTask({ tenant: '', id: 't1' } as never, new ServerCallContext()))).toBe(failure);
    expect(await caught(handler.cancelTask({ tenant: '', id: 't1' } as never, new ServerCallContext()))).toBe(numeric);
    expect(ofType(await events(), 'operation.finished')).toMatchObject([
      { outcome: 'protocol_error', error: { native_code: 'exception', code: 'internal_error' } },
      { outcome: 'protocol_error', error: { native_code: 'exception', code: 'internal_error' } },
    ]);
    valid();
  });

  it('forwards an error thrown in by the consumer to the inner stream and records transport_error', async () => {
    const { recorder, events } = setup();
    const seen: unknown[] = [];
    let closed = false;
    const update = {
      payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: status(WORKING) } as never },
    } as const;
    async function* endless(): AsyncGenerator<StreamResponse, void, undefined> {
      try {
        for (;;) yield update;
      } catch (error) {
        seen.push(error);
        throw error;
      } finally {
        closed = true;
      }
    }
    const handler = instrumentA2AHandler(stubHandler({ resubscribe: () => endless() }), { recorder });
    const stream = handler.resubscribe({ tenant: '', id: 't1' } as never, new ServerCallContext());
    await stream.next();
    const injected = new Error('consumer');
    await expect(stream.throw(injected)).rejects.toBe(injected);
    expect(seen).toEqual([injected]);
    expect(closed).toBe(true);
    expect((await events()).at(-1)).toMatchObject({ outcome: 'transport_error', stream_events: 1 });
  });

  it('keeps yielding what the inner stream produces after handling a thrown-in error', async () => {
    const { recorder, events } = setup();
    const recovered = {
      payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: status(COMPLETED) } as never },
    } as const;
    async function* recovering(): AsyncGenerator<StreamResponse, void, undefined> {
      try {
        yield { payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: status(WORKING) } as never } };
      } catch {
        yield recovered;
      }
    }
    const handler = instrumentA2AHandler(stubHandler({ resubscribe: () => recovering() }), { recorder });
    const stream = handler.resubscribe({ tenant: '', id: 't1' } as never, new ServerCallContext());
    await stream.next();
    expect(await stream.throw(new Error('consumer'))).toEqual({ done: false, value: recovered });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    const all = await events();
    expect(ofType(all, 'task.state_changed').map((event) => event.state)).toEqual(['working', 'completed']);
    expect(all.at(-1)).toMatchObject({ outcome: 'transport_error', stream_events: 2 });
  });

  it('never lets telemetry failures change results, errors or streams', async () => {
    const log = vi.fn();
    const broken: Recorder = {
      startOperation: () => {
        throw new TypeError('recorder broke');
      },
      abandonTask: () => {
        throw new TypeError('recorder broke');
      },
      transaction: () => {
        throw new TypeError('recorder broke');
      },
      flush: async () => {},
      shutdown: async () => {},
      stats: () => ({ buffered: 0, dropped: 0, sent: 0, rejected: 0, disabled: false }),
    };
    const stub = stubHandler();
    const handler = instrumentA2AHandler(stub, { recorder: broken, log });
    expect(await handler.getTask({ tenant: '', id: 't1' } as never, new ServerCallContext())).toEqual(
      await stub.getTask({} as never, {} as never),
    );
    expect(await drain(handler.sendMessageStream(request(userMessage('z')), new ServerCallContext()))).toEqual(
      await drain(stub.sendMessageStream({} as never, {} as never)),
    );
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'TypeError' });

    const failingOps: Recorder = {
      ...broken,
      startOperation: () => ({
        operationId: 'x',
        message: () => {
          throw new Error('message broke');
        },
        taskState: () => {
          throw new Error('state broke');
        },
        cost: () => {
          throw new Error('cost broke');
        },
        charge: () => {
          throw new Error('charge broke');
        },
        finish: () => {
          throw new Error('finish broke');
        },
      }),
    };
    const failure = new Error('handler failed');
    const throwing = instrumentA2AHandler(stubHandler({ getTask: async () => Promise.reject(failure) }), {
      recorder: failingOps,
      log: () => {},
    });
    await expect(throwing.getTask({ tenant: '', id: 't1' } as never, new ServerCallContext())).rejects.toBe(failure);
    const quiet = instrumentA2AHandler(stub, { recorder: failingOps, log: () => {} });
    expect(await quiet.sendMessage(request(userMessage('q')), new ServerCallContext())).toMatchObject({ id: 't1' });
    expect(await drain(quiet.resubscribe({ tenant: '', id: 't1' } as never, new ServerCallContext()))).toHaveLength(2);
    const hostile = { reason: 'X' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'reason', {
      get() {
        throw new Error('hostile');
      },
    });
    const odd = instrumentA2AHandler(stubHandler({ cancelTask: async () => Promise.reject(hostile) }), {
      recorder: setup().recorder,
      log: () => {},
    });
    await expect(odd.cancelTask({ tenant: '', id: 't1' } as never, new ServerCallContext())).rejects.toBe(hostile);
  });

  it('records SDK errors by reason, mapping the extended-card reason to its A2A code', async () => {
    const { recorder, events } = setup();
    const error = Object.assign(new Error('nope'), { reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' });
    const handler = instrumentA2AHandler(stubHandler({ getAuthenticatedExtendedAgentCard: async () => Promise.reject(error) }), {
      recorder,
    });
    await expect(handler.getAuthenticatedExtendedAgentCard({ tenant: '' } as never, new ServerCallContext())).rejects.toBe(error);
    expect((await events()).at(-1)).toMatchObject({
      error: { native_code: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED', code: 'extended_card_not_configured' },
    });
  });
});

describe('instrumentTaskStore', () => {
  const task = (id: string, state: number, contextId = 'c9') =>
    ({ id, contextId, status: status(state), artifacts: [], history: [], metadata: undefined }) as unknown as Task;

  it('records a task/update operation for a task no instrumented operation created', async () => {
    const { recorder, events, valid } = setup();
    const store = instrumentTaskStore(new InMemoryTaskStore(), { recorder });
    const context = new ServerCallContext();
    await store.save(task('t9', WORKING), context);
    await store.save(task('t9', WORKING), context);
    await store.save(task('t9', COMPLETED), context);
    const all = await events();
    expect(all.map((event) => event.type)).toEqual(['operation.started', 'task.state_changed', 'operation.finished', 'task.state_changed']);
    expect(all[0]).toMatchObject({
      method: 'task/update',
      kind: 'other',
      direction: 'inbound',
      task_ref: 't9',
      conversation_ref: 'c9',
      protocol: { name: 'a2a', version: '0.3', binding: 'other' },
    });
    expect(ofType(all, 'task.state_changed').map((event) => [event.state, event.operation_id])).toEqual([
      ['working', all[0]!.operation_id],
      ['completed', all[0]!.operation_id],
    ]);
    valid();
  });

  it('records a task saved on another instance (fresh recorder) as task/update', async () => {
    const first = server(completes);
    const result = (await first.handler.sendMessage(request(userMessage('one')), new ServerCallContext())) as Task;
    const other = setup();
    const store = instrumentTaskStore(first.base, { recorder: other.recorder });
    await store.save({ ...result, status: status(WORKING) } as Task, new ServerCallContext());
    const all = await other.events();
    expect(all[0]).toMatchObject({ type: 'operation.started', method: 'task/update', task_ref: result.id });
    expect(ofType(all, 'task.state_changed')[0]).toMatchObject({ state: 'working' });
  });

  it('delegates load and list unchanged and propagates store errors without recording', async () => {
    const { recorder, events } = setup();
    const failure = new Error('disk full');
    const base: TaskStore = {
      save: async () => Promise.reject(failure),
      load: async (taskId) => task(taskId, WORKING),
      list: async () => ({ tasks: [], nextPageToken: 'n', pageSize: 0, totalSize: 0 }) as never,
    };
    const store = instrumentTaskStore(base, { recorder });
    const context = new ServerCallContext();
    expect(await store.load('t1', context)).toMatchObject({ id: 't1' });
    expect(await store.list({ tenant: '' } as never, context)).toMatchObject({ nextPageToken: 'n' });
    await expect(store.save(task('t1', WORKING), context)).rejects.toBe(failure);
    expect(await events()).toEqual([]);
  });

  it('ignores tasks with unusable ids and swallows telemetry failures', async () => {
    const log = vi.fn();
    const { recorder, events } = setup();
    // A store that never reads the task, so only telemetry meets the hostile getter.
    const base: TaskStore = { save: async () => {}, load: async () => undefined, list: async () => ({}) as never };
    const store = instrumentTaskStore(base, { recorder, log });
    await store.save(task('x'.repeat(300), WORKING), new ServerCallContext());
    await store.save(null as unknown as Task, new ServerCallContext());
    const hostile = task('t2', WORKING);
    Object.defineProperty(hostile, 'status', {
      get() {
        throw new Error('hostile');
      },
    });
    await expect(store.save(hostile, new ServerCallContext())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'Error' });
    expect(await events()).toEqual([]);
  });

  it('abandons open tasks on request when opted in', async () => {
    const { recorder, events, valid } = setup();
    const store = instrumentTaskStore(new InMemoryTaskStore(), { recorder, abandonOpenTasksOnShutdown: true });
    const context = new ServerCallContext({ requestedVersion: '1.0' });
    await store.save(task('open-1', WORKING), context);
    await store.save(task('open-2', INPUT_REQUIRED), context);
    await store.save(task('done-1', WORKING), context);
    await store.save(task('done-1', COMPLETED), context);
    await store.abandonOpenTasks();
    await store.abandonOpenTasks();
    const abandoned = ofType(await events(), 'operation.started').filter((event) => event.method === 'task/abandon');
    expect(abandoned.map((event) => [event.task_ref, event.conversation_ref, event.protocol.version])).toEqual([
      ['open-1', 'c9', '1.0'],
      ['open-2', 'c9', '1.0'],
    ]);
    const states = ofType(await events(), 'task.state_changed').filter((event) => event.native_state === 'abandoned');
    expect(states.map((event) => [event.state, event.reason])).toEqual([
      ['canceled', 'shutdown'],
      ['canceled', 'shutdown'],
    ]);
    valid();
  });

  it('passes a custom abandon reason, bounds open tasks and abandons nothing without the option', async () => {
    const opted = setup();
    const store = instrumentTaskStore(new InMemoryTaskStore(), { recorder: opted.recorder, abandonOpenTasksOnShutdown: true });
    const context = new ServerCallContext();
    for (let index = 0; index < 10_005; index++) await store.save(task(`t${index}`, WORKING), context);
    const abandon = vi.spyOn(opted.recorder, 'abandonTask');
    await store.abandonOpenTasks('timeout');
    expect(abandon).toHaveBeenCalledTimes(10_000);
    expect(abandon.mock.calls[0]).toEqual(['t5', expect.objectContaining({ reason: 'timeout', state: 'canceled' })]);

    const plain = setup();
    const unopted = instrumentTaskStore(new InMemoryTaskStore(), { recorder: plain.recorder });
    await unopted.save(task('open', WORKING), context);
    const none = vi.spyOn(plain.recorder, 'abandonTask');
    await unopted.abandonOpenTasks();
    expect(none).not.toHaveBeenCalled();

    const broken = instrumentTaskStore(new InMemoryTaskStore(), {
      recorder: {
        ...plain.recorder,
        abandonTask: () => {
          throw new Error('x');
        },
      },
      abandonOpenTasksOnShutdown: true,
      log: () => {},
    });
    await broken.save(task('b1', WORKING), context);
    await expect(broken.abandonOpenTasks()).resolves.toBeUndefined();
  });
});

describe('instrumentA2AHandler first messages', () => {
  /** Every task state of a first message (no contextId) carries the context the SDK assigns. */
  function expectLinked(all: TelemetryEvent[], contextId: string): void {
    const states = ofType(all, 'task.state_changed');
    expect(states.map((event) => event.state)).toEqual(['submitted', 'working', 'completed']);
    expect(contextId).toBeTruthy();
    expect(states.every((event) => event.conversation_ref === contextId)).toBe(true);
    expect(new Set(all.map((event) => event.operation_id)).size).toBe(1);
  }

  it('links a blocking first send to the conversation the SDK assigns', async () => {
    const { handler, events, valid } = server(completes);
    const result = (await handler.sendMessage(request(userMessage('first', { contextId: '' })), new ServerCallContext())) as Task;
    const all = await events();
    expect(all[0]).not.toHaveProperty('conversation_ref');
    expectLinked(all, result.contextId);
    valid();
  });

  it('links a non-blocking first send, including states saved after it returns', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler, base, events, valid } = server(async (rc, bus) => {
      bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
      await gate;
      bus.publish(statusUpdate(rc, WORKING));
      bus.publish(statusUpdate(rc, COMPLETED));
    });
    const context = new ServerCallContext();
    const result = (await handler.sendMessage(
      request(userMessage('first', { contextId: '' }), { returnImmediately: true }),
      context,
    )) as Task;
    release();
    await vi.waitFor(async () => expect((await base.load(result.id, context))?.status?.state).toBe(COMPLETED));
    expectLinked(await events(), result.contextId);
    valid();
  });

  it('links a streaming first send', async () => {
    const { handler, events, valid } = server(completes);
    const seen = await drain(handler.sendMessageStream(request(userMessage('first', { contextId: '' })), new ServerCallContext()));
    expectLinked(await events(), (seen[0]?.payload?.value as Task).contextId);
    valid();
  });
});

describe('instrumentA2AHandler a2a block', () => {
  const EXT_A = 'https://ext.test/a';
  const EXT_B = 'https://ext.test/b';
  const extended = {
    ...card,
    capabilities: { ...card.capabilities, extensions: [{ uri: EXT_A, description: '', required: false, params: undefined }] },
  } as unknown as AgentCard;
  const activates: Script = (rc, bus) => {
    rc.context.addActivatedExtension(EXT_A);
    completes(rc, bus);
  };

  function extendedServer() {
    const telemetry = setup();
    const store = instrumentTaskStore(new InMemoryTaskStore(), { recorder: telemetry.recorder });
    const handler = instrumentA2AHandler(new DefaultRequestHandler(extended, store, executor(activates)), { recorder: telemetry.recorder });
    return { ...telemetry, handler };
  }

  it('records the message id, reference tasks and requested extensions, and the extensions the agent activates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, events, valid } = extendedServer();
    const message = userMessage('with extensions', { messageId: 'm-ext', referenceTaskIds: ['t-old', 'bad id'] });
    await handler.sendMessage(request(message), new ServerCallContext({ requestedExtensions: [EXT_A, EXT_B] }));
    await drain(
      handler.sendMessageStream(request({ ...message, messageId: 'm-ext-2' }), new ServerCallContext({ requestedExtensions: [EXT_A] })),
    );
    warn.mockRestore();
    const all = await events();
    expect(ofType(all, 'operation.started').map((event) => event.a2a)).toEqual([
      { message_id: 'm-ext', reference_task_ids: ['t-old'], extensions_requested: [EXT_A, EXT_B] },
      { message_id: 'm-ext-2', reference_task_ids: ['t-old'], extensions_requested: [EXT_A] },
    ]);
    expect(ofType(all, 'operation.finished').map((event) => event.a2a)).toEqual([
      { extensions_activated: [EXT_A] },
      { extensions_activated: [EXT_A] },
    ]);
    valid();
  });

  it('leaves the block out when the call carries nothing for it', async () => {
    const { handler, events } = server(completes);
    await handler.sendMessage(request(userMessage('plain')), new ServerCallContext());
    await caught(handler.getTask({ tenant: '', id: 't1' } as never, new ServerCallContext()));
    const all = await events();
    expect(ofType(all, 'operation.started')[0]?.a2a).toEqual({ message_id: expect.any(String) });
    expect(all.filter((event) => event.type === 'operation.finished').every((event) => event.a2a === undefined)).toBe(true);
  });

  it('finishes without the block when the context cannot report its extensions', async () => {
    const { recorder, events } = setup();
    const handler = instrumentA2AHandler(stubHandler(), { recorder });
    const context = new ServerCallContext();
    Object.defineProperty(context, 'activatedExtensions', {
      get() {
        throw new Error('hostile');
      },
    });
    await handler.getTask({ tenant: '', id: 't1' } as never, context);
    expect((await events()).at(-1)).toMatchObject({ type: 'operation.finished', outcome: 'ok' });
    expect((await events()).at(-1)).not.toHaveProperty('a2a');
  });
});
