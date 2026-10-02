/** ULIDs (https://github.com/ulid/spec): 48-bit millisecond time then 80 random bits, Crockford base32. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number = Date.now(), random: Uint8Array = crypto.getRandomValues(new Uint8Array(10))): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 2 ** 48 - 1) throw new RangeError('ulid time out of range');
  let time = '';
  let rest = nowMs;
  for (let index = 0; index < 10; index++) {
    time = ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let tail = '';
  let value = 0;
  let bits = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      tail += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return time + tail;
}
