/**
 * Observes a `text/event-stream` response without buffering it, for every fetch wrapper (A2A and MCP). Chunks pass
 * through unchanged and in order; events are parsed as they flow by a bounded parser, and handed to an observer whose
 * failures never reach the stream.
 *
 * Example: `id: e1\ndata: {"a":1}\n\n` reaches `observer.event({ data: '{"a":1}', id: 'e1' })`, and the stream's end
 * reaches `observer.end('done', 1)`.
 */
import { failureReason, guardLog, type Log } from './http.ts';

/** Longest line, and largest event `data`, the parser holds (in UTF-16 units); larger events are counted, not observed. */
const MAX_EVENT = 4 * 1024 * 1024;

export interface SseEvent {
  /** The event's `data` lines joined with `\n`. */
  data: string;
  /** The last event ID seen on the stream (SSE `id:` persists across events); absent until one is seen. */
  id?: string;
}

/**
 * How a stream ended: `done` (upstream closed), `canceled` (the client went away), `failed` (upstream errored), or
 * `unread` (the response had no body, or a locked one, and was returned untouched).
 */
export type SseEnd = 'done' | 'canceled' | 'failed' | 'unread';

export interface SseObserver {
  /** Each event small enough to keep. */
  event(event: SseEvent): void;
  /** Called exactly once; `events` counts every dispatched event, oversized ones included. */
  end(how: SseEnd, events: number): void;
}

interface SseParser {
  push(text: string): void;
  end(): void;
}

/**
 * An incremental, bounded parser. Lines end in CR, LF or CRLF (a CRLF may span chunks); a blank line ends an event.
 * `onEvent` receives each event, or null when the event was too large to keep.
 */
function sseParser(onEvent: (event: SseEvent | null) => void): SseParser {
  let line = '';
  let isLineOverflow = false;
  let isAfterCR = false;
  let data: string[] = [];
  let dataLength = 0;
  let hasData = false;
  let isOversized = false;
  let lastEventId: string | undefined;

  const dispatch = () => {
    if (!hasData && !isOversized) return;
    const event = isOversized ? null : { data: data.join('\n'), ...(lastEventId !== undefined ? { id: lastEventId } : {}) };
    data = [];
    dataLength = 0;
    hasData = false;
    isOversized = false;
    onEvent(event);
  };

  const field = (text: string) => {
    if (text === '') return dispatch();
    const colon = text.indexOf(':');
    const name = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(text[colon + 1] === ' ' ? colon + 2 : colon + 1);
    // An id containing NULL is ignored, as in the SSE spec; an empty one resets the last event ID.
    if (name === 'id' && !value.includes('\0')) lastEventId = value;
    if (name !== 'data') return;
    hasData = true;
    if (isOversized) return;
    dataLength += value.length + 1;
    if (dataLength > MAX_EVENT) {
      isOversized = true;
      data = [];
    } else data.push(value);
  };

  const append = (fragment: string) => {
    if (isLineOverflow) return;
    if (line.length + fragment.length <= MAX_EVENT) {
      line += fragment;
      return;
    }
    // Only a `data` field makes the event oversized (a bare `data` line is never long); other long fields are ignored.
    if ((line + fragment.slice(0, 5)).startsWith('data:')) {
      hasData = true;
      isOversized = true;
      data = [];
    }
    line = '';
    isLineOverflow = true;
  };

  const endLine = () => {
    const text = line;
    line = '';
    if (isLineOverflow) isLineOverflow = false;
    else field(text);
  };

  return {
    push(text) {
      const eol = /[\r\n]/g;
      if (isAfterCR && text.startsWith('\n')) eol.lastIndex = 1;
      if (text) isAfterCR = false;
      let start = eol.lastIndex;
      for (let match = eol.exec(text); match; match = eol.exec(text)) {
        append(text.slice(start, match.index));
        endLine();
        if (match[0] === '\r') {
          if (match.index + 1 === text.length) isAfterCR = true;
          else if (text[match.index + 1] === '\n') eol.lastIndex = match.index + 2;
        }
        start = eol.lastIndex;
      }
      append(text.slice(start));
    },
    end() {
      if (line || isLineOverflow) endLine();
      dispatch();
    },
  };
}

async function release(
  source: ReadableStream<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  cancelReason: unknown,
): Promise<void> {
  try {
    await (reader ?? source).cancel(cancelReason);
  } catch {
    // The client has gone; there is no one left to tell.
  }
}

/**
 * Returns a response with the same status, status text and headers whose body yields the upstream chunks unchanged and
 * in order. Upstream is read only when the client asks for data. Observer failures are contained per event, so one
 * never stops the parser mid-chunk; the first failure in a stream is logged, the rest would only repeat it.
 */
export function observeSse(response: Response, observer: SseObserver, hostLog: Log = () => {}): Response {
  const log = guardLog(hostLog);
  let isLogged = false;
  const safely = (work: () => void) => {
    try {
      work();
    } catch (error) {
      if (isLogged) return;
      isLogged = true;
      log('agent_telemetry_event_failed', { reason: failureReason(error) });
    }
  };

  let events = 0;
  let isEnded = false;
  const end = (how: SseEnd) => {
    if (isEnded) return;
    isEnded = true;
    safely(() => observer.end(how, events));
  };

  const source = response.body;
  if (!source || source.locked) {
    end('unread');
    return response;
  }

  const parser = sseParser((event) => {
    events++;
    if (event !== null) safely(() => observer.event(event));
  });
  const decoder = new TextDecoder();
  let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let isCanceled = false;

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          upstream ??= source.getReader();
          chunk = await upstream.read();
        } catch (error) {
          if (isCanceled) return;
          end('failed');
          controller.error(error);
          return;
        }
        if (isCanceled) return;
        if (chunk.done) {
          safely(() => {
            parser.push(decoder.decode());
            parser.end();
          });
          end('done');
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
        safely(() => parser.push(decoder.decode(chunk.value, { stream: true })));
      },
      cancel(cancelReason) {
        isCanceled = true;
        end('canceled');
        // Never awaited: a tee'd upstream settles its cancel only once its sibling is done too.
        void release(source, upstream, cancelReason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
