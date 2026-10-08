/**
 * The one MCP mapping shared by every MCP entry point: JSON-RPC messages in; kinds, targets, parts, errors and task
 * states out. Pure functions; every string they return already fits the wire contract, so the validator never rejects
 * an event for a field that came from the peer (a media type with parameters, an id with spaces, a name with a newline
 * is cleaned or dropped). Internal: not exported from the package.
 *
 * Example: `{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { q: 'x' } } }` is a
 * `tool` operation with target `search` and one `caller` data part `{ q: 'x' }`.
 */
import type { MessageInput, PartInput } from '../content.ts';
import { LIMITS, type Access, type Capability, type Kind, type Role, type TaskState } from '../contract.ts';
import { mediaTypeEssence } from '../media-type.ts';
import { boundedId, CONTROL, cutText, isRecord, MAX_COUNT, PROTOCOL_VERSION, type Json } from '../patterns.ts';

/** A non-empty string without control characters, cut to `max` UTF-16 units (never inside a surrogate pair). */
export function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value || CONTROL.test(value)) return undefined;
  return cutText(value, max);
}

/** A native ID the wire accepts as `conversation_ref` or `task_ref`, never altered; otherwise undefined. */
export const nativeRef = boundedId;

/** An `http(s)` URL of at most 2048 characters, unchanged; otherwise undefined. */
export function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > LIMITS.url || CONTROL.test(value)) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

const DISCOVERY = new Set(['initialize', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const CALLBACK = new Set(['sampling/createMessage', 'elicitation/create', 'roots/list']);
const MANAGEMENT = new Set(['ping', 'logging/setLevel', 'completion/complete', 'resources/subscribe', 'resources/unsubscribe']);

export function mcpKind(method: string): Kind {
  if (method === 'tools/call') return 'tool';
  if (method === 'resources/read') return 'resource';
  if (method === 'prompts/get') return 'prompt';
  if (DISCOVERY.has(method)) return 'discovery';
  if (CALLBACK.has(method)) return 'callback';
  if (MANAGEMENT.has(method) || method.startsWith('tasks/')) return 'management';
  return 'other';
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Everything before the first `?` or `#`. */
const withoutQuery = (text: string): string => text.split(/[?#]/, 1)[0];

/** An `@`, written plainly or percent-encoded. */
const AT = /@|%40/i;

/** What follows the last `@` (or `%40`) of an authority: the host and port without any userinfo. */
function hostOf(authority: string): string {
  const plain = authority.lastIndexOf('@') + 1;
  const encoded = authority.toLowerCase().lastIndexOf('%40');
  return authority.slice(Math.max(plain, encoded === -1 ? 0 : encoded + 3));
}

/**
 * A resource URI as a target that carries no secrets or personal data:
 * - hierarchical (`scheme://authority…`): the authority ends at the first `/`, `?` or `#`, and only what follows its
 *   last `@` (or `%40`) is kept; then query and fragment are dropped. `https://user:p@ss@host/x?sig=1` →
 *   `https://host/x`. An `@` after the authority may be a split userinfo: in the path (with no `:` before it) only
 *   `scheme://host` is kept (`https://host/a@b` → `https://host`); anywhere else only `scheme:`
 *   (`https://user:pa#ss@host/x` → `https:`).
 * - `file:` and opaque URIs (`mailto:`, `tel:`, `data:`, any `scheme:` without `//`): only `scheme:`
 *   (`mailto:alice@x` → `mailto:`, `file:///home/alice/notes.md` → `file:`),
 *   except `urn:`, which names a thing rather than a person, kept without query and fragment (and only `urn:` when it
 *   holds an `@`).
 * - no scheme: the reference without query and fragment, dropped when it holds an `@`.
 */
function resourceTarget(uri: string): string | undefined {
  const scheme = SCHEME.exec(uri)?.[1];
  if (scheme === undefined) return AT.test(uri) ? undefined : bounded(withoutQuery(uri), LIMITS.target);
  // Local file paths name the host's files and users: only the scheme is kept.
  if (scheme.toLowerCase() === 'file') return `${scheme}:`;
  const rest = uri.slice(scheme.length + 1);
  if (!rest.startsWith('//')) {
    const isUrn = scheme.toLowerCase() === 'urn' && !AT.test(uri);
    return isUrn ? bounded(withoutQuery(uri), LIMITS.target) : `${scheme}:`;
  }
  const hierarchy = rest.slice(2);
  const authorityEnd = hierarchy.search(/[/?#]/);
  const authority = authorityEnd === -1 ? hierarchy : hierarchy.slice(0, authorityEnd);
  const after = authorityEnd === -1 ? '' : hierarchy.slice(authorityEnd);
  const host = hostOf(authority);
  const path = withoutQuery(after);
  if (!AT.test(after)) return bounded(`${scheme}://${host}${path}`, LIMITS.target);
  const at = path.search(AT);
  const isPlainPathAt = at !== -1 && !path.slice(0, at).includes(':') && !AT.test(after.slice(path.length));
  return isPlainPathAt ? bounded(`${scheme}://${host}`, LIMITS.target) : `${scheme}:`;
}

/**
 * Tool or prompt name; for `resources/read`, the URI cleaned by `resourceTarget` (templates are not visible on the
 * wire). Never inferred from content. At most 128 characters.
 */
export function mcpTarget(method: string, params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (method === 'tools/call' || method === 'prompts/get') return bounded(params.name, LIMITS.target);
  if (method !== 'resources/read' || typeof params.uri !== 'string') return undefined;
  return resourceTarget(params.uri);
}

/** A negotiated MCP protocol version (`2025-11-25`), trimmed; undefined when the wire would reject it. */
export function mcpVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return PROTOCOL_VERSION.test(trimmed) ? trimmed : undefined;
}

/** The JSON-RPC id in string form, at most 128 characters. */
export function mcpRequestId(id: unknown): string | undefined {
  if (typeof id === 'number') return Number.isFinite(id) ? String(id) : undefined;
  return bounded(id, LIMITS.target);
}

/** `clientInfo` or `serverInfo` from `initialize`: name and version only (never `title`, icons or URLs). */
export function mcpPeerInfo(value: unknown): { name: string; version?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = bounded(value.name, LIMITS.target);
  if (!name) return undefined;
  const version = bounded(value.version, LIMITS.peerVersion);
  return { name, ...(version ? { version } : {}) };
}

const CAPABILITY_KEYS: readonly Capability[] = ['sampling', 'elicitation', 'roots', 'tasks'];

/** Capability flags from the allowlist that the peer declares (present and not null). */
export function mcpCapabilities(value: unknown): Capability[] {
  if (!isRecord(value)) return [];
  return CAPABILITY_KEYS.filter((key) => value[key] !== undefined && value[key] !== null);
}

/** MCP `user` is the caller; `assistant` (and anything else) is the agent. */
export const mcpRole = (native: unknown): Role => (native === 'user' ? 'caller' : 'agent');

/** True for a character of the base64 or base64url alphabet. */
function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x2d || // -
    code === 0x5f // _
  );
}

/** Decoded size of base64 text, without decoding or copying it; line breaks and padding are not data. */
function base64Bytes(value: string): number {
  let symbols = 0;
  for (let index = 0; index < value.length; index++) if (isBase64Char(value.charCodeAt(index))) symbols++;
  return Math.floor((symbols * 3) / 4);
}

/** A byte count the validator accepts, or undefined. */
const byteCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : undefined;

function filePart(name: unknown, mimeType: unknown, bytes: number | undefined): PartInput {
  const fileName = bounded(name, LIMITS.fileName);
  const mediaType = mediaTypeEssence(mimeType);
  return {
    kind: 'file',
    ...(fileName ? { name: fileName } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

/** Resource contents: text as text, blobs as file metadata. The URI is never kept. */
function resourcePart(resource: Json): PartInput | null {
  if (typeof resource.text === 'string') {
    const mediaType = mediaTypeEssence(resource.mimeType);
    return { kind: 'text', text: resource.text, ...(mediaType ? { mediaType } : {}) };
  }
  if (typeof resource.blob === 'string') return filePart(undefined, resource.mimeType, base64Bytes(resource.blob));
  return null;
}

/** One content block; unknown types (`tool_use`, `tool_result`, future ones) are skipped. Never bytes or URIs. */
function contentPart(block: unknown): PartInput | null {
  if (!isRecord(block)) return null;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { kind: 'text', text: block.text } : null;
    case 'image':
    case 'audio':
      return filePart(undefined, block.mimeType, typeof block.data === 'string' ? base64Bytes(block.data) : undefined);
    case 'resource':
      return isRecord(block.resource) ? resourcePart(block.resource) : null;
    case 'resource_link':
      return filePart(block.name, block.mimeType, byteCount(block.size));
    default:
      return null;
  }
}

const isPresent = <Value>(value: Value | null): value is Value => value !== null;

/** A content array or a single content block. */
export function mcpParts(content: unknown): PartInput[] {
  if (content === undefined) return [];
  const blocks: unknown[] = Array.isArray(content) ? content : [content];
  return blocks.map(contentPart).filter(isPresent);
}

/** A `prompts/get` or sampling message: MCP role kept, content mapped like any other. */
function roleMessage(value: unknown): MessageInput | null {
  return isRecord(value) ? { role: mcpRole(value.role), parts: mcpParts(value.content) } : null;
}

/** What a request says: tool arguments, or the messages a server asks the client to sample. */
export function mcpRequestMessages(method: string, params: unknown): MessageInput[] {
  if (!isRecord(params)) return [];
  if (method === 'tools/call' && params.arguments !== undefined)
    return [{ role: 'caller', parts: [{ kind: 'data', json: params.arguments }] }];
  if (method === 'sampling/createMessage' && Array.isArray(params.messages)) return params.messages.map(roleMessage).filter(isPresent);
  return [];
}

/** What a result says. `tasks/result` maps like `tools/call`; a task-creating result says nothing yet. */
export function mcpResultMessages(method: string, result: unknown): MessageInput[] {
  if (!isRecord(result)) return [];
  if (method === 'tools/call' || method === 'tasks/result') {
    const parts = mcpParts(result.content);
    if (result.structuredContent !== undefined) parts.push({ kind: 'data', json: result.structuredContent });
    return parts.length ? [{ role: 'agent', parts }] : [];
  }
  if (method === 'prompts/get' && Array.isArray(result.messages)) return result.messages.map(roleMessage).filter(isPresent);
  if (method === 'resources/read' && Array.isArray(result.contents)) {
    const parts = result.contents.filter(isRecord).map(resourcePart).filter(isPresent);
    return parts.length ? [{ role: 'agent', parts }] : [];
  }
  if (method === 'sampling/createMessage') return [roleMessage(result)].filter(isPresent);
  return [];
}

/**
 * JSON-RPC and MCP error codes with a name; any other code is `jsonrpc_error`. -32000 and -32001 are deliberately not
 * named: servers use that implementation-defined range for anything, and only the SDK client gives them a meaning.
 */
const ERROR_CODES = new Map<number, string>([
  [-32700, 'parse_error'],
  [-32600, 'invalid_request'],
  [-32601, 'method_not_found'],
  [-32602, 'invalid_params'],
  [-32603, 'internal_error'],
  [-32002, 'resource_not_found'],
  [-32042, 'url_elicitation_required'],
]);

/** A JSON-RPC error object as `{ nativeCode, code }`; the message is never kept. */
export function mcpError(error: unknown): { nativeCode: string; code: string } {
  const code = isRecord(error) && typeof error.code === 'number' && Number.isFinite(error.code) ? error.code : undefined;
  if (code === undefined) return { nativeCode: 'unknown', code: 'jsonrpc_error' };
  return { nativeCode: String(code), code: ERROR_CODES.get(code) ?? 'jsonrpc_error' };
}

/** The finish error of a tool result with `isError: true`. */
export const TOOL_ERROR = { nativeCode: 'isError', code: 'tool_error' } as const;

export const isToolError = (method: string, result: unknown): boolean =>
  (method === 'tools/call' || method === 'tasks/result') && isRecord(result) && result.isError === true;

const TASK_STATES = new Map<string, TaskState>([
  ['working', 'working'],
  ['input_required', 'input_required'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['cancelled', 'canceled'],
]);

/** An MCP task status, normalized (`cancelled` → `canceled`, unknown → `unknown`), with the native value kept. */
export function mcpTaskState(native: unknown): { state: TaskState; nativeState: string } {
  const nativeState = bounded(native, LIMITS.nativeState);
  return { state: (nativeState && TASK_STATES.get(nativeState)) || 'unknown', nativeState: nativeState ?? 'unknown' };
}

export interface McpTaskObservation {
  taskRef: string;
  state: TaskState;
  nativeState: string;
}

/**
 * A task-creating result (`{ task }`), a task (`tasks/get`, `tasks/cancel`) or `notifications/tasks/status` params.
 * Null when there is no task, or its id is one the wire would reject.
 */
export function mcpTask(value: unknown): McpTaskObservation | null {
  if (!isRecord(value)) return null;
  const task = isRecord(value.task) ? value.task : value;
  const taskRef = nativeRef(task.taskId);
  if (!taskRef || task.status === undefined) return null;
  return { taskRef, ...mcpTaskState(task.status) };
}

export type McpMessage =
  | { type: 'request'; id: string | number; method: string; params: unknown }
  | { type: 'notification'; method: string; params: unknown }
  | { type: 'result'; id: string | number; result: unknown }
  | { type: 'error'; id: string | number | null; error: unknown };

/** One JSON-RPC 2.0 message, classified; null for anything else (batches are split by the caller). */
export function mcpMessage(value: unknown): McpMessage | null {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return null;
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? value.id : undefined;
  if (typeof value.method === 'string') {
    return id === undefined
      ? { type: 'notification', method: value.method, params: value.params }
      : { type: 'request', id, method: value.method, params: value.params };
  }
  if (id !== undefined && 'result' in value) return { type: 'result', id, result: value.result };
  if ('error' in value) return { type: 'error', id: id ?? null, error: value.error };
  return null;
}

/** x402 over MCP: the payment payload on the request's `params._meta`, the settlement on the result's `_meta`. */
export const X402_PAYMENT_META = 'x402/payment';
export const X402_RESPONSE_META = 'x402/payment-response';

/** `value._meta[key]`, for request params and results; undefined when absent. */
export const mcpMeta = (value: unknown, key: string): unknown => (isRecord(value) && isRecord(value._meta) ? value._meta[key] : undefined);

/** MCP 2026-07-28: every request names its protocol version, and may name the client and its capabilities, in `_meta`. */
export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
export const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

/** What one request says about its client in `_meta` (MCP 2026-07-28); each part only when present and valid. */
export interface McpRequestPeer {
  version?: string;
  clientInfo?: { name: string; version?: string };
  capabilities?: Capability[];
}

/** The request's own client facts from `params._meta`; null when it carries none (a client before 2026-07-28). */
export function mcpRequestPeer(params: unknown): McpRequestPeer | null {
  const version = mcpVersion(mcpMeta(params, PROTOCOL_VERSION_META));
  const clientInfo = mcpPeerInfo(mcpMeta(params, CLIENT_INFO_META));
  const capabilities = mcpMeta(params, CLIENT_CAPABILITIES_META);
  if (!version && !clientInfo && !isRecord(capabilities)) return null;
  return {
    ...(version ? { version } : {}),
    ...(clientInfo ? { clientInfo } : {}),
    ...(isRecord(capabilities) ? { capabilities: mcpCapabilities(capabilities) } : {}),
  };
}

/**
 * What a tool does, from its `annotations` with the MCP defaults: `readOnlyHint: true` is `read`; otherwise
 * `destructiveHint` (default true) is `destructive`, and `destructiveHint: false` is `write`. A tool without an
 * `annotations` object says nothing: undefined.
 */
export function mcpToolAccess(tool: unknown): Access | undefined {
  if (!isRecord(tool) || !isRecord(tool.annotations)) return undefined;
  const { readOnlyHint, destructiveHint } = tool.annotations;
  if (readOnlyHint === true) return 'read';
  return destructiveHint === false ? 'write' : 'destructive';
}
