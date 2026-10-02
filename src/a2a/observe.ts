/** Applies every observation in an A2A result or event to an operation, deduping task states per recorder. */
import type { OperationHandle } from '../recorder.ts';
import { a2aObservations, type A2AObservation } from './mapping.ts';
import type { RecorderState } from '../state.ts';
import { isObjectOrArray } from './util.ts';

export function applyObservations(op: OperationHandle, state: RecorderState, observations: A2AObservation[]): void {
  for (const observation of observations) {
    // An agent-assigned contextId links a first message (sent without one) to its conversation.
    const conversation = observation.contextRef ? { conversationRef: observation.contextRef } : {};
    if (observation.type === 'message') op.message({ ...observation.message, ...conversation });
    else {
      state.linkTask(observation.taskRef, op);
      if (state.taskChanged(observation.taskRef, observation.state))
        op.taskState({ taskRef: observation.taskRef, state: observation.state, nativeState: observation.nativeState, ...conversation });
    }
  }
}

export function observeResult(op: OperationHandle, state: RecorderState, value: unknown): void {
  applyObservations(op, state, a2aObservations(value));
}

/** `a2aObservations` for SDK values: a bare ts-proto `Message` (a direct `sendMessage` reply) has no wrapper or `kind`. */
export function sdkObservations(value: unknown): A2AObservation[] {
  const bare = isObjectOrArray(value) && typeof value.messageId === 'string' && !('kind' in value) && !('status' in value);
  return a2aObservations(bare ? { message: value } : value);
}

export function observeSdkResult(op: OperationHandle, state: RecorderState, value: unknown): void {
  applyObservations(op, state, sdkObservations(value));
}
