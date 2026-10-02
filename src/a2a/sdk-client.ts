/**
 * Outbound telemetry for `@a2a-js/sdk` clients, as a `CallInterceptor`.
 *
 * What the SDK (1.3, `Client` in `dist/client/index.js`) guarantees, and how this interceptor relies on it:
 * - `before` and every `after` of one call receive the same `options` object: `withNormalizedHeaders` builds a fresh
 *   one per call and `executeWithInterceptors` / the streaming methods pass it to both. That object is the correlation
 *   key, in a `WeakMap`: nothing is written into the call, and an entry goes away with its call. A
 *   `ClientCallContextKey` is not used: it needs a runtime SDK import, writing it means replacing `options.context`,
 *   and a host may share one context object between calls.
 * - `after` runs only when the transport succeeds. A JSON-RPC error, an HTTP failure or a broken stream is thrown past
 *   the interceptors, so a failed outbound call is recorded as started with no finish (`incomplete`). The error itself
 *   reaches the caller untouched.
 * - Streaming methods run `after` once per event and never signal the end of the stream. The operation finishes `ok`
 *   on the event after which the SDK 1.3 server closes it (`ExecutionEventQueue.events`): a Message, any terminal
 *   state, or an `input_required` status update. `auth_required` does not end a stream (the executor resumes on the
 *   same bus), and neither does an interrupted Task snapshot (`resubscribeTask` yields the stored Task first). When
 *   the card has no `streaming` capability, `sendMessageStream` falls back to one blocking send and finishes on its
 *   only event. A stream that ends otherwise stays incomplete: one the consumer stops early, a resubscribe whose
 *   server has no live execution, or a 0.3 server closing with `final: true` at `auth-required`.
 *
 * Ordering: the SDK runs `before` in `interceptors` order and `after` in reverse. Put this interceptor first, so its
 * `before` runs before any interceptor can return early (an earlier `earlyReturn` skips it, and nothing is recorded)
 * and its `after` sees the final result. An interceptor placed after it that sets `earlyReturn` or throws in its own
 * `after` skips this `after`, which leaves the operation incomplete.
 */
import { isTerminal, type Binding } from '../contract.ts';
import { normalizeText } from '../patterns.ts';
import type { CounterpartyInput, OperationHandle, Recorder } from '../recorder.ts';
import { recorderState } from '../state.ts';
import { a2aExtensions, a2aKind, a2aMethod, a2aRequestBlock, a2aRequestRefs, type A2AObservation } from './mapping.ts';
import { applyObservations, sdkObservations } from './observe.ts';
import { VERSION, defaultLog, guardLog, isObjectOrArray, safely, type Json, type Log } from './util.ts';

/**
 * What the interceptor reads from the SDK's `BeforeArgs` and `AfterArgs`. Declared here instead of imported, so the
 * published declarations never need `@a2a-js/sdk` (an optional peer); the SDK's argument types are assignable to it.
 */
export interface A2AInterceptorArgs {
  readonly input?: unknown;
  readonly result?: unknown;
  readonly agentCard?: unknown;
  readonly options?: unknown;
}

/** Structurally an `@a2a-js/sdk` `CallInterceptor`: pass it in `clientConfig.interceptors`. */
export interface A2ACallInterceptor {
  before(args: A2AInterceptorArgs): Promise<void>;
  after(args: A2AInterceptorArgs): Promise<void>;
}

export interface A2AInterceptorOptions {
  recorder: Recorder;
  /** Protocol version recorded. Default: the call's `A2A-Version` service parameter, else `1.0`. */
  version?: string;
  /**
   * The called agent's card URL. The SDK does not keep the URL a card was fetched from, so the default is the card's
   * first interface URL (or a 0.3 card's `url`).
   */
  cardUrl?: string;
  /** Binding recorded for every call. Default `sse` for streaming calls, else `jsonrpc-http`. */
  binding?: Binding;
  log?: Log;
}

/** SDK client method → A2A 1.0 method. */
const METHODS = new Map(
  Object.entries({
    sendMessage: 'SendMessage',
    sendMessageStream: 'SendStreamingMessage',
    getTask: 'GetTask',
    cancelTask: 'CancelTask',
    listTasks: 'ListTasks',
    resubscribeTask: 'SubscribeToTask',
    resubscribe: 'SubscribeToTask',
    getAgentCard: 'GetAgentCard',
    createTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
    getTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
    listTaskPushNotificationConfig: 'ListTaskPushNotificationConfigs',
    deleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
  }),
);
const STREAMING = new Set(['sendMessageStream', 'resubscribeTask', 'resubscribe']);
const MAX_URL = 2048;
const MAX_NAME = 128;

/** An http(s) URL the event contract accepts, else undefined. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function counterparty(card: unknown, cardUrl: string | undefined): CounterpartyInput {
  if (!isObjectOrArray(card)) return httpUrl(cardUrl) ? { card_url: cardUrl } : {};
  const first: unknown = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces[0] : undefined;
  const url = httpUrl(cardUrl) ?? httpUrl(isObjectOrArray(first) ? first.url : undefined) ?? httpUrl(card.url);
  // The called agent controls its card: its name is cleaned so it can never get the started event rejected.
  const name = normalizeText(card.name, MAX_NAME);
  return { ...(url ? { card_url: url } : {}), ...(name ? { declared_name: name } : {}) };
}

function versionOf(options: Json, configured: string | undefined): string {
  if (configured) return configured;
  const header = isObjectOrArray(options.serviceParameters) ? options.serviceParameters['A2A-Version'] : undefined;
  return typeof header === 'string' && VERSION.test(header) ? header : '1.0';
}

/**
 * The extensions the call requests: the `A2A-Extensions` service parameter, or `X-A2A-Extensions` for a 0.3 agent
 * (the SDK has already normalized the name for the call's version). The SDK does not hand interceptors the response
 * headers, so the extensions the agent activated are not recorded on outbound calls.
 */
function requestedExtensions(options: Json): string[] {
  const parameters = isObjectOrArray(options.serviceParameters) ? options.serviceParameters : {};
  return a2aExtensions(
    [parameters['A2A-Extensions'], parameters['X-A2A-Extensions']].filter((value) => typeof value === 'string').join(','),
  );
}

/** True for the stream event after which the SDK 1.3 server closes the stream (see the module comment). */
function endsStream(value: unknown, observations: A2AObservation[]): boolean {
  const kind = isObjectOrArray(value) && isObjectOrArray(value.payload) ? value.payload.$case : undefined;
  if (kind === 'message') return true;
  return observations.some(
    (observation) =>
      observation.type === 'task' && (isTerminal(observation.state) || (kind === 'statusUpdate' && observation.state === 'input_required')),
  );
}

/** `sendMessageStream` against a card without `streaming` yields exactly one event (the SDK's blocking fallback). */
function isFallback(method: string, card: unknown): boolean {
  if (method !== 'sendMessageStream') return false;
  const capabilities = isObjectOrArray(card) ? card.capabilities : undefined;
  return !(isObjectOrArray(capabilities) && capabilities.streaming);
}

interface Call {
  op: OperationHandle;
  method: string;
  streaming: boolean;
  events: number;
}

/**
 * Records every call made through an SDK client as an `outbound` operation: the sent message, the result's task
 * states and messages, and the called agent as counterparty. It never changes a call's input, result or error.
 */
export function a2aTelemetryInterceptor(options: A2AInterceptorOptions): A2ACallInterceptor {
  const { recorder } = options;
  const log = guardLog(options.log ?? defaultLog);
  const state = recorderState(recorder, 'a2a', 'outbound');
  /** In-flight calls by their per-call options object; weak keys, so an unfinished call leaves nothing behind. */
  const calls = new WeakMap<object, Call>();

  function before(args: A2AInterceptorArgs): void {
    const { options: key, input } = args;
    if (!isObjectOrArray(key) || !isObjectOrArray(input)) return;
    const method = typeof input.method === 'string' ? input.method : '';
    const streaming = STREAMING.has(method);
    // A method a newer SDK adds keeps its own (sanitized) name.
    const name = METHODS.get(method) ?? a2aMethod(method);
    const refs = a2aRequestRefs(input.value);
    const a2a = a2aRequestBlock(input.value, requestedExtensions(key));
    const op = recorder.startOperation({
      protocol: { name: 'a2a', version: versionOf(key, options.version), binding: options.binding ?? (streaming ? 'sse' : 'jsonrpc-http') },
      direction: 'outbound',
      method: name,
      kind: a2aKind(name),
      ...(refs.contextRef ? { conversationRef: refs.contextRef } : {}),
      ...(refs.taskRef ? { taskRef: refs.taskRef } : {}),
      counterparty: counterparty(args.agentCard, options.cardUrl),
      ...(a2a ? { a2a } : {}),
    });
    calls.set(key, { op, method, streaming, events: 0 });
    if (refs.taskRef) state.linkTask(refs.taskRef, op);
    if (refs.message) op.message(refs.message);
  }

  function after(args: A2AInterceptorArgs): void {
    const { options: key, result } = args;
    if (!isObjectOrArray(key)) return;
    const call = calls.get(key);
    if (!call) return;
    const value = isObjectOrArray(result) ? result.value : undefined;
    // A result that cannot be read is observed as nothing; the call still finishes.
    let observations: A2AObservation[] = [];
    safely(log, () => {
      observations = sdkObservations(value);
    });
    safely(log, () => applyObservations(call.op, state, observations));
    if (call.streaming) {
      call.events++;
      if (!isFallback(call.method, args.agentCard) && !endsStream(value, observations)) return;
    }
    calls.delete(key);
    call.op.finish({ outcome: 'ok', ...(call.streaming ? { streamEvents: call.events } : {}) });
  }

  return {
    before(args) {
      safely(log, () => before(args));
      return Promise.resolve();
    },
    after(args) {
      safely(log, () => after(args));
      return Promise.resolve();
    },
  };
}
