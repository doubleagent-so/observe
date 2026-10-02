/** Currency facts shared by the recorder and the API: minor-unit exponents and the stablecoins we peg. */

/** A currency code on the wire: an ISO 4217 code or a token symbol (`USD`, `USDC`). */
export const CURRENCY = /^[A-Z0-9]{3,5}$/;

const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const FOUR_DECIMAL = new Set(['CLF', 'UYW']);

/** Supported tokens: on-chain decimals and the fiat currency they are pegged to 1:1. */
const TOKENS: Readonly<Record<string, { exponent: number; peg: string }>> = {
  USDC: { exponent: 6, peg: 'USD' },
  USDT: { exponent: 6, peg: 'USD' },
  EURC: { exponent: 6, peg: 'EUR' },
};

const token = (code: string): { exponent: number; peg: string } | undefined => (Object.hasOwn(TOKENS, code) ? TOKENS[code] : undefined);

/** Digits after the decimal point in one minor unit; null for a code we cannot place (an unknown token). */
export function currencyExponent(code: string): number | null {
  const known = token(code);
  if (known) return known.exponent;
  if (!/^[A-Z]{3}$/.test(code)) return null;
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return FOUR_DECIMAL.has(code) ? 4 : 2;
}

/** The supported stablecoins (`peggedTo` names each one's fiat currency). */
export const PEGGED_TOKENS: readonly string[] = Object.freeze(Object.keys(TOKENS));

/** The fiat currency a supported stablecoin is pegged to 1:1; null for anything else. */
export function peggedTo(code: string): string | null {
  return token(code)?.peg ?? null;
}

/** `value` as a plain decimal string, or '' when it is not a finite number (so it never matches). */
function decimalText(value: number | string): string {
  if (typeof value === 'string') return value.trim();
  return Number.isFinite(value) ? String(value) : '';
}

/**
 * A decimal amount scaled to integer units of 10^-`exponent`, by string arithmetic so binary floats never drift;
 * null when it is not a plain decimal, has more than `exponent` significant decimals, or scales past a safe integer.
 */
function scale(value: number | string, exponent: number, maxWholeDigits: number): number | null {
  const match = new RegExp(`^(-?)(\\d{1,${maxWholeDigits}})(?:\\.(\\d+))?$`).exec(decimalText(value));
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > exponent) return null;
  const units = Number(whole + significant.padEnd(exponent, '0'));
  if (!Number.isSafeInteger(units)) return null;
  // `-0` scales to 0, never to negative zero.
  return sign && units ? -units : units;
}

/** A decimal major-unit amount (e.g. `120.5` USD) in integer minor units; null if it has more decimals than allowed. */
export function toMinorUnits(value: number | string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  return exponent === null ? null : scale(value, exponent, 16);
}

/** A decimal major-unit amount (e.g. a model cost of `0.0042`) in integer millionths; null if finer than a micro. */
export function toMicros(value: number | string): number | null {
  return scale(value, 6, 9);
}
