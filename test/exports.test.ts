import { describe, expect, it } from 'vitest';

/** The runtime exports of each entry point. Types are listed explicitly in the entry files. */
const ROOT_EXPORTS = [
  'ACCESS_LEVELS',
  'BINDINGS',
  'CAPABILITIES',
  'COST_CATEGORIES',
  'CURRENCY',
  'DELEGATION_PROTOCOLS',
  'DIRECTIONS',
  'EVENT_TYPES',
  'KINDS',
  'LIMITS',
  'MANDATE_SCHEMES',
  'MONEY_BASES',
  'OUTCOMES',
  'PART_KINDS',
  'PAYMENT_METHODS',
  'PEGGED_TOKENS',
  'PROOF_KINDS',
  'ROLES',
  'SCHEMA_VERSION',
  'SIGNATURE_SCHEMES',
  'TASK_STATES',
  'TERMINAL_STATES',
  'TRANSACTION_KINDS',
  'TRANSACTION_STATUSES',
  'buildContent',
  'costEvent',
  'costMicros',
  'createRecorder',
  'currencyExponent',
  'isMoneyEvent',
  'isTerminal',
  'oauthEvidence',
  'parseInsufficientScope',
  'peggedTo',
  'protocolOf',
  'signedRequestEvidence',
  'summarizeParts',
  'toMicros',
  'toMinorUnits',
  'transactionEvent',
  'truncateUtf8',
  'ulid',
  'validateBatch',
  'validateEvent',
];

const A2A_EXPORTS = [
  'a2aError',
  'a2aKind',
  'a2aParts',
  'a2aTaskState',
  'a2aTelemetryInterceptor',
  'instrumentA2AHandler',
  'instrumentTaskStore',
  'withA2ATelemetry',
];

const MCP_EXPORTS = ['instrumentMcpTransport', 'mcpOperation', 'withMcpTelemetry'];

describe('public surface', () => {
  it('exports exactly the recorder API from the root', async () => {
    expect(Object.keys(await import('../src/index')).sort()).toEqual(ROOT_EXPORTS);
  });

  it('exports exactly the A2A entry points and the documented mapping helpers from /a2a', async () => {
    expect(Object.keys(await import('../src/a2a/index')).sort()).toEqual(A2A_EXPORTS);
  });

  it('exports exactly the MCP entry points from /mcp; the mapping and engine stay internal', async () => {
    expect(Object.keys(await import('../src/mcp/index')).sort()).toEqual(MCP_EXPORTS);
  });
});
