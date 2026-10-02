import { describe, expect, it } from 'vitest';
import { LIMITS, validateEvent } from '../src/index';

const NOW = Date.UTC(2026, 9, 1, 12);
const ISO = new Date(NOW).toISOString();
const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
const base = {
  schema_version: 1,
  occurred_at: ISO,
  protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
  direction: 'inbound',
};
const transaction = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(10),
  type: 'transaction.recorded',
  task_ref: 'task-1',
  transaction_id: id(11),
  kind: 'charge',
  amount: 500,
  currency: 'USD',
  method: 'x402',
  network: 'base',
  basis: 'reported',
  status: 'pending',
  ...over,
});
const cost = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(12),
  type: 'cost.recorded',
  operation_id: id(1),
  category: 'model',
  amount_micros: 4_200,
  currency: 'USD',
  basis: 'estimated',
  usage: { model: 'claude-x', input_tokens: 1200, output_tokens: 300 },
  ...over,
});
const code = (value: unknown) => {
  const result = validateEvent(value, NOW);
  return result.ok ? 'ok' : result.code;
};

describe('money events', () => {
  it('accepts a transaction with only a task, only an operation, or both', () => {
    expect(code(transaction())).toBe('ok');
    expect(code(transaction({ task_ref: undefined, operation_id: id(1) }))).toBe('ok');
    expect(code(transaction({ operation_id: id(1), conversation_ref: 'ctx-1' }))).toBe('ok');
  });

  it('requires a task or an operation', () => {
    expect(code(transaction({ task_ref: undefined }))).toBe('missing_link');
    expect(code(cost({ operation_id: undefined }))).toBe('missing_link');
  });

  it('still requires operation_id on operation events', () => {
    const { operation_id: _omit, ...started } = {
      ...base,
      event_id: id(2),
      type: 'operation.started',
      operation_id: id(1),
      method: 'SendMessage',
      kind: 'message',
      counterparty: {},
    };
    expect(code(started)).toBe('invalid_id');
  });

  it('checks amounts: integers within ±10^13, refunds negative, everything else non-negative', () => {
    expect(code(transaction({ amount: 10 ** 13 }))).toBe('ok');
    expect(code(transaction({ amount: 10 ** 13 + 1 }))).toBe('invalid_amount');
    expect(code(transaction({ amount: 1.5 }))).toBe('invalid_amount');
    expect(code(transaction({ amount: '500' }))).toBe('invalid_amount');
    expect(code(transaction({ amount: -500 }))).toBe('invalid_amount');
    expect(code(transaction({ kind: 'refund', amount: -500 }))).toBe('ok');
    expect(code(transaction({ kind: 'refund', amount: 500 }))).toBe('invalid_amount');
    expect(code(cost({ amount_micros: -1 }))).toBe('invalid_amount');
    expect(code(cost({ amount_micros: 0 }))).toBe('ok');
    expect(code(cost({ amount_micros: 10 ** 15 }))).toBe('ok');
    expect(code(cost({ amount_micros: 10 ** 15 + 1 }))).toBe('invalid_amount');
    expect(code(cost({ amount_micros: 0.5 }))).toBe('invalid_amount');
    expect(code(cost({ amount: 42 }))).toBe('unknown_field');
  });

  it('keeps every amount limit a safe integer, and the validator exactly at the limits', () => {
    expect(Number.isSafeInteger(LIMITS.maxMicros)).toBe(true);
    expect(Number.isSafeInteger(LIMITS.maxAmount)).toBe(true);
    expect(code(cost({ amount_micros: LIMITS.maxMicros }))).toBe('ok');
    expect(code(cost({ amount_micros: LIMITS.maxMicros + 1 }))).toBe('invalid_amount');
    expect(code(cost({ amount_micros: Number.MAX_SAFE_INTEGER + 1 }))).toBe('invalid_amount');
    expect(code(transaction({ amount: LIMITS.maxAmount }))).toBe('ok');
    expect(code(transaction({ kind: 'refund', amount: -LIMITS.maxAmount - 1 }))).toBe('invalid_amount');
  });

  it('checks currency codes', () => {
    expect(code(transaction({ currency: 'USDC' }))).toBe('ok');
    expect(code(transaction({ currency: 'usd' }))).toBe('invalid_currency');
    expect(code(transaction({ currency: 'US' }))).toBe('invalid_currency');
    expect(code(transaction({ currency: 'TOOLONG' }))).toBe('invalid_currency');
  });

  it('allowlists enums and optional fields', () => {
    expect(code(transaction({ kind: 'deposit' }))).toBe('invalid_field');
    expect(code(transaction({ method: 'paypal' }))).toBe('invalid_field');
    expect(code(transaction({ status: 'done' }))).toBe('invalid_field');
    expect(code(transaction({ processor: 'Stripe!' }))).toBe('invalid_field');
    expect(code(transaction({ network: 'eip155:8453' }))).toBe('ok');
    expect(code(transaction({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }))).toBe('ok');
    expect(code(transaction({ network: 'Base Mainnet' }))).toBe('invalid_field');
    expect(code(transaction({ network: `n${'x'.repeat(64)}` }))).toBe('invalid_field');
    expect(code(transaction({ processor: 'Stripe' }))).toBe('invalid_field');
    expect(code(transaction({ external_ref: 'x'.repeat(257) }))).toBe('invalid_field');
    expect(code(transaction({ external_ref: 'pi_123' }))).toBe('ok');
    expect(code(transaction({ transaction_id: 'not-a-ulid' }))).toBe('invalid_id');
    expect(code(transaction({ extra: 1 }))).toBe('unknown_field');
    expect(code(cost({ category: 'tokens' }))).toBe('invalid_field');
  });

  it('allows settled basis only for settled or refunded transactions', () => {
    expect(code(transaction({ basis: 'settled', status: 'settled' }))).toBe('ok');
    expect(code(transaction({ basis: 'settled', status: 'refunded' }))).toBe('ok');
    expect(code(transaction({ basis: 'settled', status: 'pending' }))).toBe('invalid_field');
    expect(code(transaction({ basis: 'settled', status: 'failed' }))).toBe('invalid_field');
  });

  it('checks cost usage', () => {
    expect(code(cost({ usage: { units: 3, unit: 'search' } }))).toBe('ok');
    expect(code(cost({ usage: { input_tokens: -1 } }))).toBe('invalid_field');
    expect(code(cost({ usage: { prompt: 'x' } }))).toBe('invalid_field');
    expect(code(cost({ usage: { model: 'x'.repeat(129) } }))).toBe('invalid_field');
  });
});
