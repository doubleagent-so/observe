import { describe, expect, it, vi } from 'vitest';
import { observeSse, type SseEnd, type SseEvent } from '../src/sse';

const encoder = new TextEncoder();

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function collector() {
  const events: SseEvent[] = [];
  const ends: [SseEnd, number][] = [];
  return {
    events,
    ends,
    observer: {
      event: (event: SseEvent) => void events.push(event),
      end: (how: SseEnd, count: number) => void ends.push([how, count]),
    },
  };
}

describe('observeSse', () => {
  it('passes bytes through unchanged while parsing ids, multi-line data and CRLF across chunk splits', async () => {
    const body = 'id: e1\r\nevent: message\r\ndata: {"a":"é✓"}\r\n\r\n: comment\n\ndata: line one\ndata: line two\n\ndata\n\n';
    const { events, ends, observer } = collector();
    const response = observeSse(
      new Response(chunked(body, 3), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-keep': '1' } }),
      observer,
    );
    expect(response.headers.get('x-keep')).toBe('1');
    expect(await response.text()).toBe(body);
    expect(events).toEqual([
      { data: '{"a":"é✓"}', id: 'e1' },
      { data: 'line one\nline two', id: 'e1' },
      { data: '', id: 'e1' },
    ]);
    expect(ends).toEqual([['done', 3]]);
  });

  it('parses CR line endings, a final event without a blank line, and resets or ignores ids', async () => {
    const body = 'data: a\r\rid\rdata: b\n\nid: x\0y\ndata: c';
    const { events, ends, observer } = collector();
    expect(await observeSse(new Response(chunked(body, 1)), observer).text()).toBe(body);
    expect(events).toEqual([{ data: 'a' }, { data: 'b', id: '' }, { data: 'c', id: '' }]);
    expect(ends).toEqual([['done', 3]]);
  });

  it('counts an oversized event without observing it, and only a data line makes one oversized', async () => {
    const big = 'y'.repeat(5 * 1024 * 1024);
    const body = `data: ${big}\n\ndataset: ${big}\ndata: kept\n\n`;
    const { events, ends, observer } = collector();
    await observeSse(new Response(chunked(body, 64 * 1024)), observer).text();
    expect(events).toEqual([{ data: 'kept' }]);
    expect(ends).toEqual([['done', 2]]);
  });

  it('reports a client cancel once and cancels upstream', async () => {
    let canceled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: 1\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const { ends, observer } = collector();
    const reader = observeSse(new Response(upstream), observer).body!.getReader();
    await reader.read();
    await reader.cancel('gone');
    expect(canceled).toBe(true);
    expect(ends).toEqual([['canceled', 1]]);
  });

  it('reports an upstream failure and errors the client stream', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream died'));
      },
    });
    const { ends, observer } = collector();
    await expect(observeSse(new Response(upstream), observer).text()).rejects.toThrow('upstream died');
    expect(ends).toEqual([['failed', 0]]);
  });

  it('returns a response without a readable body untouched', () => {
    const locked = new Response('data: 1\n\n');
    locked.body!.getReader();
    const empty = new Response(null);
    const { ends, observer } = collector();
    expect(observeSse(locked, observer)).toBe(locked);
    expect(observeSse(empty, observer)).toBe(empty);
    expect(ends).toEqual([
      ['unread', 0],
      ['unread', 0],
    ]);
  });

  it('keeps streaming when the observer throws, and logs the first failure only', async () => {
    const body = 'data: 1\n\ndata: 2\n\n';
    const log = vi.fn();
    const response = observeSse(
      new Response(chunked(body, 4)),
      {
        event() {
          throw new Error('observer bug');
        },
        end() {
          throw new Error('observer bug');
        },
      },
      log,
    );
    expect(await response.text()).toBe(body);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('agent_telemetry_event_failed', { reason: 'Error' });
  });
});
