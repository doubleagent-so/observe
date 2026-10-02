/** Per-recorder protocol state shared by every entry point (A2A and MCP) that uses the same recorder. Internal. */
import type { Direction, TaskState } from './contract.ts';
import { MAX_ID } from './patterns.ts';
import type { OperationHandle, Recorder } from './recorder.ts';

/** The default bound of every per-recorder map: task states, task links, open tasks and sessions. */
export const STATE_LIMIT = 10_000;

/** A bounded map that forgets the least recently used key, telling `onEvict` (never for a replaced or deleted key). */
export class Lru<Value> {
  readonly #map = new Map<string, Value>();
  readonly #onEvict: ((key: string, value: Value) => void) | undefined;

  constructor(
    readonly limit = STATE_LIMIT,
    onEvict?: (key: string, value: Value) => void,
  ) {
    this.#onEvict = onEvict;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): Value | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: string, value: Value): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size <= this.limit) return;
    const [oldestKey, oldest] = this.#map.entries().next().value!;
    this.#map.delete(oldestKey);
    this.#onEvict?.(oldestKey, oldest);
  }

  delete(key: string): boolean {
    return this.#map.delete(key);
  }
}

export type StateProtocol = 'a2a' | 'mcp';

export interface RecorderState {
  /** True when `state` differs from the last state seen for the task (and remembers it). */
  taskChanged(taskRef: string, state: TaskState): boolean;
  linkTask(taskRef: string, op: OperationHandle): void;
  operationFor(taskRef: string): OperationHandle | undefined;
}

function createState(): RecorderState {
  const seen = new Lru<TaskState>();
  const links = new Lru<OperationHandle>();
  return {
    taskChanged(taskRef, next) {
      if (taskRef.length > MAX_ID) return true;
      if (seen.get(taskRef) === next) return false;
      seen.set(taskRef, next);
      return true;
    },
    linkTask(taskRef, op) {
      if (taskRef.length <= MAX_ID) links.set(taskRef, op);
    },
    operationFor: (taskRef) => links.get(taskRef),
  };
}

const states = new WeakMap<Recorder, Map<string, RecorderState>>();

/**
 * One state per recorder, protocol and direction. Task ids are scoped by protocol, so A2A and MCP never share dedupe
 * entries or links. Inbound and outbound are kept apart too: a process that both serves a task and calls it through one
 * recorder records each side's states, instead of the second side being deduped away. Each state has its own LRUs, so
 * the bound is 10,000 task states and 10,000 task links per protocol and direction per recorder.
 */
export function recorderState(recorder: Recorder, protocol: StateProtocol, direction: Direction = 'inbound'): RecorderState {
  let scoped = states.get(recorder);
  if (!scoped) {
    scoped = new Map();
    states.set(recorder, scoped);
  }
  const key = `${protocol}:${direction}`;
  let state = scoped.get(key);
  if (!state) {
    state = createState();
    scoped.set(key, state);
  }
  return state;
}
