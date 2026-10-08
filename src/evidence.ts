/**
 * Helpers that turn what a host already verified into counterparty evidence, and read the insufficient-scope challenge
 * of a 403. Pure, bounded and non-throwing: bad input yields less evidence, never an exception.
 *
 * Example: the claims `{ iss: 'https://auth.example', sub: 'alice', client_id: 'app', scope: 'a b', act: { sub: 'agent-7' } }`
 * give `authenticated { issuer, subject: 'alice', client_id: 'app', actor: 'agent-7', scopes: ['a', 'b'] }` and an
 * `oauth` delegation for `alice` acted on by `agent-7`.
 */
import { FORBIDDEN_SIGNED_HEADERS, LIMITS, utf8Bytes, type SignatureEvidence, type SignatureScheme } from './contract.ts';
import { CONTROL, HEADER_NAME, HTTP_METHOD, isRecord, SCOPE } from './patterns.ts';
import type { AuthenticatedInput, CounterpartyInput, DelegationInput } from './recorder.ts';

/** Longest raw subject, principal or grant id taken from claims; longer ones are dropped (they are hashed, never cut). */
const MAX_RAW_ID = 1024;
/** Longest header a parser here reads; longer ones are ignored. */
const MAX_HEADER = 8192;

/** A non-empty string without control characters, at most `max` units; otherwise undefined (never cut). */
function whole(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value && value.length <= max && !CONTROL.test(value) ? value : undefined;
}

/** The candidate entries of a scope claim: a space-separated string split, or an array (bounded); else undefined. */
function scopeEntries(value: unknown): unknown[] | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_HEADER).split(' ');
  return Array.isArray(value) ? value.slice(0, 256) : undefined;
}

/** Valid scope tokens from a space-separated string or an array of strings: unique, at most `LIMITS.scopes`. */
export function scopeList(value: unknown): string[] | undefined {
  const raw = scopeEntries(value);
  if (!raw) return undefined;
  const scopes = [...new Set(raw.filter((entry): entry is string => typeof entry === 'string' && SCOPE.test(entry)))];
  return scopes.slice(0, LIMITS.scopes);
}

/** An RFC 8693 actor: the outermost `act.sub` is the current actor; nested `act` claims are earlier actors, ignored. */
function actorOf(act: unknown): string | undefined {
  return isRecord(act) ? whole(act.sub, LIMITS.actor) : undefined;
}

/** Seconds since the epoch as ISO-8601 with milliseconds; undefined for anything else. */
function expiry(exp: unknown): string | undefined {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  const date = new Date(exp * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** What both the principal and the grant carry: the client, the current actor and the granted scopes. */
function grantedTo(claims: Record<string, unknown>): Pick<AuthenticatedInput, 'client_id' | 'actor' | 'scopes'> {
  const clientId = whole(claims.client_id, LIMITS.clientId) ?? whole(claims.azp, LIMITS.clientId);
  const actor = actorOf(claims.act);
  const scopes = scopeList(claims.scope) ?? scopeList(claims.scp);
  return {
    ...(clientId ? { client_id: clientId } : {}),
    ...(actor ? { actor } : {}),
    ...(scopes?.length ? { scopes } : {}),
  };
}

export interface OAuthEvidenceOptions {
  /** The issuer when the claims carry no `iss` (an opaque token's introspection response). */
  issuer?: string;
}

/**
 * Counterparty evidence from the claims of an OAuth access token **the host has already verified** (signature,
 * audience, expiry). The recorder never sees or sends the token: only the issuer, the subject (hashed before it leaves
 * the process), the client id, the acting agent and the scopes. With an RFC 8693 `act` claim (an agent acting for the
 * subject) it adds an `oauth` delegation for the subject, with `grant_id` (hashed) when the claims carry one.
 *
 * Returns `{}` without an issuer or a subject. Claims of the wrong type are ignored.
 */
export function oauthEvidence(
  claims: Record<string, unknown>,
  options: OAuthEvidenceOptions = {},
): Pick<CounterpartyInput, 'authenticated' | 'delegation'> {
  try {
    if (!isRecord(claims)) return {};
    const issuer = whole(claims.iss, LIMITS.issuer) ?? whole(options.issuer, LIMITS.issuer);
    const subject = whole(claims.sub, MAX_RAW_ID);
    if (!issuer || !subject) return {};
    const shared = grantedTo(claims);
    const authenticated: AuthenticatedInput = { issuer, subject, ...shared };
    if (!isRecord(claims.act)) return { authenticated };
    const expiresAt = expiry(claims.exp);
    const grantId = whole(claims.grant_id, MAX_RAW_ID);
    const delegation: DelegationInput = {
      protocol: 'oauth',
      issuer,
      principal: subject,
      ...shared,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      ...(grantId ? { grant_id: grantId } : {}),
      verification: { status: 'verified', by: 'reporter' },
    };
    return { authenticated, delegation };
  } catch {
    return {};
  }
}

/** Splits a structured-field dictionary or list on top-level commas (outside quotes and parentheses). Linear. */
function splitMembers(value: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let isQuoted = false;
  let from = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (isQuoted) {
      if (char === '\\') index++;
      else if (char === '"') isQuoted = false;
    } else if (char === '"') isQuoted = true;
    else if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      members.push(value.slice(from, index).trim());
      from = index + 1;
    }
  }
  members.push(value.slice(from).trim());
  return members.filter(Boolean);
}

/** One `Signature-Input` member: the covered component names and its parameters. */
interface SignatureMember {
  components: string[];
  keyId?: string;
  tag?: string;
}

/** `label=("@method" "content-digest";sf);keyid="k";tag="web-bot-auth"` → its components and parameters. */
function parseMember(member: string): SignatureMember | null {
  const open = member.indexOf('(');
  const close = member.indexOf(')', open + 1);
  if (open === -1 || close === -1) return null;
  // Item names only: each item starts a quoted string after the `(` or a space; `;name="x"` parameters follow a `;`.
  const components = [...member.slice(open + 1, close).matchAll(/(?:^|\s)"([^"\\]*)"/g)].map((match) => match[1].toLowerCase());
  const params = member.slice(close + 1);
  const keyId = /;\s*keyid="([^"\\]*)"/.exec(params)?.[1];
  const tag = /;\s*tag="([^"\\]*)"/.exec(params)?.[1];
  return { components, ...(keyId !== undefined ? { keyId } : {}), ...(tag !== undefined ? { tag } : {}) };
}

/** The member to verify and its scheme: the first tagged `web-bot-auth`, else the first that names `erc8128`. */
function signatureMember(signatureInput: string): { scheme: SignatureScheme; member: SignatureMember } | null {
  const members = splitMembers(signatureInput);
  for (const raw of members) {
    const member = parseMember(raw);
    if (member?.tag === 'web-bot-auth') return { scheme: 'web-bot-auth', member };
  }
  for (const raw of members) {
    const member = parseMember(raw);
    if (member && raw.toLowerCase().includes('erc8128')) return { scheme: 'erc-8128', member };
  }
  return null;
}

/** Derived components that need the query; without one of them the query is never forwarded. */
const QUERY_COMPONENTS = new Set(['@target-uri', '@request-target', '@query', '@query-param']);

/** The URL to forward: without its fragment, and without its query unless the signature covers it. */
function forwardedUrl(raw: string, components: readonly string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  parsed.hash = '';
  if (!components.some((component) => QUERY_COMPONENTS.has(component))) parsed.search = '';
  const url = parsed.toString();
  return url.length <= LIMITS.url ? url : undefined;
}

const isForwardableValue = (value: string): boolean => !CONTROL.test(value) && utf8Bytes(value) <= LIMITS.headerValue;

/**
 * A Web Bot Auth or ERC-8128 request signature, forwarded so Double Agent verifies it itself (`verified_by:
 * 'double_agent'`). Forwards only the method, the URL (its query only when signed) and the headers the signature needs:
 * `signature`, `signature-input`, `signature-agent` and those it covers. Returns `{}` when there is no such signature,
 * when it covers `authorization`, `cookie` or `proxy-authorization` (it cannot be verified without sending a
 * credential), or when anything is too large for the wire.
 */
export function signedRequestEvidence(request: Request): { signature?: SignatureEvidence } {
  try {
    const signatureInput = request.headers.get('signature-input');
    if (!signatureInput || !request.headers.get('signature') || signatureInput.length > MAX_HEADER) return {};
    const found = signatureMember(signatureInput);
    if (!found) return {};
    const { scheme, member } = found;
    const covered = member.components.filter((component) => !component.startsWith('@'));
    if (covered.some((name) => (FORBIDDEN_SIGNED_HEADERS as readonly string[]).includes(name))) return {};
    const names = [...new Set(['signature', 'signature-input', 'signature-agent', ...covered])];
    const headers: Record<string, string> = {};
    for (const name of names) {
      const value = request.headers.get(name);
      if (value === null) continue;
      if (!HEADER_NAME.test(name) || !isForwardableValue(value)) return {};
      headers[name] = value;
    }
    const url = forwardedUrl(request.url, member.components);
    if (!url || !HTTP_METHOD.test(request.method) || Object.keys(headers).length > LIMITS.signedHeaders) return {};
    const keyId = whole(member.keyId, 256);
    return {
      signature: {
        scheme,
        ...(keyId ? { key_id: keyId } : {}),
        verified_by: 'double_agent',
        request: { method: request.method, url, headers },
      },
    };
  } catch {
    return {};
  }
}

/** One auth-param or bare token of a `WWW-Authenticate` header, in order. */
type ChallengeItem = { name: string; value?: string };

const isSeparator = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === ',';
const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';

/** The index of the first character at or after `index` that `skip` does not match. */
function skipWhile(header: string, index: number, skip: (char: string | undefined) => boolean): number {
  let at = index;
  while (at < header.length && skip(header[at])) at++;
  return at;
}

/** A quoted string starting at the opening quote, unescaped, and the index after its closing quote. */
function quoted(header: string, open: number): [string, number] {
  let value = '';
  let index = open + 1;
  while (index < header.length && header[index] !== '"') {
    if (header[index] === '\\') index++;
    value += header[index] ?? '';
    index++;
  }
  return [value, index + 1];
}

/** Tokenizes a `WWW-Authenticate` value into scheme tokens and `name=value` params. Linear; quoted strings unescaped. */
function challengeItems(header: string): ChallengeItem[] {
  const items: ChallengeItem[] = [];
  let index = 0;
  while (index < header.length) {
    const from = skipWhile(header, index, isSeparator);
    index = skipWhile(header, from, (char) => !isSeparator(char) && char !== '=');
    const name = header.slice(from, index);
    const equals = skipWhile(header, index, isBlank);
    if (header[equals] !== '=') {
      if (name) items.push({ name });
      continue;
    }
    const start = skipWhile(header, equals + 1, isBlank);
    let value: string;
    if (header[start] === '"') [value, index] = quoted(header, start);
    else {
      index = skipWhile(header, start, (char) => !isSeparator(char));
      value = header.slice(start, index);
    }
    if (name) items.push({ name: name.toLowerCase(), value });
  }
  return items;
}

/**
 * The scopes a server asks for in an RFC 6750 `insufficient_scope` challenge (`Bearer error="insufficient_scope",
 * scope="files:read files:write"`), as MCP authorization uses on HTTP 403. Params in any order, other params and
 * challenges tolerated. `{ required: [] }` when the challenge names no scope; null when there is no such challenge.
 */
export function parseInsufficientScope(wwwAuthenticate: string | null): { required: string[] } | null {
  try {
    if (!wwwAuthenticate || wwwAuthenticate.length > MAX_HEADER) return null;
    let params = new Map<string, string>();
    const challenges: Map<string, string>[] = [params];
    for (const item of challengeItems(wwwAuthenticate)) {
      if (item.value === undefined) {
        params = new Map();
        challenges.push(params);
      } else if (!params.has(item.name)) {
        params.set(item.name, item.value);
      }
    }
    const challenge = challenges.find((entry) => entry.get('error') === 'insufficient_scope');
    return challenge ? { required: scopeList(challenge.get('scope') ?? '') ?? [] } : null;
  } catch {
    return null;
  }
}

/** `{ insufficientScope }` for a 403 with an `insufficient_scope` challenge, to spread into a finish; `{}` otherwise. */
export function insufficientScope(response: Response): { insufficientScope?: { required: string[] } } {
  if (response.status !== 403) return {};
  const challenge = parseInsufficientScope(response.headers.get('www-authenticate'));
  return challenge ? { insufficientScope: challenge } : {};
}
