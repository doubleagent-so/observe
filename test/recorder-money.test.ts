import { describe, expect, it } from 'vitest';
import { createRecorder, LIMITS, validateBatch, type EventBatch, type Recorder, type RecorderOptions } from '../src/index';

// NOW, A2A, endpoint(), accepted() and recorder() are copied from recorder.test.ts.
const NOW = Date.UTC(2026, 9, 1, 12);
const A2A = { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' } as const;

function endpoint(respond: (batch: EventBatch, call: number) => Response | Promise<Response>) {
  const batches: EventBatch[] = [];
  const inits: RequestInit[] = [];
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    urls.push(String(input));
    inits.push(init);
    const batch = JSON.parse(String(init.body)) as EventBatch;
    batches.push(batch);
    return respond(batch, batches.length);
  }) as typeof globalThis.fetch;
  return { fetch, batches, inits, urls };
}
const accepted = (batch: EventBatch) => Response.json({ accepted: batch.events.length, content_dropped: 0, rejected: [] }, { status: 202 });

function recorder(fetch: typeof globalThis.fetch, options: Partial<RecorderOptions> = {}) {
  let now = NOW;
  const logs: string[] = [];
  const instance = createRecorder({
    key: 'ak_test_x',
    endpoint: 'https://api.test/',
    fetch,
    now: () => now,
    flushIntervalMs: 0,
    log: (event) => logs.push(event),
    ...options,
  });
  return {
    instance,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const start = (instance: Recorder, taskRef?: string) =>
  instance.startOperation({ protocol: A2A, direction: 'inbound', method: 'SendMessage', kind: 'message', ...(taskRef ? { taskRef } : {}) });

const pending = { amount: 1, currency: 'USD', method: 'card', status: 'pending', basis: 'reported' } as const;

describe('recorder money', () => {
  it('records costs and charges on the operation, linked to its task', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = start(instance, 'task-1');
    op.cost({
      category: 'model',
      amountMicros: 4_200,
      currency: 'USD',
      basis: 'estimated',
      usage: { model: 'claude-x', input_tokens: 1200, output_tokens: 300 },
    });
    const transactionId = op.charge({
      amount: 500,
      currency: 'USDC',
      method: 'x402',
      network: 'base',
      status: 'settled',
      basis: 'reported',
      externalRef: '0xabc',
    });
    op.finish({ outcome: 'ok' });
    await instance.flush();
    const events = server.batches[0].events;
    expect(events.map((event) => event.type)).toEqual(['operation.started', 'cost.recorded', 'transaction.recorded', 'operation.finished']);
    expect(events[1]).toMatchObject({ operation_id: op.operationId, task_ref: 'task-1', category: 'model', amount_micros: 4_200 });
    expect(events[2]).toMatchObject({
      operation_id: op.operationId,
      task_ref: 'task-1',
      transaction_id: transactionId,
      kind: 'charge',
      currency: 'USDC',
      external_ref: '0xabc',
    });
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });

  it('lets a charge name another task and keeps a caller-supplied transaction ID', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = start(instance);
    const given = '01J00000000000000000000077';
    expect(op.charge({ ...pending, taskRef: 'task-2', transactionId: given })).toBe(given);
    await instance.flush();
    expect(server.batches[0].events[1]).toMatchObject({ task_ref: 'task-2', transaction_id: given });
  });

  it(`caps costs at ${LIMITS.costsPerOperation} per operation, logs once per operation and counts every extra as dropped`, async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const op = start(instance);
    for (let index = 0; index < LIMITS.costsPerOperation + 3; index++) {
      op.cost({ category: 'tool', amountMicros: 1, currency: 'USD', basis: 'reported' });
    }
    expect(logs.filter((event) => event === 'agent_telemetry_cost_limit')).toHaveLength(1);
    expect(instance.stats().dropped).toBe(3);
    const other = start(instance);
    for (let index = 0; index < LIMITS.costsPerOperation + 1; index++) {
      other.cost({ category: 'tool', amountMicros: 1, currency: 'USD', basis: 'reported' });
    }
    expect(logs.filter((event) => event === 'agent_telemetry_cost_limit')).toHaveLength(2);
    await instance.flush();
    const [batch] = server.batches;
    expect(batch.events.filter((event) => event.type === 'cost.recorded' && event.operation_id === op.operationId)).toHaveLength(
      LIMITS.costsPerOperation,
    );
    expect(batch.dropped).toBe(4); // reported to the server like every other drop
    expect(instance.stats().dropped).toBe(4);
  });

  it('does not count a dropped cost toward the cap', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const op = start(instance);
    op.cost({ category: 'tool', amountMicros: -1, currency: 'USD', basis: 'reported' });
    for (let index = 0; index < LIMITS.costsPerOperation; index++) {
      op.cost({ category: 'tool', amountMicros: 1, currency: 'USD', basis: 'reported' });
    }
    await instance.flush();
    expect(server.batches[0].events.filter((event) => event.type === 'cost.recorded')).toHaveLength(LIMITS.costsPerOperation);
  });

  it('drops invalid money input with a log instead of throwing or sending it', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const op = start(instance);
    expect(() => op.charge({ amount: 1.5, currency: 'USD', method: 'card', status: 'settled', basis: 'settled' })).not.toThrow();
    expect(() => op.cost({ category: 'model', amountMicros: 1, currency: 'usd', basis: 'estimated' })).not.toThrow();
    expect(() => op.cost({ category: 'model', currency: 'USD', basis: 'estimated' })).not.toThrow(); // no amount
    expect(op.charge({ ...pending, taskRef: 'not a native id' })).toBe('');
    await instance.flush();
    expect(server.batches[0].events.map((event) => event.type)).toEqual(['operation.started']);
    // Logged once per rejection code (invalid_amount twice), and every drop is counted and reported.
    expect(logs.filter((event) => event === 'agent_telemetry_invalid_event')).toHaveLength(3);
    expect(instance.stats().dropped).toBe(4);
    expect(server.batches[0].dropped).toBe(4);
  });

  it('sends amounts at the limits and drops amounts just over them', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    const op = start(instance, 'task-1');
    const cost = { category: 'compute', currency: 'USD', basis: 'reported' } as const;
    expect(op.charge({ ...pending, amount: LIMITS.maxAmount })).not.toBe('');
    expect(op.charge({ ...pending, kind: 'refund', amount: -LIMITS.maxAmount })).not.toBe('');
    expect(op.charge({ ...pending, amount: LIMITS.maxAmount + 1 })).toBe('');
    expect(op.charge({ ...pending, kind: 'refund', amount: -LIMITS.maxAmount - 1 })).toBe('');
    op.cost({ ...cost, amountMicros: LIMITS.maxMicros });
    op.cost({ ...cost, amountMicros: LIMITS.maxMicros + 1 });
    op.cost({ ...cost, amount: '999999999.999999' }); // the largest decimal amount toMicros takes
    op.cost({ ...cost, amount: '1000000000' }); // 10^15 micros would fit, but toMicros refuses ten whole digits
    await instance.flush();
    const amounts = server.batches[0].events.flatMap((event) => {
      if (event.type === 'transaction.recorded') return [event.amount];
      return event.type === 'cost.recorded' ? [event.amount_micros] : [];
    });
    expect(amounts).toEqual([LIMITS.maxAmount, -LIMITS.maxAmount, LIMITS.maxMicros, 999_999_999_999_999]);
    // Four drops, all `invalid_amount`: logged once, counted four times.
    expect(logs.filter((event) => event === 'agent_telemetry_invalid_event')).toHaveLength(1);
    expect(instance.stats().dropped).toBe(4);
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });

  it('records a transaction outside any operation, e.g. from a settlement webhook', async () => {
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch);
    const transactionId = instance.transaction({
      taskRef: 'task-1',
      protocol: 'a2a',
      kind: 'charge',
      amount: 1200,
      currency: 'EUR',
      method: 'card',
      processor: 'stripe',
      status: 'settled',
      basis: 'settled',
      externalRef: 'pi_1',
      occurredAt: NOW - 60_000,
    });
    await instance.flush();
    const [event] = server.batches[0].events;
    expect(event).toMatchObject({
      type: 'transaction.recorded',
      transaction_id: transactionId,
      task_ref: 'task-1',
      direction: 'inbound',
      occurred_at: new Date(NOW - 60_000).toISOString(),
    });
    expect(event).not.toHaveProperty('operation_id');
    expect(server.batches[0].events).toHaveLength(1); // no operation was opened
    expect(validateBatch(server.batches[0], NOW)).toMatchObject({ ok: true, rejected: [] });
  });

  it('refuses a transaction without a task or operation', async () => {
    const server = endpoint(accepted);
    const { instance, logs } = recorder(server.fetch);
    expect(instance.transaction({ ...pending, protocol: 'a2a', kind: 'charge' })).toBe('');
    await instance.flush();
    expect(server.batches).toHaveLength(0);
    expect(logs).toContain('agent_telemetry_invalid_event');
  });

  it('returns no-op money methods after a failed start', () => {
    const { instance } = recorder(endpoint(accepted).fetch, { now: () => Number.NaN });
    const op = start(instance);
    expect(op.charge(pending)).toBe('');
    expect(() => op.cost({ category: 'tool', amountMicros: 1, currency: 'USD', basis: 'reported' })).not.toThrow();
  });

  it('never throws when the clock fails after the operation started', () => {
    let calls = 0;
    const { instance, logs } = recorder(endpoint(accepted).fetch, {
      now: () => {
        calls++;
        // Starting reads the clock three times: the operation id, the start time and the capture-time validation.
        if (calls > 3) throw new Error('clock');
        return NOW;
      },
    });
    const op = start(instance, 'task-1');
    expect(() => op.cost({ category: 'tool', amountMicros: 1, currency: 'USD', basis: 'reported' })).not.toThrow();
    expect(op.charge(pending)).toBe('');
    expect(instance.transaction({ ...pending, taskRef: 'task-1', protocol: 'a2a', kind: 'charge' })).toBe('');
    expect(logs.filter((event) => event === 'agent_telemetry_event_failed')).toHaveLength(3);
  });

  it('returns no transaction ID once the recorder is shut down', async () => {
    const { instance } = recorder(endpoint(accepted).fetch);
    await instance.shutdown();
    expect(instance.transaction({ ...pending, taskRef: 'task-1', protocol: 'a2a', kind: 'charge' })).toBe('');
  });

  it('never lets a throwing host logger escape', async () => {
    const log = () => {
      throw new Error('logger broke');
    };
    const server = endpoint(accepted);
    const { instance } = recorder(server.fetch, { log });
    const op = start(instance, 'task-1');
    expect(() => op.cost({ category: 'tool', amountMicros: -1, currency: 'USD', basis: 'reported' })).not.toThrow();
    expect(op.charge({ ...pending, amount: 1.5 })).toBe('');
    expect(instance.transaction({ ...pending, protocol: 'a2a', kind: 'charge' })).toBe('');
    for (let index = 0; index <= LIMITS.costsPerOperation; index++) {
      expect(() => op.cost({ category: 'tool', amountMicros: 1, currency: 'USD', basis: 'reported' })).not.toThrow();
    }
    const broken = recorder(server.fetch, { log, now: () => Number.NaN }).instance;
    expect(start(broken).operationId).toBe('');
    expect(() =>
      broken.abandonTask('task-1', { protocol: A2A, direction: 'inbound', state: 'canceled', reason: 'shutdown' }),
    ).not.toThrow();
    await expect(instance.flush()).resolves.toBeUndefined();
  });
});
