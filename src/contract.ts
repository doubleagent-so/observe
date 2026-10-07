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
  /** Longest OAuth client id (or MCP Client ID Metadata Document URL), in UTF-16 units. */
  clientId: 2048,
  /** Longest acting agent (`actor`, an RFC 8693 `act.sub`), in UTF-16 units. */
  actor: 256,
  /** Most scopes in one list, and the longest scope, in UTF-16 units. */
  scopes: 32,
  scope: 128,
  /** Longest proof (a compact JWS), in UTF-16 units. */
  proof: 8192,
  /** Most headers forwarded with a signed request, and the longest value, in UTF-8 bytes. */
  signedHeaders: 24,
  headerValue: 8192,
  /** Longest mandate reference, in UTF-16 units. */
  mandateRef: 256,
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
/** What an operation does: from MCP tool annotations or the host. */
export const ACCESS_LEVELS = ['read', 'write', 'destructive'] as const;
/**
 * The standard a grant (on-behalf-of delegation) comes from. `pap` (Personal Agent Protocol) is added when its v0.1
 * specification is published; until then the API rejects it.
 */
export const DELEGATION_PROTOCOLS = ['oauth', 'pact', 'a2a', 'ap2'] as const;
/** A signed artifact Double Agent verifies itself. `pact-delegation` and `pact-agent` are bearer tokens. */
export const PROOF_KINDS = ['pact-receipt', 'pact-delegation', 'pact-agent'] as const;
/** Payment mandate schemes a transaction can reference. */
export const MANDATE_SCHEMES = ['ap2', 'acp'] as const;
/**
 * Request headers never forwarded with a signed request: they are credentials. A signature that covers one cannot be
 * verified without sending it, so it is not forwarded at all.
 */
export const FORBIDDEN_SIGNED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;
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
export type Access = (typeof ACCESS_LEVELS)[number];
export type DelegationProtocol = (typeof DELEGATION_PROTOCOLS)[number];
export type ProofKind = (typeof PROOF_KINDS)[number];
export type MandateScheme = (typeof MANDATE_SCHEMES)[number];
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

/** The principal the host's auth middleware verified; the recorder hashes the subject before sending. */
export interface AuthenticatedEvidence {
  issuer: string;
  subject_hash: string;
  /** OAuth client id, or an MCP Client ID Metadata Document `https` URL (≤ 2048). */
  client_id?: string;
  /** The agent acting for the subject: RFC 8693 `act.sub`, or the PACT personal agent's issuer (≤ 256). */
  actor?: string;
  /** The token's granted scopes (≤ 32, each ≤ 128). */
  scopes?: string[];
}

/**
 * A grant: someone (the principal) let an agent act for them. Principal and grant ids travel as HMAC hashes only.
 *
 * Example: `{ protocol: 'oauth', issuer: 'https://auth.example', principal_hash: '3f…', actor: 'agent-7', scopes: ['orders:read'],
 * expires_at: '2026-10-08T12:00:00.000Z', verification: { status: 'verified', by: 'reporter' } }`.
 */
export interface DelegationEvidence {
  protocol: DelegationProtocol;
  issuer?: string;
  principal_hash?: string;
  actor?: string;
  client_id?: string;
  /** What the grant allows. */
  scopes?: string[];
  /** What this call used of it. */
  scopes_used?: string[];
  access?: 'read' | 'write';
  /** ISO-8601 with milliseconds. */
  expires_at?: string;
  grant_id_hash?: string;
  /** What the host found when it checked the grant itself. `reason` is a short code: `expired`, `bad_signature`. */
  verification?: { status: 'verified' | 'failed'; by: 'reporter'; reason?: string };
  /**
   * A signed artifact for Double Agent to verify; only with `protocol: 'pact'`. A PACT receipt is not a credential;
   * `pact-delegation` and `pact-agent` are bearer tokens, sent only when the host passes them explicitly.
   */
  proof?: { kind: ProofKind; jws: string };
}

/** The signed components of a request, forwarded so Double Agent verifies the signature itself. */
export interface ForwardedRequest {
  method: string;
  url: string;
  /** Lower-case names; never `authorization`, `cookie` or `proxy-authorization`. */
  headers: Record<string, string>;
}

/** A request signature: verified by the host (`reporter`), or forwarded for Double Agent to verify. */
export type SignatureEvidence =
  | { scheme: SignatureScheme; key_id: string; verified_by: 'reporter' }
  | { scheme: SignatureScheme; key_id?: string; verified_by: 'double_agent'; request: ForwardedRequest };

/** A payment mandate by reference only; mandate contents are never sent. */
export interface MandateRef {
  scheme: MandateScheme;
  ref: string;
}

/** Evidence about the other party. Each field is optional; `{}` resolves to the agent's unknown counterparty. */
export interface CounterpartyEvidence {
  card_url?: string;
  declared_name?: string;
  client_info?: { name: string; version?: string };
  /** From the host's auth middleware; the recorder hashes the subject before sending. */
  authenticated?: AuthenticatedEvidence;
  /** The grant the caller acts under, when it acts for someone else. */
  delegation?: DelegationEvidence;
  signature?: SignatureEvidence;
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
  /** What the operation does: `read`, `write` or `destructive` (MCP tool annotations, or the host). */
  access?: Access;
  /** The scopes the operation needs. */
  scope_required?: string[];
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
  /** An HTTP 403 `insufficient_scope` challenge, with the scopes the server asked for. */
  insufficient_scope?: { required: string[] };
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
  /** The AP2 or ACP mandate the payment was made under, by reference. */
  mandate_ref?: MandateRef;
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
