// The public API of `@doubleagent-so/observe`: the recorder, the wire contract and its validator, the content
// helpers, and the currency helpers and money event builders. Everything else in `src/` is internal. `test/exports.test.ts` pins this list.
export {
  BINDINGS,
  CAPABILITIES,
  COST_CATEGORIES,
  DIRECTIONS,
  EVENT_TYPES,
  KINDS,
  LIMITS,
  MONEY_BASES,
  OUTCOMES,
  PART_KINDS,
  PAYMENT_METHODS,
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
  AdvertisedProtocol,
  AgentEvent,
  Binding,
  Capability,
  ContentPart,
  CostCategory,
  CostRecorded,
  CostUsage,
  CounterpartyEvidence,
  CustomBlock,
  Direction,
  EventBatch,
  EventType,
  Kind,
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
  Protocol,
  ProtocolName,
  Role,
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
  ConversationInput,
  CounterpartyInput,
  FinishInput,
  FlushOptions,
  OperationHandle,
  Recorder,
  RecorderOptions,
  RecorderStats,
  StartInput,
  TaskStateInput,
} from './recorder.ts';
export { CURRENCY, currencyExponent, PEGGED_TOKENS, peggedTo, toMicros, toMinorUnits } from './currency.ts';
export { costEvent, costMicros, protocolOf, transactionEvent } from './money.ts';
export type { ChargeInput, CostInput, MoneyLinks, TransactionFields, TransactionInput } from './money.ts';
