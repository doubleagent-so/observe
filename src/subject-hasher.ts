/**
 * Internal: hashes authenticated subjects before they leave the process.
 *
 * `HMAC-SHA256(subjectKey, "subject:v1\n" + issuer + "\n" + subject)` as lowercase hex. Keyed, so a hash cannot be
 * reversed by hashing guessed subjects without the key; the issuer keeps equal subjects from different issuers apart.
 */
const encoder = new TextEncoder();

/** Domain separation for subject hashes; a new scheme gets a new version. */
const SUBJECT_HASH_PREFIX = 'subject:v1\n';

const toHex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

export class SubjectHasher {
  readonly #secret: string;
  /**
   * The imported HMAC key, kept once a flush has imported it. The key is cached, never the import's promise: on Workers
   * a promise created in one request must not be awaited in another.
   */
  #key: CryptoKey | undefined;

  constructor(secret: string) {
    this.#secret = secret;
  }

  async hash(issuer: string, subject: string): Promise<string> {
    this.#key ??= await crypto.subtle.importKey('raw', encoder.encode(this.#secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toHex(await crypto.subtle.sign('HMAC', this.#key, encoder.encode(`${SUBJECT_HASH_PREFIX}${issuer}\n${subject}`)));
  }
}
