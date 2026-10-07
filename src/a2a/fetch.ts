/** `withA2ATelemetry`: observes A2A JSON-RPC and Agent Card requests on any fetch-style server. */
import {
  HANDLER_THREW,
  identifyCaller,
  JSON_TYPE,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  createScheduler,
  declaredLength,
  httpError,
  isEventStream,
  readLimited,
  type LimitedRead,
} from '../http.ts';
import { insufficientScope } from '../evidence.ts';
import type { ChargeInput } from '../money.ts';
import { x402Charge, x402Evidence } from '../payments.ts';
import type { CounterpartyInput, FinishInput, OperationHandle, Recorder } from '../recorder.ts';
import { recorderState } from '../state.ts';
import {
  a2aBinding,
  a2aError,
  a2aExtensions,
  a2aKind,
  a2aMethod,
  a2aRequestBlock,
  a2aRequestRefs,
  a2aResponseBlock,
  a2aVersion,
} from './mapping.ts';
import { observeResult } from './observe.ts';
import { taskRefOf, x402Receipt, x402Submitted } from './payments.ts';
import { observeStream } from './sse.ts';
import { defaultLog, failureReason, guardLog, isRecord, safely, type Log } from './util.ts';

export interface A2ATelemetryOptions {
  recorder: Recorder;
  identify?: (request: Request) => CounterpartyInput | Promise<CounterpartyInput>;
  /** `true` uses the first handler argument with a `waitUntil` function (the Workers `ctx`). */
  waitUntil?: true | ((promise: Promise<unknown>) => void);
  cardPath?: string;
  log?: Log;
}

type Parsed = { kind: 'skip' } | { kind: 'unknown' } | { kind: 'rpc'; method: string; params: unknown };

function parse(read: LimitedRead): Parsed {
  if (read === null) return { kind: 'unknown' };
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return { kind: 'skip' };
  }
  if (Array.isArray(body)) return body.length ? { kind: 'unknown' } : { kind: 'skip' };
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return { kind: 'skip' };
  return { kind: 'rpc', method: body.method, params: body.params };
}

/** Extension URIs from the `A2A-Extensions` header, or the 0.3 `X-A2A-Extensions` one. */
function extensions(headers: Headers): string[] {
  return a2aExtensions([headers.get('a2a-extensions'), headers.get('x-a2a-extensions')].filter(Boolean).join(','));
}

/**
 * The operation with `extra` added to its finish, however it finishes. Every member is forwarded explicitly, so a
 * handle whose methods live on a prototype (or whose `operationId` is a getter) keeps working. Internal; exported for
 * its tests.
 */
export function finishingWith(op: OperationHandle, extra: Partial<FinishInput>): OperationHandle {
  return withFinish(op, (input) => op.finish({ ...input, ...extra }));
}

/** The operation with its `finish` replaced; every other member is forwarded explicitly, as in `finishingWith`. */
function withFinish(op: OperationHandle, finish: OperationHandle['finish']): OperationHandle {
  return {
    get operationId() {
      return op.operationId;
    },
    message: (input) => op.message(input),
    taskState: (input) => op.taskState(input),
    cost: (input) => op.cost(input),
    charge: (input) => op.charge(input),
    finish,
  };
}

/** One call's x402 charge, recorded at most once. */
interface Payment {
  /** The x402 payload the caller submitted in its message metadata, if any. */
  submitted: Record<string, unknown> | undefined;
  /** Charges a final receipt carried by an A2A result, when the caller submitted a payload. */
  receipt(result: unknown): void;
  /** Charges the header evidence, unless a receipt was charged; ends the payment either way. */
  settle(taskRef?: string): void;
}

/** What a response without a JSON-RPC error means: `ok`, or for a failure status an HTTP error. */
const statusFinish = (response: Response): FinishInput =>
  response.status < 400 ? { outcome: 'ok' } : { outcome: 'protocol_error', error: httpError(response.status) };

/**
 * The outcome for responses that need no body read, or null when the body decides. An event stream with an error
 * status is an HTTP error: its events are not observed, as for any error status without a JSON-RPC error.
 */
function immediateFinish(request: Request, response: Response): FinishInput | null {
  if (response.status === 401 || response.status === 403) return { outcome: 'auth_rejected', ...insufficientScope(response) };
  if (request.method === 'GET' || (response.status >= 400 && isEventStream(response))) return statusFinish(response);
  return null;
}

export function withA2ATelemetry<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  options: A2ATelemetryOptions,
): (request: Request, ...args: Args) => Promise<Response> {
  const log = guardLog(options.log ?? defaultLog);
  const cardPath = options.cardPath ?? '/.well-known/agent-card.json';
  const state = recorderState(options.recorder, 'a2a');
  const scheduler = createScheduler(options.waitUntil, log);

  const identify = async (request: Request): Promise<CounterpartyInput> => identifyCaller(options.identify, request, log);

  async function start(request: Request, method: string, params: unknown): Promise<OperationHandle | null> {
    try {
      const refs = a2aRequestRefs(params);
      const a2a = a2aRequestBlock(params, extensions(request.headers));
      const op = options.recorder.startOperation({
        protocol: { name: 'a2a', version: a2aVersion(method, request.headers.get('a2a-version')), binding: a2aBinding(method) },
        direction: 'inbound',
        method: a2aMethod(method),
        kind: a2aKind(method),
        ...(refs.contextRef ? { conversationRef: refs.contextRef } : {}),
        ...(refs.taskRef ? { taskRef: refs.taskRef } : {}),
        counterparty: await identify(request),
        ...(a2a ? { a2a } : {}),
      });
      if (refs.taskRef) state.linkTask(refs.taskRef, op);
      if (refs.message) op.message(refs.message);
      return op;
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return null;
    }
  }

  /** Reads the JSON-RPC envelope from a clone; any failure means "not ours" and the request passes through. */
  async function readRequest(request: Request): Promise<Parsed> {
    try {
      return parse(await readLimited(request, MAX_REQUEST_BYTES));
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return { kind: 'skip' };
    }
  }

  /** The operation for an observed request, with the request params (for payment metadata); null when not observed. */
  async function observeRequest(request: Request): Promise<{ op: OperationHandle | null; params?: unknown } | null> {
    if (request.method === 'GET')
      return new URL(request.url).pathname === cardPath ? { op: await start(request, 'GetAgentCard', undefined) } : null;
    if (request.method !== 'POST' || !JSON_TYPE.test(request.headers.get('content-type') ?? '')) return null;
    const parsed = await readRequest(request);
    if (parsed.kind === 'unknown') return { op: await start(request, 'unknown', undefined) };
    return parsed.kind === 'rpc' ? { op: await start(request, parsed.method, parsed.params), params: parsed.params } : null;
  }

  /** The x402 payload submitted in the request's message metadata; never throws. */
  function submittedOf(params: unknown): Record<string, unknown> | undefined {
    try {
      return x402Submitted(params);
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return undefined;
    }
  }

  /** The x402 charge of a request and its response, or null; evidence never breaks a request. */
  function paymentOf(request: Request, response: Response): ChargeInput | null {
    try {
      return x402Charge(request, response);
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return null;
    }
  }

  /** Records the charge, on `taskRef` when given, else on the operation's task (the request's), else the operation. */
  function charge(op: OperationHandle, payment: ChargeInput | null, taskRef?: string): void {
    if (payment) safely(log, () => op.charge(taskRef ? { ...payment, taskRef } : payment));
  }

  /**
   * x402 evidence for one call. A receipt in A2A metadata wins over the HTTP headers (`header`), which are only the
   * fallback, so a call that carries both is charged once.
   */
  function paymentFor(op: OperationHandle, submitted: Record<string, unknown> | undefined, header: ChargeInput | null): Payment {
    let open = true;
    return {
      submitted,
      receipt(result) {
        if (!open || !submitted) return;
        const found = x402Receipt(result);
        const evidence = found ? x402Evidence(submitted, found.receipt) : null;
        if (!evidence) return;
        open = false;
        charge(op, evidence, found?.taskRef);
      },
      settle(taskRef) {
        if (!open) return;
        open = false;
        charge(op, header, taskRef);
      },
    };
  }

  /**
   * Must be called before the response is returned: the clone is taken synchronously. Never rejects. A JSON-RPC error
   * decides the outcome; without one, the status does (`ok`, or `http_error` for an error page or a non-RPC body).
   * The payment, if any, is charged just before the finish: to the task the result carries, else the operation's.
   */
  async function settleUnary(op: OperationHandle, response: Response, payment: Payment): Promise<void> {
    const fallback = statusFinish(response);
    let bytes: number | undefined;
    let taskRef: string | undefined;
    const finish = (input: FinishInput) => {
      // Charged once (the payment ends here), even when a custom handle's finish throws and the catch finishes again.
      payment.settle(taskRef);
      op.finish(input);
    };
    try {
      const declared = declaredLength(response.headers);
      if (declared > MAX_RESPONSE_BYTES) return finish({ ...fallback, responseBytes: declared });
      const read = await readLimited(response, MAX_RESPONSE_BYTES);
      if (!read) return finish(fallback);
      bytes = read.bytes;
      const body = JSON.parse(read.text) as unknown;
      if (isRecord(body) && body.error !== undefined)
        return finish({ outcome: 'protocol_error', error: a2aError(body.error), responseBytes: bytes });
      if (fallback.outcome === 'ok') {
        const result = isRecord(body) ? body.result : undefined;
        observeResult(op, state, result);
        payment.receipt(result);
        taskRef = taskRefOf(result);
      }
      finish({ ...fallback, responseBytes: bytes });
    } catch (error) {
      // A body that is not JSON (an HTML error page) is expected and finishes on the status alone; anything else is a
      // failure worth a log line.
      if (!(error instanceof SyntaxError)) log('agent_telemetry_event_failed', { reason: failureReason(error) });
      finish({ ...fallback, ...(bytes !== undefined ? { responseBytes: bytes } : {}) });
    }
  }

  /** Adds the response's `a2a` block (activated extensions) to the finish; any failure keeps the operation as is. */
  function withResponseBlock(op: OperationHandle, response: Response): OperationHandle {
    try {
      const a2a = a2aResponseBlock(extensions(response.headers));
      return a2a ? finishingWith(op, { a2a }) : op;
    } catch (error) {
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
      return op;
    }
  }

  return async (request, ...args) => {
    const observed = await observeRequest(request);
    if (!observed?.op) return handler(request, ...args);
    let op: OperationHandle = observed.op;
    const schedule = scheduler(args);
    const flush = () => schedule(options.recorder.flush());

    let response: Response;
    try {
      response = await handler(request, ...args);
    } catch (error) {
      op.finish({ outcome: 'protocol_error', error: HANDLER_THREW });
      flush();
      throw error;
    }
    op = withResponseBlock(op, response);
    const finish = immediateFinish(request, response);
    // A rejected caller or an Agent Card fetch pays nothing; anything else with x402 evidence is charged.
    const unpaid = request.method === 'GET' || finish?.outcome === 'auth_rejected';
    const payment = paymentFor(op, unpaid ? undefined : submittedOf(observed.params), unpaid ? null : paymentOf(request, response));
    if (finish) {
      payment.settle();
      op.finish(finish);
      flush();
      return response;
    }
    if (isEventStream(response)) {
      if (!payment.submitted) {
        // Header evidence only: charged now, to the request's task (the stream's own task is not known yet).
        payment.settle();
        return observeStream(response, op, state, flush, log);
      }
      // A receipt may arrive in any event; the header evidence waits for the finish in case none does.
      const settling = withFinish(op, (input) => {
        payment.settle();
        op.finish(input);
      });
      return observeStream(response, settling, state, flush, log, (result) => payment.receipt(result));
    }
    schedule(
      (async () => {
        await settleUnary(op, response, payment);
        await options.recorder.flush();
      })(),
    );
    return response;
  };
}
