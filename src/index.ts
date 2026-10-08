// The public API of `@doubleagent-so/observe`: the recorder, the wire contract and its validator, the content
// helpers, the caller evidence helpers, and the currency helpers and money event builders. Everything else in `src/` is internal. `test/exports.test.ts` pins this list.
export {
  ACCESS_LEVELS,
  BINDINGS,
  CAPABILITIES,
  COST_CATEGORIES,
  DELEGATION_PROTOCOLS,
  DIRECTIONS,
  EVENT_TYPES,
  KINDS,
  LIMITS,
  MANDATE_SCHEMES,
  MONEY_BASES,
  OUTCOMES,
  PART_KINDS,
  PAYMENT_METHODS,
  PROOF_KINDS,
  ROLES,
  SCHEMA_VERSION,
  SIGNATURE_SCHEMES,
  TASK_STATES,
  TERMINAL_STATES,
  TRANSACTION_KINDS,
  TRANSACTION_STATUSES,
  isMoneyEvent,
  isTerminal,
} from './contract.ts';
export type {
  A2aBlock,
  Access,
  AdvertisedProtocol,
  AgentEvent,
  AuthenticatedEvidence,
  Binding,
  Capability,
  ContentPart,
  CostCategory,
  CostRecorded,
  CostUsage,
  CounterpartyEvidence,
  CustomBlock,
  DelegationEvidence,
  DelegationProtocol,
  Direction,
  EventBatch,
  ForwardedRequest,
  EventType,
  Kind,
  MandateRef,
  MandateScheme,
  McpBlock,
  MessageContent,
  MessageObserved,
  MoneyBasis,
  OperationFinished,
  OperationStarted,
  Outcome,
  PartKind,
  PartSummary,
  PaymentMethod,
  ProofKind,
  Protocol,
  ProtocolName,
  Role,
  SignatureEvidence,
  SignatureScheme,
  TaskState,
  TaskStateChanged,
  TransactionKind,
  TransactionRecorded,
  TransactionStatus,
} from './contract.ts';
export { validateBatch, validateEvent } from './validate.ts';
export type { BatchErrorCode, BatchResult, EventResult, RejectionCode } from './validate.ts';
export { ulid } from './ulid.ts';
export { buildContent, summarizeParts, truncateUtf8 } from './content.ts';
export type { MessageInput, PartInput } from './content.ts';
export { createRecorder } from './recorder.ts';
export type {
  AbandonInput,
  AuthenticatedInput,
  ConversationInput,
  CounterpartyInput,
  DelegationInput,
  FinishInput,
  FlushOptions,
  OperationHandle,
  Recorder,
  RecorderOptions,
  RecorderStats,
  StartInput,
  TaskStateInput,
} from './recorder.ts';
export { oauthEvidence, parseInsufficientScope, signedRequestEvidence } from './evidence.ts';
export type { OAuthEvidenceOptions } from './evidence.ts';
export { CURRENCY, currencyExponent, PEGGED_TOKENS, peggedTo, toMicros, toMinorUnits } from './currency.ts';
export { costEvent, costMicros, protocolOf, transactionEvent } from './money.ts';
export type { ChargeInput, CostInput, MoneyLinks, TransactionFields, TransactionInput } from './money.ts';
