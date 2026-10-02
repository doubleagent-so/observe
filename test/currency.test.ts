import { describe, expect, it } from 'vitest';
import { currencyExponent, PEGGED_TOKENS, peggedTo, toMicros, toMinorUnits } from '../src/index';

describe('currencies', () => {
  it('knows ISO exponents and token decimals', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('CLF')).toBe(4);
    expect(currencyExponent('UYW')).toBe(4);
    expect(currencyExponent('USDC')).toBe(6);
    expect(currencyExponent('DOGE')).toBeNull();
    expect(currencyExponent('usd')).toBeNull();
  });

  it('pegs supported stablecoins only', () => {
    expect(peggedTo('USDC')).toBe('USD');
    expect(peggedTo('USDT')).toBe('USD');
    expect(peggedTo('EURC')).toBe('EUR');
    expect(peggedTo('USD')).toBeNull();
  });

  it('lists the pegged tokens, each with its peg', () => {
    expect(PEGGED_TOKENS).toEqual(['USDC', 'USDT', 'EURC']);
    for (const code of PEGGED_TOKENS) expect(peggedTo(code)).not.toBeNull();
  });

  it('turns decimal amounts into minor units without float drift', () => {
    expect(toMinorUnits(120.5, 'USD')).toBe(12050);
    expect(toMinorUnits('0.29', 'USD')).toBe(29);
    expect(toMinorUnits('1500', 'JPY')).toBe(1500);
    expect(toMinorUnits('1.2345', 'USD')).toBeNull(); // more decimals than the currency has
    expect(toMinorUnits('abc', 'USD')).toBeNull();
    expect(toMinorUnits(-1, 'USD')).toBe(-100);
    expect(toMinorUnits(1, 'XYZ1')).toBeNull();
    expect(toMinorUnits('9999999999999999', 'USDC')).toBeNull(); // past Number.MAX_SAFE_INTEGER once scaled
  });

  it('scales 4-decimal currencies with their own exponent', () => {
    expect(toMinorUnits('1.2345', 'CLF')).toBe(12_345);
    expect(toMinorUnits('1.23456', 'UYW')).toBeNull();
  });

  it('never returns negative zero', () => {
    expect(Object.is(toMinorUnits('-0', 'USD'), 0)).toBe(true);
    expect(Object.is(toMinorUnits(-0, 'USD'), 0)).toBe(true);
    expect(Object.is(toMicros('-0.000'), 0)).toBe(true);
  });

  it('never reads inherited properties as tokens', () => {
    expect(currencyExponent('toString')).toBeNull();
    expect(peggedTo('constructor')).toBeNull();
  });

  it('turns decimal major units into micros', () => {
    expect(toMicros(0.0042)).toBe(4200);
    expect(toMicros('1.5')).toBe(1_500_000);
    expect(toMicros(3)).toBe(3_000_000);
    expect(toMicros('0.0000001')).toBeNull(); // finer than a micro
    expect(toMicros(1e-7)).toBeNull(); // String(1e-7) is '1e-7': not a plain decimal
    expect(toMicros(Number.NaN)).toBeNull();
  });
});
