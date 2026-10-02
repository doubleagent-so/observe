import { describe, expect, it } from 'vitest';
import { taskRefOf, x402Receipt, x402Submitted } from '../src/a2a/payments';

describe('taskRefOf', () => {
  it('finds the first task in a result', () => {
    expect(taskRefOf({ task: { id: 't-1', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } })).toBe('t-1');
    expect(taskRefOf({ kind: 'task', id: 't-2', contextId: 'c', status: { state: 'working' } })).toBe('t-2');
  });

  it('is undefined for messages and anything else', () => {
    expect(taskRefOf({ kind: 'message', messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'hi' }] })).toBeUndefined();
    expect(taskRefOf(undefined)).toBeUndefined();
    expect(taskRefOf({ task: { id: 'bad id', status: {} } })).toBeUndefined();
  });
});

const payload = { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453', amount: '1000' }, payload: {} };

describe('x402Submitted', () => {
  it('reads the payment payload of a payment-submitted message', () => {
    const metadata = { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload };
    expect(x402Submitted({ message: { messageId: 'm', taskId: 't', metadata } })).toBe(payload);
  });

  it('is undefined without a submitted payload object', () => {
    expect(x402Submitted(undefined)).toBeUndefined();
    expect(x402Submitted({ message: { messageId: 'm' } })).toBeUndefined();
    expect(x402Submitted({ message: { metadata: { 'x402.payment.payload': payload } } })).toBeUndefined();
    expect(
      x402Submitted({ message: { metadata: { 'x402.payment.status': 'payment-required', 'x402.payment.payload': payload } } }),
    ).toBeUndefined();
    expect(
      x402Submitted({ message: { metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': 'x' } } }),
    ).toBeUndefined();
  });
});

describe('x402Receipt', () => {
  const receipts = [
    { success: false, network: 'eip155:8453' },
    { success: true, transaction: '0xabc', network: 'eip155:8453' },
  ];
  const message = (status: string, value: unknown = receipts) => ({
    messageId: 'r',
    role: 'agent',
    parts: [],
    metadata: { 'x402.payment.status': status, 'x402.payment.receipts': value },
  });

  it('reads the last receipt from a task status message, in 1.0, 0.3 and ts-proto shapes', () => {
    const status = { state: 'TASK_STATE_COMPLETED', message: message('payment-completed') };
    const expected = { taskRef: 't-1', receipt: receipts[1] };
    expect(x402Receipt({ task: { id: 't-1', status } })).toEqual(expected);
    expect(x402Receipt({ kind: 'task', id: 't-1', status })).toEqual(expected);
    expect(x402Receipt({ statusUpdate: { taskId: 't-1', status } })).toEqual(expected);
    expect(x402Receipt({ kind: 'status-update', taskId: 't-1', status })).toEqual(expected);
    expect(x402Receipt({ payload: { $case: 'statusUpdate', value: { taskId: 't-1', status } } })).toEqual(expected);
    expect(x402Receipt({ payload: { $case: 'task', value: { id: 't-1', status } } })).toEqual(expected);
    expect(x402Receipt({ id: 't-1', contextId: 'c', status })).toEqual(expected);
  });

  it('reads payment-failed receipts, and keeps a receipt whose task id is unusable', () => {
    const status = { state: 'failed', message: message('payment-failed', [{ success: false }]) };
    expect(x402Receipt({ task: { id: 't-2', status } })).toEqual({ taskRef: 't-2', receipt: { success: false } });
    expect(x402Receipt({ statusUpdate: { taskId: 'bad id', status } })).toEqual({ receipt: { success: false } });
  });

  it('is undefined without receipts on a final payment status', () => {
    expect(x402Receipt(undefined)).toBeUndefined();
    expect(x402Receipt({ message: { messageId: 'm', metadata: { 'x402.payment.status': 'payment-completed' } } })).toBeUndefined();
    expect(x402Receipt({ task: { id: 't', status: { state: 'working' } } })).toBeUndefined();
    expect(x402Receipt({ task: { id: 't', status: { message: message('payment-verified') } } })).toBeUndefined();
    expect(x402Receipt({ task: { id: 't', status: { message: message('payment-completed', []) } } })).toBeUndefined();
    expect(x402Receipt({ task: { id: 't', status: { message: message('payment-completed', { success: true }) } } })).toBeUndefined();
    expect(x402Receipt({ payload: { $case: 'message', value: {} } })).toBeUndefined();
  });
});
