import { describe, expect, it } from 'vitest';
import { normalizeText } from '../src/patterns';

describe('normalizeText', () => {
  it('strips control characters and keeps everything else', () => {
    expect(normalizeText('re\u0000port\n.pdf\u007f', 256)).toBe('report.pdf');
    expect(normalizeText('Flug-Agent ✈️', 128)).toBe('Flug-Agent ✈️');
  });

  it('bounds the length without splitting a surrogate pair', () => {
    expect(normalizeText('abcdef', 4)).toBe('abcd');
    expect(normalizeText(`ab${'😀'}`, 3)).toBe('ab');
  });

  it('is undefined for anything that is not a non-empty string once cleaned', () => {
    expect(normalizeText(undefined, 10)).toBeUndefined();
    expect(normalizeText(42, 10)).toBeUndefined();
    expect(normalizeText('', 10)).toBeUndefined();
    expect(normalizeText('\n\r\t', 10)).toBeUndefined();
  });
});
