import { describe, expect, it } from 'vitest';
import { createRecorder } from '../src/index';
import { Lru, recorderState } from '../src/state';

const recorder = () =>
  createRecorder({ key: 'ak_test_x', fetch: (async () => new Response(null, { status: 202 })) as typeof fetch, flushIntervalMs: 0 });

describe('recorderState', () => {
  it('dedupes task states per recorder and protocol and links tasks to operations', () => {
    const first = recorder();
    const state = recorderState(first, 'a2a');
    expect(recorderState(first, 'a2a')).toBe(state);
    expect(recorderState(first, 'mcp')).not.toBe(state);
    expect(recorderState(recorder(), 'a2a')).not.toBe(state);
    expect(state.taskChanged('t1', 'working')).toBe(true);
    expect(state.taskChanged('t1', 'working')).toBe(false);
    expect(recorderState(first, 'mcp').taskChanged('t1', 'working')).toBe(true);
    expect(state.taskChanged('t1', 'completed')).toBe(true);
    const op = first.startOperation({
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
    });
    state.linkTask('t1', op);
    expect(state.operationFor('t1')).toBe(op);
    expect(state.operationFor('t2')).toBeUndefined();
    expect(recorderState(first, 'mcp').operationFor('t1')).toBeUndefined();
  });

  it('evicts the least recently used entries beyond 10,000', () => {
    const state = recorderState(recorder(), 'mcp');
    for (let index = 0; index <= 10_000; index++) state.taskChanged(`t${index}`, 'working');
    expect(state.taskChanged('t0', 'working')).toBe(true);
    expect(state.taskChanged('t10000', 'working')).toBe(false);
  });
});

describe('Lru', () => {
  it('keeps recently read keys, honours its limit and deletes', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.size).toBe(2);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    expect(lru.size).toBe(1);
  });

  it('defaults to 10,000 entries', () => {
    const lru = new Lru<number>();
    for (let index = 0; index <= 10_000; index++) lru.set(`k${index}`, index);
    expect(lru.size).toBe(10_000);
    expect(lru.get('k0')).toBeUndefined();
  });
});

describe('recorderState bounds', () => {
  const start = (rec: ReturnType<typeof recorder>) =>
    rec.startOperation({
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
    });

  it('evicts the least recently used task links beyond 10,000', () => {
    const rec = recorder();
    const state = recorderState(rec, 'a2a');
    const op = start(rec);
    for (let index = 0; index <= 10_000; index++) state.linkTask(`t${index}`, op);
    expect(state.operationFor('t0')).toBeUndefined();
    expect(state.operationFor('t10000')).toBe(op);
  });

  it('never stores ids longer than 256 characters', () => {
    const rec = recorder();
    const state = recorderState(rec, 'a2a');
    const long = 'x'.repeat(300);
    expect(state.taskChanged(long, 'working')).toBe(true);
    expect(state.taskChanged(long, 'working')).toBe(true);
    state.linkTask(long, start(rec));
    expect(state.operationFor(long)).toBeUndefined();
  });
});

describe('recorderState directions', () => {
  it('keeps outbound state apart from inbound state on the same recorder', () => {
    const rec = recorder();
    const inbound = recorderState(rec, 'a2a');
    const outbound = recorderState(rec, 'a2a', 'outbound');
    expect(recorderState(rec, 'a2a', 'inbound')).toBe(inbound);
    expect(recorderState(rec, 'a2a', 'outbound')).toBe(outbound);
    expect(recorderState(rec, 'mcp', 'outbound')).not.toBe(outbound);
    expect(outbound).not.toBe(inbound);
    expect(inbound.taskChanged('t1', 'completed')).toBe(true);
    expect(outbound.taskChanged('t1', 'completed')).toBe(true);
    expect(outbound.taskChanged('t1', 'completed')).toBe(false);
  });
});

describe('Lru eviction', () => {
  it('hands the evicted entry to onEvict, never a replaced or deleted one', () => {
    const evicted: [string, number][] = [];
    const lru = new Lru<number>(2, (key, value) => void evicted.push([key, value]));
    lru.set('a', 1);
    lru.set('a', 2);
    lru.set('b', 3);
    lru.delete('b');
    lru.set('c', 4);
    lru.set('d', 5);
    expect(evicted).toEqual([['a', 2]]);
  });
});
