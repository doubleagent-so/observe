import { describe, expect, it } from 'vitest';
import { LIMITS, validateEvent } from '../src/index';

const NOW = Date.UTC(2026, 9, 1, 12);
const ISO = new Date(NOW).toISOString();
const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
const HASH = 'a'.repeat(64);
const JWS = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
const base = {
  schema_version: 1,
  occurred_at: ISO,
  protocol: { name: 'mcp', version: '2026-07-28', binding: 'streamable-http' },
  direction: 'inbound',
  operation_id: id(1),
};
const started = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(2),
  type: 'operation.started',
  method: 'tools/call',
  kind: 'tool',
  counterparty: {},
  ...over,
});
const finished = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(3),
  type: 'operation.finished',
  outcome: 'auth_rejected',
  started_at: ISO,
  duration_ms: 3,
  ...over,
});
const transaction = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(4),
  type: 'transaction.recorded',
  transaction_id: id(5),
  kind: 'charge',
  amount: 500,
  currency: 'USD',
  method: 'ap2',
  basis: 'reported',
  status: 'settled',
  ...over,
});
const code = (event: unknown) => {
  const result = validateEvent(event, NOW);
  return result.ok ? 'ok' : result.code;
};
const withCounterparty = (counterparty: unknown) => code(started({ counterparty }));

const authenticated = { issuer: 'https://auth.example', subject_hash: HASH };
const delegation = {
  protocol: 'pact',
  issuer: 'https://auth.example',
  principal_hash: HASH,
  actor: 'agent-7',
  client_id: 'https://client.example/metadata.json',
  scopes: ['orders:read', 'orders:write'],
  scopes_used: ['orders:read'],
  access: 'write',
  expires_at: '2026-10-08T12:00:00.000Z',
  grant_id_hash: 'b'.repeat(64),
  verification: { status: 'verified', by: 'reporter' },
  proof: { kind: 'pact-receipt', jws: JWS },
};
const forwarded = {
  scheme: 'web-bot-auth',
  key_id: 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U',
  verified_by: 'double_agent',
  request: {
    method: 'POST',
    url: 'https://agent.example/mcp',
    headers: {
      signature: 'sig1=:abc=:',
      'signature-input': 'sig1=("@authority" "signature-agent");tag="web-bot-auth"',
      'signature-agent': '"https://bot.example"',
    },
  },
};

describe('caller identity fields', () => {
  it('accepts authenticated client id, actor and scopes', () => {
    expect(withCounterparty({ authenticated: { ...authenticated, client_id: 'c-1', actor: 'agent-7', scopes: ['a', 'b:c'] } })).toBe('ok');
    expect(withCounterparty({ authenticated: { ...authenticated, scopes: [] } })).toBe('ok');
  });

  it.each([
    ['client_id', { client_id: 'x'.repeat(LIMITS.clientId + 1) }],
    ['client_id', { client_id: '' }],
    ['actor', { actor: 'x'.repeat(LIMITS.actor + 1) }],
    ['scopes', { scopes: 'a b' }],
    ['scope with a space', { scopes: ['a b'] }],
    ['scope too long', { scopes: ['x'.repeat(LIMITS.scope + 1)] }],
    ['too many scopes', { scopes: Array.from({ length: LIMITS.scopes + 1 }, (_, n) => `s${n}`) }],
    ['unknown key', { token: 'x' }],
  ])('rejects a bad authenticated %s', (_name, over) => {
    expect(withCounterparty({ authenticated: { ...authenticated, ...over } })).toBe('invalid_counterparty');
  });

  it('accepts a full delegation and a minimal one', () => {
    expect(withCounterparty({ delegation })).toBe('ok');
    expect(withCounterparty({ delegation: { protocol: 'a2a' } })).toBe('ok');
    expect(
      withCounterparty({ delegation: { protocol: 'pact', verification: { status: 'failed', by: 'reporter', reason: 'expired' } } }),
    ).toBe('ok');
    for (const kind of ['pact-delegation', 'pact-agent']) {
      expect(withCounterparty({ delegation: { protocol: 'pact', proof: { kind, jws: 'aGVhZA..c2ln' } } })).toBe('ok');
    }
  });

  it.each([
    ['protocol', { protocol: 'saml' }],
    ['protocol pap (no published specification yet)', { protocol: 'pap' }],
    ['proof on a protocol other than pact', { protocol: 'oauth' }],
    ['missing protocol', { protocol: undefined }],
    ['issuer', { issuer: 'x'.repeat(LIMITS.issuer + 1) }],
    ['principal_hash', { principal_hash: 'A'.repeat(64) }],
    ['raw principal', { principal: 'alice' }],
    ['raw grant id', { grant_id: 'g-1' }],
    ['actor', { actor: 7 }],
    ['client_id', { client_id: 'x'.repeat(LIMITS.clientId + 1) }],
    ['scopes', { scopes: ['a"b'] }],
    ['scopes_used', { scopes_used: ['a\\b'] }],
    ['access', { access: 'destructive' }],
    ['expires_at', { expires_at: 'tomorrow' }],
    ['expires_at date', { expires_at: 1767225600 }],
    ['grant_id_hash', { grant_id_hash: 'g-1' }],
    ['verification status', { verification: { status: 'maybe', by: 'reporter' } }],
    ['verification by', { verification: { status: 'verified', by: 'double_agent' } }],
    ['verification reason', { verification: { status: 'failed', by: 'reporter', reason: 'Bad Signature' } }],
    ['verification key', { verification: { status: 'failed', by: 'reporter', detail: 'x' } }],
    ['proof kind', { proof: { kind: 'jwt', jws: JWS } }],
    ['proof jws', { proof: { kind: 'pact-receipt', jws: 'not a jws' } }],
    ['proof size', { proof: { kind: 'pact-receipt', jws: `a.b.${'c'.repeat(LIMITS.proof)}` } }],
    ['proof key', { proof: { kind: 'pact-receipt', jws: JWS, payload: {} } }],
    ['unknown key', { token: 'x' }],
  ])('rejects a bad delegation %s', (_name, over) => {
    expect(withCounterparty({ delegation: { ...delegation, ...over } })).toBe('invalid_counterparty');
  });

  it('still accepts a signature the host verified, and now one forwarded for Double Agent', () => {
    expect(withCounterparty({ signature: { scheme: 'web-bot-auth', key_id: 'k', verified_by: 'reporter' } })).toBe('ok');
    expect(withCounterparty({ signature: forwarded })).toBe('ok');
    // The API compares methods upper case, so a lower-case one is accepted.
    expect(withCounterparty({ signature: { ...forwarded, request: { ...forwarded.request, method: 'post' } } })).toBe('ok');
    const { key_id: _keyId, ...withoutKey } = forwarded;
    expect(withCounterparty({ signature: { ...withoutKey, scheme: 'erc-8128' } })).toBe('ok');
    expect(withCounterparty({ signature: { ...forwarded, request: { ...forwarded.request, headers: { 'content-digest': '' } } } })).toBe(
      'ok',
    );
  });

  const request = (over: Record<string, unknown>) => ({ signature: { ...forwarded, request: { ...forwarded.request, ...over } } });
  it.each([
    ['verified_by', { signature: { ...forwarded, verified_by: 'nobody' } }],
    ['reporter with a request', { signature: { ...forwarded, verified_by: 'reporter' } }],
    ['reporter without a key id', { signature: { scheme: 'web-bot-auth', verified_by: 'reporter' } }],
    ['missing request', { signature: { scheme: 'web-bot-auth', verified_by: 'double_agent' } }],
    ['method', request({ method: 'GET /' })],
    ['url', request({ url: 'ftp://agent.example' })],
    ['url length', request({ url: `https://a.example/${'x'.repeat(LIMITS.url)}` })],
    ['headers', request({ headers: 'signature: x' })],
    ['upper-case header name', request({ headers: { Signature: 'x' } })],
    ['authorization', request({ headers: { authorization: 'Bearer x' } })],
    ['cookie', request({ headers: { cookie: 'a=b' } })],
    ['proxy-authorization', request({ headers: { 'proxy-authorization': 'Basic x' } })],
    ['header value', request({ headers: { signature: 'a\nb' } })],
    ['header value size', request({ headers: { signature: 'x'.repeat(LIMITS.headerValue + 1) } })],
    ['header value size in UTF-8 bytes', request({ headers: { signature: 'é'.repeat(LIMITS.headerValue / 2 + 1) } })],
    ['header value type', request({ headers: { signature: 1 } })],
    [
      'too many headers',
      request({ headers: Object.fromEntries(Array.from({ length: LIMITS.signedHeaders + 1 }, (_, n) => [`h${n}`, 'x'])) }),
    ],
    ['request key', request({ body: 'x' })],
  ])('rejects a bad signature %s', (_name, counterparty) => {
    expect(withCounterparty(counterparty)).toBe('invalid_counterparty');
  });

  it('accepts access and required scopes on a started operation and rejects bad ones', () => {
    expect(code(started({ access: 'destructive', scope_required: ['orders:write'] }))).toBe('ok');
    expect(code(started({ access: 'admin' }))).toBe('invalid_field');
    expect(code(started({ scope_required: 'orders:write' }))).toBe('invalid_field');
    expect(code(started({ scope_required: ['a b'] }))).toBe('invalid_field');
  });

  it('accepts insufficient_scope on a finished operation and rejects bad ones', () => {
    expect(code(finished({ insufficient_scope: { required: ['files:write'] } }))).toBe('ok');
    expect(code(finished({ insufficient_scope: { required: [] } }))).toBe('ok');
    expect(code(finished({ insufficient_scope: ['files:write'] }))).toBe('invalid_field');
    expect(code(finished({ insufficient_scope: { required: ['a b'] } }))).toBe('invalid_field');
    expect(code(finished({ insufficient_scope: { required: [], granted: [] } }))).toBe('invalid_field');
  });

  it('accepts a mandate reference on a transaction and rejects bad ones', () => {
    expect(code(transaction({ mandate_ref: { scheme: 'ap2', ref: 'mandate-123' } }))).toBe('ok');
    expect(code(transaction({ mandate_ref: { scheme: 'acp', ref: 'x'.repeat(LIMITS.mandateRef) } }))).toBe('ok');
    expect(code(transaction({ mandate_ref: { scheme: 'visa', ref: 'm' } }))).toBe('invalid_field');
    expect(code(transaction({ mandate_ref: { scheme: 'ap2', ref: 'x'.repeat(LIMITS.mandateRef + 1) } }))).toBe('invalid_field');
    expect(code(transaction({ mandate_ref: { scheme: 'ap2', ref: 'm', contents: {} } }))).toBe('invalid_field');
  });

  it('keeps the new fields to their own event types', () => {
    expect(code(finished({ access: 'read' }))).toBe('unknown_field');
    expect(code(started({ insufficient_scope: { required: [] } }))).toBe('unknown_field');
    expect(code(started({ mandate_ref: { scheme: 'ap2', ref: 'm' } }))).toBe('unknown_field');
  });

  it('still applies the 8 KiB envelope limit to the whole event', () => {
    const big = { ...delegation, proof: { kind: 'pact-receipt', jws: `a.b.${'c'.repeat(LIMITS.proof - 4)}` } };
    expect(withCounterparty({ delegation: big })).toBe('event_too_large');
  });
});
