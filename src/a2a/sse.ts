/** A2A SSE streams: each event's JSON-RPC result is observed as it passes; an error event finishes `protocol_error`. */
import type { FinishInput, OperationHandle } from '../recorder.ts';
import { observeSse, type SseEnd } from '../sse.ts';
import type { RecorderState } from '../state.ts';
import { a2aError } from './mapping.ts';
import { observeResult } from './observe.ts';
import { isRecord, type Log } from './util.ts';

/** How the stream's end finishes the operation. A response returned unread is finished without an event count. */
function finishFor(how: SseEnd, events: number, protocolError: FinishInput['error'] | null): FinishInput {
  if (how === 'unread') return { outcome: 'ok' };
  if (how !== 'done') return { outcome: 'transport_error', streamEvents: events };
  return protocolError
    ? { outcome: 'protocol_error', streamEvents: events, error: protocolError }
    : { outcome: 'ok', streamEvents: events };
}

/**
 * Returns a response with the same status, status text and headers whose body yields the upstream chunks unchanged and
 * in order, recording each event's result as it passes, then handing it to `onResult`. Telemetry failures are logged
 * (once per stream) and never reach the stream.
 */
export function observeStream(
  response: Response,
  op: OperationHandle,
  state: RecorderState,
  flush: () => void,
  log: Log = () => {},
  onResult: (result: unknown) => void = () => {},
): Response {
  let protocolError: FinishInput['error'] | null = null;
  return observeSse(
    response,
    {
      event({ data }) {
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          return; // Not JSON: counted, not observed.
        }
        if (!isRecord(message)) return;
        if (message.error !== undefined) {
          protocolError = a2aError(message.error);
          return;
        }
        observeResult(op, state, message.result);
        onResult(message.result);
      },
      end(how, events) {
        try {
          op.finish(finishFor(how, events, protocolError));
        } finally {
          flush();
        }
      },
    },
    log,
  );
}
