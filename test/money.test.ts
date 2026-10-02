import { describe, expect, it } from 'vitest';
import { costEvent, costMicros, protocolOf, transactionEvent, validateEvent } from '../src/index';

const AT = Date.UTC(2026, 9, 1, 12);
const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
const links = { protocol: protocolOf('a2a'), direction: 'inbound' as const, taskRef: 'task-1' };

describe('money event builders', () => {
  it('builds a valid transaction event with snake_case wire fields', () => {
    const event = transactionEvent(
      links,
      {
        transactionId: id(1),
        kind: 'charge',
        amount: 1200,
        currency: 'EUR',
        method: 'card',
        processor: 'stripe',
        basis: 'settled',
        status: 'settled',
        externalRef: 'pi_1',
      },
      AT,
    );
    expect(event).toMatchObject({
      type: 'transaction.recorded',
      task_ref: 'task-1',
      transaction_id: id(1),
      external_ref: 'pi_1',
      processor: 'stripe',
      protocol: { name: 'a2a', version: 'unknown', binding: 'other' },
      occurred_at: new Date(AT).toISOString(),
    });
    expect(event).not.toHaveProperty('operation_id');
    expect(validateEvent(event, AT).ok).toBe(true);
  });

  it('uses a given event ID (server-built events are deterministic)', () => {
    const event = transactionEvent(
      links,
      { transactionId: id(1), kind: 'charge', amount: 1, currency: 'USD', method: 'card', basis: 'reported', status: 'pending' },
      AT,
      id(9),
    );
    expect(event.event_id).toBe(id(9));
  });

  it('builds a valid cost event', () => {
    const event = costEvent(
      { ...links, operationId: id(2), taskRef: undefined },
      { category: 'model', amountMicros: 4_200, currency: 'USD', basis: 'estimated', usage: { model: 'claude-x', input_tokens: 1200 } },
      AT,
    );
    expect(event).toMatchObject({
      type: 'cost.recorded',
      operation_id: id(2),
      amount_micros: 4_200,
      usage: { model: 'claude-x', input_tokens: 1200 },
    });
    expect(event).not.toHaveProperty('task_ref');
    expect(validateEvent(event, AT).ok).toBe(true);
  });

  it('copies usage, so a later change by the host cannot reach a validated event', () => {
    const usage = { model: 'claude-x', input_tokens: 1 };
    const event = costEvent(links, { category: 'model', amountMicros: 1, currency: 'USD', basis: 'estimated', usage }, AT);
    usage.input_tokens = -1;
    expect(event.usage).toEqual({ model: 'claude-x', input_tokens: 1 });
  });

  it('accepts a decimal major-unit cost and converts it to micros', () => {
    expect(costMicros({ amount: 0.0042 })).toBe(4_200);
    expect(costMicros({ amount: '0.25' })).toBe(250_000);
    expect(costMicros({ amountMicros: 7 })).toBe(7);
    expect(costMicros({})).toBeNaN();
    expect(costMicros({ amount: 1, amountMicros: 1 })).toBeNaN();
    expect(costMicros({ amount: 0.00000001 })).toBeNaN();
    const event = costEvent(links, { category: 'tool', amount: 0.0042, currency: 'USD', basis: 'reported' }, AT);
    expect(event.amount_micros).toBe(4_200);
    expect(validateEvent(costEvent(links, { category: 'tool', currency: 'USD', basis: 'reported' }, AT), AT)).toEqual({
      ok: false,
      code: 'invalid_amount',
    });
  });

  it('links a money event to its conversation', () => {
    const event = costEvent(
      { ...links, conversationRef: 'ctx-1' },
      { category: 'compute', amountMicros: 0, currency: 'USD', basis: 'reported' },
      AT,
    );
    expect(event).toMatchObject({ conversation_ref: 'ctx-1', task_ref: 'task-1', amount_micros: 0 });
    expect(validateEvent(event, AT).ok).toBe(true);
  });

  it('keeps a full protocol object as given', () => {
    expect(protocolOf({ name: 'mcp', version: '2025-11-25', binding: 'streamable-http' })).toEqual({
      name: 'mcp',
      version: '2025-11-25',
      binding: 'streamable-http',
    });
  });
});
