/**
 * ai-assistant/assistant.js processMessage — a terminal tool-use-loop turn
 * with no tool call AND no usable text (a thinking-only or refused reply)
 * already degraded to the canned "having trouble" reply (so the customer
 * never saw a blank message), but the ledger row for that exact response
 * stayed a recorded success — the same Codex r10-class gap this ledger
 * exists to catch on every other draft/answer lane. Fixed: that response is
 * now flagged with ledgerCallRejected(response, 'invalid_output').
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

// Real Knex SQL compilation with an in-memory transport: never opens a DB
// socket (same pattern as intelligence-bar-operational-reads.test.js).
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__rows = () => [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const db = require('../models/db');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');
const assistant = require('../services/ai-assistant/assistant');

// An existing, active, anonymous (customer_id null) conversation — the
// simplest getOrCreateConversation path that returns immediately with no
// further inserts.
const CONVERSATION = {
  id: 'conv-1', channel: 'portal_chat', channel_identifier: 'sess-1',
  customer_id: null, status: 'active', message_count: 0, context_snapshot: null,
};

function wireDb() {
  db.__rows = (q) => {
    if (q.sql.includes('from "agent_sessions"')) return [CONVERSATION];
    return []; // agent_messages history, and both inserts/updates
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
});

test('a terminal turn with no tool call and no text flags the ledger row and still returns the canned reply', async () => {
  mockCreate.mockResolvedValue({ content: [] }); // no tool_use, no text — e.g. a refusal
  const result = await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1' });
  expect(result.reply).toMatch(/having trouble/i);
  expect(result.generated).not.toBe(true);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
});

test('a normal text reply is not flagged', async () => {
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'We can help with that — what pest are you seeing?' }] });
  const result = await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1' });
  expect(result.reply).toBe('We can help with that — what pest are you seeing?');
  expect(result.generated).toBe(true);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});
