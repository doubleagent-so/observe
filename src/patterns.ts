/**
 * Internal: wire rules the validator enforces, shared so adapters never produce an event it rejects, and the plain
 * object check every JSON reader uses.
 */

/**
 * The longest native id: longer ids are dropped, never truncated, so two ids cannot collide, and per-task state keys
 * stay small.
 */
export const MAX_ID = 256;

/** A native id (task, context, message): 1–MAX_ID printable ASCII characters, no spaces. */
export const NATIVE_ID = new RegExp(`^[\\x21-\\x7e]{1,${MAX_ID}}$`);

/** An id the validator accepts (1–MAX_ID printable ASCII characters, no spaces), or undefined. Never altered. */
export const boundedId = (value: unknown): string | undefined => (typeof value === 'string' && NATIVE_ID.test(value) ? value : undefined);

/** Control characters, which no free-text wire field may contain. */
export const CONTROL = /[\u0000-\u001f\u007f]/;

const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/**
 * Free text from a host or a remote peer made safe for a wire field: control characters stripped and cut to `max`
 * UTF-16 units (never inside a surrogate pair); undefined when nothing is left. `'a\nb.pdf'` → `'ab.pdf'`.
 */
export function normalizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return cutText(value.replace(CONTROL_ALL, ''), max);
}

/** `text` cut to `max` UTF-16 units, never inside a surrogate pair; undefined when nothing is left. */
export function cutText(text: string, max: number): string | undefined {
  if (text.length <= max) return text || undefined;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max) || undefined;
}

/** A protocol version as sent on the wire: `1.0`, `2025-11-25`. */
export const PROTOCOL_VERSION = /^[A-Za-z0-9.+-]{1,32}$/;

/** The largest count (bytes, events) the validator accepts. */
export const MAX_COUNT = 2 ** 40;

/** A method name as sent on the wire. */
export const METHOD = /^[A-Za-z0-9_./:-]{1,64}$/;

/** A network name, case kept: `base`, `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (CAIP-2 ids are case-sensitive). */
export const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type Json = Record<string, unknown>;

/** A plain object: not null and not an array. For JSON bodies and wire shapes. */
export const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
