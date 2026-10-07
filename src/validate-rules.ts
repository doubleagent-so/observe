/**
 * Internal: the allowlist primitives every check of the validator is built from. Each throws a `Rejection` with the
 * caller's code; `validateEvent` turns it into a result.
 */
import { BINDINGS, LIMITS, type Protocol, type ProtocolName } from './contract.ts';
import { CONTROL, isRecord, MAX_COUNT, PROTOCOL_VERSION } from './patterns.ts';

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

export class Rejection extends Error {
  constructor(readonly code: RejectionCode) {
    super(code);
  }
}

export const HEX64 = /^[a-f0-9]{64}$/;
const CUSTOM_PROTOCOL = /^custom:[a-z0-9-]{1,32}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function object(value: unknown, code: RejectionCode): Record<string, unknown> {
  if (!isRecord(value)) throw new Rejection(code);
  return value;
}

export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], code: RejectionCode): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Rejection(code);
}

export function text(value: unknown, max: number, code: RejectionCode): string {
  if (typeof value !== 'string' || !value || value.length > max || CONTROL.test(value)) throw new Rejection(code);
  return value;
}

export function optionalText(value: unknown, max: number, code: RejectionCode): string | undefined {
  return value === undefined ? undefined : text(value, max, code);
}

export function pattern(value: unknown, regex: RegExp, code: RejectionCode): string {
  if (typeof value !== 'string' || !regex.test(value)) throw new Rejection(code);
  return value;
}

export function oneOf<Value extends string>(value: unknown, values: readonly Value[], code: RejectionCode): Value {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new Rejection(code);
  return value as Value;
}

export function count(value: unknown, code: RejectionCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new Rejection(code);
  return value;
}

export function optionalCount(value: unknown, code: RejectionCode): number | undefined {
  return value === undefined ? undefined : count(value, code);
}

export function list<Item>(value: unknown, max: number, item: (entry: unknown) => Item, code: RejectionCode): Item[] {
  if (!Array.isArray(value) || value.length > max) throw new Rejection(code);
  return value.map(item);
}

/** An ISO-8601 time in epoch milliseconds. */
export function time(value: unknown, code: RejectionCode = 'invalid_time'): number {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) throw new Rejection(code);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Rejection(code);
  return ms;
}

export function protocolName(value: unknown, code: RejectionCode): ProtocolName {
  if (value === 'a2a' || value === 'mcp') return value;
  return pattern(value, CUSTOM_PROTOCOL, code) as ProtocolName;
}

export function protocol(value: unknown): Protocol {
  const input = object(value, 'invalid_protocol');
  onlyKeys(input, ['name', 'version', 'binding'], 'invalid_protocol');
  return {
    name: protocolName(input.name, 'invalid_protocol'),
    version: pattern(input.version, PROTOCOL_VERSION, 'invalid_protocol'),
    binding: oneOf(input.binding, BINDINGS, 'invalid_protocol'),
  };
}

export function clientInfo(value: unknown, code: RejectionCode): { name: string; version?: string } {
  const input = object(value, code);
  onlyKeys(input, ['name', 'version'], code);
  const version = optionalText(input.version, LIMITS.peerVersion, code);
  return { name: text(input.name, LIMITS.target, code), ...(version ? { version } : {}) };
}

/** An `http(s)` URL of at most `LIMITS.url` characters. */
export function url(value: unknown, code: RejectionCode): string {
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
