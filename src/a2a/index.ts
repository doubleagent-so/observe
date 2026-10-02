// The public API of `@doubleagent-so/observe/a2a`: the three entry points, the task-store wrapper, the documented
// mapping helpers, and their option and result types. Everything else in `src/a2a/` is internal.
// `test/exports.test.ts` pins this list.
export { withA2ATelemetry } from './fetch.ts';
export type { A2ATelemetryOptions } from './fetch.ts';
export { instrumentA2AHandler, instrumentTaskStore } from './sdk-server.ts';
export type {
  A2AHandlerOptions,
  A2ARequestHandlerLike,
  A2ATaskStoreLike,
  A2ATaskStoreOptions,
  InstrumentedA2AHandler,
  InstrumentedTaskStore,
} from './sdk-server.ts';
export { a2aTelemetryInterceptor } from './sdk-client.ts';
export type { A2ACallInterceptor, A2AInterceptorArgs, A2AInterceptorOptions } from './sdk-client.ts';
export { a2aError, a2aKind, a2aParts, a2aTaskState } from './mapping.ts';
