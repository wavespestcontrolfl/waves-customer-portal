// A portal chat turn end to end through processMessage: the portal gets its
// own prompt and button tools and the reply carries the buttons; SMS, and the
// portal with PORTAL_CHAT_SELF_SERVE off, send the model exactly what they
// did before.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

// Real Knex SQL compilation with an in-memory transport (same pattern as
// ai-assistant-empty-reply-ledger.test.js).
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

const db = require('../models/db');
const assistant = require('../services/ai-assistant/assistant');

const ENV = 'PORTAL_CHAT_SELF_SERVE';
const conversationFor = (channel) => ({
  id: 'conv-1', channel, channel_identifier: 'sess-1',
  customer_id: null, status: 'active', message_count: 0, context_snapshot: null,
});

function wire(channel) {
  db.__rows = (q) => (q.sql.includes('from "agent_sessions"') ? [conversationFor(channel)] : []);
}

const toolNames = (call) => call.tools.map((t) => t.name);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[ENV];
});
afterAll(() => { delete process.env[ENV]; });

test('a billing ask in the portal returns the reply with an Open Billing button', async () => {
  wire('portal_chat');
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'open_portal_section', input: { section: 'billing' } }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Your Billing page lists every payment with its receipt.' }] });

  const result = await assistant.processMessage({ message: 'Explain my last charge', channel: 'portal_chat', channelIdentifier: 'sess-1' });

  const first = mockCreate.mock.calls[0][0];
  expect(toolNames(first)).toEqual(['get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section', 'escalate']);
  expect(first.system[0].text).toMatch(/inside the customer portal/);
  expect(result.escalated).toBe(false);
  expect(result.reply).toBe('Your Billing page lists every payment with its receipt.');
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
});

test('a portal reply with no button tool carries no actions field', async () => {
  wire('portal_chat');
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Ghost ants follow moisture.' }] });
  const result = await assistant.processMessage({ message: 'ants', channel: 'portal_chat', channelIdentifier: 'sess-1' });
  expect(result).not.toHaveProperty('actions');
});

test.each([
  ['an SMS turn', 'sms', undefined],
  ['a portal turn with the kill switch off', 'portal_chat', 'off'],
])('%s sends the model the original prompt and three tools', async (_name, channel, env) => {
  if (env) process.env[ENV] = env;
  wire(channel);
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Happy to help.' }] });

  const result = await assistant.processMessage({ message: 'Hi', channel, channelIdentifier: 'sess-1', customerPhone: '+15550100' });

  const call = mockCreate.mock.calls[0][0];
  expect(toolNames(call)).toEqual(['get_upcoming_services', 'get_pest_advice', 'escalate']);
  expect(call.system[0].text).toMatch(/^You are the Waves Pest Control AI assistant\. You help customers/);
  expect(call.system[0].text).not.toMatch(/offer_reschedule_link/);
  expect(result).not.toHaveProperty('actions');
});
