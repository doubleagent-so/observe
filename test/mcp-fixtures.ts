/** A small real MCP server and client from the official SDK, shared by the MCP adapter tests. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export function flightsServer(): McpServer {
  const server = new McpServer({ name: 'flights', version: '1.0.0' });
  server.registerTool(
    'search',
    { description: 'Search flights', inputSchema: { to: z.string() }, outputSchema: { count: z.number() } },
    async ({ to }) => ({ content: [{ type: 'text', text: `3 flights to ${to}` }], structuredContent: { count: 3 } }),
  );
  server.registerTool('fail', { description: 'Always fails' }, async () => {
    throw new Error('upstream down');
  });
  server.registerTool('slow', { description: 'Waits until cancelled' }, async (extra) => {
    await new Promise<void>((resolve) => {
      extra.signal.addEventListener('abort', () => resolve());
    });
    return { content: [] };
  });
  server.registerTool('ask', { description: 'Asks the client model' }, async () => {
    await server.server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'summarize' } }], maxTokens: 50 });
    return { content: [{ type: 'text', text: 'asked' }] };
  });
  server.registerResource('guide', 'docs://guide?lang=en', { mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Guide' }],
  }));
  server.registerPrompt('plan', { description: 'Trip plan', argsSchema: { city: z.string() } }, ({ city }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Plan a trip to ${city}` } }],
  }));
  return server;
}

export function samplingClient(name = 'claude-test', version = '0.9.0'): Client {
  const client = new Client({ name, version }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    role: 'assistant',
    content: { type: 'text', text: 'sampled' },
    model: 'test-model',
  }));
  return client;
}
