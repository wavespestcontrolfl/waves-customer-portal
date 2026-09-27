/**
 * draft_sms_reply (comms-tools.js) and draft_email_reply (email-tools.js) —
 * Codex r10-class gap on #4884: neither drafting call had an emptiness
 * check. An empty/refusal answer (a thinking-only or refused reply has no
 * .text) rendered as a blank draft a human silently never sends — the
 * ledger row still recorded a success with nothing usable produced, the
 * same gap this ledger exists to catch on every other draft lane
 * (estimate-assistant.js's answerWithAnthropic, etc). Fixed: both now flag
 * an empty draft with ledgerCallRejected(msg, 'invalid_output').
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

beforeEach(() => {
  jest.clearAllMocks();
  db.__rows = () => [];
});

describe('draft_email_reply (email-tools.js)', () => {
  const { draftEmailReply } = require('../services/intelligence-bar/email-tools');
  const EMAIL = { id: 'email-1', gmail_thread_id: 'thread-1', from_address: 'sender@example.invalid', from_name: 'Sender', subject: 'Hi', customer_id: null };

  function wire() {
    db.__rows = (q) => {
      if (q.sql.includes('from "emails"')) return [EMAIL];
      return [];
    };
  }

  test('an empty vision/text answer flags the ledger row and still returns a blank draft (never crashes)', async () => {
    wire();
    mockCreate.mockResolvedValue({ content: [] }); // no text block — e.g. a refusal
    const result = await draftEmailReply('email-1', null, null, null, []);
    expect(result.draft).toBe(true);
    expect(result.reply_draft).toBe('');
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
  });

  test('a usable answer is not flagged', async () => {
    wire();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Thanks for reaching out — we will follow up shortly.' }] });
    const result = await draftEmailReply('email-1', null, null, null, []);
    expect(result.reply_draft).toBe('Thanks for reaching out — we will follow up shortly.');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

describe('draft_sms_reply (comms-tools.js)', () => {
  const { executeCommsTool } = require('../services/intelligence-bar/comms-tools');
  const CUSTOMER = { id: 'cust-1', first_name: 'Sam', last_name: 'Customer', phone: '+19415550100', waveguard_tier: 'Bronze' };
  const INBOUND = { message_body: 'Can you come earlier?', created_at: new Date().toISOString() };

  function wire() {
    db.__rows = (q) => {
      if (q.sql.includes('from "customers"')) return [CUSTOMER];
      if (q.sql.includes('from "sms_log"')) return [INBOUND];
      return [];
    };
  }

  test('an empty/whitespace-only answer flags the ledger row and still returns a blank draft (never crashes)', async () => {
    wire();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '   ' }] });
    const result = await executeCommsTool('draft_sms_reply', { customer_id: 'cust-1' });
    expect(result.draft).toBe(true);
    expect(result.reply_draft).toBe('');
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
  });

  test('a usable answer is not flagged', async () => {
    wire();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Sure, we can move you up — call the office to confirm.' }] });
    const result = await executeCommsTool('draft_sms_reply', { customer_id: 'cust-1' });
    expect(result.reply_draft).toBe('Sure, we can move you up — call the office to confirm.');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});
