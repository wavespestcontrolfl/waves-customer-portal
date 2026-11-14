/**
 * Office-hours Waves AI step-in on the portal Messages page (GATE_PORTAL_MESSAGES_DAY_AI) against live Postgres,
 * with the model call scripted (no network, no cost). Pins the candidate query on real rows: an open thread whose
 * newest customer message waited 120 open minutes is taken (answered in the thread as Waves AI, still the office's
 * open item, the customer's bell and push); a staff answer, Mark handled, an AI reply that already answers it, a
 * night claim, an older message of the thread, a message not yet due and the gate off are not taken; a hand-off
 * sends nothing and records left_for_team; a second sweep takes nothing twice. Every row is synthetic and tagged
 * with this run's id. It refuses any database but a private QA one or CI's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'portal-messages-day-ai-postgres-only';
process.env.ANTHROPIC_API_KEY = 'test-key';

const { randomUUID, randomBytes } = require('crypto');

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
const mockCap = jest.fn();
jest.mock('../middleware/portal-chat-customer-cap', () => ({ checkPortalChatCustomerCap: (...args) => mockCap(...args) }));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('portal messages: office-hours Waves AI step-in (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const ids = { customers: [], visits: [] };
  const GATES = ['GATE_PORTAL_MESSAGES', 'GATE_PORTAL_INBOX', 'GATE_PORTAL_MESSAGES_DAY_AI'];
  // 2026-11-12 is a Thursday in EST (UTC-5). A message written at 10:00 AM ET is due at 12:00 PM ET.
  const WRITTEN = new Date('2026-11-12T15:00:00Z');
  const DUE = new Date('2026-11-12T17:30:00Z');
  const NOT_YET = new Date('2026-11-12T16:30:00Z');
  let db;
  let PortalMessages;
  let PortalInbox;
  let NightAi;
  let DayAi;
  let AccountMembershipEmail;
  let PushService;

  const actor = { technicianId: null, role: 'admin' };
  const phone = () => `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const answer = (words) => ({ content: [{ type: 'text', text: words }], usage: {} });
  const toolUse = (name, input) => ({ content: [{ type: 'tool_use', id: `t-${randomUUID().slice(0, 6)}`, name, input }], usage: {} });

  async function customer(first = 'Pat') {
    const [row] = await db('customers').insert({ first_name: first, last_name: `Synthetic${RUN}`, phone: phone(), email: `${RUN}-${first.toLowerCase()}@example.com`, active: true }).returning('*');
    ids.customers.push(row.id);
    return row;
  }

  async function visit(customerId, { days = 10 } = {}) {
    const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: date, service_type: `Synthetic pest control ${RUN}`, status: 'confirmed',
      window_start: '09:00', window_end: '10:00', reschedule_token: randomBytes(32).toString('hex'),
    }).returning('*');
    ids.visits.push(row.id);
    return row;
  }

  // A customer message in the thread, moved back in time to `at`: the message and the thread's stamps.
  async function written(c, body, at = WRITTEN) {
    const sent = await PortalMessages.customerPost({ customer: c, body });
    await db('messages').where({ id: sent.id }).update({ created_at: at });
    await db('conversations').where({ customer_id: c.id, channel: 'portal' }).update({ last_message_at: at, last_inbound_at: at });
    return sent;
  }

  const groundedTurn = (text) => mockCreate
    .mockResolvedValueOnce(toolUse('get_upcoming_services', {}))
    .mockResolvedValueOnce(answer(text));
  const thread = async (customerId) => db('conversations').where({ customer_id: customerId, channel: 'portal', our_endpoint_id: 'portal' }).first();
  const rows = async (customerId) => db('messages as m').join('conversations as c', 'c.id', 'm.conversation_id')
    .where({ 'c.customer_id': customerId, 'c.channel': 'portal' }).orderBy('m.created_at').select('m.*');
  const aiRows = async (customerId) => (await rows(customerId)).filter((r) => r.message_type === 'portal_ai_reply');
  const metaOf = async (messageId) => (await db('messages').where({ id: messageId }).first('metadata')).metadata || {};
  // A message a test leaves open and not taken is parked (claimed by the night step's key), so a later sweep in
  // this file never meets it with no scripted model answer.
  const park = (messageId) => NightAi.__private.claimMessage(messageId);

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    PortalMessages = require('../services/portal-messages');
    PortalInbox = require('../services/portal-inbox');
    NightAi = require('../services/portal-messages-night-ai');
    DayAi = require('../services/portal-messages-day-ai');
    AccountMembershipEmail = require('../services/account-membership-email');
    PushService = require('../services/push-notifications');
  }, 60000);

  afterAll(async () => {
    for (const gate of [...GATES, 'GATE_PORTAL_MESSAGES_NIGHT_AI']) delete process.env[gate];
    if (!db) return;
    const threads = await db('conversations').whereIn('customer_id', ids.customers).where({ channel: 'portal' }).pluck('id');
    await db('notifications').whereRaw("title like ? or metadata->>'portalConversationId' = any(?) or recipient_id = any(?)", [`%${RUN}%`, threads, ids.customers]).del();
    await db('conversations').whereIn('id', threads).del();
    await db('scheduled_services').whereIn('id', ids.visits).del();
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
    mockPushResult.sent = 0;
    for (const gate of GATES) process.env[gate] = 'true';
    delete process.env.GATE_PORTAL_MESSAGES_NIGHT_AI;
  });

  test('a message that waited 120 open minutes is answered in the thread on the day prompt, and the thread stays the office\'s open item', async () => {
    const pat = await customer();
    await visit(pat.id);
    const sent = await written(pat, 'When is my next visit?');
    groundedTurn('Your next visit is in ten days, between 9:00 and 11:00 AM.');

    const counts = await DayAi.answerWaitingMessages({ now: DUE });
    expect(counts.answered).toBeGreaterThanOrEqual(1);

    // The model ran on the day wording of the thread prompt.
    const system = JSON.stringify(mockCreate.mock.calls[0][0].system);
    expect(system).toContain('during office hours, and nobody on the team has answered yet');
    expect(system).not.toContain('tonight');

    const [ai] = await aiRows(pat.id);
    expect(ai).toMatchObject({ direction: 'outbound', author_type: 'agent', agent_name: 'Waves AI', message_type: 'portal_ai_reply', delivery_status: 'sent' });
    expect(ai.body).toBe('Your next visit is in ten days, between 9:00 and 11:00 AM.');
    expect(ai.metadata).toMatchObject({ ai: true, answersMessageId: sent.id, notice: { bell: true, pending: false } });
    expect((await metaOf(sent.id)).dayAi).toMatchObject({ outcome: 'answered' });
    expect((await metaOf(sent.id)).nightAi).toBeUndefined();

    // Not an answer by the office: the thread is still an open Portal-tab item.
    const row = await thread(pat.id);
    expect(new Date(row.last_message_at).getTime()).toBe(WRITTEN.getTime());
    expect((await PortalInbox.list()).items.filter((item) => item.customer.id === pat.id)).toHaveLength(1);
    expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();

    // A second sweep takes nothing twice: the claim and the AI reply both keep the message out.
    mockCreate.mockClear();
    await DayAi.answerWaitingMessages({ now: DUE });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await aiRows(pat.id)).toHaveLength(1);
  }, 60000);

  test('a message not yet 120 open minutes old, or any message with the gate off or an input gate off, is not taken', async () => {
    const pat = await customer('Early');
    const sent = await written(pat, 'Is anyone there?');
    await DayAi.answerWaitingMessages({ now: NOT_YET });
    expect((await metaOf(sent.id)).dayAi).toBeUndefined();

    for (const arrange of [() => { delete process.env.GATE_PORTAL_MESSAGES_DAY_AI; }, () => { process.env.GATE_PORTAL_INBOX = 'false'; }]) {
      arrange();
      expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual({ scanned: 0, answered: 0, silent: 0, leftForTeam: 0, capped: 0, superseded: 0, failed: 0 });
      for (const gate of GATES) process.env[gate] = 'true';
    }
    expect((await metaOf(sent.id)).dayAi).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
    await park(sent.id);
  }, 60000);

  test('nothing is taken while the clock is outside office hours', async () => {
    const pat = await customer('Late');
    const sent = await written(pat, 'Is anyone there?');
    await DayAi.answerWaitingMessages({ now: new Date('2026-11-13T03:00:00Z') }); // 10 PM ET
    expect((await metaOf(sent.id)).dayAi).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
    await park(sent.id);
  }, 60000);

  test('a staff answer after the message, and Mark handled, each keep it out', async () => {
    const answered = await customer('Staffed');
    const sentA = await written(answered, 'When is my next visit?');
    await PortalMessages.staffReply({ kind: 'message', id: (await thread(answered.id)).id, body: 'Friday at 9.', actor });

    const handled = await customer('Handled');
    const sentH = await written(handled, 'When is my next visit?');
    expect(await PortalInbox.markMessageHandled((await thread(handled.id)).id, sentH.id, actor)).toEqual({ handled: true, open: false });

    await DayAi.answerWaitingMessages({ now: DUE });
    expect((await metaOf(sentA.id)).dayAi).toBeUndefined();
    expect((await metaOf(sentH.id)).dayAi).toBeUndefined();
    expect(await aiRows(answered.id)).toHaveLength(0);
    expect(await aiRows(handled.id)).toHaveLength(0);
  }, 60000);

  test('a message an AI reply already answers, and a message the night step claimed, are not taken', async () => {
    const replied = await customer('Replied');
    const sentR = await written(replied, 'The gate was left open.');
    const row = await thread(replied.id);
    const saved = await NightAi.__private.saveReply(row.id, { id: sentR.id, created_at: WRITTEN }, { body: 'Thanks for your message.', handOff: true });
    expect(saved).toBeTruthy();

    const claimed = await customer('Claimed');
    const sentC = await written(claimed, 'When is my next visit?');
    expect(await NightAi.__private.claimMessage(sentC.id)).toBe(true);

    await DayAi.answerWaitingMessages({ now: DUE });
    expect((await metaOf(sentR.id)).dayAi).toBeUndefined();
    expect((await metaOf(sentC.id)).dayAi).toBeUndefined();
    expect(await aiRows(replied.id)).toHaveLength(1);
    expect(await aiRows(claimed.id)).toHaveLength(0);
  }, 60000);

  test('only the newest customer message of a thread is taken', async () => {
    const pat = await customer('Newest');
    await visit(pat.id);
    const first = await written(pat, 'When is my next visit?', new Date('2026-11-12T14:00:00Z'));
    const second = await written(pat, 'Never mind, what time is the visit?', WRITTEN);
    groundedTurn('Your next visit is in ten days.');
    await DayAi.answerWaitingMessages({ now: DUE });
    expect((await metaOf(first.id)).dayAi).toBeUndefined();
    expect((await metaOf(second.id)).dayAi).toMatchObject({ outcome: 'answered' });
    expect((await aiRows(pat.id)).map((r) => r.metadata.answersMessageId)).toEqual([second.id]);
  }, 60000);

  test('a hand-off sends nothing: no reply, no notice, the thread as it was, left_for_team on the message', async () => {
    const pat = await customer('Hand');
    const sent = await written(pat, 'The technician broke my hibiscus.');
    mockCreate.mockResolvedValueOnce(toolUse('escalate', { reason: 'Customer says the technician damaged a plant', topic: 'complaint' }));
    const before = await thread(pat.id);

    await DayAi.answerWaitingMessages({ now: DUE });
    expect((await metaOf(sent.id)).dayAi).toMatchObject({ outcome: 'left_for_team' });
    expect(await aiRows(pat.id)).toHaveLength(0);
    expect(await db('ai_escalations').where({ customer_id: pat.id })).toHaveLength(0);
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
    const after = await thread(pat.id);
    expect(new Date(after.last_message_at).getTime()).toBe(new Date(before.last_message_at).getTime());
    expect(after.message_count).toBe(before.message_count);
    expect((await PortalInbox.list()).items.filter((item) => item.customer.id === pat.id)).toHaveLength(1);
  }, 60000);

  test('thanks is silent with no model call, and the customer\'s cap sends nothing', async () => {
    const thanks = await customer('Thanks');
    const sentT = await written(thanks, 'Thank you!');
    const capped = await customer('Capped');
    const sentP = await written(capped, 'When is my next visit?');
    mockCap.mockImplementation(async (customerId) => ({ allowed: customerId !== capped.id }));

    await DayAi.answerWaitingMessages({ now: DUE });
    expect((await metaOf(sentT.id)).dayAi).toMatchObject({ outcome: 'silent' });
    expect((await metaOf(sentP.id)).dayAi).toMatchObject({ outcome: 'capped' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await aiRows(thanks.id)).toHaveLength(0);
    expect(await aiRows(capped.id)).toHaveLength(0);
  }, 60000);

  test('an answer the office beat to the thread is superseded, not sent', async () => {
    const pat = await customer('Beaten');
    await visit(pat.id);
    const sent = await written(pat, 'When is my next visit?');
    // The office answers while the model is working.
    mockCreate
      .mockImplementationOnce(async () => {
        await PortalMessages.staffReply({ kind: 'message', id: (await thread(pat.id)).id, body: 'Friday at 9.', actor });
        return toolUse('get_upcoming_services', {});
      })
      .mockResolvedValueOnce(answer('Your next visit is in ten days.'));
    await DayAi.answerWaitingMessages({ now: DUE });
    expect((await metaOf(sent.id)).dayAi).toMatchObject({ outcome: 'superseded' });
    expect(await aiRows(pat.id)).toHaveLength(0);
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  }, 60000);
});
