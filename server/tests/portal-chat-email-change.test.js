// GATE_PORTAL_CHAT_EMAIL_CHANGE: an email change in portal chat is a confirmed
// hand-off (owner ruling 2026-10-02). The chat reads the new address back,
// the customer confirms it, and the office gets ONE bell with the address on
// file and the new one; staff make the change. The model judges whether the
// customer confirmed; the server verifies the address is one the customer
// typed in this chat, and sends only the exact address its own read-back
// instruction carried in the previous turn and the assistant's reply showed.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

// Real Knex SQL compilation with an in-memory transport (same pattern as
// portal-chat-turn.test.js).
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__rows = () => [];
  db.__queries = [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    db.__queries.push(query.sql);
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/agent-gap-reports', () => ({ recordGap: jest.fn(async () => {}) }));
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { recordGap } = require('../services/agent-gap-reports');
const assistant = require('../services/ai-assistant/assistant');
const { portalToolsFor, executeToolCall, emailReadBackAwaitingAnswer } = require('../services/ai-assistant/tools');

const GATE = 'GATE_PORTAL_CHAT_EMAIL_CHANGE';
const NEW = 'Pat.New@Example.com';
const conversation = {
  id: 'conv-1', channel: 'portal_chat', channel_identifier: 'sess-1', customer_id: 'cust-1',
  status: 'active', message_count: 0, context_snapshot: { version: 2, firstName: 'Pat' },
};
const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', email: 'pat.old@example.com' };
// The chat so far, newest first (both reads of agent_messages are newest-first).
let chat;
let failMessages;

beforeEach(() => {
  jest.clearAllMocks();
  // Also drops replies a test queued and never used.
  mockCreate.mockReset();
  process.env[GATE] = 'true';
  chat = [];
  failMessages = false;
  db.__queries.length = 0;
  db.__bindings = [];
  db.__rows = (q) => {
    if (q.sql.includes('from "agent_sessions"')) return [conversation];
    if (q.sql.includes('from "agent_messages"')) {
      if (failMessages && q.sql.includes('limit')) throw new Error('db down');
      // A copy per read: buildHistory reverses its rows in place.
      return [...chat];
    }
    if (q.sql.includes('from "customers"')) return [customer];
    if (q.sql.includes('insert into "ai_escalations"')) { db.__bindings.push(q.bindings); return [{ id: 'esc-1' }]; }
    return [];
  };
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1', deduped: false });
});
afterAll(() => { delete process.env[GATE]; });

const say = (message) => assistant.processMessage({ message, channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });
const ask = (input) => ({ content: [{ type: 'tool_use', id: 't1', name: 'request_email_change', input }] });
const text = (words) => ({ content: [{ type: 'text', text: words }] });
// What the model was told by the tool.
const toolResult = () => JSON.parse(mockCreate.mock.calls[1][0].messages.at(-1).content[0].content);
// The tool's own logged result for a read-back turn.
const readBackRow = (address) => ({ role: 'tool_use', content: 'request_email_change', tool_results: JSON.stringify({ sent: false, read_back: address }) });
// The customer gave the address, the assistant read it back, the customer answers.
const afterReadBack = (answer, reply = `I have ${NEW} as your new email. Is that right?`, { address = NEW, logged = readBackRow(address) } = {}) => {
  chat = [
    { role: 'user', content: answer },
    { role: 'assistant', content: reply },
    ...(logged ? [logged] : []),
    { role: 'user', content: `Please change my email to ${address}.` },
  ];
  return answer;
};

test('gate off: no tool, and an email change is still a plain hand-off', async () => {
  delete process.env[GATE];
  mockCreate.mockResolvedValueOnce(text('Hi.'));

  await say('Hi');

  const call = mockCreate.mock.calls[0][0];
  expect(call.tools.map((t) => t.name)).not.toContain('request_email_change');
  expect(call.system[0].text).toMatch(/Changes to the account: email, phone/);
  expect(call.system[0].text).not.toMatch(/EMAIL CHANGE:/);
  expect(await executeToolCall('request_email_change', { new_email: NEW, customer_confirmed: true }, 'cust-1', [], null, { conversationId: 'conv-1' }))
    .toEqual({ error: 'Unknown tool: request_email_change' });
});

test('the tool sits before escalate, and the first call only reads the address back as the customer typed it', async () => {
  expect(portalToolsFor({ emailChange: true }).map((t) => t.name).slice(-2)).toEqual(['request_email_change', 'escalate']);
  chat = [{ role: 'user', content: `Please change my email to ${NEW}.` }];
  mockCreate
    .mockResolvedValueOnce(ask({ new_email: NEW.toLowerCase(), customer_confirmed: false }))
    .mockResolvedValueOnce(text(`I have ${NEW}. Is that right?`));

  const result = await say(`Please change my email to ${NEW}.`);

  const prompt = mockCreate.mock.calls[0][0].system[0].text;
  expect(prompt).toMatch(/EMAIL CHANGE:/);
  expect(prompt).toMatch(/Changes to the account: phone, address/);
  // The address is passed through as given: nothing is stripped or re-cased.
  expect(toolResult()).toEqual(expect.objectContaining({ sent: false, read_back: NEW.toLowerCase() }));
  // The address on file never reaches the model.
  expect(JSON.stringify(mockCreate.mock.calls[1][0].messages)).not.toMatch(/pat\.old/);
  expect(result.escalated).toBe(false);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(db.__queries.some((sql) => /update "customers"/.test(sql))).toBe(false);
});

test('confirmed after the read-back: one bell with both addresses, and the reply says the team makes the change', async () => {
  mockCreate.mockResolvedValueOnce(ask({ new_email: NEW, customer_confirmed: true }));

  const result = await say(afterReadBack('Yes, that is right'));

  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(category).toBe('alert');
  expect(headline).toBe("Customers — Change Pat Sample's email");
  expect(why).toBe('Pat Sample confirmed a new email address in portal chat');
  expect(opts.detail).toBe(`Email on file: pat.old@example.com\nNew email, confirmed by the customer in portal chat: ${NEW}\n\nCustomer's message: Yes, that is right`);
  expect(opts).toEqual(expect.objectContaining({ bell: true, link: '/admin/customers?customerId=cust-1', dedupeKey: 'portal-chat-email-change:conv-1:pat.new@example.com' }));
  // Saved as an account change, whatever the confirming message says.
  expect(db.__bindings[0]).toContain('account_change');
  expect(opts.metadata).toEqual(expect.objectContaining({ severity: 'needs-you', who: 'person', doneWhen: 'email_changed', subject: { type: 'customer', id: 'cust-1' } }));
  expect(result).toEqual(expect.objectContaining({ escalated: true, escalationId: 'esc-1', teamNotified: true }));
  expect(result.reply).toMatch(new RegExp(`sent your new email address, ${NEW.replace(/\./g, '\\.')}, to our team`));
  expect(result.reply).not.toMatch(/pat\.old|has been changed|is now/);
  // Staff make the change: the chat never writes the customer row.
  expect(db.__queries.some((sql) => /update "customers"/.test(sql))).toBe(false);
});

test('another tool already run this turn does not hide the read-back', async () => {
  const message = afterReadBack('Yes, and when is my next visit?');
  chat.unshift({ role: 'tool_use', content: 'get_upcoming_services', tool_results: JSON.stringify({ services: [] }) });
  mockCreate.mockResolvedValueOnce(ask({ new_email: NEW, customer_confirmed: true }));

  const result = await say(message);

  expect(result.escalated).toBe(true);
  expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toMatch(/New email, confirmed/);
});

test('a confirmation the portal sent twice still finds the read-back, and both land on one bell key', async () => {
  afterReadBack('Yes');
  chat.unshift({ role: 'user', content: 'Yes' });
  mockCreate.mockResolvedValue(ask({ new_email: NEW, customer_confirmed: true }));

  const [first, second] = await Promise.all([say('Yes'), say('Yes')]);

  expect(first.escalated && second.escalated).toBe(true);
  expect(NotificationService.notifyAdmin.mock.calls.map((call) => call[3].dedupeKey)).toEqual(['portal-chat-email-change:conv-1:pat.new@example.com', 'portal-chat-email-change:conv-1:pat.new@example.com']);
});

test('a keyword hand-off that answers a read-back carries the address, marked not yet confirmed', async () => {
  const message = afterReadBack('Yes that is right, and cancel my service');

  const result = await say(message);

  expect(mockCreate).not.toHaveBeenCalled();
  expect(result.escalated).toBe(true);
  const [, headline, , opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(headline).toBe('Comms — Reply to a portal chat request');
  expect(opts.detail).toBe(`Email on file: pat.old@example.com\nNew email the chat had just read back, not yet confirmed (the message below is the customer's answer): ${NEW}\n\nCustomer's message: ${message}`);
  expect(db.__bindings[0].some((value) => String(value).includes(`not yet confirmed (the message below is the customer's answer): ${NEW}`))).toBe(true);
  // The customer is not told the email change was sent as confirmed.
  expect(result.reply).not.toMatch(/new email address/);
});

test('a keyword hand-off with no read-back waiting is the plain hand-off', async () => {
  chat = [{ role: 'user', content: 'cancel my service' }];

  await say('cancel my service');

  expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toBe('cancel my service');
});

test('an address typed right before a comma or a slash is still the address', async () => {
  chat = [{ role: 'user', content: `change it to ${NEW},thanks` }];
  mockCreate
    .mockResolvedValueOnce(ask({ new_email: NEW, customer_confirmed: false }))
    .mockResolvedValueOnce(text(`I have ${NEW} . Is that right?`));

  await say(`change it to ${NEW},thanks`);

  expect(toolResult()).toEqual(expect.objectContaining({ sent: false, read_back: NEW }));
});

test('a first read-back and an escalate call in one reply: the read-back wins, nothing is handed off', async () => {
  chat = [{ role: 'user', content: `Please change my email to ${NEW}` }];
  mockCreate
    .mockResolvedValueOnce({ content: [
      { type: 'tool_use', id: 't0', name: 'escalate', input: { reason: 'email change', topic: 'account_change' } },
      { type: 'tool_use', id: 't1', name: 'request_email_change', input: { new_email: NEW, customer_confirmed: false } },
    ] })
    .mockResolvedValueOnce(text(`I have ${NEW} . Is that right?`));

  const result = await say(`Please change my email to ${NEW}`);

  expect(result.escalated).toBe(false);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  const results = mockCreate.mock.calls[1][0].messages.at(-1).content.map((r) => JSON.parse(r.content));
  expect(results).toEqual([expect.objectContaining({ read_back: NEW }), expect.objectContaining({ escalated: false })]);
});

test('the lane\'s fallback hand-off is saved as an account change, and only under the gate', async () => {
  const conv = { id: 'conv-1', customer_id: 'cust-1', channel: 'portal_chat' };
  await assistant.escalate(conv, 'please change my email', 'could not check', { topic: 'account_change' });
  delete process.env[GATE];
  await assistant.escalate(conv, 'please change my email', 'could not check', { topic: 'account_change' });

  expect(db.__bindings[0]).toContain('account_change');
  expect(db.__bindings[1]).toContain('schedule_change');
});

test('a second need handed off beside the confirmed change rides on the same bell and saved row', async () => {
  mockCreate.mockResolvedValueOnce({ content: [
    { type: 'tool_use', id: 't0', name: 'escalate', input: { reason: 'wants mosquito service quoted', topic: 'add_service' } },
    { type: 'tool_use', id: 't1', name: 'request_email_change', input: { new_email: NEW, customer_confirmed: true } },
  ] });

  await say(afterReadBack('Yes, and can you quote the mosquito add-on'));

  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const detail = NotificationService.notifyAdmin.mock.calls[0][3].detail;
  expect(detail).toMatch(new RegExp(`confirmed by the customer in portal chat: ${NEW.replace(/\./g, '\\.')}\nThe customer also asked about adding a service: wants mosquito service quoted\n\nCustomer's message:`));
  expect(db.__bindings[0].some((value) => String(value).includes('The customer also asked about adding a service: wants mosquito service quoted'))).toBe(true);
});

test('an address longer than the account can hold is handed off, never read back', async () => {
  const long = `${'a'.repeat(140)}@example.com`;
  chat = [{ role: 'user', content: `Change it to ${long}` }];

  const result = await executeToolCall('request_email_change', { new_email: long, customer_confirmed: false }, 'cust-1', [], null,
    { emailChange: true, conversationId: 'conv-1', customerMessage: chat[0].content });
  const fits = await executeToolCall('request_email_change', { new_email: long.slice(2), customer_confirmed: false }, 'cust-1', [], null,
    { emailChange: true, conversationId: 'conv-1', customerMessage: `Change it to ${long.slice(2)}` });

  expect(long.length).toBe(152);
  expect(result).toEqual(expect.objectContaining({ sent: false, instruction: expect.stringMatching(/longer than the account can hold/) }));
  expect(result).not.toHaveProperty('read_back');
  expect(fits.read_back).toBe(long.slice(2));
});

test('a confirmed change and an escalate call in one reply ring one bell, the one with the address', async () => {
  mockCreate.mockResolvedValueOnce({ content: [
    { type: 'tool_use', id: 't0', name: 'escalate', input: { reason: 'email change', topic: 'account_change' } },
    { type: 'tool_use', id: 't1', name: 'request_email_change', input: { new_email: NEW, customer_confirmed: true } },
  ] });

  await say(afterReadBack('Yes'));

  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toMatch(/New email, confirmed/);
});

test('another account change beside the confirmed email is carried too, and a gap is filed under its own reason', async () => {
  mockCreate.mockResolvedValueOnce({ content: [
    { type: 'tool_use', id: 't0', name: 'escalate', input: { reason: 'new gate code is needed on the account', topic: 'account_change', not_supported: true } },
    { type: 'tool_use', id: 't1', name: 'request_email_change', input: { new_email: NEW, customer_confirmed: true } },
  ] });

  await say(afterReadBack('Yes, and my gate code changed too'));

  expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toMatch(/The customer also asked about an account change: new gate code is needed on the account/);
  expect(recordGap).toHaveBeenCalledWith(expect.objectContaining({ summary: 'new gate code is needed on the account' }));
});

test('when the bell does not ring the customer is not told the team has it', async () => {
  NotificationService.notifyAdmin.mockResolvedValue(null);
  mockCreate.mockResolvedValueOnce(ask({ new_email: NEW, customer_confirmed: true }));

  const result = await say(afterReadBack('Yes'));

  expect(result.teamNotified).toBe(false);
  expect(result.reply).toMatch(/saved your email change request/);
  // What was saved names both addresses: the request does not depend on the bell.
  expect(db.__bindings[0]).toContain(`Customer confirmed a new email address in portal chat. Email on file: pat.old@example.com. New email, confirmed by the customer in portal chat: ${NEW}`);
  expect(result.reply).not.toMatch(/sent your new email/);
});

test('the address sent is the one read back, character for character (a leading underscore is part of it)', async () => {
  const address = '_pat.new@example.com';
  mockCreate.mockResolvedValueOnce(ask({ new_email: address, customer_confirmed: true }));

  const result = await say(afterReadBack('Yes', `I have ${address} as your new email. Is that right?`, { address }));

  expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toMatch(/portal chat: _pat\.new@example\.com\n/);
  expect(result.reply).toMatch(/address, _pat\.new@example\.com, to our team/);
});

test.each([
  ['the assistant\'s last reply did not show the address', () => afterReadBack('Yes', 'What is the new address?')],
  ['the last reply showed a longer address', () => afterReadBack('Yes', `I have x${NEW}. Is that right?`)],
  ['the last reply showed it with an underscore in front', () => afterReadBack('Yes', `I have _${NEW}. Is that right?`)],
  ['the last reply showed it as the start of a longer token', () => afterReadBack('Yes', `I have ${NEW}_bad.net. Is that right?`)],
  ['the last reply showed it with a longer domain', () => afterReadBack('Yes', `I have ${NEW}.au. Is that right?`)],
  ['the read-back was for another address', () => afterReadBack('Yes', `I have _${NEW}. Is that right?`, { logged: readBackRow(`_${NEW}`) })],
  ['the only read-back is from this same turn', () => {
    afterReadBack(`Change it to ${NEW}, yes I am sure`, `Sure. Is ${NEW} the new one?`, { logged: null });
    chat.unshift(readBackRow(NEW));
    return chat[1].content;
  }],
  ['another customer message came after the read-back', () => {
    afterReadBack('Yes');
    chat.splice(1, 0, { role: 'user', content: 'Hold on' });
    return 'Yes';
  }],
  ['no read-back was asked for last turn', () => afterReadBack('Yes', `I have ${NEW}. Is that right?`, { logged: null })],
  ['the read-back was a turn before the last one', () => {
    afterReadBack('Yes');
    chat.splice(1, 0, { role: 'assistant', content: 'Your next visit is Friday.' }, { role: 'user', content: 'When is my next visit?' });
    return 'Yes';
  }],
  ['there is no earlier reply at all', () => { chat = [{ role: 'user', content: `Change it to ${NEW}, yes I am sure` }]; return chat[0].content; }],
])('claimed confirmed but %s: read back again, nothing sent', async (_name, arrange) => {
  const message = arrange();
  mockCreate
    .mockResolvedValueOnce(ask({ new_email: NEW, customer_confirmed: true }))
    .mockResolvedValueOnce(text(`I have ${NEW}. Is that right?`));

  const result = await say(message);

  expect(toolResult()).toEqual(expect.objectContaining({ sent: false, read_back: NEW }));
  expect(result.escalated).toBe(false);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test.each([
  ['an address the customer never typed', 'pat.other@example.com', /not in the customer's own messages/],
  ['a shorter address inside the one they typed', 'New@Example.com', /not in the customer's own messages/],
  ['the address they typed with its leading underscore dropped', 'pat.under@example.com', /not in the customer's own messages/],
  ['the tail of a mistyped token with two @ signs', 'tail@example.com', /not in the customer's own messages/],
  ['something that is not an address', 'pat at example', /not a complete email address/],
  ['the address already on the account', 'pat.old@example.com', /already the email on the account/],
])('%s is never sent', async (_name, address, instruction) => {
  afterReadBack('Yes');
  chat.push({ role: 'user', content: 'My email now is pat.old@example.com' });
  chat.push({ role: 'user', content: 'Or use _pat.under@example.com' });
  chat.push({ role: 'user', content: 'Or old@tail@example.com' });
  mockCreate
    .mockResolvedValueOnce(ask({ new_email: address, customer_confirmed: true }))
    .mockResolvedValueOnce(text('Could you type the new address?'));

  const result = await say('Yes');

  expect(toolResult().sent).toBe(false);
  expect(toolResult().instruction).toMatch(instruction);
  expect(result.escalated).toBe(false);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('a failed read of the chat hands off instead of sending', async () => {
  afterReadBack('Yes');
  failMessages = true;

  const result = await executeToolCall('request_email_change', { new_email: NEW, customer_confirmed: true }, 'cust-1', [], null,
    { emailChange: true, conversationId: 'conv-1', customerMessage: 'Yes' });

  expect(result.sent).toBe(false);
  expect(result.instruction).toMatch(/escalate tool with topic account_change/);
});

test('an address the customer types is not read as asking for the owner', async () => {
  const message = 'My new email is homeowner.adam@example.com';
  expect(assistant.matchedEscalationTrigger(message, 'portal_chat')).toBeNull();
  expect(assistant.matchedEscalationTrigger(`${message}, and I want to cancel`, 'portal_chat')).toBe('cancel');
  // Only the address is left out, not words that touch it.
  expect(assistant.matchedEscalationTrigger('use pat.new@example.com,cancel my service', 'portal_chat')).toBe('cancel');
  expect(assistant.matchedEscalationTrigger('use pat.new@example.com/cancel my service', 'portal_chat')).toBe('cancel');
  delete process.env[GATE];
  expect(assistant.matchedEscalationTrigger(message, 'portal_chat')).toBe('owner');
});


test('coordinated email checks use bounded history and customer reads', async () => {
  const turn = { query: jest.fn((query) => query) };
  const context = { emailChange: true, conversationId: 'conv-1', customerMessage: NEW };
  await expect(executeToolCall('request_email_change', { new_email: NEW }, 'cust-1', [], [], context, turn))
    .resolves.toMatchObject({ read_back: NEW });
  await emailReadBackAwaitingAnswer('conv-1', 'yes', turn);
  expect(turn.query.mock.calls.map((call) => call[1]))
    .toEqual(['email change history', 'email change customer', 'email read-back']);
});

test.each(['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014', 'AbortError', 'KnexTimeoutError']
  .flatMap((identity) => ['email change history', 'email change customer', 'email read-back'].map((stage) => [identity, stage])))
('email cancellation %s at %s stops without another read', async (identity, stage) => {
  const error = Object.assign(new Error('cancelled'), { code: identity, name: identity });
  const turn = { query: jest.fn((query, label) => {
    if (label === stage) throw error;
    return query;
  }) };
  const result = stage === 'email read-back'
    ? emailReadBackAwaitingAnswer('conv-1', 'yes', turn)
    : executeToolCall('request_email_change', { new_email: NEW }, 'cust-1', [], [],
      { emailChange: true, conversationId: 'conv-1', customerMessage: NEW }, turn);
  await expect(result).rejects.toBe(error);
  expect(turn.query).toHaveBeenCalledTimes(stage === 'email change customer' ? 2 : 1);
});
