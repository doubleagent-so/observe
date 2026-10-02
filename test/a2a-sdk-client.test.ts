import type { AgentCard, Message, StreamResponse, Task } from '@a2a-js/sdk';
import {
  ClientFactory,
  JsonRpcTransportFactory,
  type AfterArgs,
  type BeforeArgs,
  type CallInterceptor,
  type Client,
} from '@a2a-js/sdk/client';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createRecorder,
  validateBatch,
  type AgentEvent as TelemetryEvent,
  type EventBatch,
  type OperationHandle,
  type Recorder,
} from '../src/index';
import { a2aTelemetryInterceptor, instrumentA2AHandler, instrumentTaskStore } from '../src/a2a/index';

// ts-proto TaskState and Role values.
const SUBMITTED = 1;
const WORKING = 2;
const COMPLETED = 3;
const INPUT_REQUIRED = 6;
const AUTH_REQUIRED = 8;
const USER = 1;
const AGENT = 2;

const SERVICE_URL = 'https://agent.test/a2a';

function telemetry() {
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
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) expect(validateBatch(batch, Date.now())).toMatchObject({ ok: true, rejected: [] });
  };
  return { recorder, events, valid };
}

function cardOf(overrides: Record<string, unknown> = {}): AgentCard {
  return {
    name: 'Flight agent',
    description: 'test',
    supportedInterfaces: [{ url: SERVICE_URL, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    provider: undefined,
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
    signatures: [],
    ...overrides,
  } as unknown as AgentCard;
}

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

const send = (message: Message) => ({ tenant: '', message, configuration: undefined, metadata: undefined });

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

const replies: Script = (rc, bus) => {
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
};

/** An in-process SDK server (instrumented with its own recorder) reached through a `fetch` function: no network. */
function agentServer(script: Script, card: AgentCard) {
  const server = telemetry();
  const store = instrumentTaskStore(new InMemoryTaskStore(), { recorder: server.recorder });
  const handler = instrumentA2AHandler(new DefaultRequestHandler(card, store, executor(script)), { recorder: server.recorder });
  const transport = new JsonRpcTransportHandler(handler);
  const encoder = new TextEncoder();
  const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const version = new Headers(init.headers).get('A2A-Version') ?? undefined;
    const result = await transport.handle(String(init.body), new ServerCallContext({ requestedVersion: version }));
    if (!(Symbol.asyncIterator in result)) return Response.json(result);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const event of result) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { ...server, fetchImpl };
}

async function connect(
  script: Script,
  options: {
    card?: AgentCard;
    interceptor?: Partial<Parameters<typeof a2aTelemetryInterceptor>[0]>;
    interceptors?: (own: CallInterceptor) => CallInterceptor[];
  } = {},
) {
  const card = options.card ?? cardOf();
  const server = agentServer(script, card);
  const client = telemetry();
  const own = a2aTelemetryInterceptor({ recorder: client.recorder, ...options.interceptor });
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: server.fetchImpl })],
    clientConfig: { interceptors: options.interceptors ? options.interceptors(own) : [own] },
  });
  return { sdk: await factory.createFromAgentCard(card), client, server };
}

/** A plain client for the same script, to compare results with and without the interceptor. */
async function plainClient(script: Script, card = cardOf()): Promise<Client> {
  const server = agentServer(script, card);
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: server.fetchImpl })] });
  return factory.createFromAgentCard(card);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const ofType = <T extends TelemetryEvent['type']>(events: TelemetryEvent[], type: T) =>
  events.filter((event): event is Extract<TelemetryEvent, { type: T }> => event.type === type);

/** Strips per-run ids so two runs can be compared. */
const shape = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, field) => (/id$/i.test(key) ? '<id>' : field)));

describe('a2aTelemetryInterceptor', () => {
  it('records a blocking sendMessage as one outbound operation with the same task_ref as the server', async () => {
    const { sdk, client, server } = await connect(completes);
    const result = (await sdk.sendMessage(send(userMessage('find flights')))) as Task;
    expect(result.status?.state).toBe(COMPLETED);

    const all = await client.events();
    expect(all.map((event) => event.type)).toEqual([
      'operation.started',
      'message.observed',
      'task.state_changed',
      'message.observed',
      'operation.finished',
    ]);
    expect(all[0]).toMatchObject({
      direction: 'outbound',
      method: 'SendMessage',
      kind: 'message',
      conversation_ref: 'c1',
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      counterparty: { card_url: SERVICE_URL, declared_name: 'Flight agent' },
    });
    expect(all[1]).toMatchObject({ role: 'caller', artifact: false, parts: [{ kind: 'text' }] });
    expect(all[2]).toMatchObject({ task_ref: result.id, state: 'completed' });
    expect(all[3]).toMatchObject({ role: 'agent', artifact: true });
    expect(all[4]).toMatchObject({ outcome: 'ok' });
    expect(new Set(all.map((event) => event.operation_id)).size).toBe(1);
    client.valid();

    const inbound = await server.events();
    expect(inbound[0]).toMatchObject({ direction: 'inbound', method: 'SendMessage', protocol: { version: '1.0' } });
    expect(new Set(ofType(inbound, 'task.state_changed').map((event) => event.task_ref))).toEqual(new Set([result.id]));
    expect(ofType(all, 'task.state_changed')[0]?.task_ref).toBe(ofType(inbound, 'task.state_changed')[0]?.task_ref);
    server.valid();
  });

  it('links a first send (no contextId) to the conversation the called agent assigns, unary and streaming', async () => {
    const { sdk, client, server } = await connect(completes);
    const result = (await sdk.sendMessage(send(userMessage('first', { contextId: '' })))) as Task;
    const streamed = await collect(sdk.sendMessageStream(send(userMessage('first again', { contextId: '' }))));
    const streamedContext = (streamed[0]?.payload?.value as Task).contextId;
    const all = await client.events();
    const states = ofType(all, 'task.state_changed');
    expect(states.map((event) => event.state)).toEqual(['completed', 'submitted', 'working', 'completed']);
    expect(states.map((event) => event.conversation_ref)).toEqual([result.contextId, streamedContext, streamedContext, streamedContext]);
    expect(ofType(all, 'operation.started').every((event) => event.conversation_ref === undefined)).toBe(true);
    client.valid();
    const inbound = ofType(await server.events(), 'task.state_changed');
    expect(inbound.every((event) => event.conversation_ref === result.contextId || event.conversation_ref === streamedContext)).toBe(true);
  });

  it('returns the same results as an uninstrumented client', async () => {
    const { sdk } = await connect(completes);
    const plain = await plainClient(completes);
    const seen = await sdk.sendMessage(send(userMessage('same')));
    const expected = await plain.sendMessage(send(userMessage('same')));
    expect(shape(seen)).toEqual(shape(expected));
    const streamed = await collect(sdk.sendMessageStream(send(userMessage('same'))));
    const plainStreamed = await collect(plain.sendMessageStream(send(userMessage('same'))));
    expect(shape(streamed)).toEqual(shape(plainStreamed));
  });

  it('records a direct Message reply with no task events', async () => {
    const { sdk, client } = await connect(replies);
    const result = (await sdk.sendMessage(send(userMessage('hi')))) as Message;
    expect(result.messageId).toBe('reply-1');
    const all = await client.events();
    expect(all.map((event) => event.type)).toEqual(['operation.started', 'message.observed', 'message.observed', 'operation.finished']);
    expect(all[2]).toMatchObject({ role: 'agent', message_id: 'reply-1' });
    client.valid();
  });

  it('records a streaming send per event and finishes once when the task completes', async () => {
    const { sdk, client } = await connect(completes);
    const events: StreamResponse[] = await collect(sdk.sendMessageStream(send(userMessage('stream'))));
    expect(events).toHaveLength(4);
    const all = await client.events();
    expect(all[0]).toMatchObject({
      direction: 'outbound',
      method: 'SendStreamingMessage',
      kind: 'message',
      protocol: { binding: 'sse', version: '1.0' },
    });
    expect(ofType(all, 'task.state_changed').map((event) => event.state)).toEqual(['submitted', 'working', 'completed']);
    expect(ofType(all, 'message.observed').map((event) => event.role)).toEqual(['caller', 'agent']);
    const finished = ofType(all, 'operation.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: 'ok', stream_events: 4 });
    expect(all.at(-1)?.type).toBe('operation.finished');
    client.valid();
  });

  it('finishes a stream that pauses for input and one that ends with a Message', async () => {
    const paused = await connect((rc, bus) => {
      bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
      bus.publish(statusUpdate(rc, INPUT_REQUIRED));
    });
    await collect(paused.sdk.sendMessageStream(send(userMessage('which date?'))));
    expect(ofType(await paused.client.events(), 'operation.finished')).toMatchObject([{ outcome: 'ok', stream_events: 2 }]);

    const message = await connect(replies);
    await collect(message.sdk.sendMessageStream(send(userMessage('hi'))));
    expect(ofType(await message.client.events(), 'operation.finished')).toMatchObject([{ outcome: 'ok', stream_events: 1 }]);
  });

  it('keeps recording a stream past auth_required until it completes, finishing once', async () => {
    const { sdk, client } = await connect((rc, bus) => {
      bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
      bus.publish(statusUpdate(rc, AUTH_REQUIRED));
      bus.publish(statusUpdate(rc, WORKING));
      bus.publish(statusUpdate(rc, COMPLETED));
    });
    const events = await collect(sdk.sendMessageStream(send(userMessage('needs auth'))));
    expect(events).toHaveLength(4);
    const all = await client.events();
    expect(ofType(all, 'task.state_changed').map((event) => event.state)).toEqual(['submitted', 'auth_required', 'working', 'completed']);
    expect(ofType(all, 'operation.finished')).toMatchObject([{ outcome: 'ok', stream_events: 4 }]);
    expect(all.at(-1)?.type).toBe('operation.finished');
    client.valid();
  });

  it('does not finish resubscribeTask on the stored input_required Task it yields first', async () => {
    const { sdk, client } = await connect((rc, bus) => {
      bus.publish(AgentEvent.task(taskOf(rc, SUBMITTED)));
      bus.publish(statusUpdate(rc, INPUT_REQUIRED));
    });
    const sent = await collect(sdk.sendMessageStream(send(userMessage('which date?'))));
    const taskId = (sent[0]!.payload as { value: Task }).value.id;
    // The task's event bus is still live, so the server keeps the stream open after the stored Task: take event 1 only.
    const stream = sdk.resubscribeTask({ tenant: '', id: taskId });
    const first = await stream.next();
    expect(first.value?.payload?.$case).toBe('task');
    const all = await client.events();
    await stream.return(undefined);
    const resubscribe = ofType(all, 'operation.started').find((event) => event.method === 'SubscribeToTask')!;
    expect(resubscribe).toMatchObject({ task_ref: taskId, protocol: { binding: 'sse' } });
    expect(ofType(all, 'operation.finished').filter((event) => event.operation_id === resubscribe.operation_id)).toEqual([]);
    client.valid();
  });

  it('records the non-streaming fallback of sendMessageStream as one event', async () => {
    const card = cardOf({ capabilities: { streaming: false, pushNotifications: false, extensions: [] } });
    const { sdk, client } = await connect(completes, { card });
    const events = await collect(sdk.sendMessageStream(send(userMessage('fallback'))));
    expect(events).toHaveLength(1);
    const all = await client.events();
    expect(all[0]).toMatchObject({ method: 'SendStreamingMessage', protocol: { binding: 'sse' } });
    expect(ofType(all, 'operation.finished')).toMatchObject([{ outcome: 'ok', stream_events: 1 }]);
  });

  it('leaves a stream the consumer stops early incomplete, without changing the stream', async () => {
    const { sdk, client } = await connect(completes);
    const seen: StreamResponse[] = [];
    for await (const event of sdk.sendMessageStream(send(userMessage('stop')))) {
      seen.push(event);
      break;
    }
    expect(seen).toHaveLength(1);
    const all = await client.events();
    expect(all.map((event) => event.type)).toEqual(['operation.started', 'message.observed', 'task.state_changed']);
    expect(ofType(all, 'operation.finished')).toEqual([]);
    client.valid();
  });

  it('records each concurrent call under its own operation', async () => {
    const { sdk, client } = await connect(completes);
    const [first, second] = (await Promise.all([
      sdk.sendMessage(send(userMessage('one', { contextId: 'c-one' }))),
      sdk.sendMessage(send(userMessage('two', { contextId: 'c-two' }))),
    ])) as Task[];
    const all = await client.events();
    const started = ofType(all, 'operation.started');
    expect(started.map((event) => event.conversation_ref).sort()).toEqual(['c-one', 'c-two']);
    for (const task of [first!, second!]) {
      const op = started.find((event) => event.conversation_ref === task.contextId)!.operation_id;
      expect(ofType(all, 'task.state_changed').find((event) => event.task_ref === task.id)?.operation_id).toBe(op);
      expect(ofType(all, 'operation.finished').filter((event) => event.operation_id === op)).toHaveLength(1);
    }
  });

  it('records GetTask and CancelTask as management calls with the task_ref', async () => {
    const { sdk, client } = await connect(completes);
    const sent = (await sdk.sendMessage(send(userMessage('x')))) as Task;
    const fetched = await sdk.getTask({ tenant: '', id: sent.id });
    expect(fetched.id).toBe(sent.id);
    const all = await client.events();
    const started = ofType(all, 'operation.started');
    expect(started[1]).toMatchObject({ method: 'GetTask', kind: 'management', task_ref: sent.id, direction: 'outbound' });
    expect(ofType(all, 'operation.finished')).toHaveLength(2);
    client.valid();
  });

  it('records a call the SDK rejects as started and unfinished, and rethrows the same error', async () => {
    const { sdk, client } = await connect(completes);
    const thrown = await caught(sdk.getTask({ tenant: '', id: 'missing-task' }));
    expect(thrown).toBeInstanceOf(TaskNotFoundError);
    const all = await client.events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: 'operation.started', method: 'GetTask', task_ref: 'missing-task', direction: 'outbound' });
    client.valid();
  });

  it('records the result when a later interceptor returns early', async () => {
    const task = {
      id: 'cached',
      contextId: 'c1',
      status: status(COMPLETED),
      artifacts: [],
      history: [],
      metadata: undefined,
    } as unknown as Task;
    const cache: CallInterceptor = {
      async before(args) {
        if (args.input?.method === 'getTask') args.earlyReturn = { method: 'getTask', value: task };
      },
      async after() {},
    };
    const { sdk, client } = await connect(completes, { interceptors: (own) => [own, cache] });
    expect(await sdk.getTask({ tenant: '', id: 'cached' })).toBe(task);
    const all = await client.events();
    expect(all.map((event) => event.type)).toEqual(['operation.started', 'task.state_changed', 'operation.finished']);
    expect(all[2]).toMatchObject({ outcome: 'ok' });
  });

  it('uses the configured card URL and version when given', async () => {
    const { sdk, client } = await connect(replies, {
      interceptor: { cardUrl: 'https://agent.test/.well-known/agent-card.json', version: '1.1' },
    });
    await sdk.sendMessage(send(userMessage('hi')));
    const [started] = await client.events();
    expect(started).toMatchObject({
      protocol: { version: '1.1' },
      counterparty: { card_url: 'https://agent.test/.well-known/agent-card.json', declared_name: 'Flight agent' },
    });
    client.valid();
  });
});

/** Calls the interceptor directly, as the SDK does, with a fresh per-call options object. */
function direct(interceptor: CallInterceptor, card: unknown, method: string, value?: unknown) {
  const options = { serviceParameters: { 'A2A-Version': '1.0' } };
  const input = value === undefined ? { method } : { method, value };
  const before = { input, agentCard: card, options } as unknown as BeforeArgs;
  const after = (result: unknown) => ({ result: { method, value: result }, agentCard: card, options }) as unknown as AfterArgs;
  return { before, after, options };
}

describe('a2aTelemetryInterceptor mapping', () => {
  it.each([
    ['sendMessage', 'SendMessage', 'message', 'jsonrpc-http'],
    ['sendMessageStream', 'SendStreamingMessage', 'message', 'sse'],
    ['getTask', 'GetTask', 'management', 'jsonrpc-http'],
    ['cancelTask', 'CancelTask', 'management', 'jsonrpc-http'],
    ['listTasks', 'ListTasks', 'management', 'jsonrpc-http'],
    ['resubscribeTask', 'SubscribeToTask', 'management', 'sse'],
    ['resubscribe', 'SubscribeToTask', 'management', 'sse'],
    ['getAgentCard', 'GetAgentCard', 'discovery', 'jsonrpc-http'],
    ['createTaskPushNotificationConfig', 'CreateTaskPushNotificationConfig', 'management', 'jsonrpc-http'],
    ['getTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'management', 'jsonrpc-http'],
    ['listTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'management', 'jsonrpc-http'],
    ['deleteTaskPushNotificationConfig', 'DeleteTaskPushNotificationConfig', 'management', 'jsonrpc-http'],
    ['somethingNew', 'somethingNew', 'other', 'jsonrpc-http'],
    ['bad method!', 'unknown', 'other', 'jsonrpc-http'],
  ])('maps %s to %s', async (clientMethod, method, kind, binding) => {
    const { recorder, events, valid } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const call = direct(interceptor, cardOf(), clientMethod, { tenant: '', id: 't1' });
    await interceptor.before(call.before);
    const [started] = await events();
    expect(started).toMatchObject({ method, kind, direction: 'outbound', protocol: { binding } });
    valid();
  });

  it.each([
    [
      'a legacy card url',
      { name: 'Legacy', url: 'https://legacy.test/a2a' },
      undefined,
      { card_url: 'https://legacy.test/a2a', declared_name: 'Legacy' },
    ],
    [
      'a non-http url and an oversized name',
      { name: 'x'.repeat(129), supportedInterfaces: [{ url: 'ftp://agent.test' }] },
      undefined,
      { declared_name: 'x'.repeat(128) },
    ],
    ['a name with control characters', { name: 'Flight\n\u0000agent\u007f' }, undefined, { declared_name: 'Flightagent' }],
    ['an invalid url and an empty name', { name: '', supportedInterfaces: [{ url: 'not a url' }] }, 'not a url either', {}],
    ['an oversized url', { supportedInterfaces: [{ url: `https://agent.test/${'x'.repeat(2048)}` }] }, undefined, {}],
    ['no interfaces', { supportedInterfaces: [] }, undefined, {}],
    ['no card', null, undefined, {}],
    ['no card but a configured card url', null, 'https://agent.test/card.json', { card_url: 'https://agent.test/card.json' }],
  ])('builds the counterparty from %s', async (_case, card, cardUrl, counterparty) => {
    const { recorder, events, valid } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder, ...(cardUrl ? { cardUrl } : {}) });
    await interceptor.before(direct(interceptor, card, 'getTask', { tenant: '', id: 't1' }).before);
    const [started] = await events();
    expect((started as { counterparty: unknown }).counterparty).toEqual(counterparty);
    valid();
  });

  it('takes the version from the A2A-Version service parameter, else 1.0', async () => {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const legacy = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' });
    legacy.options.serviceParameters['A2A-Version'] = '0.3';
    await interceptor.before(legacy.before);
    const bad = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't2' });
    bad.options.serviceParameters['A2A-Version'] = 'latest';
    await interceptor.before(bad.before);
    const none = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't3' });
    (none.before as { options?: unknown }).options = { serviceParameters: undefined };
    await interceptor.before(none.before);
    expect((await events()).map((event) => event.protocol.version)).toEqual(['0.3', '1.0', '1.0']);
  });

  it('uses the configured binding for unary and streaming calls', async () => {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder, binding: 'grpc' });
    await interceptor.before(direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' }).before);
    await interceptor.before(direct(interceptor, cardOf(), 'resubscribeTask', { tenant: '', id: 't1' }).before);
    expect((await events()).map((event) => event.protocol.binding)).toEqual(['grpc', 'grpc']);
  });

  /** Runs one stream through the interceptor directly; returns the finished events. */
  async function streamThrough(method: string, values: unknown[], card: unknown = cardOf()) {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const call = direct(interceptor, card, method, { tenant: '', id: 't1' });
    await interceptor.before(call.before);
    // The SDK runs `after` once per event, in order.
    for (const value of values) {
      await interceptor.after(call.after(value));
    }
    return ofType(await events(), 'operation.finished');
  }

  const taskEvent = (state: number) => ({ payload: { $case: 'task', value: { id: 't1', contextId: 'c1', status: status(state) } } });
  const statusEvent = (state: number) => ({
    payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: status(state) } },
  });

  it.each([
    ['a Message', [{ payload: { $case: 'message', value: userMessage('m') } }], 1],
    ['a terminal status update', [statusEvent(WORKING), statusEvent(COMPLETED)], 2],
    ['a terminal Task snapshot', [taskEvent(COMPLETED)], 1],
    ['an input_required status update', [taskEvent(SUBMITTED), statusEvent(INPUT_REQUIRED)], 2],
  ])('finishes a stream on %s', async (_case, values, streamEvents) => {
    expect(await streamThrough('sendMessageStream', values)).toMatchObject([{ outcome: 'ok', stream_events: streamEvents }]);
  });

  it.each([
    ['an input_required Task snapshot', [taskEvent(INPUT_REQUIRED)]],
    ['an auth_required status update', [statusEvent(AUTH_REQUIRED)]],
    ['an auth_required Task snapshot', [taskEvent(AUTH_REQUIRED)]],
    ['an artifact update', [{ payload: { $case: 'artifactUpdate', value: { taskId: 't1', artifact: { artifactId: 'a', parts: [] } } } }]],
  ])('does not finish a stream on %s', async (_case, values) => {
    expect(await streamThrough('resubscribeTask', values)).toEqual([]);
  });

  it('finishes the non-streaming fallback on its only event, whatever its state', async () => {
    const card = cardOf({ capabilities: { streaming: false, pushNotifications: false, extensions: [] } });
    expect(await streamThrough('sendMessageStream', [taskEvent(INPUT_REQUIRED)], card)).toMatchObject([
      { outcome: 'ok', stream_events: 1 },
    ]);
    expect(await streamThrough('sendMessageStream', [taskEvent(AUTH_REQUIRED)], { capabilities: null })).toMatchObject([
      { stream_events: 1 },
    ]);
  });

  it('records nothing for a call without a per-call options object, and ignores an after with no before', async () => {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const call = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' });
    await interceptor.before({ ...call.before, options: undefined });
    await interceptor.before({ ...call.before, input: undefined } as unknown as BeforeArgs);
    await interceptor.after({ ...call.after({}), options: undefined });
    await interceptor.after(call.after({ id: 't1', status: status(COMPLETED) }));
    expect(await events()).toEqual([]);
  });

  it('finishes a call whose result is missing without observing anything', async () => {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const call = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' });
    await interceptor.before(call.before);
    await interceptor.after({ ...call.after(null), result: undefined } as unknown as AfterArgs);
    expect((await events()).map((event) => event.type)).toEqual(['operation.started', 'operation.finished']);
  });

  it('finishes a call whose result cannot be read, observing nothing', async () => {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const call = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' });
    await interceptor.before(call.before);
    const hostile = {
      get messageId(): never {
        throw new Error('hostile getter');
      },
    };
    await interceptor.after(call.after(hostile));
    const recorded = await events();
    expect(recorded.map((event) => event.type)).toEqual(['operation.started', 'operation.finished']);
    expect(ofType(recorded, 'operation.finished')).toMatchObject([{ outcome: 'ok' }]);
  });

  it('ignores stream events after the stream finished', async () => {
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const call = direct(interceptor, cardOf(), 'sendMessageStream', send(userMessage('s')));
    await interceptor.before(call.before);
    const done = { payload: { $case: 'statusUpdate', value: { taskId: 't1', contextId: 'c1', status: status(COMPLETED) } } };
    await interceptor.after(call.after(done));
    await interceptor.after(call.after({ payload: { $case: 'statusUpdate', value: { taskId: 't1', status: status(WORKING) } } }));
    const all = await events();
    expect(ofType(all, 'operation.finished')).toMatchObject([{ stream_events: 1 }]);
    expect(ofType(all, 'task.state_changed').map((event) => event.state)).toEqual(['completed']);
  });
});

describe('a2aTelemetryInterceptor failures', () => {
  function brokenRecorder(fail: 'start' | 'handle'): Recorder {
    const handle: OperationHandle = {
      operationId: 'op',
      message() {
        throw new Error('message');
      },
      taskState() {
        throw new Error('taskState');
      },
      cost() {
        throw new Error('cost');
      },
      charge() {
        throw new Error('charge');
      },
      finish() {
        throw new Error('finish');
      },
    };
    return {
      startOperation() {
        if (fail === 'start') throw new TypeError('start');
        return handle;
      },
      abandonTask() {},
      transaction: () => '',
      flush: async () => {},
      shutdown: async () => {},
      stats: () => ({ buffered: 0, dropped: 0, sent: 0, rejected: 0, disabled: false }),
    };
  }

  it.each(['start', 'handle'] as const)('logs and swallows a recorder that throws (%s) without changing results', async (fail) => {
    const log = vi.fn();
    const card = cardOf();
    const server = agentServer(completes, card);
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: server.fetchImpl })],
      clientConfig: { interceptors: [a2aTelemetryInterceptor({ recorder: brokenRecorder(fail), log })] },
    });
    const sdk = await factory.createFromAgentCard(card);
    const result = (await sdk.sendMessage(send(userMessage('x')))) as Task;
    expect(result.status?.state).toBe(COMPLETED);
    const streamed = await collect(sdk.sendMessageStream(send(userMessage('y'))));
    expect(streamed).toHaveLength(4);
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: fail === 'start' ? 'TypeError' : 'Error' });
  });

  it('never rejects or mutates the call when the input is hostile', async () => {
    const log = vi.fn();
    const { recorder, events } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder, log });
    const hostile = {
      get message(): never {
        throw new RangeError('getter');
      },
    };
    const call = direct(interceptor, cardOf(), 'sendMessage', hostile);
    const snapshot = JSON.stringify(call.options);
    await expect(interceptor.before(call.before)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'RangeError' });
    expect(JSON.stringify(call.options)).toBe(snapshot);
    expect(call.before.earlyReturn).toBeUndefined();
    const result = { id: 't1', status: status(COMPLETED) };
    const after = call.after(result);
    await expect(interceptor.after(after)).resolves.toBeUndefined();
    expect(after.result?.value).toBe(result);
    expect(after.earlyReturn).toBeUndefined();
    expect(await events()).toEqual([]);
  });

  it('logs with console.warn by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const interceptor = a2aTelemetryInterceptor({ recorder: brokenRecorder('start') });
      await interceptor.before(direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' }).before);
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'agent_telemetry_event_failed', reason: 'TypeError' }));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a2aTelemetryInterceptor a2a block', () => {
  it('records the message id, reference tasks and requested extensions; activated extensions are not exposed to interceptors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sdk, client } = await connect(completes);
    const message = userMessage('with extensions', { messageId: 'm-ext', referenceTaskIds: ['t-old', 'bad id'] });
    await sdk.sendMessage(send(message), { serviceParameters: { 'A2A-Extensions': 'https://ext.test/a, https://ext.test/b' } });
    warn.mockRestore();
    const all = await client.events();
    expect(ofType(all, 'operation.started')[0]?.a2a).toEqual({
      message_id: 'm-ext',
      reference_task_ids: ['t-old'],
      extensions_requested: ['https://ext.test/a', 'https://ext.test/b'],
    });
    expect(ofType(all, 'operation.finished')[0]).not.toHaveProperty('a2a');
    client.valid();
  });

  it('reads the legacy extensions parameter and leaves out an empty block', async () => {
    const { recorder, events, valid } = telemetry();
    const interceptor = a2aTelemetryInterceptor({ recorder });
    const legacy = direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't1' });
    (legacy.options.serviceParameters as Record<string, string>)['X-A2A-Extensions'] = 'https://ext.test/old';
    await interceptor.before(legacy.before);
    await interceptor.before(direct(interceptor, cardOf(), 'getTask', { tenant: '', id: 't2' }).before);
    const started = ofType(await events(), 'operation.started');
    expect(started[0]?.a2a).toEqual({ extensions_requested: ['https://ext.test/old'] });
    expect(started[1]).not.toHaveProperty('a2a');
    valid();
  });
});
