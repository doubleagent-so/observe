/**
 * Internal: the counterparty checks of the validator (who called, proven how, for whom), plus the scope list shared
 * with operation fields. Every nested object is an allowlist; any problem is `invalid_counterparty`.
 */
import {
  BINDINGS,
  CAPABILITIES,
  DELEGATION_PROTOCOLS,
  FORBIDDEN_SIGNED_HEADERS,
  LIMITS,
  PROOF_KINDS,
  SIGNATURE_SCHEMES,
  type AdvertisedProtocol,
  type CounterpartyEvidence,
  utf8Bytes,
} from './contract.ts';
import { COMPACT_JWS, CONTROL, HEADER_NAME, HTTP_METHOD, PROTOCOL_VERSION, REASON_CODE, SCOPE } from './patterns.ts';
import {
  HEX64,
  Rejection,
  clientInfo,
  list,
  object,
  oneOf,
  onlyKeys,
  optionalText,
  pattern,
  protocolName,
  text,
  time,
  url,
  type RejectionCode,
} from './validate-rules.ts';

const CODE = 'invalid_counterparty';

/** At most `LIMITS.scopes` scope tokens. */
export const scopes = (value: unknown, code: RejectionCode): string[] =>
  list(value, LIMITS.scopes, (entry) => pattern(entry, SCOPE, code), code);

function advertised(value: unknown): AdvertisedProtocol {
  const input = object(value, CODE);
  onlyKeys(input, ['name', 'versions', 'bindings', 'capabilities'], CODE);
  return {
    name: protocolName(input.name, CODE),
    versions: list(input.versions, 8, (entry) => pattern(entry, PROTOCOL_VERSION, CODE), CODE),
    bindings: list(input.bindings, 8, (entry) => oneOf(entry, BINDINGS, CODE), CODE),
    capabilities: list(input.capabilities, LIMITS.listItems, (entry) => oneOf(entry, CAPABILITIES, CODE), CODE),
  };
}

function authenticated(value: unknown): void {
  const input = object(value, CODE);
  onlyKeys(input, ['issuer', 'subject_hash', 'client_id', 'actor', 'scopes'], CODE);
  text(input.issuer, LIMITS.issuer, CODE);
  pattern(input.subject_hash, HEX64, CODE);
  optionalText(input.client_id, LIMITS.clientId, CODE);
  optionalText(input.actor, LIMITS.actor, CODE);
  if (input.scopes !== undefined) scopes(input.scopes, CODE);
}

function verification(value: unknown): void {
  const input = object(value, CODE);
  onlyKeys(input, ['status', 'by', 'reason'], CODE);
  oneOf(input.status, ['verified', 'failed'], CODE);
  if (input.by !== 'reporter') throw new Rejection(CODE);
  if (input.reason !== undefined) pattern(input.reason, REASON_CODE, CODE);
}

function proof(value: unknown): void {
  const input = object(value, CODE);
  onlyKeys(input, ['kind', 'jws'], CODE);
  oneOf(input.kind, PROOF_KINDS, CODE);
  text(input.jws, LIMITS.proof, CODE);
  pattern(input.jws, COMPACT_JWS, CODE);
}

function delegation(value: unknown): void {
  const input = object(value, CODE);
  onlyKeys(
    input,
    [
      'protocol',
      'issuer',
      'principal_hash',
      'actor',
      'client_id',
      'scopes',
      'scopes_used',
      'access',
      'expires_at',
      'grant_id_hash',
      'verification',
      'proof',
    ],
    CODE,
  );
  oneOf(input.protocol, DELEGATION_PROTOCOLS, CODE);
  optionalText(input.issuer, LIMITS.issuer, CODE);
  if (input.principal_hash !== undefined) pattern(input.principal_hash, HEX64, CODE);
  optionalText(input.actor, LIMITS.actor, CODE);
  optionalText(input.client_id, LIMITS.clientId, CODE);
  if (input.scopes !== undefined) scopes(input.scopes, CODE);
  if (input.scopes_used !== undefined) scopes(input.scopes_used, CODE);
  if (input.access !== undefined) oneOf(input.access, ['read', 'write'], CODE);
  if (input.expires_at !== undefined) time(input.expires_at, CODE);
  if (input.grant_id_hash !== undefined) pattern(input.grant_id_hash, HEX64, CODE);
  if (input.verification !== undefined) verification(input.verification);
  if (input.proof !== undefined) {
    // Double Agent verifies proofs of PACT grants only.
    if (input.protocol !== 'pact') throw new Rejection(CODE);
    proof(input.proof);
  }
}

/** A header value as forwarded: any text without control characters (empty is a valid value), at most 8 KiB of UTF-8. */
function headerValue(value: unknown): void {
  if (typeof value !== 'string' || CONTROL.test(value) || utf8Bytes(value) > LIMITS.headerValue) throw new Rejection(CODE);
}

function forwardedRequest(value: unknown): void {
  const input = object(value, CODE);
  onlyKeys(input, ['method', 'url', 'headers'], CODE);
  // The API compares methods upper case.
  pattern(input.method, HTTP_METHOD, CODE);
  url(input.url, CODE);
  const entries = Object.entries(object(input.headers, CODE));
  if (entries.length > LIMITS.signedHeaders) throw new Rejection(CODE);
  for (const [name, entry] of entries) {
    pattern(name, HEADER_NAME, CODE);
    if ((FORBIDDEN_SIGNED_HEADERS as readonly string[]).includes(name)) throw new Rejection(CODE);
    headerValue(entry);
  }
}

/** Verified by the host (`reporter`, with its key id), or forwarded for Double Agent to verify (`double_agent`). */
function signature(value: unknown): void {
  const input = object(value, CODE);
  oneOf(input.scheme, SIGNATURE_SCHEMES, CODE);
  if (input.verified_by === 'reporter') {
    onlyKeys(input, ['scheme', 'key_id', 'verified_by'], CODE);
    text(input.key_id, 256, CODE);
  } else if (input.verified_by === 'double_agent') {
    onlyKeys(input, ['scheme', 'key_id', 'verified_by', 'request'], CODE);
    optionalText(input.key_id, 256, CODE);
    forwardedRequest(input.request);
  } else {
    throw new Rejection(CODE);
  }
}

export function counterparty(value: unknown): CounterpartyEvidence {
  const input = object(value, CODE);
  onlyKeys(
    input,
    ['card_url', 'declared_name', 'client_info', 'authenticated', 'delegation', 'signature', 'network', 'advertised_protocols'],
    CODE,
  );
  if (input.card_url !== undefined) url(input.card_url, CODE);
  if (input.declared_name !== undefined) text(input.declared_name, 128, CODE);
  if (input.client_info !== undefined) clientInfo(input.client_info, CODE);
  if (input.authenticated !== undefined) authenticated(input.authenticated);
  if (input.delegation !== undefined) delegation(input.delegation);
  if (input.signature !== undefined) signature(input.signature);
  if (input.network !== undefined) {
    const network = object(input.network, CODE);
    onlyKeys(network, ['ip_prefix_hash', 'ua_family'], CODE);
    pattern(network.ip_prefix_hash, HEX64, CODE);
    optionalText(network.ua_family, 64, CODE);
  }
  if (input.advertised_protocols !== undefined) list(input.advertised_protocols, LIMITS.protocols, advertised, CODE);
  return input as CounterpartyEvidence;
}
