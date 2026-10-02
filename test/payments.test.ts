import { describe, expect, it } from 'vitest';
import { transactionEvent, validateEvent } from '../src/index';
import { x402Charge, x402Evidence } from '../src/payments';

const b64 = (value: unknown) => btoa(JSON.stringify(value));
const payment = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: { signature: '0xsig', authorization: { from: '0xa', to: '0xb', value: '500000', nonce: '0x1' } },
};
const settlement = { success: true, transaction: '0xtxhash', network: 'base', payer: '0xa' };
const request = (headers: Record<string, string>) => new Request('https://agent.test/a2a', { method: 'POST', headers });
const response = (headers: Record<string, string>) => new Response('{}', { headers });
const v2 = (accepted: Record<string, unknown>) => ({ x402Version: 2, accepted: { scheme: 'exact', ...accepted }, payload: {} });

describe('x402Evidence', () => {
  it('turns decoded payment and settlement objects into a reported USDC charge', () => {
    expect(x402Evidence(payment, settlement)).toEqual({
      amount: 500_000,
      currency: 'USDC',
      method: 'x402',
      network: 'base',
      status: 'settled',
      basis: 'reported',
      externalRef: '0xtxhash',
    });
  });

  it('reads v2 amounts from the accepted requirements, else maxAmountRequired', () => {
    const settled = { success: false, network: 'eip155:8453' };
    expect(x402Evidence(v2({ network: 'eip155:8453', amount: '1000' }), settled)).toEqual({
      amount: 1000,
      currency: 'USDC',
      method: 'x402',
      network: 'eip155:8453',
      status: 'failed',
      basis: 'reported',
    });
    expect(x402Evidence(v2({ maxAmountRequired: '7' }), { success: true })).toMatchObject({ amount: 7, status: 'settled' });
  });

  it('names the network from the settlement, else the payment, exactly as sent and bounded', () => {
    const solana = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    expect(x402Evidence(v2({ network: solana, amount: '1' }), { success: true })).toMatchObject({ network: solana });
    expect(x402Evidence(v2({ network: 'base', amount: '1' }), { success: true, network: solana })).toMatchObject({ network: solana });
    expect(x402Evidence({ ...payment, network: 'n'.repeat(65) }, { success: true })).not.toHaveProperty('network');
    expect(x402Evidence({ ...payment, network: 'bad network' }, { success: true, network: 7 })).not.toHaveProperty('network');
  });

  it('identifies known assets and drops unknown ones', () => {
    const base = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const eurc = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
    expect(x402Evidence(v2({ amount: '1', asset: base }), { success: true })).toMatchObject({ currency: 'USDC' });
    expect(x402Evidence(v2({ amount: '1', asset: eurc.toLowerCase() }), { success: true })).toMatchObject({ currency: 'EURC' });
    expect(x402Evidence(v2({ amount: '1', asset: 'usdt' }), { success: true })).toMatchObject({ currency: 'USDT' });
    expect(x402Evidence(v2({ amount: '1', asset: '0x0000000000000000000000000000000000000001' }), { success: true })).toBeNull();
    expect(x402Evidence(v2({ amount: '1', asset: 42 }), { success: true })).toBeNull();
    expect(x402Evidence(v2({ amount: '1', asset: 'constructor' }), { success: true })).toBeNull();
    const eurcBaseSepolia = '0x808456652fdb597867f38412077A9182bf77359F';
    expect(x402Evidence(v2({ amount: '1', asset: eurcBaseSepolia }), { success: true })).toMatchObject({ currency: 'EURC' });
  });

  it('applies the bounds: atomic integer strings up to LIMITS.maxAmount, references up to 256 printable characters', () => {
    expect(x402Evidence(payment, undefined)).toBeNull();
    expect(x402Evidence(undefined, settlement)).toBeNull();
    expect(x402Evidence('junk', 'junk')).toBeNull();
    expect(x402Evidence([payment], settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '1.5' } } }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '-1' } } }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: 500 } } }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '9'.repeat(15) } } }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '10000000000001' } } }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '10000000000000' } } }, settlement)).toMatchObject({
      amount: 10_000_000_000_000,
    });
    expect(x402Evidence({ payload: {} }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '0' } } }, settlement)).toBeNull();
    expect(x402Evidence({ payload: { authorization: { value: '000' } } }, settlement)).toBeNull();
    expect(x402Evidence(payment, { success: 'true' })).toMatchObject({ status: 'failed' });
    expect(x402Evidence(payment, { success: true, transaction: 'x'.repeat(257) })).not.toHaveProperty('externalRef');
    expect(x402Evidence(payment, { success: true, transaction: 'tx with space' })).not.toHaveProperty('externalRef');
    expect(x402Evidence(payment, { success: true, transaction: 'x'.repeat(256) })).toMatchObject({ externalRef: 'x'.repeat(256) });
  });

  it('never carries the signature, payer or authorization beyond the amount', () => {
    const charge = x402Evidence(payment, settlement);
    expect(JSON.stringify(charge)).not.toMatch(/0xsig|0xa"|0xb|nonce/);
  });

  it('builds charges the validator accepts', () => {
    const links = {
      protocol: { name: 'a2a' as const, version: '1.0', binding: 'jsonrpc-http' as const },
      direction: 'inbound' as const,
      operationId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    };
    for (const charge of [
      x402Evidence(payment, settlement),
      x402Evidence(v2({ network: 'eip155:8453', amount: '1' }), { success: false }),
      x402Evidence(v2({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '1' }), { success: true }),
    ]) {
      const event = transactionEvent(links, { ...charge!, kind: 'charge', transactionId: '01JABCDEFGHJKMNPQRSTVWXYZ1' }, Date.now());
      expect(validateEvent(event, Date.now())).toMatchObject({ ok: true, event: { network: charge!.network } });
    }
  });
});

describe('x402Charge', () => {
  it('decodes v1 headers', () => {
    expect(x402Charge(request({ 'x-payment': b64(payment) }), response({ 'x-payment-response': b64(settlement) }))).toEqual(
      x402Evidence(payment, settlement),
    );
  });

  it('decodes v2 headers, and base64url', () => {
    const paid = v2({ network: 'eip155:8453', amount: '1000' });
    const url = b64(paid).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(x402Charge(request({ 'payment-signature': url }), response({ 'payment-response': b64({ success: true }) }))).toMatchObject({
      amount: 1000,
      status: 'settled',
    });
  });

  it('records nothing without both headers, or when either does not parse', () => {
    expect(x402Charge(request({ 'x-payment': b64(payment) }), response({}))).toBeNull();
    expect(x402Charge(request({}), response({ 'x-payment-response': b64(settlement) }))).toBeNull();
    expect(x402Charge(request({ 'x-payment': 'not base64!' }), response({ 'x-payment-response': b64(settlement) }))).toBeNull();
    expect(x402Charge(request({ 'x-payment': b64(payment) }), response({ 'x-payment-response': btoa('{oops') }))).toBeNull();
    expect(x402Charge(request({ 'x-payment': b64(payment) }), response({ 'x-payment-response': b64('text') }))).toBeNull();
    const huge = btoa(JSON.stringify({ ...payment, pad: 'p'.repeat(70_000) }));
    expect(x402Charge(request({ 'x-payment': huge }), response({ 'x-payment-response': b64(settlement) }))).toBeNull();
  });
});
