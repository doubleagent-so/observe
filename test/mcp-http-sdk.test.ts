import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import type { Recorder } from '../src/index';
import { instrumentMcpTransport } from '../src/mcp/index';
import { flightsServer, samplingClient } from './mcp-fixtures';
import { capture, expectValid, operation, starts } from './support';

const ENDPOINT = new URL('https://flights.example/mcp');

/** One stateful SDK server session served over fetch; remembers every POST response body. */
function statefulEndpoint(recorder?: Recorder) {
  const raw = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'session-1' });
  const transport = recorder ? instrumentMcpTransport(raw, { recorder, role: 'server', binding: 'streamable-http' }) : raw;
  const connected = flightsServer().connect(transport);
  const posts: Promise<string>[] = [];
  const fetch: FetchLike = async (input, init) => {
    await connected;
    const response = await transport.handleRequest(new Request(input, init));
    if (init?.method === 'POST') posts.push(response.clone().text());
    return response;
  };
  return { fetch, posts, close: () => transport.close() };
}

/** A new SDK server and stateless transport per request, as the SDK recommends. */
function statelessEndpoint(recorder: Recorder): FetchLike {
  return async (input, init) => {
    const transport = instrumentMcpTransport(new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined }), {
      recorder,
      role: 'server',
      binding: 'streamable-http',
    });
    await flightsServer().connect(transport);
    return transport.handleRequest(new Request(input, init));
  };
}

async function httpClient(fetch: FetchLike, recorder?: Recorder): Promise<Client> {
  const raw = new StreamableHTTPClientTransport(ENDPOINT, { fetch });
  const transport = recorder
    ? instrumentMcpTransport(raw, { recorder, role: 'client', binding: 'streamable-http', serverUrl: ENDPOINT.href })
    : raw;
  const client = samplingClient();
  await client.connect(transport);
  return client;
}

async function script(client: Client): Promise<void> {
  await client.callTool({ name: 'search', arguments: { to: 'Lisbon' } });
  await client.callTool({ name: 'fail' });
  await client.callTool({ name: 'ask' });
}

describe('Streamable HTTP SDK servers', () => {
  it('groups a stateful session and leaves every POST response byte-identical', async () => {
    const plain = statefulEndpoint();
    const plainClient = await httpClient(plain.fetch);
    await script(plainClient);
    await plainClient.close();
    await plain.close();

    const server = capture();
    const client = capture();
    const observed = statefulEndpoint(server.recorder);
    const observedClient = await httpClient(observed.fetch, client.recorder);
    await script(observedClient);
    await observedClient.close();
    await observed.close();

    expect(await Promise.all(observed.posts)).toEqual(await Promise.all(plain.posts));
    const events = await server.settle();
    expect(new Set(starts(events).map((event) => event.conversation_ref))).toEqual(new Set(['session-1']));
    expect(operation(events, 'tools/call').start).toMatchObject({
      target: 'search',
      protocol: { name: 'mcp', version: '2025-11-25', binding: 'streamable-http' },
      counterparty: { client_info: { name: 'claude-test', version: '0.9.0' } },
    });
    expect(operation(events, 'tools/call', 1).finish).toMatchObject({ outcome: 'tool_error' });
    expect(operation(events, 'sampling/createMessage').finish).toMatchObject({ outcome: 'ok' });

    const outbound = await client.settle();
    // The client learns the session ID from the initialize response, so only later operations carry it.
    expect(operation(outbound, 'initialize').start.conversation_ref).toBeUndefined();
    expect(operation(outbound, 'tools/call').start.conversation_ref).toBe('session-1');
    expectValid([...server.batches, ...client.batches]);
  });

  it('records stateless requests without a conversation, with the version from the request header', async () => {
    const server = capture();
    const client = await httpClient(statelessEndpoint(server.recorder));
    await client.callTool({ name: 'search', arguments: { to: 'Faro' } });
    await client.close();
    const events = await server.settle();
    expect(starts(events).every((event) => event.conversation_ref === undefined)).toBe(true);
    expect(operation(events, 'initialize').start.protocol.version).toBe('2025-11-25');
    expect(operation(events, 'tools/call').start).toMatchObject({ target: 'search', protocol: { version: '2025-11-25' } });
    expect(operation(events, 'tools/call').finish).toMatchObject({ outcome: 'ok' });
    expectValid(server.batches);
  });
});
