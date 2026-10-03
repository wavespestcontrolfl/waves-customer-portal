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
const mockListPayments = jest.fn(async () => ({ payments: [] }));
jest.mock('../services/portal-payment-history', () => ({ listPortalPayments: (...a) => mockListPayments(...a) }));
const mockListVisits = jest.fn(async () => ({ services: [], total: 0 }));
jest.mock('../services/portal-service-history', () => ({ listPortalServiceHistory: (...a) => mockListVisits(...a) }));
const mockLaneState = jest.fn(async () => ({ eligible: ['pest'], open: {}, bookable: ['pest'], verified: true, hasRecurringPlan: true }));
jest.mock('../services/reservice-scheduler', () => {
  const actual = jest.requireActual('../services/reservice-scheduler');
  return {
    reportedReserviceLanes: actual.reportedReserviceLanes,
    reportedReserviceExcludedSpecialty: actual.reportedReserviceExcludedSpecialty,
    reserviceSelfServeEnabled: () => true,
    loadReserviceLaneAvailability: (...a) => mockLaneState(...a),
  };
});
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

const db = require('../models/db');
const assistant = require('../services/ai-assistant/assistant');

const ENV = 'PORTAL_CHAT_SELF_SERVE';
const conversationFor = (channel, customerId = null) => ({
  id: 'conv-1', channel, channel_identifier: 'sess-1',
  customer_id: customerId, status: 'active', message_count: 0,
  // A signed-in customer's active conversation carries the minimal snapshot
  // (version 2), or getOrCreateConversation retires it.
  context_snapshot: customerId ? { version: 2, firstName: 'Pat' } : null,
});

function wire(channel, customerId = null) {
  db.__rows = (q) => (q.sql.includes('from "agent_sessions"') ? [conversationFor(channel, customerId)] : []);
}

const toolNames = (call) => call.tools.map((t) => t.name);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[ENV];
  delete process.env.GATE_PORTAL_CHAT_FACTS;
  delete process.env.GATE_PORTAL_CHAT_VISIT_FACTS;
  delete process.env.GATE_PORTAL_CHAT_RESERVICE;
});
afterAll(() => {
  delete process.env[ENV];
  delete process.env.GATE_PORTAL_CHAT_FACTS;
  delete process.env.GATE_PORTAL_CHAT_RESERVICE;
});

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

test('a hand-off carries its topic: from the model on an escalate call, from the keyword group on a forced one', async () => {
  wire('portal_chat');
  const escalate = jest.spyOn(assistant, 'escalate').mockResolvedValue({ reply: 'ok', escalated: true });
  mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', id: 't1', name: 'escalate', input: { reason: 'wants a new email on file', topic: 'account_change' } }] });

  await assistant.processMessage({ message: 'Please change my email', channel: 'portal_chat', channelIdentifier: 'sess-1' });
  await assistant.processMessage({ message: 'I want to cancel', channel: 'portal_chat', channelIdentifier: 'sess-1' });

  expect(escalate.mock.calls[0][3]).toEqual({ gap: false, topic: 'account_change' });
  expect(escalate.mock.calls[1][3]).toEqual({ topic: 'cancellation' });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  const escalateTool = mockCreate.mock.calls[0][0].tools.find((t) => t.name === 'escalate');
  expect(escalateTool.input_schema.required).toEqual(['reason', 'topic']);
  escalate.mockRestore();
});

test('GATE_PORTAL_CHAT_FACTS on: the facts prompt and tools, and the reply carries the card', async () => {
  process.env.GATE_PORTAL_CHAT_FACTS = 'true';
  mockListPayments.mockResolvedValue({ payments: [{ id: 'p1', date: '2026-09-28', amount: 129, status: 'paid', description: 'Invoice WV-1 — Pest', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: '/receipt/tok' }] });
  // A signed-in customer: the card tool is customer-scoped.
  wire('portal_chat', 'cust-1');
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'show_recent_payments', input: {} }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Your last payment went through; the card below has the details.' }] });

  const result = await assistant.processMessage({ message: 'Explain my last charge', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  const first = mockCreate.mock.calls[0][0];
  expect(toolNames(first)).toContain('show_recent_payments');
  expect(first.system[0].text).toMatch(/CHARGES AND PAYMENTS:/);
  expect(first.system[0].text).not.toMatch(/BILLING, PLAN, REPORTS/);
  // The tool result the model saw carries no figure.
  const toolResult = mockCreate.mock.calls[1][0].messages.at(-1).content[0].content;
  expect(toolResult).not.toMatch(/129|WV-1|4242|Sep/);
  expect(result.cards).toEqual([expect.objectContaining({ type: 'payments', rows: [expect.objectContaining({ amountLabel: '$129.00', receiptUrl: '/receipt/tok' })] })]);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
});

test('a card shown before a hand-off in the same turn stays on the hand-off reply', async () => {
  process.env.GATE_PORTAL_CHAT_FACTS = 'true';
  mockListPayments.mockResolvedValue({ payments: [{ id: 'p1', date: '2026-09-28', amount: 129, status: 'paid', description: 'Pest', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: null }] });
  wire('portal_chat', 'cust-1');
  const escalate = jest.spyOn(assistant, 'escalate').mockResolvedValue({ reply: 'sent to the team', escalated: true, teamNotified: true });
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'show_recent_payments', input: {} }] })
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't2', name: 'escalate', input: { reason: 'asks why the amount changed', topic: 'billing' } }] });

  const result = await assistant.processMessage({ message: 'Why is my last charge higher?', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  expect(result.escalated).toBe(true);
  expect(result.cards).toHaveLength(1);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
  escalate.mockRestore();
});

test('a card and a hand-off asked for in one response: the card runs first and rides the hand-off reply', async () => {
  process.env.GATE_PORTAL_CHAT_FACTS = 'true';
  mockListPayments.mockResolvedValue({ payments: [{ id: 'p1', date: '2026-09-28', amount: 129, status: 'paid', description: 'Pest', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: null }] });
  wire('portal_chat', 'cust-1');
  const escalate = jest.spyOn(assistant, 'escalate').mockResolvedValue({ reply: 'sent', escalated: true, teamNotified: true });
  mockCreate.mockResolvedValueOnce({ content: [
    { type: 'tool_use', id: 't1', name: 'escalate', input: { reason: 'why did it go up', topic: 'billing' } },
    { type: 'tool_use', id: 't2', name: 'show_recent_payments', input: {} },
  ] });

  const result = await assistant.processMessage({ message: 'Why did my charge go up?', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  expect(result.escalated).toBe(true);
  expect(result.cards).toHaveLength(1);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
  escalate.mockRestore();
});

test('a billing keyword hand-off ("refund") still shows the card under the facts gate, with no model call', async () => {
  process.env.GATE_PORTAL_CHAT_FACTS = 'true';
  mockListPayments.mockResolvedValue({ payments: [{ id: 'p1', date: '2026-09-28', amount: 129, status: 'paid', description: 'Pest', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: null }] });
  wire('portal_chat', 'cust-1');
  const escalate = jest.spyOn(assistant, 'escalate').mockResolvedValue({ reply: 'sent', escalated: true, teamNotified: true });

  const result = await assistant.processMessage({ message: 'Please refund my last payment', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  expect(mockCreate).not.toHaveBeenCalled();
  expect(escalate.mock.calls[0][3]).toEqual({ topic: 'billing' });
  expect(result.cards).toHaveLength(1);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
  escalate.mockRestore();
});

test('a card built before the model call fails still shows under the fallback text', async () => {
  process.env.GATE_PORTAL_CHAT_FACTS = 'true';
  mockListPayments.mockResolvedValue({ payments: [{ id: 'p1', date: '2026-09-28', amount: 129, status: 'paid', description: 'Pest', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: null }] });
  wire('portal_chat', 'cust-1');
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'show_recent_payments', input: {} }] })
    .mockRejectedValueOnce(new Error('provider down'));

  const result = await assistant.processMessage({ message: 'Explain my last charge', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  expect(result.reply).toMatch(/having trouble/);
  expect(result.cards).toHaveLength(1);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
});

test('GATE_PORTAL_CHAT_VISIT_FACTS on: structured facts to the model, the summary on a card, and the gates compose', async () => {
  process.env.GATE_PORTAL_CHAT_VISIT_FACTS = 'true';
  mockListVisits.mockResolvedValue({ services: [{ id: 's1', date: '2026-09-28', type: 'Pest Control', technician: 'Jordan Sample', notes: 'Treated the lanai.', products: [{ product_name: 'BrandName', product_category: 'insecticide' }], reportUrl: '/report/tok_r' }], total: 1 });
  wire('portal_chat', 'cust-1');
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'get_recent_visits', input: {} }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Jordan treated the lanai on Sep 28.' }] });

  const result = await assistant.processMessage({ message: 'What was done last visit?', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  const first = mockCreate.mock.calls[0][0];
  expect(toolNames(first)).toEqual(['get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section', 'get_recent_visits', 'escalate']);
  expect(first.system[0].text).toMatch(/PAST VISITS:/);
  expect(first.system[0].text).toMatch(/COMPANY FACTS \(owner-approved/);
  // Payments gate off: the billing section is still the page-button one.
  expect(first.system[0].text).toMatch(/BILLING, PLAN, REPORTS/);
  const toolResult = mockCreate.mock.calls[1][0].messages.at(-1).content[0].content;
  expect(toolResult).toMatch(/Pest Control/);
  expect(toolResult).not.toMatch(/Treated the lanai|BrandName|tok_r|Sample/);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open completed visits and reports', tab: 'services' }]);
  expect(result.cards).toEqual([expect.objectContaining({ type: 'visits', rows: [expect.objectContaining({ summary: 'Treated the lanai.', reportUrl: '/report/tok_r' })] })]);

  // Both gates: both fact tools, both prompt sections.
  process.env.GATE_PORTAL_CHAT_FACTS = 'true';
  mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi.' }] });
  await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });
  const both = mockCreate.mock.calls.at(-1)[0];
  expect(toolNames(both)).toEqual(expect.arrayContaining(['show_recent_payments', 'get_recent_visits']));
  expect(both.system[0].text).toMatch(/CHARGES AND PAYMENTS:/);
  expect(both.system[0].text).toMatch(/PAST VISITS:/);
});

test('visits gate alone: a billing keyword hand-off shows no payment card (the payment gate is off)', async () => {
  process.env.GATE_PORTAL_CHAT_VISIT_FACTS = 'true';
  wire('portal_chat', 'cust-1');
  const escalate = jest.spyOn(assistant, 'escalate').mockResolvedValue({ reply: 'sent', escalated: true, teamNotified: true });

  const result = await assistant.processMessage({ message: 'Please refund my last payment', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

  expect(mockListPayments).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('cards');
  expect(result).not.toHaveProperty('actions');
  escalate.mockRestore();
});

describe('GATE_PORTAL_CHAT_RESERVICE', () => {
  const gates = require('../config/feature-gates');
  let isEnabled;
  beforeEach(() => {
    process.env.GATE_PORTAL_CHAT_RESERVICE = 'true';
    isEnabled = jest.spyOn(gates, 'isEnabled').mockImplementation((name) => name === 'reserviceStreamline');
    wire('portal_chat', 'cust-1');
    db.__rows = (q) => {
      if (q.sql.includes('from "agent_sessions"')) return [conversationFor('portal_chat', 'cust-1')];
      if (q.sql.includes('"reservice_token" from "customers"')) return [{ reservice_token: 'tok_rs' }];
      if (q.sql.includes('select "content" from "agent_messages"')) return mockRecentWords(q);
      return [];
    };
  });
  afterEach(() => isEnabled.mockRestore());
  // Newest first, as the read orders them; by default only the turn's own message.
  let mockRecentWords;
  beforeEach(() => { mockRecentWords = () => []; });

  const pestTurn = (extra = {}) => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Sorry about the ants. Your plan covers a free visit; tap below to book it.' }] });
    return assistant.processMessage({ message: 'The ants are back in the kitchen', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', ...extra });
  };

  test('the tool and the prompt section join the lane, and a primary-property session gets the booking button', async () => {
    const result = await pestTurn({ secondaryProperty: false });

    const first = mockCreate.mock.calls[0][0];
    expect(toolNames(first)).toEqual(['get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section', 'offer_reservice', 'escalate']);
    expect(first.system[0].text).toMatch(/PESTS BACK BETWEEN VISITS:/);
    expect(first.system[0].text).toMatch(/\(offer_reservice\)/);
    expect(mockLaneState).toHaveBeenCalledWith('cust-1');
    expect(result.actions).toEqual([{ type: 'link', label: 'Book your free pest control re-service', href: '/reservice/tok_rs' }]);
    const toolResult = mockCreate.mock.calls[1][0].messages.at(-1).content[0].content;
    expect(toolResult).not.toMatch(/tok_rs/);
  });

  test.each([
    ['a secondary saved-property session', { secondaryProperty: true }],
    ['a caller that names no property scope', {}],
  ])('%s gets no button', async (_label, extra) => {
    const result = await pestTurn(extra);

    expect(mockLaneState).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actions');
  });

  test('the customer\'s message reaches the tool: a rodent report gets no free offer even when the model picks pest', async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Sorry about that, I am passing this to the team.' }] });

    const result = await assistant.processMessage({ message: 'The rats are back in the attic', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

    expect(mockLaneState).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actions');
    expect(mockCreate.mock.calls[1][0].messages.at(-1).content[0].content).toMatch(/separately priced/);
  });

  test('the customer\'s newest messages are read newest-first, so a long chat still classifies its latest words', async () => {
    let sql;
    mockRecentWords = (q) => { sql = q.sql; return [{ content: 'yes please' }, { content: 'The ants are back in the kitchen' }]; };
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Tap below to book it.' }] });

    const result = await assistant.processMessage({ message: 'yes please', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

    expect(sql).toMatch(/order by "created_at" desc, "id" desc limit \$\d/);
    expect(result.actions).toEqual([{ type: 'link', label: 'Book your free pest control re-service', href: '/reservice/tok_rs' }]);
  });

  test('the words read is skipped when the re-service gate is off', async () => {
    delete process.env.GATE_PORTAL_CHAT_RESERVICE;
    let read = false;
    mockRecentWords = () => { read = true; return []; };
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi.' }] });

    await assistant.processMessage({ message: 'The ants are back', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

    expect(read).toBe(false);
  });

  test('the gates compose: every portal section in one prompt', async () => {
    process.env.GATE_PORTAL_CHAT_FACTS = 'true';
    process.env.GATE_PORTAL_CHAT_VISIT_FACTS = 'true';
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi.' }] });

    await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

    const call = mockCreate.mock.calls[0][0];
    expect(toolNames(call)).toEqual(expect.arrayContaining(['show_recent_payments', 'get_recent_visits', 'offer_reservice']));
    expect(call.system[0].text).toMatch(/CHARGES AND PAYMENTS:[\s\S]*PAST VISITS:[\s\S]*PESTS BACK BETWEEN VISITS:[\s\S]*WHAT YOU MUST ESCALATE/);
  });
});

test('gate off: the portal prompt has no payment card tool', async () => {
  wire('portal_chat');
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Hi.' }] });
  await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1' });
  const call = mockCreate.mock.calls[0][0];
  expect(toolNames(call)).not.toContain('show_recent_payments');
  expect(toolNames(call)).not.toContain('get_recent_visits');
  expect(call.system[0].text).toMatch(/BILLING, PLAN, REPORTS/);
  expect(call.system[0].text).not.toMatch(/PAST VISITS:|COMPANY FACTS|PESTS BACK BETWEEN VISITS/);
  expect(toolNames(call)).not.toContain('offer_reservice');
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
