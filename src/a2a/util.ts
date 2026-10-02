/** Internal helpers shared by the A2A entry points. Not exported from the package. */
import type { Json } from '../patterns.ts';

export { isRecord, type Json } from '../patterns.ts';
export { defaultLog, failureReason, guardLog, safely, type Log } from '../http.ts';

/** Any non-null object, arrays included. For SDK values and call contexts, which are read field by field. */
export const isObjectOrArray = (value: unknown): value is Json => value !== null && typeof value === 'object';

/** An A2A protocol version (`1.0`, `0.3`, `1.0.1`). */
export const VERSION = /^\d+\.\d+(?:\.\d+)?$/;
