import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  createScheduler,
  declaredLength,
  failureReason,
  isEventStream,
  JSON_TYPE,
  readLimited,
} from '../src/http';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://x.example/', {
    method: 'POST',
    body,
    headers,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);

const bytes = (...sizes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });

describe('readLimited', () => {
  it('reads a clone and leaves the original body for the handler', async () => {
    const request = post('{"a":"é"}');
    expect(await readLimited(request)).toEqual({ text: '{"a":"é"}', bytes: 10 });
    expect(await request.text()).toBe('{"a":"é"}');
    const response = Response.json({ ok: true });
    expect(await readLimited(response, MAX_RESPONSE_BYTES)).toEqual({ text: '{"ok":true}', bytes: 11 });
    expect(await response.json()).toEqual({ ok: true });
  });

  it('refuses bodies over the limit by declared length or by streamed bytes', async () => {
    expect(await readLimited(post('x'.repeat(11), { 'content-length': '11' }), 10)).toBeNull();
    expect(await readLimited(post(bytes(6, 6)), 10)).toBeNull();
    expect(await readLimited(post(bytes(5, 5)), 10)).toEqual({ text: expect.any(String), bytes: 10 });
    expect(await readLimited(new Request('https://x.example/'))).toEqual({ text: '', bytes: 0 });
    expect(MAX_REQUEST_BYTES).toBe(1024 * 1024);
    expect(MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  it('rethrows a failing stream', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('broken'));
      },
    });
    await expect(readLimited(post(failing))).rejects.toThrow('broken');
  });
});

describe('declaredLength', () => {
  it('reads content-length, treating absent or malformed values as 0', () => {
    expect(declaredLength(new Headers({ 'content-length': '42' }))).toBe(42);
    expect(declaredLength(new Headers({ 'content-length': 'lots' }))).toBe(0);
    expect(declaredLength(new Headers())).toBe(0);
  });
});

describe('createScheduler', () => {
  it('uses a function, a ctx argument, or nothing, and warns once when the ctx is missing', () => {
    const seen: Promise<unknown>[] = [];
    const logged: string[] = [];
    const log = (event: string) => void logged.push(event);
    const work = Promise.resolve(1);
    createScheduler((promise) => void seen.push(promise), log)([])(work);
    const fromContext = createScheduler(true, log);
    fromContext([{}, { waitUntil: (promise: Promise<unknown>) => void seen.push(promise) }])(work);
    fromContext([{}])(work);
    fromContext([{}])(work);
    createScheduler(undefined, log)([])(work);
    expect(seen).toEqual([work, work]);
    expect(logged).toEqual(['agent_telemetry_no_waituntil']);
  });

  it('logs and swallows a throwing waitUntil', () => {
    const logged: [string, unknown][] = [];
    const schedule = createScheduler(
      () => {
        throw new RangeError('closed');
      },
      (event, fields) => void logged.push([event, fields]),
    )([]);
    expect(() => schedule(Promise.resolve())).not.toThrow();
    expect(logged).toEqual([['agent_telemetry_schedule_failed', { reason: 'RangeError' }]]);
  });
});

describe('small helpers', () => {
  it('recognizes JSON and SSE content and names failures', () => {
    expect(JSON_TYPE.test('application/json; charset=utf-8')).toBe(true);
    expect(JSON_TYPE.test('application/vnd.api+json')).toBe(true);
    expect(JSON_TYPE.test('text/plain')).toBe(false);
    expect(isEventStream(new Response('x', { headers: { 'content-type': 'text/event-stream' } }))).toBe(true);
    expect(isEventStream(new Response(null, { headers: { 'content-type': 'text/event-stream' } }))).toBe(false);
    expect(isEventStream(new Response('x'))).toBe(false);
    expect(failureReason(new TypeError('x'))).toBe('TypeError');
    expect(failureReason('x')).toBe('unknown');
  });
});
