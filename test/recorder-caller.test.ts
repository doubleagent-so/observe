import { describe, expect, it } from 'vitest';
import type { OperationFinished, OperationStarted, StartInput, TransactionRecorded } from '../src/index';
import { capture, expectValid, subjectHash } from './support';

const start: StartInput = {
  protocol: { name: 'mcp', version: '2026-07-28', binding: 'streamable-http' },
  direction: 'inbound',
  method: 'tools/call',
  kind: 'tool',
  target: 'refund_order',
};

/** `HMAC-SHA256(subjectKey, "grant:v1\n" + issuer + "\n" + grantId)` as hex, with the capture recorder's key. */
async function grantHash(issuer: string, grantId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode('ak_test_x'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`grant:v1\n${issuer}\n${grantId}`)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('caller identity on the recorder', () => {
  it('sends the authenticated client id, actor and scopes beside the subject hash', async () => {
    const { recorder, batches, events } = capture();
    recorder.startOperation({
      ...start,
      counterparty: {
        authenticated: { issuer: 'https://auth.example', subject: 'user-1', client_id: 'app-1', actor: 'agent-7', scopes: ['a'] },
      },
    });
    await recorder.flush();
    const [started] = events() as OperationStarted[];
    expect(started.counterparty.authenticated).toEqual({
      issuer: 'https://auth.example',
      subject_hash: await subjectHash('https://auth.example', 'user-1'),
      client_id: 'app-1',
      actor: 'agent-7',
      scopes: ['a'],
    });
    expectValid(batches);
  });

  it('hashes a delegation principal like a subject of the grant issuer, and the grant id with its own label', async () => {
    const { recorder, batches, events } = capture();
    recorder.startOperation({
      ...start,
      counterparty: {
        delegation: {
          protocol: 'oauth',
          issuer: 'https://auth.example',
          principal: 'alice@example.com',
          grant_id: 'grant-secret-1',
          actor: 'agent-7',
          scopes: ['orders:write'],
          access: 'write',
          expires_at: '2026-10-08T12:00:00.000Z',
          verification: { status: 'verified', by: 'reporter' },
        },
      },
    });
    await recorder.flush();
    const [started] = events() as OperationStarted[];
    expect(started.counterparty.delegation).toEqual({
      protocol: 'oauth',
      issuer: 'https://auth.example',
      principal_hash: await subjectHash('https://auth.example', 'alice@example.com'),
      grant_id_hash: await grantHash('https://auth.example', 'grant-secret-1'),
      actor: 'agent-7',
      scopes: ['orders:write'],
      access: 'write',
      expires_at: '2026-10-08T12:00:00.000Z',
      verification: { status: 'verified', by: 'reporter' },
    });
    const sent = JSON.stringify(batches);
    expect(sent).not.toContain('alice@example.com');
    expect(sent).not.toContain('grant-secret-1');
    expectValid(batches);
  });

  it('keys a delegation without an issuer by the authenticated issuer, else by none', async () => {
    const { recorder, events } = capture();
    recorder.startOperation({
      ...start,
      counterparty: {
        authenticated: { issuer: 'https://auth.example', subject: 'agent-app' },
        delegation: { protocol: 'pact', principal: 'alice', grant_id: 'g-1' },
      },
    });
    recorder.startOperation({ ...start, counterparty: { delegation: { protocol: 'pact', principal: 'alice' } } });
    await recorder.flush();
    const [first, second] = events() as OperationStarted[];
    expect(first.counterparty.delegation).toEqual({
      protocol: 'pact',
      principal_hash: await subjectHash('https://auth.example', 'alice'),
      grant_id_hash: await grantHash('https://auth.example', 'g-1'),
    });
    expect(second.counterparty.delegation).toEqual({ protocol: 'pact', principal_hash: await subjectHash('', 'alice') });
  });

  it('sends a delegation without raw identifiers as given', async () => {
    const { recorder, events } = capture();
    recorder.startOperation({
      ...start,
      counterparty: { delegation: { protocol: 'pact', proof: { kind: 'pact-receipt', jws: 'aGVhZA.cGF5bG9hZA.c2ln' } } },
    });
    await recorder.flush();
    const [started] = events() as OperationStarted[];
    expect(started.counterparty.delegation).toEqual({ protocol: 'pact', proof: { kind: 'pact-receipt', jws: 'aGVhZA.cGF5bG9hZA.c2ln' } });
  });

  it('sends access and required scopes on the start, and an insufficient scope challenge on the finish', async () => {
    const { recorder, batches, events } = capture();
    recorder
      .startOperation({ ...start, access: 'destructive', scopeRequired: ['orders:write'] })
      .finish({ outcome: 'auth_rejected', insufficientScope: { required: ['orders:write'] } });
    await recorder.flush();
    const [started, finished] = events() as [OperationStarted, OperationFinished];
    expect(started).toMatchObject({ access: 'destructive', scope_required: ['orders:write'] });
    expect(finished).toMatchObject({ outcome: 'auth_rejected', insufficient_scope: { required: ['orders:write'] } });
    expectValid(batches);
  });

  it('sends a mandate reference on transactions and charges', async () => {
    const { recorder, batches, events } = capture();
    recorder.transaction({
      protocol: 'a2a',
      kind: 'charge',
      taskRef: 't-1',
      amount: 500,
      currency: 'USD',
      method: 'ap2',
      status: 'settled',
      basis: 'reported',
      mandateRef: { scheme: 'ap2', ref: 'mandate-1' },
    });
    recorder.startOperation(start).charge({
      amount: 100,
      currency: 'USD',
      method: 'card',
      status: 'pending',
      basis: 'reported',
      mandateRef: { scheme: 'acp', ref: 'spt_1' },
    });
    await recorder.flush();
    const money = events().filter((event): event is TransactionRecorded => event.type === 'transaction.recorded');
    expect(money.map((event) => event.mandate_ref)).toEqual([
      { scheme: 'ap2', ref: 'mandate-1' },
      { scheme: 'acp', ref: 'spt_1' },
    ]);
    expectValid(batches);
  });

  it('drops a start with a bad grant field and never throws into the host', async () => {
    const { recorder, events, logs } = capture();
    expect(() =>
      recorder
        .startOperation({ ...start, counterparty: { delegation: { protocol: 'oauth', scopes: ['has space'], principal: 'alice' } } })
        .finish({ outcome: 'ok' }),
    ).not.toThrow();
    await recorder.flush();
    expect(events()).toEqual([]);
    expect(logs).toContain('agent_telemetry_invalid_event');
  });
});
