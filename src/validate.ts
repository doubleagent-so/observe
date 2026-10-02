/**
 * The one validator for agent telemetry, shared by the recorder's tests and the API's ingest route, so client and
 * server cannot drift. Every check is an allowlist: unknown keys are rejected, never ignored.
 */
import {
  BINDINGS,
  CAPABILITIES,
  COST_CATEGORIES,
  DIRECTIONS,
  EVENT_TYPES,
  KINDS,
  LIMITS,
  MONEY_BASES,
  OUTCOMES,
  PART_KINDS,
  PAYMENT_METHODS,
  ROLES,
  SIGNATURE_SCHEMES,
  TASK_STATES,
  TRANSACTION_KINDS,
  TRANSACTION_STATUSES,
  exceedsDepth,
  isMoneyEvent,
  utf8Bytes,
  type AdvertisedProtocol,
  type AgentEvent,
  type CounterpartyEvidence,
  type EventType,
  type Protocol,
  type ProtocolName,
} from './contract.ts';
import { CURRENCY } from './currency.ts';
import { MEDIA_TYPE } from './media-type.ts';
import { CONTROL, isRecord, MAX_COUNT, METHOD, NATIVE_ID, NETWORK, PROTOCOL_VERSION } from './patterns.ts';

export type RejectionCode =
  | 'invalid_event'
  | 'unknown_field'
  | 'invalid_id'
  | 'invalid_time'
  | 'time_out_of_range'
  | 'invalid_protocol'
  | 'invalid_field'
  | 'invalid_counterparty'
  | 'invalid_protocol_block'
  | 'invalid_parts'
  | 'invalid_content'
  | 'content_too_large'
  | 'event_too_large'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'missing_link';
export type BatchErrorCode = 'invalid_batch' | 'too_many_events' | 'invalid_adapter';

export type EventResult = { ok: true; event: AgentEvent } | { ok: false; code: RejectionCode };
export type BatchResult =
  | { ok: false; code: BatchErrorCode }
  | {
      ok: true;
      adapter: string;
      dropped: number;
      events: AgentEvent[];
      rejected: { index: number; code: RejectionCode }[];
    };

class Rejection extends Error {
  constructor(readonly code: RejectionCode) {
    super(code);
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CUSTOM_PROTOCOL = /^custom:[a-z0-9-]{1,32}$/;
const CUSTOM_KEY = /^[a-z0-9_]{1,32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ADAPTER = /^[A-Za-z0-9@._/+-]{1,64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** A processor name: `stripe`, `coinbase`. */
const SLUG = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

const ENVELOPE = [
  'schema_version',
  'event_id',
  'type',
  'occurred_at',
  'protocol',
  'direction',
  'operation_id',
  'conversation_ref',
  'task_ref',
  'a2a',
  'mcp',
  'custom',
];
const FIELDS: Record<EventType, string[]> = {
  'operation.started': ['method', 'kind', 'target', 'counterparty', 'request_bytes'],
  'operation.finished': ['outcome', 'started_at', 'duration_ms', 'first_byte_ms', 'stream_events', 'response_bytes', 'error'],
  'message.observed': ['message_id', 'role', 'artifact', 'parts', 'content'],
  'task.state_changed': ['state', 'native_state', 'reason'],
  'transaction.recorded': [
    'transaction_id',
    'kind',
    'amount',
    'currency',
    'method',
    'processor',
    'network',
    'basis',
    'status',
    'external_ref',
  ],
  'cost.recorded': ['category', 'amount_micros', 'currency', 'basis', 'usage'],
};

function object(value: unknown, code: RejectionCode): Record<string, unknown> {
  if (!isRecord(value)) throw new Rejection(code);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], code: RejectionCode): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Rejection(code);
}

function text(value: unknown, max: number, code: RejectionCode): string {
  if (typeof value !== 'string' || !value || value.length > max || CONTROL.test(value)) throw new Rejection(code);
  return value;
}

function optionalText(value: unknown, max: number, code: RejectionCode): string | undefined {
  return value === undefined ? undefined : text(value, max, code);
}

function pattern(value: unknown, regex: RegExp, code: RejectionCode): string {
  if (typeof value !== 'string' || !regex.test(value)) throw new Rejection(code);
  return value;
}

function oneOf<Value extends string>(value: unknown, values: readonly Value[], code: RejectionCode): Value {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new Rejection(code);
  return value as Value;
}

function count(value: unknown, code: RejectionCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new Rejection(code);
  return value;
}

function optionalCount(value: unknown, code: RejectionCode): number | undefined {
  return value === undefined ? undefined : count(value, code);
}

function list<Item>(value: unknown, max: number, item: (entry: unknown) => Item, code: RejectionCode): Item[] {
  if (!Array.isArray(value) || value.length > max) throw new Rejection(code);
  return value.map(item);
}

/** An ISO-8601 time in epoch milliseconds. */
function time(value: unknown): number {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) throw new Rejection('invalid_time');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Rejection('invalid_time');
  return ms;
}

function protocolName(value: unknown, code: RejectionCode): ProtocolName {
  if (value === 'a2a' || value === 'mcp') return value;
  return pattern(value, CUSTOM_PROTOCOL, code) as ProtocolName;
}

function protocol(value: unknown): Protocol {
  const input = object(value, 'invalid_protocol');
  onlyKeys(input, ['name', 'version', 'binding'], 'invalid_protocol');
  return {
    name: protocolName(input.name, 'invalid_protocol'),
    version: pattern(input.version, PROTOCOL_VERSION, 'invalid_protocol'),
    binding: oneOf(input.binding, BINDINGS, 'invalid_protocol'),
  };
}

function clientInfo(value: unknown, code: RejectionCode): { name: string; version?: string } {
  const input = object(value, code);
  onlyKeys(input, ['name', 'version'], code);
  const version = optionalText(input.version, LIMITS.peerVersion, code);
  return { name: text(input.name, LIMITS.target, code), ...(version ? { version } : {}) };
}

function a2aBlock(value: unknown): void {
  const code = 'invalid_protocol_block';
  const input = object(value, code);
  onlyKeys(input, ['message_id', 'reference_task_ids', 'extensions_requested', 'extensions_activated'], code);
  if (input.message_id !== undefined) pattern(input.message_id, NATIVE_ID, code);
  if (input.reference_task_ids !== undefined) {
    list(input.reference_task_ids, LIMITS.listItems, (entry) => pattern(entry, NATIVE_ID, code), code);
  }
  for (const key of ['extensions_requested', 'extensions_activated']) {
    if (input[key] !== undefined) list(input[key], LIMITS.listItems, (entry) => text(entry, 512, code), code);
  }
}

function mcpBlock(value: unknown): void {
  const code = 'invalid_protocol_block';
  const input = object(value, code);
  onlyKeys(input, ['request_id', 'client_info', 'capabilities'], code);
  if (input.request_id !== undefined) text(input.request_id, LIMITS.target, code);
  if (input.client_info !== undefined) clientInfo(input.client_info, code);
  if (input.capabilities !== undefined) {
    list(input.capabilities, LIMITS.listItems, (entry) => oneOf(entry, CAPABILITIES, code), code);
  }
}

function customBlock(value: unknown): void {
  const code = 'invalid_protocol_block';
  const input = object(value, code);
  const entries = Object.entries(input);
  if (entries.length > LIMITS.listItems) throw new Rejection(code);
  for (const [key, entry] of entries) {
    pattern(key, CUSTOM_KEY, code);
    if (typeof entry === 'string') text(entry, 256, code);
    else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Rejection(code);
    } else if (typeof entry !== 'boolean') throw new Rejection(code);
  }
}

/** A block is allowed only for its own protocol: `a2a` for A2A, `mcp` for MCP, `custom` for `custom:*`. */
function blocks(input: Record<string, unknown>, name: ProtocolName): void {
  if (input.a2a !== undefined) {
    if (name !== 'a2a') throw new Rejection('invalid_protocol_block');
    a2aBlock(input.a2a);
  }
  if (input.mcp !== undefined) {
    if (name !== 'mcp') throw new Rejection('invalid_protocol_block');
    mcpBlock(input.mcp);
  }
  if (input.custom !== undefined) {
    if (!name.startsWith('custom:')) throw new Rejection('invalid_protocol_block');
    customBlock(input.custom);
  }
}

function url(value: unknown, code: RejectionCode): string {
  const raw = text(value, LIMITS.url, code);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Rejection(code);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Rejection(code);
  return raw;
}

function advertised(value: unknown): AdvertisedProtocol {
  const code = 'invalid_counterparty';
  const input = object(value, code);
  onlyKeys(input, ['name', 'versions', 'bindings', 'capabilities'], code);
  return {
    name: protocolName(input.name, code),
    versions: list(input.versions, 8, (entry) => pattern(entry, PROTOCOL_VERSION, code), code),
    bindings: list(input.bindings, 8, (entry) => oneOf(entry, BINDINGS, code), code),
    capabilities: list(input.capabilities, LIMITS.listItems, (entry) => oneOf(entry, CAPABILITIES, code), code),
  };
}

function counterparty(value: unknown): CounterpartyEvidence {
  const code = 'invalid_counterparty';
  const input = object(value, code);
  onlyKeys(input, ['card_url', 'declared_name', 'client_info', 'authenticated', 'signature', 'network', 'advertised_protocols'], code);
  if (input.card_url !== undefined) url(input.card_url, code);
  if (input.declared_name !== undefined) text(input.declared_name, 128, code);
  if (input.client_info !== undefined) clientInfo(input.client_info, code);
  if (input.authenticated !== undefined) {
    const auth = object(input.authenticated, code);
    onlyKeys(auth, ['issuer', 'subject_hash'], code);
    text(auth.issuer, LIMITS.issuer, code);
    pattern(auth.subject_hash, HEX64, code);
  }
  if (input.signature !== undefined) {
    const signature = object(input.signature, code);
    onlyKeys(signature, ['scheme', 'key_id', 'verified_by'], code);
    oneOf(signature.scheme, SIGNATURE_SCHEMES, code);
    text(signature.key_id, 256, code);
    if (signature.verified_by !== 'reporter') throw new Rejection(code);
  }
  if (input.network !== undefined) {
    const network = object(input.network, code);
    onlyKeys(network, ['ip_prefix_hash', 'ua_family'], code);
    pattern(network.ip_prefix_hash, HEX64, code);
    optionalText(network.ua_family, 64, code);
  }
  if (input.advertised_protocols !== undefined) list(input.advertised_protocols, LIMITS.protocols, advertised, code);
  return input as CounterpartyEvidence;
}

function partSummary(value: unknown): void {
  const code = 'invalid_parts';
  const input = object(value, code);
  onlyKeys(input, ['kind', 'media_type', 'bytes'], code);
  oneOf(input.kind, PART_KINDS, code);
  if (input.media_type !== undefined) pattern(input.media_type, MEDIA_TYPE, code);
  count(input.bytes, code);
}

function contentPart(value: unknown): void {
  const code = 'invalid_content';
  const input = object(value, code);
  if (input.kind === 'text') {
    onlyKeys(input, ['kind', 'text', 'truncated'], code);
    if (typeof input.text !== 'string' || typeof input.truncated !== 'boolean') throw new Rejection(code);
    if (utf8Bytes(input.text) > LIMITS.partBytes) throw new Rejection('content_too_large');
  } else if (input.kind === 'data') {
    onlyKeys(input, ['kind', 'json', 'truncated'], code);
    if (!('json' in input) || typeof input.truncated !== 'boolean') throw new Rejection(code);
    // Depth first: it is bounded and never recurses, while stringifying a hostile deep value can overflow the stack.
    if (exceedsDepth(input.json, LIMITS.dataDepth)) throw new Rejection(code);
    if (utf8Bytes(JSON.stringify(input.json) ?? 'null') > LIMITS.partBytes) throw new Rejection('content_too_large');
  } else if (input.kind === 'file') {
    onlyKeys(input, ['kind', 'name', 'media_type', 'bytes'], code);
    optionalText(input.name, LIMITS.fileName, code);
    if (input.media_type !== undefined) pattern(input.media_type, MEDIA_TYPE, code);
    optionalCount(input.bytes, code);
  } else {
    throw new Rejection(code);
  }
}

function content(value: unknown): void {
  const code = 'invalid_content';
  const input = object(value, code);
  onlyKeys(input, ['parts', 'truncated'], code);
  if (input.truncated !== undefined && typeof input.truncated !== 'boolean') throw new Rejection(code);
  list(input.parts, LIMITS.parts, contentPart, code);
  if (utf8Bytes(JSON.stringify(input)) > LIMITS.contentBytes) throw new Rejection('content_too_large');
}

/** An integer amount within ±`max`; the sign is the caller's to check. */
function amount(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > max) throw new Rejection('invalid_amount');
  return value;
}

function usage(value: unknown): void {
  const code = 'invalid_field';
  const input = object(value, code);
  onlyKeys(input, ['model', 'input_tokens', 'output_tokens', 'units', 'unit'], code);
  optionalText(input.model, 128, code);
  optionalText(input.unit, 32, code);
  for (const key of ['input_tokens', 'output_tokens', 'units']) optionalCount(input[key], code);
}

function costFields(input: Record<string, unknown>): void {
  const code = 'invalid_field';
  if (amount(input.amount_micros, LIMITS.maxMicros) < 0) throw new Rejection('invalid_amount');
  pattern(input.currency, CURRENCY, 'invalid_currency');
  oneOf(input.basis, MONEY_BASES, code);
  oneOf(input.category, COST_CATEGORIES, code);
  if (input.usage !== undefined) usage(input.usage);
}

/** Refunds are negative and everything else is not; `settled` basis needs a settled (or refunded) status. */
function transactionFields(input: Record<string, unknown>): void {
  const code = 'invalid_field';
  const value = amount(input.amount, LIMITS.maxAmount);
  pattern(input.currency, CURRENCY, 'invalid_currency');
  const basis = oneOf(input.basis, MONEY_BASES, code);
  pattern(input.transaction_id, ULID, 'invalid_id');
  const kind = oneOf(input.kind, TRANSACTION_KINDS, code);
  if (kind === 'refund' ? value >= 0 : value < 0) throw new Rejection('invalid_amount');
  oneOf(input.method, PAYMENT_METHODS, code);
  const status = oneOf(input.status, TRANSACTION_STATUSES, code);
  if (basis === 'settled' && status !== 'settled' && status !== 'refunded') throw new Rejection(code);
  if (input.processor !== undefined) pattern(input.processor, SLUG, code);
  if (input.network !== undefined) pattern(input.network, NETWORK, code);
  optionalText(input.external_ref, 256, code);
}

function typeFields(input: Record<string, unknown>, type: EventType): void {
  const code = 'invalid_field';
  if (type === 'operation.started') {
    pattern(input.method, METHOD, code);
    oneOf(input.kind, KINDS, code);
    optionalText(input.target, LIMITS.target, code);
    counterparty(input.counterparty);
    optionalCount(input.request_bytes, code);
  } else if (type === 'operation.finished') {
    oneOf(input.outcome, OUTCOMES, code);
    time(input.started_at);
    count(input.duration_ms, code);
    for (const key of ['first_byte_ms', 'stream_events', 'response_bytes']) optionalCount(input[key], code);
    if (input.error !== undefined) {
      const error = object(input.error, code);
      onlyKeys(error, ['native_code', 'code'], code);
      text(error.native_code, 64, code);
      text(error.code, 64, code);
    }
  } else if (type === 'message.observed') {
    pattern(input.message_id, NATIVE_ID, code);
    oneOf(input.role, ROLES, code);
    if (typeof input.artifact !== 'boolean') throw new Rejection(code);
    list(input.parts, LIMITS.parts, partSummary, 'invalid_parts');
    if (input.content !== undefined) content(input.content);
  } else if (type === 'transaction.recorded') {
    transactionFields(input);
  } else if (type === 'cost.recorded') {
    costFields(input);
  } else {
    if (input.task_ref === undefined) throw new Rejection(code);
    oneOf(input.state, TASK_STATES, code);
    text(input.native_state, LIMITS.nativeState, code);
    optionalText(input.reason, LIMITS.reason, code);
  }
}

function check(value: unknown, nowMs: number): AgentEvent {
  const input = object(value, 'invalid_event');
  if (input.schema_version !== 1) throw new Rejection('invalid_event');
  const type = oneOf(input.type, EVENT_TYPES, 'invalid_event');
  onlyKeys(input, [...ENVELOPE, ...FIELDS[type]], 'unknown_field');
  pattern(input.event_id, ULID, 'invalid_id');
  if (!isMoneyEvent(type)) pattern(input.operation_id, ULID, 'invalid_id');
  else if (input.operation_id !== undefined) pattern(input.operation_id, ULID, 'invalid_id');
  else if (input.task_ref === undefined) throw new Rejection('missing_link');
  if (input.conversation_ref !== undefined) pattern(input.conversation_ref, NATIVE_ID, 'invalid_id');
  if (input.task_ref !== undefined) pattern(input.task_ref, NATIVE_ID, 'invalid_id');
  const occurred = time(input.occurred_at);
  if (occurred < nowMs - LIMITS.pastMs || occurred > nowMs + LIMITS.futureMs) throw new Rejection('time_out_of_range');
  const parsed = protocol(input.protocol);
  oneOf(input.direction, DIRECTIONS, 'invalid_field');
  blocks(input, parsed.name);
  typeFields(input, type);
  const { content: _content, ...envelope } = input;
  if (utf8Bytes(JSON.stringify(envelope)) > LIMITS.envelopeBytes) throw new Rejection('event_too_large');
  return input as unknown as AgentEvent;
}

/** One event against the window around `nowMs` (the API's receipt time). */
export function validateEvent(value: unknown, nowMs: number): EventResult {
  try {
    return { ok: true, event: check(value, nowMs) };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, code: error.code };
    throw error;
  }
}

/** A whole batch: structural problems reject the batch; event problems reject only that event. */
export function validateBatch(value: unknown, nowMs: number): BatchResult {
  if (!isRecord(value) || Object.keys(value).some((key) => !['adapter', 'dropped', 'events'].includes(key))) {
    return { ok: false, code: 'invalid_batch' };
  }
  if (typeof value.adapter !== 'string' || !ADAPTER.test(value.adapter)) return { ok: false, code: 'invalid_adapter' };
  if (!Array.isArray(value.events)) return { ok: false, code: 'invalid_batch' };
  if (
    value.dropped !== undefined &&
    (typeof value.dropped !== 'number' || !Number.isInteger(value.dropped) || value.dropped < 0 || value.dropped > 1e9)
  ) {
    return { ok: false, code: 'invalid_batch' };
  }
  if (value.events.length > LIMITS.batchEvents) return { ok: false, code: 'too_many_events' };
  const events: AgentEvent[] = [];
  const rejected: { index: number; code: RejectionCode }[] = [];
  value.events.forEach((entry, index) => {
    const result = validateEvent(entry, nowMs);
    if (result.ok) events.push(result.event);
    else rejected.push({ index, code: result.code });
  });
  return { ok: true, adapter: value.adapter, dropped: (value.dropped as number | undefined) ?? 0, events, rejected };
}
