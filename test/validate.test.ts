import { describe, expect, it } from 'vitest';
import { LIMITS, validateBatch, validateEvent } from '../src/index';

const NOW = Date.UTC(2026, 9, 1, 12);
const ISO = new Date(NOW).toISOString();
/** A valid ULID: '01J' plus 23 digits. */
const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
const base = {
  schema_version: 1,
  occurred_at: ISO,
  protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
  direction: 'inbound',
  operation_id: id(1),
};
const started = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(2),
  type: 'operation.started',
  method: 'SendMessage',
  kind: 'message',
  counterparty: { declared_name: 'Caller' },
  ...over,
});
const finished = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(3),
  type: 'operation.finished',
  outcome: 'ok',
  started_at: ISO,
  duration_ms: 12,
  ...over,
});
const message = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(4),
  type: 'message.observed',
  message_id: 'm-1',
  role: 'caller',
  artifact: false,
  parts: [{ kind: 'text', bytes: 5 }],
  ...over,
});
const task = (over: Record<string, unknown> = {}) => ({
  ...base,
  event_id: id(5),
  type: 'task.state_changed',
  task_ref: 't-1',
  state: 'working',
  native_state: 'TASK_STATE_WORKING',
  ...over,
});
const code = (event: unknown) => {
  const result = validateEvent(event, NOW);
  return result.ok ? 'ok' : result.code;
};
const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });

describe('validateEvent', () => {
  it('accepts an optional abandonment reason on task events', () => {
    expect(code(task({ state: 'canceled', native_state: 'abandoned', reason: 'shutdown' }))).toBe('ok');
    expect(code(task({ reason: 'x'.repeat(129) }))).toBe('invalid_field');
    expect(code(task({ reason: 'line\nbreak' }))).toBe('invalid_field');
  });

  it('accepts one event of each type', () => {
    for (const event of [started(), finished(), message(), task()]) expect(code(event)).toBe('ok');
  });

  it('accepts MCP and custom protocols with their own blocks', () => {
    const mcp = { name: 'mcp', version: '2025-11-25', binding: 'streamable-http' };
    expect(
      code(
        started({
          protocol: mcp,
          method: 'tools/call',
          kind: 'tool',
          target: 'search',
          mcp: { request_id: '7', client_info: { name: 'claude-ai', version: '0.1.0' }, capabilities: ['sampling'] },
        }),
      ),
    ).toBe('ok');
    expect(
      code(
        started({
          protocol: { name: 'custom:orders', version: '2', binding: 'other' },
          custom: { region: 'eu', retries: 2, beta: true },
        }),
      ),
    ).toBe('ok');
    expect(code(started({ a2a: { message_id: 'm', reference_task_ids: ['t'], extensions_requested: ['https://ext.example/v1'] } }))).toBe(
      'ok',
    );
  });

  it('rejects unknown fields, bad identifiers, enums and schema versions', () => {
    expect(code(started({ account_id: 'acc_x' }))).toBe('unknown_field');
    expect(code(started({ event_id: 'not-a-ulid' }))).toBe('invalid_id');
    expect(code(started({ operation_id: id(1).toLowerCase() }))).toBe('invalid_id');
    expect(code(started({ schema_version: 2 }))).toBe('invalid_event');
    expect(code(started({ type: 'operation.paused' }))).toBe('invalid_event');
    expect(code(started({ kind: 'chat' }))).toBe('invalid_field');
    expect(code(started({ method: 'has space' }))).toBe('invalid_field');
    expect(code(started({ target: 'x'.repeat(129) }))).toBe('invalid_field');
    expect(code(started({ direction: 'sideways' }))).toBe('invalid_field');
    expect(code(finished({ outcome: 'great' }))).toBe('invalid_field');
    expect(code(finished({ duration_ms: -1 }))).toBe('invalid_field');
    expect(code(message({ role: 'system' }))).toBe('invalid_field');
    expect(code(task({ state: 'paused' }))).toBe('invalid_field');
    expect(code(task({ task_ref: undefined }))).toBe('invalid_field');
    expect(code(started({ conversation_ref: 'has\nnewline' }))).toBe('invalid_id');
    expect(code(null)).toBe('invalid_event');
  });

  it('rejects times outside the window', () => {
    expect(code(started({ occurred_at: 'yesterday' }))).toBe('invalid_time');
    expect(code(started({ occurred_at: new Date(NOW - LIMITS.pastMs - 1).toISOString() }))).toBe('time_out_of_range');
    expect(code(started({ occurred_at: new Date(NOW + LIMITS.futureMs + 1).toISOString() }))).toBe('time_out_of_range');
    expect(code(finished({ started_at: 'soon' }))).toBe('invalid_time');
  });

  it('rejects malformed protocols and blocks that do not match the protocol', () => {
    expect(code(started({ protocol: { name: 'grpc', version: '1', binding: 'grpc' } }))).toBe('invalid_protocol');
    expect(code(started({ protocol: { name: 'a2a', version: '1 0', binding: 'jsonrpc-http' } }))).toBe('invalid_protocol');
    expect(code(started({ mcp: { request_id: '1' } }))).toBe('invalid_protocol_block');
    expect(code(started({ custom: { a: 1 } }))).toBe('invalid_protocol_block');
    expect(code(started({ a2a: { extra: 1 } }))).toBe('invalid_protocol_block');
    const custom = { name: 'custom:x', version: '1', binding: 'other' };
    expect(code(started({ protocol: custom, custom: { 'Bad-Key': 1 } }))).toBe('invalid_protocol_block');
    expect(code(started({ protocol: custom, custom: { k: { nested: true } } }))).toBe('invalid_protocol_block');
    expect(code(started({ protocol: custom, custom: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`k${n}`, n])) }))).toBe(
      'invalid_protocol_block',
    );
  });

  it('validates counterparty evidence', () => {
    const hash = 'a'.repeat(64);
    expect(code(started({ counterparty: {} }))).toBe('ok');
    expect(
      code(
        started({
          counterparty: {
            card_url: 'https://agent.example/.well-known/agent-card.json',
            authenticated: { issuer: 'https://idp.example', subject_hash: hash },
            signature: { scheme: 'erc-8128', key_id: 'eip155:1:0xabc', verified_by: 'reporter' },
            network: { ip_prefix_hash: hash, ua_family: 'node' },
            advertised_protocols: [{ name: 'a2a', versions: ['1.0'], bindings: ['jsonrpc-http'], capabilities: ['streaming'] }],
          },
        }),
      ),
    ).toBe('ok');
    expect(code(started({ counterparty: undefined }))).toBe('invalid_counterparty');
    expect(code(started({ counterparty: { card_url: 'ftp://x' } }))).toBe('invalid_counterparty');
    expect(code(started({ counterparty: { authenticated: { issuer: 'i', subject_hash: 'raw-subject' } } }))).toBe('invalid_counterparty');
    expect(code(started({ counterparty: { signature: { scheme: 'erc-8128', key_id: 'k', verified_by: 'server' } } }))).toBe(
      'invalid_counterparty',
    );
    expect(code(started({ counterparty: { nickname: 'x' } }))).toBe('invalid_counterparty');
  });

  it('bounds parts and content', () => {
    const text = (n: number) => ({ kind: 'text', text: 'a'.repeat(n), truncated: false });
    expect(code(message({ content: { parts: [text(10)] } }))).toBe('ok');
    expect(
      code(
        message({
          content: {
            parts: [
              { kind: 'data', json: { a: [1, 2] }, truncated: false },
              { kind: 'file', name: 'x.pdf', media_type: 'application/pdf', bytes: 9 },
            ],
            truncated: true,
          },
        }),
      ),
    ).toBe('ok');
    expect(code(message({ content: { parts: [text(LIMITS.partBytes + 1)] } }))).toBe('content_too_large');
    expect(code(message({ content: { parts: [text(30_000), text(30_000), text(30_000), text(30_000)] } }))).toBe('content_too_large');
    expect(code(message({ content: { parts: [{ kind: 'data', json: nested(17), truncated: false }] } }))).toBe('invalid_content');
    expect(code(message({ content: { parts: [{ kind: 'file', url: 'https://x' }] } }))).toBe('invalid_content');
    expect(code(message({ content: { parts: 'hello' } }))).toBe('invalid_content');
    expect(code(message({ parts: Array.from({ length: 65 }, () => ({ kind: 'text', bytes: 1 })) }))).toBe('invalid_parts');
    expect(code(message({ parts: [{ kind: 'video', bytes: 1 }] }))).toBe('invalid_parts');
    expect(code(message({ content: { parts: [text(1)] }, type: 'message.observed', role: 'agent' }))).toBe('ok');
  });

  it('rejects hostile data parts without throwing', () => {
    const data = (json: unknown) => message({ content: { parts: [{ kind: 'data', json, truncated: false }] } });
    expect(code(data(Array.from({ length: 200_000 }, (_, n) => n)))).toBe('content_too_large');
    expect(code(data(JSON.parse(`${'{"a":'.repeat(10_000)}1${'}'.repeat(10_000)}`)))).toBe('invalid_content');
    expect(code(data(nested(16)))).toBe('ok');
  });

  it('rejects envelopes over 8 KiB', () => {
    const extensions = Array.from({ length: 16 }, (_, n) => `https://ext.example/${String(n).padStart(490, '0')}`);
    expect(code(started({ a2a: { extensions_requested: extensions } }))).toBe('event_too_large');
  });
});

describe('validateBatch', () => {
  it('returns valid events and per-event rejections', () => {
    const result = validateBatch(
      { adapter: 'a2a-js@0.1.0', dropped: 3, events: [started(), { ...started(), kind: 'chat' }, finished()] },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      adapter: 'a2a-js@0.1.0',
      dropped: 3,
      rejected: [{ index: 1, code: 'invalid_field' }],
    });
    expect(result.ok && result.events.map((event) => event.type)).toEqual(['operation.started', 'operation.finished']);
  });

  it('keeps the valid events when another carries a hostile data part', () => {
    const json = Array.from({ length: 200_000 }, (_, n) => n);
    const hostile = message({ content: { parts: [{ kind: 'data', json, truncated: false }] } });
    const result = validateBatch({ adapter: 'x', events: [hostile, started()] }, NOW);
    expect(result).toMatchObject({ ok: true, rejected: [{ index: 0, code: 'content_too_large' }] });
    expect(result.ok && result.events).toHaveLength(1);
  });

  it('rejects malformed batches as a whole', () => {
    expect(validateBatch([], NOW)).toEqual({ ok: false, code: 'invalid_batch' });
    expect(validateBatch({ adapter: 'x', events: [], account_id: 'acc' }, NOW)).toEqual({
      ok: false,
      code: 'invalid_batch',
    });
    expect(validateBatch({ adapter: 'has space', events: [] }, NOW)).toEqual({ ok: false, code: 'invalid_adapter' });
    expect(validateBatch({ adapter: 'x', events: 'nope' }, NOW)).toEqual({ ok: false, code: 'invalid_batch' });
    expect(validateBatch({ adapter: 'x', dropped: -1, events: [] }, NOW)).toEqual({ ok: false, code: 'invalid_batch' });
    expect(validateBatch({ adapter: 'x', events: Array.from({ length: 101 }, started) }, NOW)).toEqual({
      ok: false,
      code: 'too_many_events',
    });
    expect(validateBatch({ adapter: 'x', events: [] }, NOW)).toEqual({
      ok: true,
      adapter: 'x',
      dropped: 0,
      events: [],
      rejected: [],
    });
  });
});
