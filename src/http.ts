/**
 * Internal helpers shared by the adapters: bounded body reads, logging, guarded work, caller evidence, scheduling and
 * HTTP errors.
 */
import { isRecord } from './patterns.ts';

/** Request bodies are read from a clone up to this size; larger ones are not parsed. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** JSON response bodies are parsed from a clone in the background up to this size. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** `application/json` and `application/*+json`, with or without parameters. */
export const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export const defaultLog: Log = (event, fields) => console.warn(JSON.stringify({ event, ...fields }));

/**
 * The host's logger, made safe to call anywhere: a logger that throws loses that line and nothing else, so it can never
 * reach the host's request, stream or SDK call. Each entry point wraps its logger once with this.
 */
export function guardLog(log: Log): Log {
  return (event, fields) => {
    try {
      log(event, fields);
    } catch {
      // Nothing left to report the failure to; telemetry carries on without the log line.
    }
  };
}

/** What a log line says about a failure: the error's name, never its message, which can carry request data. */
export const failureReason = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/** Runs telemetry work; a failure is logged and swallowed, never reaching the host. */
export function safely(log: Log, work: () => void): void {
  try {
    work();
  } catch (error) {
    log('agent_telemetry_event_failed', { reason: failureReason(error) });
  }
}

/** The host's evidence about a caller (`identify`), or none when there is no `identify` or it fails (logged). */
export async function identifyCaller<Evidence extends object>(
  identify: ((request: Request) => Evidence | Promise<Evidence>) | undefined,
  request: Request,
  log: Log,
): Promise<Evidence | Record<string, never>> {
  try {
    return (await identify?.(request)) ?? {};
  } catch (error) {
    log('agent_telemetry_identify_failed', { reason: failureReason(error) });
    return {};
  }
}

/** The declared `content-length`, or 0 when absent or malformed. */
export function declaredLength(headers: Headers): number {
  const length = Number(headers.get('content-length') ?? 0);
  return Number.isFinite(length) ? length : 0;
}

export type LimitedRead = { text: string; bytes: number } | null;

async function release(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The clone is ours alone; nothing to report.
  }
}

/**
 * Reads a clone of the body, up to `max` bytes; null when it is (or declares itself) larger. The clone is taken
 * synchronously, before the first await, so the caller can hand the original on straight away. Throws when the body
 * cannot be cloned or the stream fails.
 */
export async function readLimited(message: Request | Response, max = MAX_REQUEST_BYTES): Promise<LimitedRead> {
  if (declaredLength(message.headers) > max) return null;
  const stream = message.clone().body;
  if (!stream) return { text: '', bytes: 0 };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk, in order.
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), bytes };
      bytes += value.byteLength;
      if (bytes > max) {
        // A clone is a tee branch: its cancel settles only once the other branch is done, so never await it.
        void release(reader);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void release(reader);
    throw error;
  }
}

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Where a wrapper hands its background telemetry work: a `waitUntil` function, the first handler argument with a
 * `waitUntil` method (the Workers `ctx`) when `waitUntil` is `true`, or nowhere. One scheduler per wrapper: it warns
 * once when `true` finds no `ctx`. The returned `schedule` never throws; the work runs (detached) either way and
 * `recorder.flush` never rejects.
 */
export function createScheduler(
  waitUntil: true | WaitUntil | undefined,
  log: Log,
): (args: readonly unknown[]) => (promise: Promise<unknown>) => void {
  let isWarned = false;

  function target(args: readonly unknown[]): WaitUntil | undefined {
    if (typeof waitUntil === 'function') return waitUntil;
    if (waitUntil !== true) return undefined;
    const ctx = args.find((arg): arg is { waitUntil: WaitUntil } => isRecord(arg) && typeof arg.waitUntil === 'function');
    if (ctx) return (promise) => ctx.waitUntil(promise);
    if (!isWarned) {
      isWarned = true;
      log('agent_telemetry_no_waituntil');
    }
    return undefined;
  }

  return (args) => {
    const destination = target(args);
    return (promise) => {
      try {
        destination?.(promise);
      } catch (error) {
        log('agent_telemetry_schedule_failed', { reason: failureReason(error) });
      }
    };
  };
}

export const isEventStream = (response: Response): boolean =>
  (response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body !== null;

/** A handler that throws (rather than returning a protocol error) is recorded as an internal error, on every adapter. */
export const HANDLER_THREW = { nativeCode: 'exception', code: 'internal_error' } as const;

/** An HTTP failure status whose body carries no JSON-RPC error. */
export const httpError = (status: number): { nativeCode: string; code: string } => ({ nativeCode: String(status), code: 'http_error' });
