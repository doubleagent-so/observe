/**
 * The one A2A mapping shared by every entry point. Accepts A2A 1.0 wire JSON, 0.3 wire JSON and the official SDK's
 * in-process objects (ts-proto: numeric enums, `content.$case` parts, `payload.$case` stream events).
 */
import type { MessageInput, PartInput } from '../content.ts';
import { LIMITS, utf8Bytes, type A2aBlock, type Kind, type Role, type TaskState } from '../contract.ts';
import { mediaTypeEssence } from '../media-type.ts';
import { CONTROL, METHOD, normalizeText } from '../patterns.ts';
import { boundedId as id } from './ids.ts';
import { VERSION, isRecord, type Json } from './util.ts';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const MESSAGE = new Set(['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']);
const DISCOVERY = new Set(['GetExtendedAgentCard', 'agent/getAuthenticatedExtendedCard', 'GetAgentCard']);
const MANAGEMENT = new Set([
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'tasks/get',
  'tasks/list',
  'tasks/cancel',
  'tasks/resubscribe',
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list',
  'tasks/pushNotificationConfig/delete',
]);
const STREAMING = new Set(['SendStreamingMessage', 'SubscribeToTask', 'message/stream', 'tasks/resubscribe']);

/** 0.3 wire method → its A2A 1.0 name. */
const CANONICAL = new Map(
  Object.entries({
    'message/send': 'SendMessage',
    'message/stream': 'SendStreamingMessage',
    'tasks/get': 'GetTask',
    'tasks/list': 'ListTasks',
    'tasks/cancel': 'CancelTask',
    'tasks/resubscribe': 'SubscribeToTask',
    'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig',
    'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig',
    'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs',
    'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig',
    'agent/getAuthenticatedExtendedCard': 'GetExtendedAgentCard',
  }),
);

/**
 * The method recorded: the A2A 1.0 name for any known 1.0 or 0.3 wire method, else the native string when it is a
 * valid wire method, else `unknown`. The version and binding still say which wire form was used.
 */
export function a2aMethod(native: string): string {
  return CANONICAL.get(native) ?? (METHOD.test(native) ? native : 'unknown');
}

export function a2aKind(method: string): Kind {
  if (MESSAGE.has(method)) return 'message';
  if (DISCOVERY.has(method)) return 'discovery';
  if (MANAGEMENT.has(method)) return 'management';
  return 'other';
}

/** The `A2A-Version` header when valid, else inferred: slash methods are 0.3, PascalCase methods 1.0. */
export function a2aVersion(method: string, header?: string | null): string {
  if (typeof method !== 'string') return '1.0';
  if (header && VERSION.test(header.trim())) return header.trim();
  return method.includes('/') ? '0.3' : '1.0';
}

export const a2aBinding = (method: string): 'jsonrpc-http' | 'sse' => (STREAMING.has(method) ? 'sse' : 'jsonrpc-http');

const STATE_NAMES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
];
const STATES = new Map<string, TaskState>(
  Object.entries({
    submitted: 'submitted',
    working: 'working',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled',
    cancelled: 'canceled',
    input_required: 'input_required',
    'input-required': 'input_required',
    rejected: 'rejected',
    auth_required: 'auth_required',
    'auth-required': 'auth_required',
  } as Record<string, TaskState>),
);

export function a2aTaskState(native: unknown): { state: TaskState; nativeState: string } {
  // A peer's state string is cleaned to what the validator accepts, so it can never get the event rejected.
  const name = typeof native === 'number' ? STATE_NAMES[native] : normalizeText(native, LIMITS.nativeState);
  if (!name) return { state: 'unknown', nativeState: typeof native === 'number' ? String(native) : 'unknown' };
  const key = name.replace(/^TASK_STATE_/, '').toLowerCase();
  return { state: STATES.get(key) ?? 'unknown', nativeState: name };
}

export function a2aRole(native: unknown): Role {
  return native === 1 || native === 'ROLE_USER' || native === 'user' ? 'caller' : 'agent';
}

/** Bytes of base64 text without decoding it. */
function base64Bytes(value: string): number {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  return Math.floor((end * 3) / 4);
}

function filePart(name: unknown, mediaType: unknown, bytes: number | undefined): PartInput {
  const fileName = normalizeText(name, LIMITS.fileName);
  const essence = mediaTypeEssence(mediaType);
  return {
    kind: 'file',
    ...(fileName ? { name: fileName } : {}),
    ...(essence ? { mediaType: essence } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

function part(value: unknown): PartInput | null {
  if (!isRecord(value)) return null;
  const content = isRecord(value.content) ? value.content : null;
  if (content) {
    if (content.$case === 'text' && typeof content.value === 'string') return { kind: 'text', text: content.value };
    if (content.$case === 'data') return { kind: 'data', json: content.value ?? null };
    if (content.$case === 'raw')
      return filePart(value.filename, value.mediaType, content.value instanceof Uint8Array ? content.value.byteLength : undefined);
    if (content.$case === 'url') return filePart(value.filename, value.mediaType, undefined);
    return null;
  }
  if (value.kind === 'text' || (value.kind === undefined && typeof value.text === 'string'))
    return typeof value.text === 'string' ? { kind: 'text', text: value.text } : null;
  if (value.kind === 'data' || (value.kind === undefined && 'data' in value)) return { kind: 'data', json: value.data ?? null };
  if (value.kind === 'file' && isRecord(value.file)) {
    const file = value.file;
    return filePart(file.name, file.mimeType, typeof file.bytes === 'string' ? base64Bytes(file.bytes) : undefined);
  }
  if (typeof value.raw === 'string') return filePart(value.filename, value.mediaType, base64Bytes(value.raw));
  if (typeof value.url === 'string') return filePart(value.filename, value.mediaType, undefined);
  return null;
}

export function a2aParts(parts: unknown): PartInput[] {
  return Array.isArray(parts) ? parts.map(part).filter((entry): entry is PartInput => entry !== null) : [];
}

const ERROR_CODES: Record<number, string> = {
  [-32700]: 'parse_error',
  [-32600]: 'invalid_request',
  [-32601]: 'method_not_found',
  [-32602]: 'invalid_params',
  [-32603]: 'internal_error',
  [-32001]: 'task_not_found',
  [-32002]: 'task_not_cancelable',
  [-32003]: 'push_notification_not_supported',
  [-32004]: 'unsupported_operation',
  [-32005]: 'content_type_not_supported',
  [-32006]: 'invalid_agent_response',
  [-32007]: 'extended_card_not_configured',
  [-32009]: 'version_not_supported',
};

export function a2aError(error: unknown): { nativeCode: string; code: string } {
  const code = isRecord(error) && typeof error.code === 'number' ? error.code : undefined;
  return { nativeCode: code === undefined ? 'unknown' : String(code), code: (code !== undefined && ERROR_CODES[code]) || 'jsonrpc_error' };
}

export type A2AObservation =
  | { type: 'message'; message: MessageInput; taskRef?: string; contextRef?: string }
  | { type: 'task'; taskRef: string; contextRef?: string; state: TaskState; nativeState: string };

const unspecified = (role: unknown): boolean => role === undefined || role === 0 || role === 'ROLE_UNSPECIFIED';

function message(value: unknown, artifact = false, fallback: Role = 'agent'): MessageInput | null {
  if (!isRecord(value)) return null;
  const messageId = id(value.messageId) ?? id(value.artifactId);
  const role = artifact ? 'agent' : unspecified(value.role) ? fallback : a2aRole(value.role);
  return { role, ...(messageId ? { messageId } : {}), artifact, parts: a2aParts(value.parts) };
}

const refs = (taskRef?: string, contextRef?: string) => ({ ...(taskRef ? { taskRef } : {}), ...(contextRef ? { contextRef } : {}) });

function taskObservations(task: Json): A2AObservation[] {
  const taskRef = id(task.id);
  if (!taskRef) return [];
  const contextRef = id(task.contextId);
  const status = isRecord(task.status) ? task.status : {};
  const out: A2AObservation[] = [{ type: 'task', ...refs(taskRef, contextRef), taskRef, ...a2aTaskState(status.state) }];
  const statusMessage = message(status.message);
  if (statusMessage) out.push({ type: 'message', ...refs(taskRef, contextRef), message: statusMessage });
  for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
    const built = message(artifact, true);
    if (built) out.push({ type: 'message', ...refs(taskRef, contextRef), message: built });
  }
  return out;
}

function messageObservation(value: Json): A2AObservation[] {
  const built = message(value);
  return built ? [{ type: 'message', ...refs(id(value.taskId), id(value.contextId)), message: built }] : [];
}

/** Everything observable in a result, stream event or task object, in order. */
export function a2aObservations(value: unknown): A2AObservation[] {
  if (!isRecord(value)) return [];
  if (isRecord(value.payload)) {
    const { $case } = value.payload;
    if ($case !== 'task' && $case !== 'message' && $case !== 'statusUpdate' && $case !== 'artifactUpdate') return [];
    return a2aObservations({ [$case]: value.payload.value });
  }
  if (isRecord(value.task)) return taskObservations(value.task);
  if (isRecord(value.message)) return messageObservation(value.message);
  const update = isRecord(value.statusUpdate) ? value.statusUpdate : value.kind === 'status-update' ? value : null;
  if (update) {
    const taskRef = id(update.taskId);
    const status = isRecord(update.status) ? update.status : {};
    return taskRef ? [{ type: 'task', ...refs(taskRef, id(update.contextId)), taskRef, ...a2aTaskState(status.state) }] : [];
  }
  const artifactUpdate = isRecord(value.artifactUpdate) ? value.artifactUpdate : value.kind === 'artifact-update' ? value : null;
  if (artifactUpdate) {
    const built = message(artifactUpdate.artifact, true);
    return built ? [{ type: 'message', ...refs(id(artifactUpdate.taskId), id(artifactUpdate.contextId)), message: built }] : [];
  }
  if (value.kind === 'message') return messageObservation(value);
  if (value.kind === 'task' || (id(value.id) && isRecord(value.status))) return taskObservations(value);
  return [];
}

/** Context, task and caller message carried by request params (SendMessage, GetTask, CancelTask, …). */
export function a2aRequestRefs(params: unknown): { contextRef?: string; taskRef?: string; message?: MessageInput } {
  if (!isRecord(params)) return {};
  if (isRecord(params.message)) {
    const built = message(params.message, false, 'caller');
    return { ...refs(id(params.message.taskId), id(params.message.contextId)), ...(built ? { message: built } : {}) };
  }
  const name = text(params.name);
  const taskRef = id(params.id) ?? id(params.taskId) ?? (name?.startsWith('tasks/') ? id(name.slice(6).split('/')[0]) : undefined);
  return taskRef ? { taskRef } : {};
}

/** Longest extension URI the validator accepts; longer ones are dropped, never truncated. */
const MAX_EXTENSION = 512;
/** UTF-8 budget per list, so the `a2a` block always fits the validator's envelope limit. */
const EXTENSIONS_BYTES = 1024;
const REFERENCES_BYTES = 2048;

/** The first entries of `values`, unique, while they fit `LIMITS.listItems` and `budget` UTF-8 bytes. */
function bounded(values: string[], budget: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const value of new Set(values)) {
    bytes += utf8Bytes(value);
    if (out.length === LIMITS.listItems || bytes > budget) break;
    out.push(value);
  }
  return out;
}

/** Extension URIs from an `A2A-Extensions` header value (comma-separated) or a list, as the validator accepts them. */
export function a2aExtensions(value: unknown): string[] {
  let entries: unknown[] = [];
  if (typeof value === 'string') entries = value.split(',');
  else if (Array.isArray(value)) entries = value;
  const uris = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.length <= MAX_EXTENSION && !CONTROL.test(entry));
  return bounded(uris, EXTENSIONS_BYTES);
}

/** The request's `a2a` block: the caller message's id and reference tasks, and the requested extensions. */
export function a2aRequestBlock(params: unknown, requested: string[]): A2aBlock | undefined {
  const sent = isRecord(params) && isRecord(params.message) ? params.message : {};
  const messageId = id(sent.messageId);
  const references = Array.isArray(sent.referenceTaskIds)
    ? sent.referenceTaskIds.map(id).filter((ref): ref is string => ref !== undefined)
    : [];
  const referenceTaskIds = bounded(references, REFERENCES_BYTES);
  const block: A2aBlock = {
    ...(messageId ? { message_id: messageId } : {}),
    ...(referenceTaskIds.length ? { reference_task_ids: referenceTaskIds } : {}),
    ...(requested.length ? { extensions_requested: requested } : {}),
  };
  return Object.keys(block).length ? block : undefined;
}

/** The response's `a2a` block (activated extensions), or undefined when there is nothing to say. */
export const a2aResponseBlock = (activated: string[]): A2aBlock | undefined =>
  activated.length ? { extensions_activated: activated } : undefined;
