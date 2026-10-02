import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as RuntimeResponse } from 'miniflare';
import { expect, it } from 'vitest';

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// The worker keeps one recorder per isolate (the usual Workers setup) and flushes it in each request's waitUntil.
const worker = `
import { createRecorder } from './src/index.ts';
let recorder;
export default {
  async fetch(request, env, ctx) {
    recorder ??= createRecorder({ key: 'ak_test_x', endpoint: 'https://telemetry.test', flushIntervalMs: 0 });
    recorder.startOperation({
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
      counterparty: { authenticated: { issuer: 'https://idp', subject: new URL(request.url).pathname } },
    }).finish({ outcome: 'ok' });
    ctx.waitUntil(recorder.flush());
    return new Response('ok');
  },
};
`;

async function bundle(source: string): Promise<string> {
  const built = await build({
    stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
  });
  return built.outputFiles[0].text;
}

// workerd forbids timers in the global scope, so a recorder created there with the default timer must still work.
const moduleScopeWorker = `
import { createRecorder } from './src/index.ts';
const recorder = createRecorder({ key: 'ak_test_x', endpoint: 'https://telemetry.test' });
export default {
  async fetch(request, env, ctx) {
    recorder.startOperation({
      protocol: { name: 'a2a', version: '1.0', binding: 'jsonrpc-http' },
      direction: 'inbound',
      method: 'SendMessage',
      kind: 'message',
    }).finish({ outcome: 'ok' });
    ctx.waitUntil(recorder.flush());
    return new Response('ok');
  },
};
`;

it('runs a recorder created at module scope on workerd without a timer, logging it once', async () => {
  const logs: string[] = [];
  const received: string[] = [];
  const runtime = new Miniflare({
    handleStructuredLogs: (log: { message: string }) => logs.push(log.message),
    workers: [
      {
        config: {
          name: 'observe-module-scope-test',
          compatibilityDate: '2026-10-01',
          manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: await bundle(moduleScopeWorker) } } },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request: { text(): Promise<string> }) => {
              const batch = JSON.parse(await request.text()) as { events: Array<{ event_id: string }> };
              received.push(...batch.events.map((event) => event.event_id));
              return RuntimeResponse.json({ accepted: batch.events.length, rejected: [] }, { status: 202 });
            },
          },
        },
      },
    ],
  });
  try {
    expect(await (await runtime.dispatchFetch('http://localhost/one')).text()).toBe('ok');
    expect(await (await runtime.dispatchFetch('http://localhost/two')).text()).toBe('ok');
    for (let wait = 0; received.length < 4 && wait < 100; wait++) await delay(20);
    expect(received).toHaveLength(4);
    expect(logs.filter((message) => message.includes('agent_telemetry_timer_unavailable'))).toHaveLength(1);
  } finally {
    await runtime.dispose();
  }
}, 20_000);

it('flushes a recorder shared across requests on workerd without crossing request contexts', async () => {
  const logs: string[] = [];
  const received: string[] = [];
  let calls = 0;
  let open = 0;
  let overlapped = false;
  const runtime = new Miniflare({
    handleStructuredLogs: (log: { message: string }) => logs.push(log.message),
    workers: [
      {
        config: {
          name: 'observe-workers-test',
          compatibilityDate: '2026-10-01',
          manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: await bundle(worker) } } },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request: { text(): Promise<string> }) => {
              // The first flush is slow, so the second request flushes while it is still in flight.
              overlapped ||= open > 0;
              open++;
              if (++calls === 1) await delay(300);
              const batch = JSON.parse(await request.text()) as { events: Array<{ event_id: string }> };
              received.push(...batch.events.map((event) => event.event_id));
              open--;
              return RuntimeResponse.json({ accepted: batch.events.length, rejected: [] }, { status: 202 });
            },
          },
        },
      },
    ],
  });
  try {
    expect(await (await runtime.dispatchFetch('http://localhost/one')).text()).toBe('ok');
    await delay(50);
    expect(await (await runtime.dispatchFetch('http://localhost/two')).text()).toBe('ok');
    for (let wait = 0; received.length < 4 && wait < 100; wait++) await delay(20);
    // Let workerd report anything left over from the first request.
    await delay(200);
    expect(new Set(received).size).toBe(4);
    expect(received).toHaveLength(4);
    // The real regression check: the second request sent its own events instead of waiting on the first request's
    // flush (the old recorder awaited a promise created in the other request).
    expect(overlapped).toBe(true);
    // A guard only: workerd warns about cross-request promises once the creating request has ended, which waitUntil
    // prevents here, so the old recorder did not trip this assertion either.
    expect(logs.filter((message) => /different request context|cross-request|hang/i.test(message))).toEqual([]);
  } finally {
    await runtime.dispose();
  }
}, 20_000);
