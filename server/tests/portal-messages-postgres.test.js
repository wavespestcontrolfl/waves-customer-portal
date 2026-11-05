/**
 * Portal messages against live Postgres (GATE_PORTAL_MESSAGES): the office answers a portal item inside the
 * portal. Pins: one thread per customer (channel 'portal'), an answer closes the item it answers (chat
 * resolved, request resolved quietly) and its bells, the one customer notice (bell + push, else the reply
 * email), a retried send is one answer, unread / mark read, and that a customer only ever reads their own
 * thread. Every row is synthetic and tagged with this run's id; cleanup removes only those rows. It refuses
 * any database but a private QA one or CI's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'portal-messages-postgres-only';

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendPortalReply: jest.fn(async () => ({ ok: true, messageId: 'email-1' })),
  sendRequestUpdated: jest.fn(async () => ({ ok: true })),
}));
const mockPushResult = { subscriptions: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: jest.fn(async () => mockPushResult),
  resolveNotificationPropertyId: jest.fn(async () => null),
}));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('portal messages (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const ids = { customers: [], sessions: [], requests: [] };
  let db;
  let PortalMessages;
  let AccountMembershipEmail;
  let PushService;

  const phone = () => `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const actor = { technicianId: null, role: 'admin' };

  async function customer(first = 'Pat') {
    const [row] = await db('customers').insert({ first_name: first, last_name: `Synthetic${RUN}`, phone: phone(), email: `${RUN}-${first.toLowerCase()}@example.com` }).returning('*');
    ids.customers.push(row.id);
    return row;
  }

  async function chat(customerId, { alert = true } = {}) {
    const [session] = await db('agent_sessions').insert({ customer_id: customerId, channel: 'portal_chat', channel_identifier: `t-${RUN}-${randomUUID()}`, status: 'escalated' }).returning('id');
    ids.sessions.push(session.id);
    const [esc] = await db('ai_escalations').insert({
      conversation_id: session.id, customer_id: customerId, reason: 'complex_question', summary: 'needs a person',
      customer_message: `${RUN} can you bundle pest and lawn?`, status: 'pending', priority: 'normal',
    }).returning('id');
    if (alert) {
      await db('notifications').insert({ recipient_type: 'admin', category: 'alert', title: `Comms - ${RUN}`, body: 'x', metadata: JSON.stringify({ escalationId: esc.id }) });
    }
    return { escalationId: esc.id, sessionId: session.id };
  }

  async function request(customerId, { source = null, alert = true } = {}) {
    const [row] = await db('service_requests').insert({
      customer_id: customerId, category: 'general', subject: `${RUN} request`, description: 'Can you come sooner?', status: 'new', source,
    }).returning('*');
    ids.requests.push(row.id);
    if (alert) {
      await db('notifications').insert({ recipient_type: 'admin', category: 'service', title: `Customers - ${RUN}`, body: 'x', metadata: JSON.stringify({ requestId: row.id }) });
    }
    return row;
  }

  const thread = (customerId) => db('conversations').where({ customer_id: customerId, channel: 'portal', our_endpoint_id: 'portal' });
  const openAdminBells = (key, value) => db('notifications').where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw(`metadata->>'${key}' = ?`, [String(value)]);

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    PortalMessages = require('../services/portal-messages');
    AccountMembershipEmail = require('../services/account-membership-email');
    PushService = require('../services/push-notifications');
  }, 60000);

  afterAll(async () => {
    delete process.env.GATE_PORTAL_MESSAGES;
    if (!db) return;
    const threads = await db('conversations').whereIn('customer_id', ids.customers).where({ channel: 'portal' }).pluck('id');
    await db('notifications').whereRaw('title like ? or recipient_id = any(?)', [`%${RUN}%`, ids.customers]).del();
    await db('conversations').whereIn('id', threads).del();
    await db('service_requests').whereIn('id', ids.requests).del();
    await db('agent_sessions').whereIn('id', ids.sessions).del();
    await db('customers').whereIn('id', ids.customers).del();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_PORTAL_MESSAGES = 'true';
    mockPushResult.sent = 0;
  });

  test('an answer to a chat hand-off is saved in the customer portal thread, resolves the chat and its bell, and emails when no app took the push', async () => {
    const pat = await customer();
    const { escalationId, sessionId } = await chat(pat.id);

    const result = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: '  Yes, we can bundle them.\n\n\n\nWe will call Tuesday.  ', actor });

    expect(result.closed).toBe(true);
    expect(result.message).toMatchObject({ direction: 'outbound', body: 'Yes, we can bundle them.\n\nWe will call Tuesday.' });
    const [row] = await thread(pat.id);
    expect(row).toMatchObject({ customer_id: pat.id, channel: 'portal', our_endpoint_id: 'portal', message_count: 1 });
    expect(await db('ai_escalations').where({ id: escalationId }).first('status', 'resolution_notes')).toEqual({ status: 'resolved', resolution_notes: 'Answered in the portal' });
    expect((await db('agent_sessions').where({ id: sessionId }).first('status')).status).toBe('resolved');
    expect(await openAdminBells('escalationId', escalationId)).toHaveLength(0);
    // One notice: the in-app bell (with the push attempt), then the email because no device took the push.
    const bell = await db('notifications').where({ recipient_type: 'customer', recipient_id: pat.id }).whereRaw("metadata->>'portalMessageId' = ?", [result.message.id]).first();
    expect(bell).toMatchObject({ title: 'New message from Waves', link: '/?tab=messages' });
    expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith({ customerId: pat.id, messageId: result.message.id, body: 'Yes, we can bundle them.\n\nWe will call Tuesday.' });
    expect(result.notice).toEqual({ bell: true, pushAccepted: 0, email: 'sent' });
    const saved = await db('messages').where({ id: result.message.id }).first('metadata', 'author_type', 'channel');
    expect(saved).toMatchObject({ author_type: 'admin', channel: 'portal' });
    expect(saved.metadata).toMatchObject({ portalItem: { kind: 'chat', id: escalationId }, notice: { bell: true, pushAccepted: 0, email: 'sent' } });
  });

  test('a push an app device took is the whole notice: no email', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    mockPushResult.sent = 1;
    const result = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'On our way Thursday.', actor });
    expect(result.notice).toEqual({ bell: true, pushAccepted: 1, email: 'not_needed' });
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
  });

  test('an answer to a service request resolves it quietly with a note, and closes its bell; a staff-made request is not an item', async () => {
    const pat = await customer();
    const req = await request(pat.id);
    const result = await PortalMessages.staffReply({ kind: 'request', id: req.id, body: 'We can come Monday at 9.', actor });
    expect(result.closed).toBe(true);
    const after = await db('service_requests').where({ id: req.id }).first('status', 'status_version', 'admin_notes', 'resolved_at');
    expect(after).toMatchObject({ status: 'resolved', status_version: req.status_version + 1, admin_notes: 'Answered in the portal' });
    expect(after.resolved_at).toBeTruthy();
    expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
    expect(await openAdminBells('requestId', req.id)).toHaveLength(0);

    const staffMade = await request(pat.id, { source: 'admin', alert: false });
    await expect(PortalMessages.staffReply({ kind: 'request', id: staffMade.id, body: 'x', actor })).rejects.toMatchObject({ status: 404 });
    await expect(PortalMessages.staffReply({ kind: 'chat', id: randomUUID(), body: 'x', actor })).rejects.toMatchObject({ status: 404 });
    await expect(PortalMessages.staffReply({ kind: 'request', id: req.id, body: '   ', actor })).rejects.toMatchObject({ status: 400, code: 'empty' });
  });

  test('an inactive customer row (cannot sign in or take a push) gets no portal answer, and the item stays open', async () => {
    const pat = await customer();
    const req = await request(pat.id, { alert: false });
    await db('customers').where({ id: pat.id }).update({ active: false });
    await expect(PortalMessages.staffReply({ kind: 'request', id: req.id, body: 'Hello', actor })).rejects.toMatchObject({ status: 409, code: 'customer_inactive' });
    expect((await db('service_requests').where({ id: req.id }).first('status')).status).toBe('new');
    expect(await thread(pat.id)).toHaveLength(0);
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
  });

  test('a retried send with the same request id is one answer and one notice', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    const clientRequestId = randomUUID();
    const first = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Answer once.', clientRequestId, actor });
    const again = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Answer once.', clientRequestId, actor });
    expect(again).toMatchObject({ replay: true, message: { id: first.message.id }, notice: first.notice });
    expect(await db('messages').whereIn('conversation_id', thread(pat.id).select('id'))).toHaveLength(1);
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(1);
  });

  test('gate off: every entry point refuses and nothing is written', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    process.env.GATE_PORTAL_MESSAGES = 'false';
    await expect(PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'x', actor })).rejects.toMatchObject({ status: 404, code: 'disabled' });
    await expect(PortalMessages.customerThread(pat.id)).rejects.toMatchObject({ status: 404 });
    await expect(PortalMessages.customerUnread(pat.id)).rejects.toMatchObject({ status: 404 });
    await expect(PortalMessages.markRead(pat.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await thread(pat.id)).toHaveLength(0);
    expect((await db('ai_escalations').where({ id: escalationId }).first('status')).status).toBe('pending');
  });

  test('unread counts only the answers since the read stamp, which only moves forward; reading marks their bells read', async () => {
    const pat = await customer();
    const first = await chat(pat.id, { alert: false });
    const second = await chat(pat.id, { alert: false });
    const a1 = await PortalMessages.staffReply({ kind: 'chat', id: first.escalationId, body: 'Thursday morning.', actor });
    const a2 = await PortalMessages.staffReply({ kind: 'chat', id: second.escalationId, body: 'Between 8 and 10.', actor });
    expect(await thread(pat.id)).toHaveLength(1);

    const view = await PortalMessages.customerThread(pat.id);
    expect(view.messages.map((m) => [m.from, m.body])).toEqual([['waves', 'Thursday morning.'], ['waves', 'Between 8 and 10.']]);
    expect(view).toMatchObject({ hasMore: false, unread: 2 });
    expect(await PortalMessages.markRead(pat.id, a1.message.id)).toEqual({ unread: 1 });
    const bellOf = (m) => db('notifications').where({ recipient_type: 'customer', recipient_id: pat.id }).whereRaw("metadata->>'portalMessageId' = ?", [m.message.id]).first('read_at');
    expect((await bellOf(a1)).read_at).toBeTruthy();
    expect((await bellOf(a2)).read_at).toBeNull();
    expect(await PortalMessages.markRead(pat.id, a2.message.id)).toEqual({ unread: 0 });
    expect(await PortalMessages.markRead(pat.id, a1.message.id)).toEqual({ unread: 0 });
    expect(await PortalMessages.customerUnread(pat.id)).toBe(0);
  });
  test('a customer reads and marks only their own thread', async () => {
    const pat = await customer('Pat');
    const sam = await customer('Sam');
    const { escalationId } = await chat(pat.id, { alert: false });
    const answer = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Only for Pat.', actor });
    expect((await PortalMessages.customerThread(sam.id)).messages).toEqual([]);
    // Sam has no thread: marking Pat's answer does nothing and says nothing about it.
    expect(await PortalMessages.markRead(sam.id, answer.message.id)).toEqual({ unread: 0 });
    // With a thread of his own, Pat's message id is not in it.
    const samChat = await chat(sam.id, { alert: false });
    await PortalMessages.staffReply({ kind: 'chat', id: samChat.escalationId, body: 'Only for Sam.', actor });
    await expect(PortalMessages.markRead(sam.id, answer.message.id)).rejects.toMatchObject({ status: 404 });
    expect(await PortalMessages.customerUnread(pat.id)).toBe(1);
  });

  test('two first answers at once make one thread', async () => {
    const pat = await customer();
    const [one, two] = await Promise.all([chat(pat.id, { alert: false }), chat(pat.id, { alert: false })]);
    await Promise.all([
      PortalMessages.staffReply({ kind: 'chat', id: one.escalationId, body: 'one', actor }),
      PortalMessages.staffReply({ kind: 'chat', id: two.escalationId, body: 'two', actor }),
    ]);
    const rows = await thread(pat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].message_count).toBe(2);
  });
});
