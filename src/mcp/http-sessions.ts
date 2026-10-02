/**
 * Internal: the sessions `withMcpTelemetry` keeps, by `Mcp-Session-Id`, in the per-recorder cache (bounded LRU).
 *
 * An ID the cache does not know gets a provisional session, kept only once the server accepts a request in it
 * (`commit`), so made-up IDs answered with 404 never evict real sessions. Without a valid ID a session is private to
 * its request.
 */
import type { Recorder } from '../recorder.ts';
import type { Lru } from '../state.ts';
import { nativeRef } from './mapping.ts';
import { mcpSessions, newSession, type McpSession } from './session.ts';

/** What `initialize` teaches a session, so a rejected `initialize` can be undone. */
export type SessionFacts = Pick<McpSession, 'clientInfo' | 'requestedVersion' | 'capabilities'>;

export const sessionFacts = ({ clientInfo, requestedVersion, capabilities }: McpSession): SessionFacts => ({
  ...(clientInfo ? { clientInfo } : {}),
  ...(requestedVersion ? { requestedVersion } : {}),
  capabilities,
});

export function restoreFacts(session: McpSession, facts: SessionFacts): void {
  delete session.clientInfo;
  delete session.requestedVersion;
  Object.assign(session, facts);
}

export class HttpSessions {
  readonly #cache: Lru<McpSession>;

  constructor(recorder: Recorder) {
    this.#cache = mcpSessions(recorder);
  }

  /** The cached session for a valid session ID, else a provisional one; a private one without a valid ID. */
  forId(id: string | null): McpSession {
    const ref = nativeRef(id);
    if (!ref) return newSession();
    return this.#cache.get(ref) ?? newSession(ref);
  }

  /** Keeps a provisional session once the server accepted a request in it (status below 400). */
  commit(session: McpSession, status: number): void {
    if (status >= 400 || session.id === undefined || this.#cache.get(session.id)) return;
    this.#cache.set(session.id, session);
  }

  /** True for the cached session of its ID; any other session lives only as long as its request. */
  isShared(session: McpSession): boolean {
    return session.id !== undefined && this.#cache.get(session.id) === session;
  }

  forget(id: string): void {
    this.#cache.delete(id);
  }
}
