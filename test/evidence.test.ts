import { describe, expect, it } from 'vitest';
import {
  createRecorder,
  oauthEvidence,
  parseInsufficientScope,
  signedRequestEvidence,
  validateEvent,
  type AgentEvent,
  type CounterpartyInput,
} from '../src/index';

const NOW = Date.now();

/** The started event a recorder builds with `counterparty`, validated like the API does. */
async function validStart(counterparty: CounterpartyInput) {
  const sent: AgentEvent[] = [];
  const recorder = createRecorder({
    key: 'ak_test_x',
    endpoint: 'https://api.test',
    flushIntervalMs: 0,
    fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push(...(JSON.parse(String(init.body)) as { events: AgentEvent[] }).events);
      return Response.json({ accepted: 1, content_dropped: 0, rejected: [] }, { status: 202 });
    }) as typeof fetch,
  });
  recorder.startOperation({
    protocol: { name: 'mcp', version: '2026-07-28', binding: 'streamable-http' },
    direction: 'inbound',
    method: 'tools/call',
    kind: 'tool',
    counterparty,
  });
  await recorder.flush();
  expect(sent).toHaveLength(1);
  expect(validateEvent(sent[0], NOW)).toMatchObject({ ok: true });
  return sent[0];
}

describe('oauthEvidence', () => {
  const claims = {
    iss: 'https://auth.example',
    sub: 'alice',
    client_id: 'https://client.example/metadata.json',
    scope: 'orders:read orders:write orders:read',
    exp: 1_790_000_000,
    grant_id: 'grant-1',
    act: { sub: 'agent-7', act: { sub: 'earlier-agent' } },
  };

  it('reads the subject, client, current actor and scopes, and a delegation when an agent acts', async () => {
    const evidence = oauthEvidence(claims);
    const shared = { client_id: 'https://client.example/metadata.json', actor: 'agent-7', scopes: ['orders:read', 'orders:write'] };
    expect(evidence).toEqual({
      authenticated: { issuer: 'https://auth.example', subject: 'alice', ...shared },
      delegation: {
        protocol: 'oauth',
        issuer: 'https://auth.example',
        principal: 'alice',
        ...shared,
        expires_at: new Date(1_790_000_000_000).toISOString(),
        grant_id: 'grant-1',
        verification: { status: 'verified', by: 'reporter' },
      },
    });
    await validStart(evidence);
  });

  it('gives only the authenticated principal without an act claim, with azp and scp as fallbacks', () => {
    expect(oauthEvidence({ sub: 'svc', azp: 'app', scp: ['a', 'b c', 7] }, { issuer: 'https://idp.example' })).toEqual({
      authenticated: { issuer: 'https://idp.example', subject: 'svc', client_id: 'app', scopes: ['a'] },
    });
  });

  it('ignores claims of the wrong type and never throws', () => {
    expect(oauthEvidence({ iss: 7, sub: 'x' })).toEqual({});
    expect(oauthEvidence({ iss: 'i', sub: { id: 1 } })).toEqual({});
    expect(oauthEvidence(null as unknown as Record<string, unknown>)).toEqual({});
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(oauthEvidence(hostile)).toEqual({});
    expect(oauthEvidence({ iss: 'i', sub: 's', client_id: 1, scope: '', act: { sub: 2 }, exp: 'soon', grant_id: 3 })).toEqual({
      authenticated: { issuer: 'i', subject: 's' },
      delegation: { protocol: 'oauth', issuer: 'i', principal: 's', verification: { status: 'verified', by: 'reporter' } },
    });
    expect(oauthEvidence({ iss: 'i', sub: 's', act: {}, exp: 1e20 }).delegation).not.toHaveProperty('expires_at');
  });

  it('keeps at most 32 scopes', () => {
    const scope = Array.from({ length: 40 }, (_, n) => `s${n}`).join(' ');
    expect(oauthEvidence({ iss: 'i', sub: 's', scope }).authenticated?.scopes).toHaveLength(32);
  });
});

const WEB_BOT_AUTH_INPUT =
  'sig1=("@authority" "@method" "signature-agent" "content-digest");created=1;keyid="key-1";alg="ed25519";tag="web-bot-auth"';

function signedRequest(headers: Record<string, string>, url = 'https://agent.example/mcp?token=secret#frag'): Request {
  return new Request(url, { method: 'POST', headers: { signature: 'sig1=:c2ln:', 'content-type': 'application/json', ...headers } });
}

describe('signedRequestEvidence', () => {
  it('forwards a Web Bot Auth signature with only the headers it needs, and no query it does not sign', async () => {
    const request = signedRequest({
      'signature-input': WEB_BOT_AUTH_INPUT,
      'signature-agent': '"https://bot.example"',
      'content-digest': 'sha-256=:abc=:',
      'x-other': 'not forwarded',
    });
    const evidence = signedRequestEvidence(request);
    expect(evidence).toEqual({
      signature: {
        scheme: 'web-bot-auth',
        key_id: 'key-1',
        verified_by: 'double_agent',
        request: {
          method: 'POST',
          url: 'https://agent.example/mcp',
          headers: {
            signature: 'sig1=:c2ln:',
            'signature-input': WEB_BOT_AUTH_INPUT,
            'signature-agent': '"https://bot.example"',
            'content-digest': 'sha-256=:abc=:',
          },
        },
      },
    });
    await validStart(evidence);
  });

  it('keeps the query when the signature covers it, and picks the web-bot-auth member', () => {
    const input = `other=("@method");keyid="x", sig2=("@target-uri");keyid="k2";tag="web-bot-auth"`;
    const evidence = signedRequestEvidence(signedRequest({ 'signature-input': input }));
    expect(evidence.signature).toMatchObject({
      scheme: 'web-bot-auth',
      key_id: 'k2',
      request: { url: 'https://agent.example/mcp?token=secret' },
    });
  });

  it('detects ERC-8128 and reads only item names, not parameter values', () => {
    const input = 'eth=("@method" "@query-param";name="authorization" "x-amount");keyid="erc8128:8453:0xabc"';
    const evidence = signedRequestEvidence(signedRequest({ 'signature-input': input, 'x-amount': '5' }));
    expect(evidence.signature).toMatchObject({
      scheme: 'erc-8128',
      key_id: 'erc8128:8453:0xabc',
      request: { url: 'https://agent.example/mcp?token=secret', headers: { 'x-amount': '5' } },
    });
  });

  it.each([
    ['no signature headers', {}],
    ['no signature-input', { 'signature-input': '' }],
    ['an untagged member', { 'signature-input': 'sig1=("@method");keyid="k"' }],
    ['a member without an inner list', { 'signature-input': 'sig1=;tag="web-bot-auth"' }],
    ['a covered authorization header', { 'signature-input': 'sig1=("authorization");tag="web-bot-auth"', authorization: 'Bearer t' }],
    ['a covered cookie', { 'signature-input': 'sig1=("cookie");tag="web-bot-auth"' }],
    ['an oversized header', { 'signature-input': 'sig1=("x-big");tag="web-bot-auth"', 'x-big': 'x'.repeat(9000) }],
    ['a header over 8 KiB of UTF-8', { 'signature-input': 'sig1=("x-big");tag="web-bot-auth"', 'x-big': 'é'.repeat(4097) }],
    ['an oversized signature-input', { 'signature-input': `sig1=("@method");tag="web-bot-auth";n="${'x'.repeat(9000)}"` }],
  ])('returns {} for %s', (_name, headers) => {
    expect(signedRequestEvidence(signedRequest(headers))).toEqual({});
  });

  it('returns {} without a signature, for too many headers, an overlong URL, and never throws', () => {
    const noSignature = new Request('https://a.example', { headers: { 'signature-input': WEB_BOT_AUTH_INPUT } });
    expect(signedRequestEvidence(noSignature)).toEqual({});
    const names = Array.from({ length: 30 }, (_, n) => `x-h${n}`);
    const many = signedRequest({
      'signature-input': `sig1=(${names.map((name) => `"${name}"`).join(' ')});tag="web-bot-auth"`,
      ...Object.fromEntries(names.map((name) => [name, 'v'])),
    });
    expect(signedRequestEvidence(many)).toEqual({});
    const long = signedRequest(
      { 'signature-input': 'sig1=("@target-uri");tag="web-bot-auth"' },
      `https://a.example/?q=${'x'.repeat(3000)}`,
    );
    expect(signedRequestEvidence(long)).toEqual({});
    expect(signedRequestEvidence({} as Request)).toEqual({});
  });

  it('omits an unusable key id', () => {
    const evidence = signedRequestEvidence(signedRequest({ 'signature-input': 'sig1=("@method");tag="web-bot-auth"' }));
    expect(evidence.signature).not.toHaveProperty('key_id');
  });
});

describe('parseInsufficientScope', () => {
  it.each([
    ['Bearer error="insufficient_scope", scope="files:read files:write"', ['files:read', 'files:write']],
    [
      'Bearer scope="a", realm="mcp", error="insufficient_scope", resource_metadata="https://x.example/.well-known/oauth-protected-resource"',
      ['a'],
    ],
    ['DPoP algs="ES256", Bearer realm="x",error=insufficient_scope,scope="b"', ['b']],
    ['Bearer error = "insufficient_scope" , scope = "c\\"d e"', ['e']],
    ['Bearer error="insufficient_scope"', []],
  ])('reads %s', (header, required) => {
    expect(parseInsufficientScope(header)).toEqual({ required });
  });

  it.each([
    [null],
    [''],
    ['Bearer error="invalid_token"'],
    ['Basic realm="x"'],
    ['='],
    [`Bearer error="insufficient_scope", x="${'y'.repeat(9000)}"`],
  ])('returns null for %s', (header) => {
    expect(parseInsufficientScope(header)).toBeNull();
  });

  it('tolerates an unterminated quoted value', () => {
    expect(parseInsufficientScope('Bearer error="insufficient_scope", scope="unterminated')).toEqual({ required: ['unterminated'] });
  });
});
