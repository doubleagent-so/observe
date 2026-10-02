import { describe, expect, it } from 'vitest';
import { utf8Bytes } from '../src/contract';
import { buildContent, LIMITS, summarizeParts, truncateUtf8, ulid } from '../src/index';

describe('ulid', () => {
  it('encodes time then 80 random bits in Crockford base32', () => {
    expect(ulid(0, new Uint8Array(10))).toBe('0'.repeat(26));
    expect(ulid(1, new Uint8Array(10).fill(255))).toBe(`${'0'.repeat(9)}1${'Z'.repeat(16)}`);
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(Date.UTC(2026, 9, 1)) < ulid(Date.UTC(2026, 9, 2))).toBe(true);
    expect(() => ulid(-1)).toThrow(RangeError);
  });
});

describe('truncateUtf8', () => {
  it('never splits a multi-byte character', () => {
    expect(truncateUtf8('héllo', 100)).toEqual({ text: 'héllo', truncated: false });
    const emoji = '😀'.repeat(10); // 4 bytes each
    const cut = truncateUtf8(emoji, 10);
    expect(cut).toEqual({ text: '😀😀', truncated: true });
    expect(utf8Bytes(cut.text)).toBeLessThanOrEqual(10);
    expect(truncateUtf8(`${'a'.repeat(LIMITS.partBytes - 1)}é`, LIMITS.partBytes).truncated).toBe(true);
  });
});

describe('summarizeParts and buildContent', () => {
  it('summarizes sizes and media types without content', () => {
    expect(
      summarizeParts([
        { kind: 'text', text: 'hé' },
        { kind: 'data', json: { a: 1 }, mediaType: 'application/json' },
        { kind: 'file', name: 'a.pdf', bytes: 9 },
      ]),
    ).toEqual([
      { kind: 'text', bytes: 3 },
      { kind: 'data', media_type: 'application/json', bytes: 7 },
      { kind: 'file', bytes: 9 },
    ]);
  });

  it('truncates oversized text and data, keeps file metadata only, and caps the total', () => {
    const content = buildContent([
      { kind: 'text', text: 'x'.repeat(LIMITS.partBytes + 10) },
      { kind: 'data', json: { big: 'y'.repeat(LIMITS.partBytes) } },
      { kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', bytes: 3 },
    ]);
    expect(content.parts[0]).toMatchObject({ kind: 'text', truncated: true });
    expect(content.parts[1]).toEqual({ kind: 'data', json: null, truncated: true });
    expect(content.parts[2]).toEqual({ kind: 'file', name: 'a.pdf', media_type: 'application/pdf', bytes: 3 });
    const many = buildContent(Array.from({ length: 5 }, () => ({ kind: 'text' as const, text: 'z'.repeat(30_000) })));
    expect(many.truncated).toBe(true);
    expect(utf8Bytes(JSON.stringify(many))).toBeLessThanOrEqual(LIMITS.contentBytes);
    expect(buildContent(Array.from({ length: 70 }, () => ({ kind: 'text' as const, text: 'a' }))).parts).toHaveLength(LIMITS.parts);
  });

  it('survives hostile depth and width without throwing', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 10_000; index++) deep = { next: deep };
    const wide = Array.from({ length: 200_000 }, () => 0);
    const content = buildContent([
      { kind: 'data', json: deep },
      { kind: 'data', json: wide },
    ]);
    expect(content.parts).toEqual([
      { kind: 'data', json: null, truncated: true },
      { kind: 'data', json: null, truncated: true },
    ]);
    expect(() => summarizeParts([{ kind: 'data', json: deep }])).not.toThrow();
    expect(summarizeParts([{ kind: 'data', json: deep }])).toEqual([{ kind: 'data', bytes: 0 }]);
  });

  it('handles files without metadata, undefined data and media types', () => {
    const content = buildContent([
      { kind: 'file' },
      { kind: 'data', json: undefined },
      { kind: 'text', text: 'a', mediaType: 'text/plain' },
    ]);
    expect(content.parts).toEqual([
      { kind: 'file' },
      { kind: 'data', json: null, truncated: false },
      { kind: 'text', text: 'a', truncated: false },
    ]);
    expect(summarizeParts([{ kind: 'file' }, { kind: 'text', text: 'a', mediaType: 'text/plain' }])).toEqual([
      { kind: 'file', bytes: 0 },
      { kind: 'text', media_type: 'text/plain', bytes: 1 },
    ]);
    expect(buildContent([{ kind: 'file', name: 'n'.repeat(300) }]).parts[0]).toMatchObject({ name: 'n'.repeat(256) });
  });
});

describe('host input the validator would reject', () => {
  it('strips control characters from file names and keeps only the essence of a media type', () => {
    const parts = [
      { kind: 'file' as const, name: 'report\n\u0000.pdf', mediaType: 'application/pdf', bytes: 3 },
      { kind: 'text' as const, text: 'hi', mediaType: 'text/plain; charset=utf-8' },
      { kind: 'file' as const, name: '\r\n', mediaType: 'not a media type' },
    ];
    expect(buildContent(parts).parts).toEqual([
      { kind: 'file', name: 'report.pdf', media_type: 'application/pdf', bytes: 3 },
      { kind: 'text', text: 'hi', truncated: false },
      { kind: 'file' },
    ]);
    expect(summarizeParts(parts)).toEqual([
      { kind: 'file', media_type: 'application/pdf', bytes: 3 },
      { kind: 'text', media_type: 'text/plain', bytes: 2 },
      { kind: 'file', bytes: 0 },
    ]);
  });
});

describe('ulid range', () => {
  it('rejects a time beyond 48 bits', () => {
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });
});
