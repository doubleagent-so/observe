/**
 * Internal: the recorder's delivery. Holds the bounded buffer, validates every event at capture, and sends batches
 * with retries, backoff and `Retry-After`, keeping event IDs so the server deduplicates retries. Never throws.
 *
 * Each flush takes the buffer it finds and sends it with its own requests, so no flush ever awaits a promise another
 * flush created. On Workers a recorder lives for the isolate while each flush runs in one request's `waitUntil`, and a
 * promise created in one request and settled in another triggers cross-request warnings or never settles.
 */
import { LIMITS, utf8Bytes, type AgentEvent } from './contract.ts';
import { failureReason, type Log } from './http.ts';
import { isRecord } from './patterns.ts';
import type { RecorderStats } from './recorder.ts';
import { validateEvent } from './validate.ts';

/** A built event with its serialized size, so batching never re-serializes. */
interface Queued {
  event: AgentEvent;
  size: number;
}

/**
 * An event whose last asynchronous step (hashing the authenticated subject) runs in the flush that sends it. `probe`
 * is the event as it will be sent, with a placeholder hash, so it is validated at capture like every other event.
 */
export interface Deferred {
  probe: AgentEvent;
  complete: () => Promise<AgentEvent>;
}

/** `poison`: the batch no longer serializes (the host changed an object an event holds by reference). */
type Attempt = 'sent' | 'retry' | 'refused' | 'stopped' | 'poison';

export interface DeliveryOptions {
  /** The ingest URL; already checked to be `https://` (or loopback `http://`). */
  url: string;
  key: string;
  adapter: string;
  fetcher: typeof fetch;
  now: () => number;
  maxBuffer: number;
  timeoutMs: number;
  /** Already guarded: it never throws. */
  log: Log;
}

const MAX_BACKOFF_MS = 60_000;
const SHUTDOWN_POLL_MS = 10;
/** An unforced flush sleeps through a backoff this short instead of skipping it (Workers have no timer to retry). */
const MAX_FLUSH_WAIT_MS = 5_000;
/** The longest `Retry-After` honoured. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** A rejection code as the API sends it; anything else in a rejection is not logged. */
const REJECTION_CODE = /^[a-z_]{1,64}$/;
const MAX_LOGGED_CODES = 16;

/** Cancels a response body the recorder does not read. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored: nothing is held open.
  }
}

/** How long a `Retry-After` (seconds or an HTTP date) asks to wait, capped; 1 s when absent or unreadable. */
function retryAfterMs(header: string | null, nowMs: number): number {
  if (!header?.trim()) return 1000;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 1000;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const serialize = (event: AgentEvent): Queued => ({ event, size: utf8Bytes(JSON.stringify(event)) + 1 });

/** Up to 100 events and about 1 MiB, from the front of the queue. */
function batchLength(queue: Queued[]): number {
  let count = 0;
  let bytes = 256;
  for (const queued of queue) {
    if (count === LIMITS.batchEvents || (count && bytes + queued.size > LIMITS.batchBytes)) break;
    count++;
    bytes += queued.size;
  }
  return count;
}

export class Delivery {
  readonly #options: DeliveryOptions;
  #buffer: Array<Queued | Deferred> = [];
  /**
   * Events taken by flushes that have not finished. They count toward the buffer bound, so memory stays bounded: while
   * a flush is in flight, a full buffer drops its oldest events (the new event itself when nothing else is buffered).
   * Every drop is counted in `stats().dropped` and reported to the server with the next batch.
   */
  #inflight = 0;
  #flushing = 0;
  #dropped = 0;
  #unreported = 0;
  #sent = 0;
  #rejected = 0;
  #isDisabled = false;
  #isClosed = false;
  #failures = 0;
  #nextAttemptAt = 0;
  /** The kind of the last failed send (`status:503`, `reason:TypeError`); '' after a success. */
  #lastFailure = '';
  /** Rejection codes already logged for events dropped at capture: each is logged once. */
  readonly #loggedInvalidCodes = new Set<string>();
  #isLateEventLogged = false;

  constructor(options: DeliveryOptions) {
    this.#options = options;
  }

  get isDisabled(): boolean {
    return this.#isDisabled;
  }

  /** Stops sending for good and drops what is buffered; logged with `reason`. */
  disable(reason: string): void {
    this.#isDisabled = true;
    this.#buffer = [];
    this.#options.log('agent_telemetry_disabled', { reason });
  }

  stats(): RecorderStats {
    return {
      buffered: this.#buffer.length + this.#inflight,
      dropped: this.#dropped,
      sent: this.#sent,
      rejected: this.#rejected,
      disabled: this.#isDisabled,
    };
  }

  /**
   * Builds, validates and serializes the event now. An event the server would reject (bad host or peer input) is
   * logged with its rejection code and dropped here, so it never costs the rest of its batch. Blocks the host passed in
   * (`custom`, `a2a`, `mcp`) are held by reference, so a later change to them can still reach the server; one that
   * makes the event unserializable drops it at send time.
   */
  push(build: () => AgentEvent | Deferred): boolean {
    if (this.#isDisabled) return false;
    if (this.#isClosed) {
      this.#dropLate();
      return false;
    }
    try {
      const built = build();
      const event = 'complete' in built ? built.probe : built;
      const result = validateEvent(event, this.#options.now());
      if (!result.ok) {
        if (!this.#loggedInvalidCodes.has(result.code)) {
          this.#loggedInvalidCodes.add(result.code);
          this.#options.log('agent_telemetry_invalid_event', { type: event.type, code: result.code });
        }
        this.drop();
        return false;
      }
      this.#buffer.push('complete' in built ? built : serialize(built));
    } catch (error) {
      this.#logFailure(error);
      this.drop();
      return false;
    }
    this.#overflow();
    return true;
  }

  /** Counts an event lost before sending; the count is reported to the server with the next batch. */
  drop(): void {
    this.#dropped++;
    this.#unreported++;
  }

  /** An event of an operation that was never recorded (its started event was dropped): counted, never sent. */
  dropOrphan(): void {
    if (this.#isDisabled) return;
    if (this.#isClosed) this.#dropLate();
    else this.drop();
  }

  /**
   * One flush. Unforced, it honours the backoff; with `wait` (an explicit `flush()`), it sleeps through a backoff of
   * `MAX_FLUSH_WAIT_MS` or less and then makes one attempt, so a Worker flushing in `waitUntil` still delivers.
   */
  async flush(force: boolean, wait = false): Promise<void> {
    if (this.#isDisabled || !this.#buffer.length) return;
    if (!force) {
      const remaining = this.#nextAttemptAt - this.#options.now();
      if (remaining > 0) {
        if (!wait || remaining > MAX_FLUSH_WAIT_MS) return;
        await sleep(remaining);
        // The backoff this flush waited out is over; another flush may have sent everything meanwhile.
        force = true;
        if (this.#isDisabled || !this.#buffer.length) return;
      }
    }
    await this.#flushTaken(force);
  }

  /** Flushes (forced), waits for flushes in flight, then makes the last attempt; later events are dropped. */
  async shutdown(): Promise<void> {
    await this.flush(true);
    await this.#settle();
    // The last attempt: closed first, so whatever it cannot send is counted and logged as dropped, not stranded.
    this.#isClosed = true;
    // Sends what a flush that was in flight put back.
    await this.flush(true);
  }

  /** Takes the buffer and delivers it; what is left goes back in front of the buffer (or is dropped after shutdown). */
  async #flushTaken(force: boolean): Promise<void> {
    const taken = this.#buffer;
    this.#buffer = [];
    this.#inflight += taken.length;
    this.#flushing++;
    let queue: Queued[] = [];
    try {
      queue = await this.#prepare(taken);
      await this.#deliver(queue, force);
    } catch (error) {
      this.#options.log('agent_telemetry_flush_failed', { reason: failureReason(error) });
    } finally {
      this.#inflight -= taken.length;
      this.#flushing--;
      if (queue.length && !this.#isDisabled) {
        if (this.#isClosed) {
          // Closed by shutdown (its last attempt, or a flush it stopped waiting for): nothing will send these again.
          this.#dropped += queue.length;
          this.#options.log('agent_telemetry_dropped_after_shutdown', { events: queue.length });
        } else {
          this.#buffer = [...queue, ...this.#buffer];
          this.#overflow();
        }
      }
    }
  }

  #logFailure(error: unknown): void {
    this.#options.log('agent_telemetry_event_failed', { reason: failureReason(error) });
  }

  /** Drops the oldest buffered events beyond the bound (events in flight included); in-flight events stay. */
  #overflow(): void {
    const excess = Math.min(this.#buffer.length, this.#buffer.length + this.#inflight - this.#options.maxBuffer);
    if (excess <= 0) return;
    this.#buffer.splice(0, excess);
    this.#dropped += excess;
    this.#unreported += excess;
  }

  /** An event recorded after shutdown: counted (nothing will report it) and logged once. */
  #dropLate(): void {
    this.#dropped++;
    if (this.#isLateEventLogged) return;
    this.#isLateEventLogged = true;
    this.#options.log('agent_telemetry_dropped_after_shutdown', { events: 1, reason: 'recorded after shutdown' });
  }

  /** Completes deferred events in this flush; one that fails is logged and dropped. */
  async #prepare(entries: Array<Queued | Deferred>): Promise<Queued[]> {
    const queue: Queued[] = [];
    for (const entry of entries) {
      if (!('complete' in entry)) {
        queue.push(entry);
        continue;
      }
      try {
        // Sequential on purpose: each digest is microseconds, and order is preserved.
        // eslint-disable-next-line no-await-in-loop
        queue.push(serialize(await entry.complete()));
      } catch (error) {
        this.#logFailure(error);
        this.drop();
      }
    }
    return queue;
  }

  /** Sends the queue batch by batch, removing what the server took; what is left is for a later flush. */
  async #deliver(queue: Queued[], force: boolean): Promise<void> {
    while (queue.length && !this.#isDisabled) {
      if (!force && this.#options.now() < this.#nextAttemptAt) return;
      const count = batchLength(queue);
      // Batches go one at a time: a failure stops the flush and keeps the rest in order.
      // eslint-disable-next-line no-await-in-loop
      const attempt = await this.#post(queue.slice(0, count).map((queued) => queued.event));
      if (attempt === 'poison') {
        this.#discardUnserializable(queue, count);
        continue;
      }
      if (attempt === 'retry') {
        this.#failures++;
        const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.#failures - 1)) * (0.5 + Math.random() / 2);
        this.#nextAttemptAt = Math.max(this.#nextAttemptAt, this.#options.now() + backoff);
        return;
      }
      queue.splice(0, count);
      this.#failures = 0;
      this.#nextAttemptAt = 0;
      this.#settleAttempt(attempt, count);
    }
  }

  /** After a batch left the queue: a refused batch is counted as dropped; a stopped one disables delivery. */
  #settleAttempt(attempt: Attempt, count: number): void {
    if (attempt === 'refused') {
      // The server will never take these events: counted as dropped and reported with the next batch.
      this.#dropped += count;
      this.#unreported += count;
      this.#options.log('agent_telemetry_batch_refused', { events: count });
    }
    if (attempt === 'stopped') this.disable('credential refused or source deleted');
  }

  /** Sends one batch. The drop count is claimed for the request, so overlapping flushes never report it twice. */
  async #post(events: AgentEvent[]): Promise<Attempt> {
    const reported = this.#unreported;
    let body: string;
    try {
      body = JSON.stringify({ adapter: this.#options.adapter, dropped: reported, events });
    } catch {
      return 'poison';
    }
    this.#unreported = 0;
    let attempt: Attempt = 'retry';
    try {
      attempt = await this.#send(events, body);
      return attempt;
    } finally {
      if (attempt !== 'sent') this.#unreported += reported;
    }
  }

  async #send(events: AgentEvent[], body: string): Promise<Attempt> {
    const { url, key, fetcher, timeoutMs, now } = this.#options;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.#noteFailure({ reason: failureReason(error) });
      return 'retry';
    }
    if (response.status >= 200 && response.status < 300) {
      this.#lastFailure = '';
      await this.#noteAccepted(response, events.length);
      return 'sent';
    }
    this.#noteFailure({ status: response.status });
    // Unread bodies hold the connection open (and count against Workers' concurrent connections).
    await discardBody(response);
    if (response.status === 401 || response.status === 403 || response.status === 410) return 'stopped';
    if (response.status === 429) {
      this.#nextAttemptAt = now() + retryAfterMs(response.headers.get('retry-after'), now());
      return 'retry';
    }
    if (response.status >= 400 && response.status < 500) return 'refused';
    return 'retry';
  }

  /** Logs a failed send the first time, and again only when its kind (status or error) changes or after a success. */
  #noteFailure(failure: { status: number } | { reason: string }): void {
    const kind = 'status' in failure ? `status:${failure.status}` : `reason:${failure.reason}`;
    if (kind === this.#lastFailure) return;
    this.#lastFailure = kind;
    this.#options.log('agent_telemetry_send_failed', failure);
  }

  /** Counts what the server took, and logs the codes of the events it rejected (codes only, deduplicated). */
  async #noteAccepted(response: Response, events: number): Promise<void> {
    let answer: { accepted?: unknown; rejected?: unknown };
    try {
      answer = (await response.json()) as typeof answer;
    } catch {
      // A 2xx without a JSON answer (204, or a proxy's page): the batch was taken whole.
      this.#sent += events;
      return;
    }
    this.#sent += typeof answer?.accepted === 'number' ? answer.accepted : events;
    const list = Array.isArray(answer?.rejected) ? (answer.rejected as unknown[]) : [];
    if (!list.length) return;
    this.#rejected += list.length;
    const codes = new Set<string>();
    for (const entry of list) {
      const code = isRecord(entry) ? entry.code : undefined;
      if (typeof code === 'string' && REJECTION_CODE.test(code) && codes.size < MAX_LOGGED_CODES) codes.add(code);
    }
    this.#options.log('agent_telemetry_events_rejected', { events: list.length, codes: [...codes] });
  }

  /** Drops the events of a batch that no longer serialize, or the whole batch when none fails alone. */
  #discardUnserializable(queue: Queued[], count: number): void {
    let removed = 0;
    for (let index = count - 1; index >= 0; index--) {
      try {
        JSON.stringify(queue[index].event);
      } catch (error) {
        queue.splice(index, 1);
        removed++;
        this.#logFailure(error);
      }
    }
    if (!removed) {
      queue.splice(0, count);
      removed = count;
      this.#options.log('agent_telemetry_event_failed', { reason: 'unserializable batch' });
    }
    this.#dropped += removed;
    this.#unreported += removed;
  }

  /** Waits for other flushes by polling: awaiting their promises could cross Workers request contexts. */
  async #settle(): Promise<void> {
    const deadline = Date.now() + this.#options.timeoutMs + 1000;
    while (this.#flushing && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(SHUTDOWN_POLL_MS);
    }
  }
}
