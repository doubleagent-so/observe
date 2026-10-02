/**
 * Wire contract for agent telemetry: one envelope for every protocol, with protocol-specific fields in a small
 * allowlisted block.
 */
export const SCHEMA_VERSION = 1;

export const LIMITS = {
  batchEvents: 100,
  batchBytes: 1024 * 1024,
  envelopeBytes: 8 * 1024,
  contentBytes: 96 * 1024,
  partBytes: 32 * 1024,
  parts: 64,
  dataDepth: 16,
  pastMs: 7 * 24 * 60 * 60 * 1000,
  futureMs: 5 * 60 * 1000,
  listItems: 16,
  protocols: 8,
  /**
   * Largest transaction amount, in minor units either way (refunds are negative). A safe integer, like `maxMicros`, so
   * every accepted amount is exact.
   */
  maxAmount: 10_000_000_000_000,
  /** Largest cost amount, in micros (10^15); at most Number.MAX_SAFE_INTEGER (about 9 × 10^15). */
  maxMicros: 1_000_000_000_000_000,
  costsPerOperation: 16,
  /** Longest file name, native task state and state reason, in UTF-16 units. */
  fileName: 256,
  nativeState: 64,
  reason: 128,
  /** Longest operation target, MCP request ID and peer (client or server) name, in UTF-16 units. */
  target: 128,
  /** Longest URL (`card_url`), in UTF-16 units. */
  url: 2048,
  /** Longest peer version (`client_info.version`), in UTF-16 units. */
  peerVersion: 64,
  /** Longest issuer of an authenticated principal, in UTF-16 units. */
  issuer: 256,
} as const;

export const EVENT_TYPES = [
  'operation.started',
  'operation.finished',
  'message.observed',
  'task.state_changed',
  'transaction.recorded',
  'cost.recorded',
] as const;
export const DIRECTIONS = ['inbound', 'outbound'] as const;
export const BINDINGS = ['jsonrpc-http', 'sse', 'streamable-http', 'stdio', 'grpc', 'http-json', 'other'] as const;
export const KINDS = ['message', 'tool', 'resource', 'prompt', 'discovery', 'management', 'callback', 'other'] as const;
export const OUTCOMES = ['ok', 'protocol_error', 'tool_error', 'auth_rejected', 'transport_error', 'canceled', 'incomplete'] as const;
export const TASK_STATES = [
  'submitted',
  'working',
  'input_required',
  'auth_required',
  'completed',
  'failed',
  'canceled',
  'rejected',
  'unknown',
] as const;
export const TERMINAL_STATES = ['completed', 'failed', 'canceled', 'rejected'] as const;
export const ROLES = ['caller', 'agent'] as const;
export const PART_KINDS = ['text', 'data', 'file'] as const;
export const SIGNATURE_SCHEMES = ['web-bot-auth', 'erc-8128'] as const;
export const CAPABILITIES = ['streaming', 'push', 'sampling', 'elicitation', 'roots', 'tasks'] as const;
export const TRANSACTION_KINDS = ['charge', 'refund', 'payout', 'fee', 'credit'] as const;
export const PAYMENT_METHODS = ['card', 'link', 'bank', 'x402', 'ap2', 'invoice', 'credits', 'manual', 'other'] as const;
export const MONEY_BASES = ['reported', 'settled', 'estimated'] as const;
export const TRANSACTION_STATUSES = ['pending', 'settled', 'refunded', 'failed'] as const;
export const COST_CATEGORIES = ['model', 'tool', 'outbound_agent', 'compute', 'other'] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type Binding = (typeof BINDINGS)[number];
export type Kind = (typeof KINDS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type Role = (typeof ROLES)[number];
export type PartKind = (typeof PART_KINDS)[number];
export type SignatureScheme = (typeof SIGNATURE_SCHEMES)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type MoneyBasis = (typeof MONEY_BASES)[number];
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export type CostCategory = (typeof COST_CATEGORIES)[number];
export type ProtocolName = 'a2a' | 'mcp' | `custom:${string}`;

export interface Protocol {
  name: ProtocolName;
  version: string;
  binding: Binding;
}

/** What a counterparty declares it supports (an A2A card's interfaces, an MCP client's initialize). */
export interface AdvertisedProtocol {
  name: ProtocolName;
  versions: string[];
  bindings: Binding[];
  capabilities: Capability[];
}

/** Evidence about the other party. Each field is optional; `{}` resolves to the agent's unknown counterparty. */
export interface CounterpartyEvidence {
  card_url?: string;
  declared_name?: string;
  client_info?: { name: string; version?: string };
  /** From the host's auth middleware; the recorder hashes the subject before sending. */
  authenticated?: { issuer: string; subject_hash: string };
  signature?: { scheme: SignatureScheme; key_id: string; verified_by: 'reporter' };
  /** Weak: groups callers that have nothing else. */
  network?: { ip_prefix_hash: string; ua_family?: string };
  advertised_protocols?: AdvertisedProtocol[];
}

export interface A2aBlock {
  message_id?: string;
  reference_task_ids?: string[];
  extensions_requested?: string[];
  extensions_activated?: string[];
}

export interface McpBlock {
  request_id?: string;
  client_info?: { name: string; version?: string };
  capabilities?: Capability[];
}

export type CustomBlock = Record<string, string | number | boolean>;

interface Envelope {
  schema_version: 1;
  event_id: string;
  /** ISO-8601 with milliseconds, fixed by the recorder at capture. */
  occurred_at: string;
  protocol: Protocol;
  direction: Direction;
  operation_id: string;
  conversation_ref?: string;
  task_ref?: string;
  a2a?: A2aBlock;
  mcp?: McpBlock;
  custom?: CustomBlock;
}

export interface OperationStarted extends Envelope {
  type: 'operation.started';
  method: string;
  kind: Kind;
  target?: string;
  counterparty: CounterpartyEvidence;
  request_bytes?: number;
}

export interface OperationFinished extends Envelope {
  type: 'operation.finished';
  outcome: Outcome;
  started_at: string;
  duration_ms: number;
  first_byte_ms?: number;
  stream_events?: number;
  response_bytes?: number;
  error?: { native_code: string; code: string };
}

export interface PartSummary {
  kind: PartKind;
  media_type?: string;
  bytes: number;
}

export type ContentPart =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'data'; json: unknown; truncated: boolean }
  | { kind: 'file'; name?: string; media_type?: string; bytes?: number };

export interface MessageContent {
  parts: ContentPart[];
  /** True when parts were left out to stay within the content limit. */
  truncated?: boolean;
}

export interface MessageObserved extends Envelope {
  type: 'message.observed';
  message_id: string;
  role: Role;
  artifact: boolean;
  parts: PartSummary[];
  content?: MessageContent;
}

export interface TaskStateChanged extends Envelope {
  type: 'task.state_changed';
  task_ref: string;
  state: TaskState;
  native_state: string;
  /** Why the recorder ended the task itself (`abandonTask`); absent for protocol transitions. */
  reason?: string;
}

/** Money events may stand outside an operation (a settlement webhook), so `operation_id` is optional here. */
interface MoneyEnvelope extends Omit<Envelope, 'operation_id'> {
  operation_id?: string;
}

export interface TransactionRecorded extends MoneyEnvelope {
  type: 'transaction.recorded';
  /** ULID; the idempotency key. A later event with the same ID updates status and basis. */
  transaction_id: string;
  kind: TransactionKind;
  /** Integer minor units of `currency`; negative for refunds. */
  amount: number;
  currency: string;
  method: PaymentMethod;
  processor?: string;
  network?: string;
  basis: MoneyBasis;
  status: TransactionStatus;
  external_ref?: string;
}

export interface CostUsage {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  units?: number;
  unit?: string;
}

export interface CostRecorded extends MoneyEnvelope {
  type: 'cost.recorded';
  category: CostCategory;
  /** Integer millionths of the currency's major unit, so sub-cent model costs keep their precision. */
  amount_micros: number;
  currency: string;
  basis: MoneyBasis;
  usage?: CostUsage;
}

export type AgentEvent = OperationStarted | OperationFinished | MessageObserved | TaskStateChanged | TransactionRecorded | CostRecorded;

export interface EventBatch {
  adapter: string;
  dropped?: number;
  events: AgentEvent[];
}

/** Whether `type` is a money event, whose `operation_id` is optional (a task reference can stand in for it). */
export const isMoneyEvent = (type: EventType): boolean => type === 'transaction.recorded' || type === 'cost.recorded';

export const isTerminal = (state: TaskState): boolean => (TERMINAL_STATES as readonly string[]).includes(state);

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** Whether JSON-shaped `value` nests deeper than `max` containers. Iterative, so hostile input cannot overflow the stack. */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const [node, level] = frame;
    if (node === null || typeof node !== 'object') continue;
    if (level + 1 > max) return true;
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') stack.push([child, level + 1]);
    }
  }
  return false;
}
