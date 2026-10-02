/** Part summaries (always sent) and message content (sent only when capture is wanted), within LIMITS. */
import { exceedsDepth, LIMITS, utf8Bytes, type ContentPart, type MessageContent, type PartSummary, type Role } from './contract.ts';
import { mediaTypeEssence } from './media-type.ts';
import { normalizeText } from './patterns.ts';

export type PartInput =
  | { kind: 'text'; text: string; mediaType?: string }
  | { kind: 'data'; json: unknown; mediaType?: string }
  | { kind: 'file'; name?: string; mediaType?: string; bytes?: number };

export interface MessageInput {
  role: Role;
  parts: PartInput[];
  messageId?: string;
  artifact?: boolean;
}

/** The longest prefix of `text` within `maxBytes` of UTF-8, cut only between characters. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let out = '';
  for (const character of text) {
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) break;
    out += character;
    bytes += size;
  }
  return { text: out, truncated: true };
}

const serialized = (json: unknown): string => JSON.stringify(json) ?? 'null';

/** Serialized size of a data part; 0 when it nests too deep to serialize safely. */
const dataBytes = (json: unknown): number => (exceedsDepth(json, LIMITS.dataDepth) ? 0 : utf8Bytes(serialized(json)));

function partBytes(part: PartInput): number {
  if (part.kind === 'text') return utf8Bytes(part.text);
  if (part.kind === 'data') return dataBytes(part.json);
  return part.bytes ?? 0;
}

export function summarizeParts(parts: PartInput[]): PartSummary[] {
  return parts.slice(0, LIMITS.parts).map((part) => {
    const bytes = partBytes(part);
    const mediaType = mediaTypeEssence(part.mediaType);
    return { kind: part.kind, ...(mediaType ? { media_type: mediaType } : {}), bytes };
  });
}

function contentPart(part: PartInput): ContentPart {
  if (part.kind === 'text') return { kind: 'text', ...truncateUtf8(part.text, LIMITS.partBytes) };
  if (part.kind === 'data') {
    const fits = !exceedsDepth(part.json, LIMITS.dataDepth) && utf8Bytes(serialized(part.json)) <= LIMITS.partBytes;
    return fits ? { kind: 'data', json: part.json ?? null, truncated: false } : { kind: 'data', json: null, truncated: true };
  }
  const name = normalizeText(part.name, LIMITS.fileName);
  const mediaType = mediaTypeEssence(part.mediaType);
  return {
    kind: 'file',
    ...(name ? { name } : {}),
    ...(mediaType ? { media_type: mediaType } : {}),
    ...(part.bytes !== undefined ? { bytes: part.bytes } : {}),
  };
}

/** Content within the per-part and total limits; parts that would overflow the total are left out. */
export function buildContent(parts: PartInput[]): MessageContent {
  const content: MessageContent = { parts: [] };
  // Headroom for the wrapper object and the `truncated` flag.
  let bytes = 64;
  for (const part of parts.slice(0, LIMITS.parts)) {
    const built = contentPart(part);
    const size = utf8Bytes(JSON.stringify(built)) + 1;
    if (bytes + size > LIMITS.contentBytes) {
      content.truncated = true;
      break;
    }
    content.parts.push(built);
    bytes += size;
  }
  if (parts.length > LIMITS.parts) content.truncated = true;
  return content;
}
