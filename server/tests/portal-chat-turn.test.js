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
jest.mock('../services/reservice-scheduler', () => {
  const actual = jest.requireActual('../services/reservice-scheduler');
  return {
    reportedReserviceLanes: actual.reportedReserviceLanes,
    reportedReserviceExcludedSpecialty: actual.reportedReserviceExcludedSpecialty,
    isActivePestReport: actual.isActivePestReport,
    RESERVICE_LAWN_SERVICE_WORDS: actual.RESERVICE_LAWN_SERVICE_WORDS,
    reserviceSelfServeEnabled: () => true,
    openReserviceCallbacks: async () => ({}),
  };
});
// The /reservice page's own verdict: pest bookable for cust-1.
const mockPageState = jest.fn(async () => ({ customer: { id: 'cust-1' }, laneCatalog: {}, lanes: [{ key: 'pest', alreadyBooked: null }], bookableLanes: ['pest'] }));
jest.mock('../routes/reservice-public', () => ({ _internals: { TOKEN_RE: /^[a-f0-9]{64}$/, pageLaneState: (...a) => mockPageState(...a), reserviceLocationReviewRequired: async () => false } }));
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
  delete process.env.GATE_PORTAL_CHAT_RESERVICE_LAWN;
});
afterAll(() => {
  delete process.env[ENV];
  delete process.env.GATE_PORTAL_CHAT_FACTS;
  delete process.env.GATE_PORTAL_CHAT_RESERVICE;
  delete process.env.GATE_PORTAL_CHAT_RESERVICE_LAWN;
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

test('a portal escalation checkpoints its exact handoff and completed cards inside the escalation transaction', async () => {
  const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample' };
  const escalation = { id: 'esc-1' };
  const cards = [{ type: 'payments', title: 'Your most recent payment', rows: [{ id: 'p1' }] }];
  const actions = [{ type: 'tab', label: 'Open Billing', tab: 'billing' }];
  const trx = Object.assign(jest.fn((table) => {
    if (table === 'customers') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(customer) };
    if (table === 'ai_escalations') return {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([escalation]) }),
    };
    if (table === 'agent_sessions') return { where: jest.fn().mockReturnThis(), update: jest.fn().mockResolvedValue(1) };
    if (table === 'agent_messages') return {
      insert: jest.fn().mockReturnValue({
        onConflict: jest.fn().mockReturnValue({ ignore: jest.fn().mockResolvedValue(1) }),
      }),
    };
    throw new Error(`unexpected table ${table}`);
  }), { transaction: async (work) => work(trx) });
  let insideTransaction = false;
  const turn = {
    requestRowId: 'request-row-handoff',
    assertActive: jest.fn(),
    fallbackExtras: () => ({ actions, cards }),
    persistCommittedResult: jest.fn(async (_executor, result) => {
      expect(insideTransaction).toBe(true);
      return result;
    }),
    rememberCommittedResult: jest.fn((result) => result),
    transaction: async (_stage, work) => {
      insideTransaction = true;
      try { return await work(trx); } finally { insideTransaction = false; }
    },
  };
  const notify = jest.spyOn(assistant, 'notifyTeamOfEscalation').mockRejectedValue(new Error('bell write failed'));

  const result = await assistant.escalatePortalTurn(
    { id: 'conv-1', customer_id: 'cust-1', channel: 'portal_chat' },
    'Please help with this charge',
    'Customer needs billing help',
    { gap: false, topic: 'billing', turn },
  );

  expect(turn.persistCommittedResult).toHaveBeenCalledWith(trx, expect.objectContaining({
    escalated: true,
    escalationId: 'esc-1',
    teamNotified: false,
    generated: false,
    actions,
    cards,
  }));
  expect(turn.rememberCommittedResult).toHaveBeenCalledWith(expect.objectContaining({ escalated: true, cards }));
  expect(result).toEqual(expect.objectContaining({ escalated: true, actions, cards }));
  notify.mockRestore();
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
  let fallbackExtras;
  const turn = {
    requestRowId: 'request-row-card',
    query: (query) => query,
    transaction: (_stage, work) => work(db),
    waitFor: (work) => typeof work === 'function' ? work() : work,
    assertActive: jest.fn(),
    providerOptions: () => ({}),
    registerFallbackExtras: (provider) => { fallbackExtras = provider; },
  };

  const result = await assistant.processMessage({
    message: 'Explain my last charge', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', turn,
  });

  expect(result.reply).toMatch(/having trouble/);
  expect(result.cards).toHaveLength(1);
  expect(result.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
  expect(fallbackExtras()).toEqual(expect.objectContaining({ actions: result.actions, cards: result.cards }));
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
      if (q.sql.includes('"reservice_token" from "customers"')) return [{ reservice_token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }];
      if (q.sql.includes('from "agent_messages"')) return mockRecentWords(q);
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
    expect(mockPageState).toHaveBeenCalledWith('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    // The one plan fact this lane may state is the tool's.
    expect(first.system[0].text).toMatch(/plan details \(apart from what offer_reservice tells you\)/);
    expect(result.actions).toEqual([{ type: 'link', label: 'Book your free re-service', href: '/reservice/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }]);
    const toolResult = mockCreate.mock.calls[1][0].messages.at(-1).content[0].content;
    expect(toolResult).not.toMatch(/bbbbbbbb/);
  });

  test.each([
    ['a secondary saved-property session', { secondaryProperty: true }],
    ['a caller that names no property scope', {}],
  ])('%s gets no button', async (_label, extra) => {
    const result = await pestTurn(extra);

    expect(mockPageState).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actions');
  });

  test('the customer\'s message reaches the tool: a rodent report gets no free offer even when the model picks pest', async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Sorry about that, I am passing this to the team.' }] });

    const result = await assistant.processMessage({ message: 'The rats are back in the attic', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

    expect(mockPageState).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actions');
    expect(mockCreate.mock.calls[1][0].messages.at(-1).content[0].content).toMatch(/separately priced/);
  });

  test('portal history is read newest-first, and only this turn\'s message is classified', async () => {
    let sql;
    mockRecentWords = (q) => { sql = q.sql; return [{ role: 'user', content: 'yes please' }, { role: 'assistant', content: 'Sorry to hear that. Want me to check your plan?' }, { role: 'user', content: 'The ants are back in the kitchen' }]; };
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Let me pass that to the team.' }] });

    const result = await assistant.processMessage({ message: 'yes please', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

    expect(sql).toMatch(/order by "created_at" desc, "id" desc limit \$\d/);
    // Put back in order: the model's last message is the customer's newest.
    const sent = mockCreate.mock.calls[0][0].messages;
    const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join(''));
    expect(sent.map(textOf)).toEqual(['The ants are back in the kitchen', 'Sorry to hear that. Want me to check your plan?', 'yes please']);
    // "yes please" reports nothing: the earlier report is not carried forward.
    expect(mockPageState).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actions');
  });

  test('a newest-20 window that opens on an assistant row starts at the customer turn after it', async () => {
    mockRecentWords = () => [
      { role: 'user', content: 'yes please' },
      { role: 'assistant', content: 'Want me to check your plan?' },
      { role: 'user', content: 'The ants are back in the kitchen' },
      { role: 'assistant', content: 'Hi Pat, how can I help?' },
    ];
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Tap below.' }] });

    await assistant.processMessage({ message: 'yes please', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent[0]).toEqual(expect.objectContaining({ role: 'user', content: 'The ants are back in the kitchen' }));
    expect(sent).toHaveLength(3);
  });

  test('a turn that offers the re-service and then hands off drops the booking button, keeping the others', async () => {
    const escalate = jest.spyOn(assistant, 'escalate').mockResolvedValue({ reply: 'sent', escalated: true, teamNotified: true });
    mockCreate.mockResolvedValueOnce({ content: [
      { type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'pest' } },
      { type: 'tool_use', id: 't2', name: 'open_portal_section', input: { section: 'service_reports' } },
      { type: 'tool_use', id: 't3', name: 'escalate', input: { reason: 'Treatment did not work', topic: 'complaint' } },
    ] });

    const result = await assistant.processMessage({ message: 'The ants are back in the kitchen and your treatment did nothing', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

    expect(result.escalated).toBe(true);
    expect(result.actions).toEqual([{ type: 'tab', label: 'Open completed visits and reports', tab: 'services' }]);
    escalate.mockRestore();
  });

  describe('with GATE_PORTAL_CHAT_RESERVICE_LAWN', () => {
    beforeEach(() => { process.env.GATE_PORTAL_CHAT_RESERVICE_LAWN = 'true'; });

    test('the prompt and the tool gain the lawn line, and a quoted current lawn problem gets the button', async () => {
      mockPageState.mockResolvedValueOnce({ customer: { id: 'cust-1' }, laneCatalog: {}, lanes: [{ key: 'lawn', alreadyBooked: null }], bookableLanes: ['lawn'] });
      mockCreate
        .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'lawn', current_problem: true, customer_quote: 'weeds are coming back all over the lawn' } }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Sorry about the weeds. Your plan covers a free visit; tap below.' }] });

      const result = await assistant.processMessage({ message: 'Weeds are coming back all over the lawn', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

      const first = mockCreate.mock.calls[0][0];
      const tool = first.tools.find((t) => t.name === 'offer_reservice');
      expect(tool.input_schema.properties.service_line.enum).toEqual(['pest', 'lawn']);
      expect(first.system[0].text).toMatch(/call offer_reservice in that same turn with service line lawn, current_problem true, and customer_quote/);
      expect(first.system[0].text).not.toMatch(/A lawn problem \(weeds, brown or thin grass\) is not this tool's/);
      expect(result.actions).toEqual([{ type: 'link', label: 'Book your free re-service', href: `/reservice/${'b'.repeat(64)}` }]);
    });

    test('a quote from an earlier turn is not in this message: no button', async () => {
      mockCreate
        .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'offer_reservice', input: { service_line: 'lawn', current_problem: true, customer_quote: 'weeds are coming back all over the lawn' } }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Let me pass that along.' }] });

      const result = await assistant.processMessage({ message: 'yes please', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', secondaryProperty: false });

      expect(mockPageState).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('actions');
    });

    test('the lawn gate without the offer\'s own gate changes nothing', async () => {
      delete process.env.GATE_PORTAL_CHAT_RESERVICE;
      mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi.' }] });

      await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

      const call = mockCreate.mock.calls[0][0];
      expect(toolNames(call)).not.toContain('offer_reservice');
      expect(call.system[0].text).not.toMatch(/PESTS BACK BETWEEN VISITS/);
    });
  });

  test('SMS keeps the original oldest-first history read', async () => {
    let sql;
    mockRecentWords = (q) => { sql = q.sql; return []; };
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi.' }] });

    await assistant.processMessage({ message: 'Hi', channel: 'sms', channelIdentifier: '+15550100', customerPhone: '+15550100' });

    expect(sql).toMatch(/order by "created_at" asc limit \$\d/);
  });

  test('with visit facts on too, a problem since the visit goes to the re-service rule, not a blanket hand-off', async () => {
    process.env.GATE_PORTAL_CHAT_VISIT_FACTS = 'true';
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi.' }] });

    await assistant.processMessage({ message: 'Hi', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });

    const text = mockCreate.mock.calls[0][0].system[0].text;
    expect(text).not.toMatch(/reports a problem since the visit or says something was missed, escalate/);
    expect(text).toMatch(/Pests back since the visit follow PESTS BACK BETWEEN VISITS/);
    expect(text).toMatch(/A lawn problem \(weeds, brown or thin grass\) is not this tool's: escalate it with topic pest_problem/);
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

test('a coordinated portal turn passes its deadline signal and retry budget to Anthropic', async () => {
  wire('portal_chat', 'cust-1');
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Happy to help.' }] });
  const controller = new AbortController();
  const providerOptions = {
    signal: controller.signal,
    timeout: 4_200,
    maxRetries: 0,
  };
  const turn = {
    requestRowId: 'request-row-1',
    query: (query) => query,
    waitFor: (promise) => promise,
    assertActive: jest.fn(),
    providerOptions: jest.fn(() => providerOptions),
  };

  const result = await assistant.processMessage({
    message: 'Hi',
    channel: 'portal_chat',
    channelIdentifier: 'sess-1',
    customerId: 'cust-1',
    turn,
  });

  expect(result.reply).toBe('Happy to help.');
  expect(mockCreate).toHaveBeenCalledWith(expect.any(Object), providerOptions);
  expect(turn.providerOptions).toHaveBeenCalledTimes(1);
  expect(turn.assertActive).toHaveBeenCalledWith('model response');
});

test('a coordinated model reply checkpoints and remembers the exact result inside transcript persistence', async () => {
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Happy to help.' }] });
  let activeStage = null;
  const rememberedResult = { reply: 'Happy to help.', requestId: 'request-1', generated: true };
  const turn = {
    requestRowId: 'request-row-1',
    assertActive: jest.fn(),
    providerOptions: () => undefined,
    transaction: async (stage, work) => {
      activeStage = stage;
      try {
        return await work(db);
      } finally {
        activeStage = null;
      }
    },
    persistCommittedResult: jest.fn(async (executor, result) => {
      expect(activeStage).toBe('assistant reply persistence');
      expect(executor).toBe(db);
      expect(result).toEqual(expect.objectContaining({
        reply: 'Happy to help.',
        conversationId: 'conv-1',
        generated: true,
      }));
      return rememberedResult;
    }),
    rememberCommittedResult: jest.fn((result) => result),
  };

  const result = await assistant.answerWithTools({
    conversation: { id: 'conv-1' },
    message: 'Hi',
    history: [{ role: 'user', content: 'Hi' }],
    contextStr: '',
    lane: { prompt: 'Help the customer.', tools: [], actions: null, cards: null },
    customerId: 'cust-1',
    channel: 'portal_chat',
    turn,
  });

  expect(turn.persistCommittedResult).toHaveBeenCalledTimes(1);
  expect(turn.rememberCommittedResult).toHaveBeenCalledWith(rememberedResult);
  expect(result).toBe(rememberedResult);
});

test('a controlled provider stops when the coordinated portal signal aborts', async () => {
  wire('portal_chat', 'cust-1');
  const controller = new AbortController();
  let providerObservedAbort = false;
  mockCreate.mockImplementation((_body, options) => new Promise((_resolve, reject) => {
    const abort = () => {
      providerObservedAbort = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }));
  const turn = {
    requestRowId: 'request-row-2',
    query: (query) => query,
    waitFor: (promise) => promise,
    assertActive: jest.fn(),
    providerOptions: () => ({ signal: controller.signal, timeout: 100, maxRetries: 0 }),
  };
  const pending = assistant.processMessage({
    message: 'Hi',
    channel: 'portal_chat',
    channelIdentifier: 'sess-1',
    customerId: 'cust-1',
    turn,
  });
  setTimeout(() => controller.abort(), 10);

  const result = await pending;

  expect(providerObservedAbort).toBe(true);
  expect(result.reply).toMatch(/trouble/);
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
