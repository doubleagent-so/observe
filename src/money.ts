/** Pure builders for money events, shared by the recorder and the API's provider webhooks. */
import type {
  CostCategory,
  CostRecorded,
  CostUsage,
  Direction,
  MandateRef,
  MoneyBasis,
  PaymentMethod,
  Protocol,
  ProtocolName,
  TransactionKind,
  TransactionRecorded,
  TransactionStatus,
} from './contract.ts';
import { toMicros } from './currency.ts';
import { ulid } from './ulid.ts';

/** What a money event belongs to. It needs `taskRef` or `operationId` to be valid. */
export interface MoneyLinks {
  protocol: Protocol;
  direction: Direction;
  operationId?: string;
  taskRef?: string;
  conversationRef?: string;
}

export interface TransactionFields {
  transactionId: string;
  kind: TransactionKind;
  amount: number;
  currency: string;
  method: PaymentMethod;
  processor?: string;
  network?: string;
  basis: MoneyBasis;
  status: TransactionStatus;
  externalRef?: string;
  /** The AP2 or ACP mandate the payment was made under: a reference only, never the mandate. */
  mandateRef?: MandateRef;
}

export interface CostInput {
  category: CostCategory;
  /** Integer millionths of the major unit (USD 0.0042 = 4_200). Give this or `amount`. */
  amountMicros?: number;
  /** Convenience: decimal major units (0.0042), converted to micros. Give this or `amountMicros`. */
  amount?: number | string;
  currency: string;
  basis: MoneyBasis;
  usage?: CostUsage;
  /** Defaults to the operation's task. */
  taskRef?: string;
}

export interface ChargeInput {
  /** Integer minor units of `currency` (cents for USD); negative only for a refund. */
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: TransactionStatus;
  basis: MoneyBasis;
  /** Default `charge`. */
  kind?: TransactionKind;
  processor?: string;
  network?: string;
  externalRef?: string;
  /** The AP2 or ACP mandate the payment was made under: a reference only, never the mandate. */
  mandateRef?: MandateRef;
  /** Pass your own to update the same transaction later (pending → settled); generated otherwise. */
  transactionId?: string;
  /** Defaults to the operation's task. */
  taskRef?: string;
}

export interface TransactionInput extends Omit<ChargeInput, 'kind'> {
  kind: TransactionKind;
  /** A bare name when the version and binding are not known (e.g. in a webhook). */
  protocol: Protocol | ProtocolName;
  /** Default `inbound`: money the agent earned from its caller. */
  direction?: Direction;
  operationId?: string;
  conversationRef?: string;
  /** Epoch ms; default now. */
  occurredAt?: number;
}

/**
 * The cost in micros; NaN (which the validator rejects) when neither or both amounts are given, or `amount` is not a
 * plain decimal or is finer than a micro.
 */
export function costMicros(input: Pick<CostInput, 'amountMicros' | 'amount'>): number {
  const { amountMicros, amount } = input;
  if (amount === undefined) return amountMicros ?? Number.NaN;
  if (amountMicros !== undefined) return Number.NaN;
  return toMicros(amount) ?? Number.NaN;
}

/** A full protocol object as given; a bare name becomes `{ name, version: 'unknown', binding: 'other' }`. */
export const protocolOf = (value: Protocol | ProtocolName): Protocol =>
  typeof value === 'string' ? { name: value, version: 'unknown', binding: 'other' } : value;

function envelope(links: MoneyLinks, at: number, eventId: string) {
  return {
    schema_version: 1 as const,
    event_id: eventId,
    occurred_at: new Date(at).toISOString(),
    protocol: links.protocol,
    direction: links.direction,
    ...(links.operationId ? { operation_id: links.operationId } : {}),
    ...(links.conversationRef ? { conversation_ref: links.conversationRef } : {}),
    ...(links.taskRef ? { task_ref: links.taskRef } : {}),
  };
}

/** A `transaction.recorded` event; pass `eventId` to make it deterministic (e.g. derived from a webhook's event). */
export function transactionEvent(links: MoneyLinks, fields: TransactionFields, at: number, eventId = ulid(at)): TransactionRecorded {
  return {
    ...envelope(links, at, eventId),
    type: 'transaction.recorded',
    transaction_id: fields.transactionId,
    kind: fields.kind,
    amount: fields.amount,
    currency: fields.currency,
    method: fields.method,
    ...(fields.processor ? { processor: fields.processor } : {}),
    ...(fields.network ? { network: fields.network } : {}),
    basis: fields.basis,
    status: fields.status,
    ...(fields.externalRef ? { external_ref: fields.externalRef } : {}),
    ...(fields.mandateRef ? { mandate_ref: { scheme: fields.mandateRef.scheme, ref: fields.mandateRef.ref } } : {}),
  };
}

/** A `cost.recorded` event. `usage` is copied, so a later change by the caller cannot reach the event. */
export function costEvent(links: MoneyLinks, input: CostInput, at: number): CostRecorded {
  return {
    ...envelope(links, at, ulid(at)),
    type: 'cost.recorded',
    category: input.category,
    amount_micros: costMicros(input),
    currency: input.currency,
    basis: input.basis,
    ...(input.usage ? { usage: { ...input.usage } } : {}),
  };
}
