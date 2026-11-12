/**
 * After-hours Waves AI on the portal Messages page (GATE_PORTAL_MESSAGES_NIGHT_AI) against live Postgres, with the
 * model call scripted (no network, no cost). Pins: gate off or inside 8 AM to 8 PM nothing changes; at night the
 * answer comes after the POST returned, is saved as Waves AI's, and the thread stays an open Portal-tab item
 * (count, item, Mark handled, staff answer, the late "still waiting" ring); a hand-off is the thread's one fixed
 * reply with no second item, bell or page; at most one answer per customer message; the cap; a staff answer that
 * lands first wins; the notice is the in-app bell plus an app push, never the email. Every row is synthetic and
 * tagged with this run's id. It refuses any database but a private QA one or CI's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'portal-messages-night-ai-postgres-only';
process.env.ANTHROPIC_API_KEY = 'test-key';

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendPortalReply: jest.fn(async () => ({ ok: true, messageId: 'email-1' })),
  sendRequestUpdated: jest.fn(async () => ({ ok: true })),
}));
const mockPushResult = { subscriptions: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: jest.fn(async () => mockPushResult),
  resolveNotificationPropertyId: jest.fn(async () => null),
}));
jest.mock('../services/portal-ask-push', () => ({
  pushPortalAsk: jest.fn(async () => ({ sent: true })),
  shortName: (first, last) => [first, last ? `${last[0]}.` : ''].filter(Boolean).join(' '),
}));
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
// The Eastern hour a test pretends it is (null = the real clock).
let mockHour = null;
jest.mock('../utils/datetime-et', () => {
  const real = jest.requireActual('../utils/datetime-et');
  return { ...real, etParts: (date) => (mockHour === null ? real.etParts(date) : { ...real.etParts(date), hour: mockHour }) };
});
const mockCap = jest.fn();
jest.mock('../middleware/portal-chat-customer-cap', () => ({ checkPortalChatCustomerCap: (...args) => mockCap(...args) }));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('portal messages: after-hours Waves AI (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const ids = { customers: [] };
  const NIGHT = 23;
  const DAY = 10;
  const GATES = ['GATE_PORTAL_MESSAGES', 'GATE_PORTAL_INBOX', 'GATE_PORTAL_MESSAGES_NIGHT_AI'];
  let db;
  let PortalMessages;
  let PortalInbox;
  let NightAi;
  let AccountMembershipEmail;
  let PushService;

  const actor = { technicianId: null, role: 'admin' };
  const phone = () => `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const answer = (words) => ({ content: [{ type: 'text', text: words }], usage: {} });
  const toolUse = (name, input) => ({ content: [{ type: 'tool_use', id: `t-${randomUUID().slice(0, 6)}`, name, input }], usage: {} });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function customer(first = 'Pat') {
    const [row] = await db('customers').insert({ first_name: first, last_name: `Synthetic${RUN}`, phone: phone(), email: `${RUN}-${first.toLowerCase()}@example.com`, active: true }).returning('*');
    ids.customers.push(row.id);
    return row;
  }

  const thread = async (customerId) => db('conversations').where({ customer_id: customerId, channel: 'portal', our_endpoint_id: 'portal' }).first();
  const rows = async (customerId) => db('messages as m').join('conversations as c', 'c.id', 'm.conversation_id')
    .where({ 'c.customer_id': customerId, 'c.channel': 'portal' }).orderBy('m.created_at').select('m.*');
  const aiRows = async (customerId) => (await rows(customerId)).filter((r) => r.message_type === 'portal_ai_reply');
  const openAdminBells = (key, value) => db('notifications').where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw(`metadata->>'${key}' = ?`, [String(value)]);
  const adminBellsFor = (customerId) => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'customerId' = ?", [customerId]);
  const escalationsFor = (customerId) => db('ai_escalations').where({ customer_id: customerId });
  const outcomeOf = async (messageId) => (await db('messages').where({ id: messageId }).first('metadata')).metadata?.nightAi?.outcome || null;
  // The AI step runs after the POST returned: wait for its outcome on the customer's message.
  async function settled(messageId) {
    for (let i = 0; i < 150; i += 1) {
      const outcome = await outcomeOf(messageId);
      if (outcome) return outcome;
      await pause(100);
    }
    throw new Error('the after-hours step did not finish');
  }
  async function post(c, body, { hour = NIGHT, clientRequestId = null } = {}) {
    mockHour = hour;
    try {
      return await PortalMessages.customerPost({ customer: c, body, clientRequestId });
    } finally {
      mockHour = null;
    }
  }

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    PortalMessages = require('../services/portal-messages');
    PortalInbox = require('../services/portal-inbox');
    NightAi = require('../services/portal-messages-night-ai');
    AccountMembershipEmail = require('../services/account-membership-email');
    PushService = require('../services/push-notifications');
  }, 60000);

  afterAll(async () => {
    for (const gate of [...GATES, 'GATE_PORTAL_CHAT_OPEN']) delete process.env[gate];
    if (!db) return;
    const threads = await db('conversations').whereIn('customer_id', ids.customers).where({ channel: 'portal' }).pluck('id');
    await db('notifications').whereRaw("title like ? or metadata->>'portalConversationId' = any(?) or recipient_id = any(?)", [`%${RUN}%`, threads, ids.customers]).del();
    await db('conversations').whereIn('id', threads).del();
    await db('service_requests').whereIn('customer_id', ids.customers).del();
    await db('ai_escalations').whereIn('customer_id', ids.customers).del();
    await db('agent_sessions').whereIn('customer_id', ids.customers).del();
    await db('customers').whereIn('id', ids.customers).del();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockReset();
    mockCap.mockReset();
    mockCap.mockResolvedValue({ allowed: true });
    mockHour = null;
    mockPushResult.sent = 0;
    for (const gate of GATES) process.env[gate] = 'true';
    delete process.env.GATE_PORTAL_CHAT_OPEN;
  });

  test('the fixed hand-off sentence is one exported constant', () => {
    expect(NightAi.HAND_OFF_REPLY).toBe('Thanks for your message. A member of our team will answer here after 8 AM.');
  });

  test('at night the answer comes after the POST returned, is Waves AI\'s own row, and the thread stays an open item with its bell', async () => {
    const pat = await customer();
    let release;
    mockCreate.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(answer('Yes, our pest program covers ants. A technician treats the outside of your home each visit.')); }));

    const sent = await post(pat, 'Do you cover ants?');
    // The POST has returned with only the customer's own message: the model has not answered yet.
    expect(sent).toMatchObject({ from: 'you', body: 'Do you cover ants?' });
    expect(await aiRows(pat.id)).toHaveLength(0);
    for (let i = 0; i < 100 && !release; i += 1) await pause(50);
    release();
    expect(await settled(sent.id)).toBe('answered');

    const [ai] = await aiRows(pat.id);
    expect(ai).toMatchObject({ direction: 'outbound', author_type: 'agent', agent_name: 'Waves AI', message_type: 'portal_ai_reply', channel: 'portal', delivery_status: 'sent' });
    expect(ai.body).toBe('Yes, our pest program covers ants. A technician treats the outside of your home each visit.');
    expect(ai.metadata).toMatchObject({ ai: true, answersMessageId: sent.id });
    expect(ai.admin_user_id).toBeNull();

    // Not an answer by the office: last_message_at stays at the customer's message, so the thread is still open.
    const row = await thread(pat.id);
    expect(new Date(row.last_message_at).getTime()).toBe(new Date(row.last_inbound_at).getTime());
    expect(row.message_count).toBe(2);
    const listed = (await PortalInbox.list()).items.filter((item) => item.customer.id === pat.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: 'message', customerMessage: 'Do you cover ants?', aiReply: { handOff: false, body: ai.body } });
    expect(listed[0].lastAnswer).toBe('');
    expect((await PortalInbox.summary()).count).toBeGreaterThanOrEqual(1);
    const bells = await openAdminBells('portalConversationId', row.id);
    expect(bells).toHaveLength(1);

    // Both sides read it labelled; the customer's unread counts it.
    expect((await PortalMessages.customerThread(pat.id)).messages.map((m) => [m.from, m.ai === true])).toEqual([['you', false], ['waves', true]]);
    expect((await PortalMessages.customerThread(pat.id)).unread).toBe(1);
    expect((await PortalMessages.staffThread(row.id)).messages.map((m) => [m.direction, m.ai === true])).toEqual([['inbound', false], ['outbound', true]]);

    // The notice: the in-app bell and an app push, never the reply email, and nothing left pending for the sweep.
    const notice = await db('notifications').where({ recipient_type: 'customer', recipient_id: pat.id }).whereRaw("metadata->>'portalMessageId' = ?", [ai.id]).first();
    expect(notice).toMatchObject({ title: 'New message from Waves', link: '/?tab=messages' });
    expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(PushService.sendToCustomer.mock.calls[0][2]).toMatchObject({ nativeOnly: true });
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
    expect((await db('messages').where({ id: ai.id }).first('metadata')).metadata.notice).toMatchObject({ bell: true, pending: false });
    expect(await PortalMessages.resumePendingNotices(new Date(Date.now() + 10 * 60 * 1000))).toBe(0);
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();

    // Mark handled closes the item and its bell; a staff answer does too.
    const handled = await PortalInbox.markMessageHandled(row.id, sent.id, actor);
    expect(handled).toEqual({ handled: true, open: false });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
  }, 60000);

  test('the late "still waiting" ring still fires after the AI answered, and a staff answer closes the item and its bell', async () => {
    const { runPortalLateRering, dueAtFor, STILL_WAITING } = require('../services/portal-late-rering');
    const { bellEventAt } = require('../services/admin-alert-relevance');
    const pat = await customer('Late');
    mockCreate.mockResolvedValueOnce(answer('Our team can look at that for you.'));
    const sent = await post(pat, 'Can you come Friday?');
    expect(await settled(sent.id)).toBe('answered');
    const row = await thread(pat.id);
    const [bell] = await openAdminBells('portalConversationId', row.id);
    const afterDue = new Date(dueAtFor(bellEventAt(bell)).getTime() + 60 * 1000);

    await runPortalLateRering({ now: afterDue });
    const rung = await db('notifications').where({ id: bell.id }).first();
    expect(rung.metadata.lateReRungAt).toBe(afterDue.toISOString());
    expect(rung.body).toBe(`${STILL_WAITING}. They wrote in the portal: “Can you come Friday?”`);

    await PortalMessages.staffReply({ kind: 'message', id: row.id, body: 'Friday at 9.', actor });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    expect((await PortalInbox.list()).items.filter((item) => item.customer.id === pat.id)).toHaveLength(0);
    // The office's answer is the last answer; the AI's earlier reply is not shown as an item any more.
    const staff = (await PortalMessages.staffThread(row.id)).messages;
    expect(staff.map((m) => [m.direction, m.ai === true])).toEqual([['inbound', false], ['outbound', true], ['outbound', false]]);
  }, 60000);

  test('between 8 AM and 8 PM, with the gate off, or with an input gate off, nothing changes: no model call, no extra row, no session', async () => {
    const cases = [
      ['daytime', () => {}, DAY],
      ['gate off', () => { delete process.env.GATE_PORTAL_MESSAGES_NIGHT_AI; }, NIGHT],
      ['portal inbox off', () => { process.env.GATE_PORTAL_INBOX = 'false'; }, NIGHT],
    ];
    for (const [label, arrange, hour] of cases) {
      arrange();
      const pat = await customer(label.replace(/\W/g, ''));
      const sent = await post(pat, 'Is anyone there?', { hour });
      await pause(400);
      expect({ label, calls: mockCreate.mock.calls.length }).toEqual({ label, calls: 0 });
      const all = await rows(pat.id);
      expect(all.map((r) => r.id)).toEqual([sent.id]);
      expect(all[0].metadata.nightAi).toBeUndefined();
      expect(await db('agent_sessions').where({ customer_id: pat.id })).toHaveLength(0);
      expect(await openAdminBells('portalConversationId', (await thread(pat.id)).id)).toHaveLength(1);
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      for (const gate of GATES) process.env[gate] = 'true';
    }
  }, 60000);

  test('the day boundaries are 8 AM and 8 PM Eastern, any day of the week', () => {
    mockHour = null;
    const at = (iso) => NightAi.isAfterHours(new Date(iso));
    // 2026-11-12 is a Thursday in EST (UTC-5); 2026-11-14 a Saturday; 2026-11-15 a Sunday.
    expect(at('2026-11-12T12:59:00Z')).toBe(true); // 7:59 AM
    expect(at('2026-11-12T13:00:00Z')).toBe(false); // 8:00 AM
    expect(at('2026-11-13T00:59:00Z')).toBe(false); // 7:59 PM
    expect(at('2026-11-13T01:00:00Z')).toBe(true); // 8:00 PM
    expect(at('2026-11-15T20:00:00Z')).toBe(false); // Sunday 3 PM
    expect(at('2026-11-15T03:00:00Z')).toBe(true); // Saturday 10 PM
    expect(at('2026-07-15T11:59:00Z')).toBe(true); // 7:59 AM in EDT
    expect(at('2026-07-15T12:00:00Z')).toBe(false); // 8:00 AM in EDT
  });

  test('a hand-off is the thread\'s one fixed reply: no escalation row, no second bell or page, and the item stays open', async () => {
    const { pushPortalAsk } = require('../services/portal-ask-push');
    const pat = await customer('Hand');
    mockCreate.mockResolvedValueOnce(toolUse('escalate', { reason: 'Customer says the technician damaged a plant', topic: 'complaint' }));
    const first = await post(pat, 'The technician broke my hibiscus.');
    expect(await settled(first.id)).toBe('handoff');

    const [ai] = await aiRows(pat.id);
    expect(ai).toMatchObject({ author_type: 'agent', agent_name: 'Waves AI', body: NightAi.HAND_OFF_REPLY });
    expect(ai.metadata).toMatchObject({ ai: true, handOff: true });
    expect(await escalationsFor(pat.id)).toHaveLength(0);
    // One bell: the thread's own. One phone page: the message's.
    const bells = await adminBellsFor(pat.id);
    expect(bells).toHaveLength(1);
    expect(bells[0].metadata.dedupeKey).toBe(`portal-message:${(await thread(pat.id)).id}`);
    expect(pushPortalAsk).toHaveBeenCalledTimes(1);
    const item = (await PortalInbox.list()).items.find((i) => i.customer.id === pat.id);
    expect(item).toMatchObject({ kind: 'message', aiReply: { handOff: true, body: NightAi.HAND_OFF_REPLY } });
    expect((await PortalMessages.staffThread(item.id)).messages.at(-1)).toMatchObject({ ai: true, handOff: true, body: NightAi.HAND_OFF_REPLY });

    // A second night message gets no second fixed reply while the office has not answered.
    mockCreate.mockResolvedValueOnce(toolUse('escalate', { reason: 'Same complaint', topic: 'complaint' }));
    const second = await post(pat, 'Hello? Anyone?');
    expect(await settled(second.id)).toBe('superseded');
    expect(await aiRows(pat.id)).toHaveLength(1);

    // After the office answers, a later night message can be handed off again.
    await PortalMessages.staffReply({ kind: 'message', id: item.id, body: 'We will replace it.', actor });
    mockCreate.mockResolvedValueOnce(toolUse('escalate', { reason: 'Another complaint', topic: 'complaint' }));
    const third = await post(pat, 'Thank you but also the gate was left open.');
    expect(await settled(third.id)).toBe('handoff');
    expect(await aiRows(pat.id)).toHaveLength(2);
    expect(await escalationsFor(pat.id)).toHaveLength(0);
  }, 60000);

  test('a keyword hand-off, a failed model call and a quote request that would file an item are all the fixed reply, with nothing filed', async () => {
    const keyword = await customer('Key');
    const sentKeyword = await post(keyword, 'I want to cancel my service.');
    expect(await settled(sentKeyword.id)).toBe('handoff');
    expect(mockCreate).not.toHaveBeenCalled();
    expect((await aiRows(keyword.id))[0].body).toBe(NightAi.HAND_OFF_REPLY);
    expect(await escalationsFor(keyword.id)).toHaveLength(0);

    const failing = await customer('Fail');
    mockCreate.mockRejectedValueOnce(new Error('provider down'));
    const sentFail = await post(failing, 'What does the lawn plan cost?');
    expect(await settled(sentFail.id)).toBe('handoff');
    expect((await aiRows(failing.id))[0].body).toBe(NightAi.HAND_OFF_REPLY);
    expect(await escalationsFor(failing.id)).toHaveLength(0);

    // The opened-up chat's request_quote files a service request and a bell in the chat; here it hands off.
    process.env.GATE_PORTAL_CHAT_OPEN = 'true';
    const quote = await customer('Quote');
    mockCreate
      .mockResolvedValueOnce(toolUse('request_quote', { service: 'mosquito', note: 'backyard' }))
      .mockResolvedValueOnce(toolUse('escalate', { reason: 'Wants a mosquito quote', topic: 'other' }));
    const sentQuote = await post(quote, 'Can I get a mosquito quote?');
    expect(await settled(sentQuote.id)).toBe('handoff');
    const secondCall = mockCreate.mock.calls.at(-1)[0].messages.at(-1).content.map((r) => JSON.parse(r.content));
    expect(secondCall[0]).toMatchObject({ sent: false });
    expect(await db('service_requests').where({ customer_id: quote.id })).toHaveLength(0);
    expect(await escalationsFor(quote.id)).toHaveLength(0);
    expect(await adminBellsFor(quote.id)).toHaveLength(1);
  }, 60000);

  test('a tool that would show a button or card answers "no button" on this turn, and the AI answers in plain text', async () => {
    const pat = await customer('Btn');
    mockCreate
      .mockResolvedValueOnce(toolUse('offer_reschedule_link', {}))
      .mockResolvedValueOnce(answer('I cannot move visits from here, so our team will help with that.'));
    const sent = await post(pat, 'Can I move my visit?');
    expect(await settled(sent.id)).toBe('answered');
    const result = JSON.parse(mockCreate.mock.calls.at(-1)[0].messages.at(-1).content[0].content);
    expect(result).toMatchObject({ available: false });
    expect((await aiRows(pat.id))[0].body).toBe('I cannot move visits from here, so our team will help with that.');
    expect(await escalationsFor(pat.id)).toHaveLength(0);
  }, 60000);

  test('at most one answer per customer message: two starts at once, and a duplicate POST, run the model once', async () => {
    const pat = await customer('Once');
    let release;
    mockCreate.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(answer('We spray the outside perimeter.')); }));
    const sent = await post(pat, 'Where do you spray?', { clientRequestId: randomUUID() });
    const message = await db('messages').where({ id: sent.id }).first();
    const row = await thread(pat.id);
    mockHour = NIGHT;
    // A second start for the same saved message does nothing, while the first is still waiting on the model.
    const again = await NightAi.answerAfterHours({ customer: pat, threadId: row.id, message });
    mockHour = null;
    expect(again).toBeNull();
    for (let i = 0; i < 100 && !release; i += 1) await pause(50);
    release();
    expect(await settled(sent.id)).toBe('answered');

    const replayId = randomUUID();
    mockCreate.mockResolvedValueOnce(answer('Second.'));
    const first = await post(pat, 'Another question', { clientRequestId: replayId });
    const replay = await post(pat, 'Another question', { clientRequestId: replayId });
    expect(replay.id).toBe(first.id);
    await settled(first.id);
    await pause(300);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(await aiRows(pat.id)).toHaveLength(2);
  }, 60000);

  test('over the per-customer cap there is no AI answer and nothing else changes', async () => {
    const pat = await customer('Cap');
    mockCap.mockResolvedValueOnce({ allowed: false, reply: 'limit' });
    const sent = await post(pat, 'Another question please');
    expect(await settled(sent.id)).toBe('capped');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await aiRows(pat.id)).toHaveLength(0);
    expect(await escalationsFor(pat.id)).toHaveLength(0);
    expect(await openAdminBells('portalConversationId', (await thread(pat.id)).id)).toHaveLength(1);
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  }, 60000);

  test('a staff answer that lands while the model is working wins: the AI reply is not saved', async () => {
    const pat = await customer('Race');
    let release;
    mockCreate.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(answer('Too late.')); }));
    const sent = await post(pat, 'Is the lawn safe for pets?');
    const row = await thread(pat.id);
    await PortalMessages.staffReply({ kind: 'message', id: row.id, body: 'Yes, once it dries.', actor });
    for (let i = 0; i < 100 && !release; i += 1) await pause(50);
    release();
    expect(await settled(sent.id)).toBe('superseded');
    expect(await aiRows(pat.id)).toHaveLength(0);
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
  }, 60000);

  test('a failure while saving is swallowed: the message, its bell and the item stand', async () => {
    const pat = await customer('Boom');
    mockCreate.mockResolvedValueOnce(answer('Fine.'));
    const Conversations = require('../services/conversations');
    const realAppend = Conversations.appendMessage;
    const spy = jest.spyOn(Conversations, 'appendMessage')
      .mockImplementation((opts) => (opts.authorType === 'agent' ? Promise.reject(new Error('disk full')) : realAppend(opts)));
    try {
      const sent = await post(pat, 'Quick question');
      expect(await settled(sent.id)).toBe('failed');
    } finally {
      spy.mockRestore();
    }
    expect(await aiRows(pat.id)).toHaveLength(0);
    expect((await PortalInbox.list()).items.filter((item) => item.customer.id === pat.id)).toHaveLength(1);
    expect(await openAdminBells('portalConversationId', (await thread(pat.id)).id)).toHaveLength(1);
  }, 60000);
});
