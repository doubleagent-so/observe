/** `@doubleagent-so/observe/mcp`: record MCP servers and clients. */
export { instrumentMcpTransport, type McpTransportLike, type McpTransportOptions } from './transport.ts';
export { withMcpTelemetry, type McpTelemetryOptions } from './fetch.ts';
export { mcpOperation, type McpHandlerExtra } from './inflight.ts';
export type { McpOperationInfo, McpPeerInfo, McpRedactIds, McpRole, OnOperation } from './engine.ts';
