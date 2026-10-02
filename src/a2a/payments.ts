/**
 * Internal: A2A payment evidence. Where a charge is attached, and the x402 A2A transport, which carries the payment
 * in the caller's message metadata and the settlement receipts in the task status message metadata. Not exported from
 * the package.
 */
import { boundedId } from './ids.ts';
import { a2aObservations } from './mapping.ts';
import { isRecord } from './util.ts';

const STATUS = 'x402.payment.status';
const PAYLOAD = 'x402.payment.payload';
const RECEIPTS = 'x402.payment.receipts';
/** Receipts are read only once the payment is final. */
const FINAL = new Set(['payment-completed', 'payment-failed']);

/** The first task an A2A result carries, or undefined (a message, an empty result). */
export function taskRefOf(result: unknown): string | undefined {
  for (const observation of a2aObservations(result)) if (observation.type === 'task') return observation.taskRef;
  return undefined;
}

const metadataOf = (message: unknown): Record<string, unknown> | undefined =>
  isRecord(message) && isRecord(message.metadata) ? message.metadata : undefined;

/** The x402 payment payload of a `payment-submitted` caller message in request params, or undefined. */
export function x402Submitted(params: unknown): Record<string, unknown> | undefined {
  const metadata = metadataOf(isRecord(params) ? params.message : undefined);
  const payload = metadata?.[PAYLOAD];
  return metadata?.[STATUS] === 'payment-submitted' && isRecord(payload) ? payload : undefined;
}

/** The task id and status of a task or status update in a result or stream event (1.0, 0.3 or ts-proto shape). */
function taskStatus(value: unknown): { taskRef?: string; status: unknown } | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.payload)) {
    const { $case } = value.payload;
    return $case === 'task' || $case === 'statusUpdate' ? taskStatus({ [$case]: value.payload.value }) : undefined;
  }
  if (isRecord(value.statusUpdate)) return withTask(value.statusUpdate.taskId, value.statusUpdate.status);
  if (value.kind === 'status-update') return withTask(value.taskId, value.status);
  if (isRecord(value.task)) return withTask(value.task.id, value.task.status);
  const bareTask = value.kind === 'task' || (typeof value.id === 'string' && isRecord(value.status));
  return bareTask ? withTask(value.id, value.status) : undefined;
}

function withTask(id: unknown, status: unknown): { taskRef?: string; status: unknown } {
  const taskRef = boundedId(id);
  return { ...(taskRef ? { taskRef } : {}), status };
}

/**
 * The last receipt of a final x402 payment status (`payment-completed` or `payment-failed`) on the task status message
 * a result carries, with that task's id; undefined when there is none.
 */
export function x402Receipt(result: unknown): { taskRef?: string; receipt: unknown } | undefined {
  const found = taskStatus(result);
  const metadata = metadataOf(isRecord(found?.status) ? found.status.message : undefined);
  const receipts = metadata?.[RECEIPTS];
  if (!found || !FINAL.has(String(metadata?.[STATUS])) || !Array.isArray(receipts) || receipts.length === 0) return undefined;
  return { ...(found.taskRef ? { taskRef: found.taskRef } : {}), receipt: receipts.at(-1) };
}
