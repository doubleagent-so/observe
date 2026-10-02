/** Wrappers for servers built on `@a2a-js/sdk`: every request-handler method, plus the task store for late updates. */
import type { A2ARequestHandler, ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { isTerminal, type Binding, type Kind } from '../contract.ts';
import { NOOP_OPERATION as NOOP, type CounterpartyInput, type FinishInput, type OperationHandle, type Recorder } from '../recorder.ts';
import { boundedId as ref } from './ids.ts';
import { HANDLER_THREW } from '../http.ts';
import { a2aExtensions, a2aRequestBlock, a2aRequestRefs, a2aResponseBlock, a2aTaskState } from './mapping.ts';
import { observeSdkResult } from './observe.ts';
import { STATE_LIMIT, recorderState } from '../state.ts';
import { VERSION, defaultLog, guardLog, isObjectOrArray, failureReason, safely, type Log } from './util.ts';

export interface A2AHandlerOptions {
  recorder: Recorder;
  /** Issuer recorded for authenticated SDK users. Default `a2a-sdk`. */
  issuer?: string;
  /** The SDK handler is transport-agnostic; say which binding serves it. Default `jsonrpc-http`. */
  binding?: Binding;
  log?: Log;
}

export interface A2ATaskStoreOptions {
  recorder: Recorder;
  /** Remember open tasks so `abandonOpenTasks()` can close them on shutdown. Default false. */
  abandonOpenTasksOnShutdown?: boolean;
  log?: Log;
}

/*
 * The SDK types below are declared structurally instead of imported, so the published declarations never need
 * `@a2a-js/sdk` (an optional peer). `never` parameters accept any SDK signature; the wrappers return the wrapped
 * object's own method types, which stay assignable to the SDK's `A2ARequestHandler` and `TaskStore`. Only method
 * names are checked: a method a newer SDK 1.x adds to `A2ARequestHandler` needs a release of this package.
 */
type SdkCall = (params: never, context: never) => Promise<unknown>;
type SdkStream = (params: never, context: never) => AsyncGenerator<unknown, void, undefined>;

/** The methods of an `@a2a-js/sdk` `A2ARequestHandler` (such as `DefaultRequestHandler`). */
export interface A2ARequestHandlerLike {
  getAgentCard: () => Promise<unknown>;
  getAuthenticatedExtendedAgentCard: SdkCall;
  sendMessage: SdkCall;
  sendMessageStream: SdkStream;
  getTask: SdkCall;
  cancelTask: SdkCall;
  listTasks: SdkCall;
  resubscribe: SdkStream;
  createTaskPushNotificationConfig: SdkCall;
  getTaskPushNotificationConfig: SdkCall;
  listTaskPushNotificationConfigs: SdkCall;
  deleteTaskPushNotificationConfig: SdkCall;
}

/** The methods of an `@a2a-js/sdk` `TaskStore` (such as `InMemoryTaskStore`). */
export interface A2ATaskStoreLike {
  save: (task: never, context: never) => Promise<void>;
  load: SdkCall;
  list: SdkCall;
}

/** The handler's request methods, with its own signatures; pass it wherever the SDK takes an `A2ARequestHandler`. */
export type InstrumentedA2AHandler<H extends A2ARequestHandlerLike> = Pick<H, keyof A2ARequestHandlerLike>;

/** The store's methods, with its own signatures, plus `abandonOpenTasks`; e.g. `InstrumentedTaskStore<InMemoryTaskStore>`. */
export type InstrumentedTaskStore<S extends A2ATaskStoreLike> = Pick<S, keyof A2ATaskStoreLike> & {
  /**
   * Records every task still open as `canceled` with `reason` (default `shutdown`), then forgets them. Does nothing
   * unless the store was created with `abandonOpenTasksOnShutdown: true`. Call it before `recorder.shutdown()`.
   */
  abandonOpenTasks(reason?: string): Promise<void>;
};

type Context = ServerCallContext | undefined;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
/** SDK reasons whose A2A code differs from the lower-cased reason. */
const REASON_CODES: Record<string, string> = { EXTENDED_AGENT_CARD_NOT_CONFIGURED: 'extended_card_not_configured' };

/** The SDK's own default when the caller sent no `A2A-Version`. */
function versionOf(context: Context): string {
  const version = context?.requestedVersion;
  return typeof version === 'string' && VERSION.test(version) ? version : '0.3';
}

/** SDK `A2AError`s carry an UPPER_SNAKE `reason`; anything else the handler throws is an internal error. */
function sdkError(error: unknown, log: Log): { nativeCode: string; code: string } {
  try {
    const reason = isObjectOrArray(error) ? error.reason : undefined;
    if (typeof reason === 'string' && REASON.test(reason))
      return { nativeCode: reason, code: REASON_CODES[reason] ?? reason.toLowerCase() };
  } catch (failure) {
    // A hostile `reason` getter: the throw is still the handler's own, recorded as an internal error.
    log('agent_telemetry_event_failed', { reason: failureReason(failure) });
  }
  return HANDLER_THREW;
}

/** The extensions the agent activated on this call (`ServerCallContext.activatedExtensions`), as a finish block. */
function activated(context: Context, log: Log): Pick<FinishInput, 'a2a'> {
  try {
    const a2a = a2aResponseBlock(a2aExtensions(context?.activatedExtensions));
    return a2a ? { a2a } : {};
  } catch (error) {
    // A context that cannot say: the operation still finishes, without the block.
    log('agent_telemetry_event_failed', { reason: failureReason(error) });
    return {};
  }
}

/**
 * The operation each in-flight call context belongs to, per recorder. The SDK passes the request's context to the task
 * store, so a task created by a send is linked to that send before its result is returned. Weak keys: no bound needed.
 */
const contexts = new WeakMap<Recorder, WeakMap<object, OperationHandle>>();

function contextOperations(recorder: Recorder): WeakMap<object, OperationHandle> {
  let map = contexts.get(recorder);
  if (!map) {
    map = new WeakMap();
    contexts.set(recorder, map);
  }
  return map;
}

/**
 * Wraps every `A2ARequestHandler` method. Each request must get its own `ServerCallContext` (the SDK's transports do
 * this): a context shared between concurrent requests can attach a new task's first states to another operation.
 */
export function instrumentA2AHandler<H extends A2ARequestHandlerLike>(handler: H, options: A2AHandlerOptions): InstrumentedA2AHandler<H> {
  // Typed against the SDK inside; the public signature stays structural (see A2ARequestHandlerLike).
  const sdk = handler as unknown as A2ARequestHandler;
  const { recorder } = options;
  const log = guardLog(options.log ?? defaultLog);
  const issuer = options.issuer ?? 'a2a-sdk';
  const state = recorderState(recorder, 'a2a');
  const byContext = contextOperations(recorder);

  function counterparty(context: Context): CounterpartyInput {
    const user = context?.user;
    if (user?.isAuthenticated !== true) return {};
    const subject = user.userName;
    return typeof subject === 'string' && subject ? { authenticated: { issuer, subject } } : {};
  }

  function start(method: string, kind: Kind, params: unknown, context: Context, binding?: Binding): OperationHandle {
    let op = NOOP;
    safely(log, () => {
      const refs = a2aRequestRefs(params);
      // Read before the SDK narrows the requested set to the extensions the card exposes.
      const a2a = a2aRequestBlock(params, a2aExtensions(context?.requestedExtensions));
      op = recorder.startOperation({
        protocol: { name: 'a2a', version: versionOf(context), binding: binding ?? options.binding ?? 'jsonrpc-http' },
        direction: 'inbound',
        method,
        kind,
        ...(refs.contextRef ? { conversationRef: refs.contextRef } : {}),
        ...(refs.taskRef ? { taskRef: refs.taskRef } : {}),
        counterparty: counterparty(context),
        ...(a2a ? { a2a } : {}),
      });
      if (isObjectOrArray(context)) byContext.set(context, op);
      if (refs.taskRef) state.linkTask(refs.taskRef, op);
      if (refs.message) op.message(refs.message);
    });
    return op;
  }

  async function unary<R>(method: string, kind: Kind, params: unknown, context: Context, run: () => Promise<R>): Promise<R> {
    const op = start(method, kind, params, context);
    let result: R;
    try {
      result = await run();
    } catch (error) {
      safely(log, () => op.finish({ outcome: 'protocol_error', error: sdkError(error, log), ...activated(context, log) }));
      throw error;
    }
    safely(log, () => observeSdkResult(op, state, result));
    safely(log, () => op.finish({ outcome: 'ok', ...activated(context, log) }));
    return result;
  }

  async function* stream<E>(
    method: string,
    kind: Kind,
    params: unknown,
    context: Context,
    run: () => AsyncGenerator<E, void, undefined>,
  ): AsyncGenerator<E, void, undefined> {
    const op = start(method, kind, params, context, 'sse');
    let events = 0;
    let finish: FinishInput | undefined;
    /** True while paused at `yield`; still true in `finally` only when the consumer called `return()` there. */
    let suspended = false;
    /** Set once the consumer throws an error in: the stream then ends as an early stop, whatever follows. */
    let interrupted = false;
    let inner: AsyncGenerator<E, void, undefined> | undefined;
    try {
      // Iterated by hand so the consumer's `throw()` reaches the inner stream, as `yield*` would forward it.
      inner = run();
      let step = await inner.next();
      while (!step.done) {
        const event = step.value;
        events++;
        safely(log, () => observeSdkResult(op, state, event));
        let injected: { error: unknown } | undefined;
        suspended = true;
        try {
          yield event;
        } catch (error) {
          injected = { error };
        }
        suspended = false;
        // A stream is consumed one event at a time; each step must wait for the previous one.
        if (injected) {
          interrupted = true;
          // eslint-disable-next-line no-await-in-loop -- sequential by nature (see above)
          step = await inner.throw(injected.error);
        } else {
          // eslint-disable-next-line no-await-in-loop -- sequential by nature (see above)
          step = await inner.next();
        }
      }
      finish = { outcome: interrupted ? 'transport_error' : 'ok' };
    } catch (error) {
      finish = interrupted ? { outcome: 'transport_error' } : { outcome: 'protocol_error', error: sdkError(error, log) };
      throw error;
    } finally {
      try {
        // The consumer called `return()` at `yield`: close the inner stream too, as for-await would.
        if (suspended) await inner?.return(undefined);
      } finally {
        const result = finish ?? { outcome: 'transport_error' };
        safely(log, () => op.finish({ ...result, streamEvents: events, ...activated(context, log) }));
      }
    }
  }

  const wrapped: A2ARequestHandler = {
    getAgentCard: () => unary('GetAgentCard', 'discovery', undefined, undefined, () => sdk.getAgentCard()),
    getAuthenticatedExtendedAgentCard: (params, context) =>
      unary('GetExtendedAgentCard', 'discovery', params, context, () => sdk.getAuthenticatedExtendedAgentCard(params, context)),
    sendMessage: (params, context) => unary('SendMessage', 'message', params, context, () => sdk.sendMessage(params, context)),
    sendMessageStream: (params, context) =>
      stream('SendStreamingMessage', 'message', params, context, () => sdk.sendMessageStream(params, context)),
    getTask: (params, context) => unary('GetTask', 'management', params, context, () => sdk.getTask(params, context)),
    cancelTask: (params, context) => unary('CancelTask', 'management', params, context, () => sdk.cancelTask(params, context)),
    listTasks: (params, context) => unary('ListTasks', 'management', params, context, () => sdk.listTasks(params, context)),
    resubscribe: (params, context) => stream('SubscribeToTask', 'management', params, context, () => sdk.resubscribe(params, context)),
    createTaskPushNotificationConfig: (params, context) =>
      unary('CreateTaskPushNotificationConfig', 'management', params, context, () => sdk.createTaskPushNotificationConfig(params, context)),
    getTaskPushNotificationConfig: (params, context) =>
      unary('GetTaskPushNotificationConfig', 'management', params, context, () => sdk.getTaskPushNotificationConfig(params, context)),
    listTaskPushNotificationConfigs: (params, context) =>
      unary('ListTaskPushNotificationConfigs', 'management', params, context, () => sdk.listTaskPushNotificationConfigs(params, context)),
    deleteTaskPushNotificationConfig: (params, context) =>
      unary('DeleteTaskPushNotificationConfig', 'management', params, context, () => sdk.deleteTaskPushNotificationConfig(params, context)),
  };
  return wrapped as unknown as InstrumentedA2AHandler<H>;
}

interface OpenTask {
  version: string;
  conversationRef?: string;
}

/**
 * Records task states as they are saved, linked to the operation that created or last touched the task (found through
 * the per-request `ServerCallContext`, which must not be shared between requests); unknown tasks get `task/update`.
 */
export function instrumentTaskStore<S extends A2ATaskStoreLike>(store: S, options: A2ATaskStoreOptions): InstrumentedTaskStore<S> {
  // Typed against the SDK inside; the public signature stays structural (see A2ATaskStoreLike).
  const sdk = store as unknown as TaskStore;
  const { recorder } = options;
  const log = guardLog(options.log ?? defaultLog);
  const state = recorderState(recorder, 'a2a');
  const byContext = contextOperations(recorder);
  /** Tasks whose last saved state is not terminal, oldest first; bounded like every per-recorder map. */
  const open = options.abandonOpenTasksOnShutdown ? new Map<string, OpenTask>() : null;

  function remember(taskRef: string, terminal: boolean, task: OpenTask): void {
    if (!open) return;
    open.delete(taskRef);
    if (terminal) return;
    open.set(taskRef, task);
    if (open.size > STATE_LIMIT) open.delete(open.keys().next().value!);
  }

  function record(task: unknown, context: Context): void {
    if (!isObjectOrArray(task)) return;
    const taskRef = ref(task.id);
    if (!taskRef) return;
    const { state: next, nativeState } = a2aTaskState(isObjectOrArray(task.status) ? task.status.state : undefined);
    const conversationRef = ref(task.contextId);
    const version = versionOf(context);
    remember(taskRef, isTerminal(next), { version, ...(conversationRef ? { conversationRef } : {}) });
    if (!state.taskChanged(taskRef, next)) return;

    let op = state.operationFor(taskRef);
    if (!op && isObjectOrArray(context)) {
      op = byContext.get(context);
      if (op) state.linkTask(taskRef, op);
    }
    if (op) {
      // The SDK assigns a contextId to a first message sent without one: it links the operation to its conversation.
      op.taskState({ taskRef, state: next, nativeState, ...(conversationRef ? { conversationRef } : {}) });
      return;
    }
    const update = recorder.startOperation({
      protocol: { name: 'a2a', version, binding: 'other' },
      direction: 'inbound',
      method: 'task/update',
      kind: 'other',
      taskRef,
      ...(conversationRef ? { conversationRef } : {}),
    });
    state.linkTask(taskRef, update);
    update.taskState({ taskRef, state: next, nativeState });
    update.finish({ outcome: 'ok' });
  }

  const wrapped: TaskStore & { abandonOpenTasks(reason?: string): Promise<void> } = {
    async save(task, context) {
      await sdk.save(task, context);
      try {
        record(task, context);
      } catch (error) {
        log('agent_telemetry_event_failed', { reason: failureReason(error) });
      }
    },
    load: (taskId, context) => sdk.load(taskId, context),
    list: (params, context) => sdk.list(params, context),
    abandonOpenTasks(reason = 'shutdown') {
      if (!open) return Promise.resolve();
      const tasks = [...open];
      open.clear();
      for (const [taskRef, task] of tasks) {
        try {
          recorder.abandonTask(taskRef, {
            protocol: { name: 'a2a', version: task.version, binding: 'other' },
            direction: 'inbound',
            state: 'canceled',
            reason,
            ...(task.conversationRef ? { conversationRef: task.conversationRef } : {}),
          });
        } catch (error) {
          log('agent_telemetry_event_failed', { reason: failureReason(error) });
        }
      }
      return Promise.resolve();
    },
  };
  return wrapped as unknown as InstrumentedTaskStore<S>;
}
