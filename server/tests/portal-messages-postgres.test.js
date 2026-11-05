/**
 * Portal messages against live Postgres (GATE_PORTAL_MESSAGES): the office answers a portal item inside the
 * portal and the customer writes back. Pins: one thread per customer (channel 'portal'), an answer closes
 * the item it answers (chat resolved, request resolved quietly, a portal message answered) and its bells,
 * the one customer notice (bell + push, else the reply email), a retried send is one answer, a customer
 * message rings one bell per thread and is a Portal-tab item until answered or handled, unread / mark read,
 * and that a customer only ever reads their own thread. Every row is synthetic and tagged with this run's id; cleanup removes only those rows. It refuses
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
jest.mock('../services/portal-ask-push', () => ({
  pushPortalAsk: jest.fn(async () => ({ sent: true })),
  shortName: (first, last) => [first, last ? `${last[0]}.` : ''].filter(Boolean).join(' '),
}));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('portal messages (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const ids = { customers: [], sessions: [], requests: [] };
  let db;
  let PortalMessages;
  let AccountMembershipEmail;
  let PushService;
  let portalAskPush;

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
    portalAskPush = require('../services/portal-ask-push');
  }, 60000);

  afterAll(async () => {
    delete process.env.GATE_PORTAL_MESSAGES;
    if (!db) return;
    const threads = await db('conversations').whereIn('customer_id', ids.customers).where({ channel: 'portal' }).pluck('id');
    await db('notifications').whereRaw("title like ? or metadata->>'portalConversationId' = any(?) or recipient_id = any(?)", [`%${RUN}%`, threads, ids.customers]).del();
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
    // App devices only: a browser subscription must never stand in for the app and skip the email.
    expect(PushService.sendToCustomer.mock.calls[0][2]).toMatchObject({ nativeOnly: true });
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

  test('a notice a stopped process left pending is finished by a retry once its claim is stale, and by the sweep', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    const clientRequestId = randomUUID();
    const first = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'We will call today.', clientRequestId, actor });
    // As if the process stopped mid-notice: pending, claimed `claimMinutesAgo` ago, the answer `ageMinutes` old.
    const pend = (claimMinutesAgo, ageMinutes = 0) => db('messages').where({ id: first.message.id }).update({
      metadata: db.raw("jsonb_set(metadata, '{notice}', jsonb_build_object('pending', true, 'claimedAt', (now() - make_interval(mins => ?))::text))", [claimMinutesAgo]),
      created_at: db.raw('now() - make_interval(mins => ?)', [ageMinutes]),
    });
    jest.clearAllMocks();
    await pend(0);
    // A retry while the claim is fresh never races the attempt that holds it.
    let again = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'We will call today.', clientRequestId, actor });
    expect(again.notice).toEqual({ pending: true });
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
    // A stale claim (its process stopped) is taken over and finished, once.
    await pend(3);
    again = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'We will call today.', clientRequestId, actor });
    expect(again.notice).toEqual({ bell: true, pushAccepted: 0, email: 'sent' });
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(1);
    // The sweep: an answer under 5 minutes old is left alone; 10 minutes old is finished; gate off does nothing.
    jest.clearAllMocks();
    await pend(3, 2);
    expect(await PortalMessages.resumePendingNotices()).toBe(0);
    await pend(3, 10);
    process.env.GATE_PORTAL_MESSAGES = 'false';
    expect(await PortalMessages.resumePendingNotices()).toBe(0);
    process.env.GATE_PORTAL_MESSAGES = 'true';
    expect(await PortalMessages.resumePendingNotices()).toBeGreaterThanOrEqual(1);
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith(expect.objectContaining({ messageId: first.message.id }));
    expect((await db('messages').where({ id: first.message.id }).first('metadata')).metadata.notice).toMatchObject({ bell: true, pushAccepted: 0, email: 'sent', pending: false });
    // Finished: the next sweep has nothing of this answer's.
    jest.clearAllMocks();
    await PortalMessages.resumePendingNotices();
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalledWith(expect.objectContaining({ messageId: first.message.id }));
  });

  test('two attempts at one notice at once: one runs it, the other waits; a push still in flight adds no email', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    const answer = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'On our way.', actor });
    const row = await db('messages').where({ id: answer.message.id }).first('id', 'body');
    await db('messages').where({ id: row.id }).update({ metadata: db.raw("jsonb_set(metadata, '{notice}', '{\"pending\": true}')") });
    jest.clearAllMocks();
    const { noticeCustomer } = PortalMessages.__private;
    const results = await Promise.all([noticeCustomer(pat.id, row), noticeCustomer(pat.id, row)]);
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(1);
    expect(results).toEqual(expect.arrayContaining([{ bell: true, pushAccepted: 0, email: 'sent' }]));

    // The push service says another attempt holds the push: no email, the notice stays pending for later.
    await db('messages').where({ id: row.id }).update({ metadata: db.raw("jsonb_set(metadata, '{notice}', '{\"pending\": true}')") });
    jest.clearAllMocks();
    PushService.sendToCustomer.mockResolvedValueOnce({ subscriptions: 1, sent: 0, failed: 0, expired: 0, skipped: 0, reason: 'push_in_flight' });
    expect(await noticeCustomer(pat.id, row)).toEqual({ pending: true });
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
    expect((await db('messages').where({ id: row.id }).first('metadata')).metadata.notice).toMatchObject({ pending: true, attempts: 1 });

    // On the last try a push still in flight ends the notice (whatever that push does is the outcome).
    await db('messages').where({ id: row.id }).update({ metadata: db.raw("jsonb_set(metadata, '{notice}', '{\"pending\": true, \"attempts\": 4}')") });
    PushService.sendToCustomer.mockResolvedValueOnce({ subscriptions: 1, sent: 0, failed: 0, expired: 0, skipped: 0, reason: 'push_in_flight' });
    expect(await noticeCustomer(pat.id, row)).toEqual({ pending: false });
    expect((await db('messages').where({ id: row.id }).first('metadata')).metadata.notice).toMatchObject({ pending: false, attempts: 5, email: 'not_needed' });
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
  });

  test('a passing email failure stays pending and the sweep finishes it with no staff click; a skip is final; tries stop at 5', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    const clientRequestId = randomUUID();
    AccountMembershipEmail.sendPortalReply.mockResolvedValueOnce({ ok: false, sent: false, transient: true, reason: 'prefs_unavailable' });
    const first = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Answer.', clientRequestId, actor });
    expect(first.notice).toEqual({ bell: true, pushAccepted: 0, email: 'prefs_unavailable', pending: true });
    // Its claim waits out the stale time; the answer is old enough for the sweep.
    const age = (claimMinutesAgo, ageMinutes) => db('messages').where({ id: first.message.id }).update({
      metadata: db.raw("jsonb_set(metadata, '{notice,claimedAt}', to_jsonb((now() - make_interval(mins => ?))::text))", [claimMinutesAgo]),
      created_at: db.raw('now() - make_interval(mins => ?)', [ageMinutes]),
    });
    // A staff retry while the claim is fresh does nothing more.
    expect((await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Answer.', clientRequestId, actor })).notice)
      .toEqual({ bell: true, pushAccepted: 0, email: 'prefs_unavailable', pending: true });
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(1);
    await age(3, 10);
    expect(await PortalMessages.resumePendingNotices()).toBeGreaterThanOrEqual(1);
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(2);
    // After the move to the email, a later try finishes the email and pushes nothing.
    expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
    expect((await db('messages').where({ id: first.message.id }).first('metadata')).metadata.notice).toMatchObject({ bell: true, pushAccepted: 0, email: 'sent', pending: false });
    // Delivered: a retried click returns it and sends nothing.
    expect((await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Answer.', clientRequestId, actor })).notice)
      .toEqual({ bell: true, pushAccepted: 0, email: 'sent' });
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(2);
    // One in-app bell for the answer however often its notice ran.
    expect(await db('notifications').where({ recipient_type: 'customer', recipient_id: pat.id }).whereRaw("metadata->>'portalMessageId' = ?", [first.message.id])).toHaveLength(1);

    // A skip (opted out of email) is final: not pending, never swept.
    const second = await chat(pat.id, { alert: false });
    AccountMembershipEmail.sendPortalReply.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'email_opted_out' });
    const skipRetryId = randomUUID();
    const skipped = await PortalMessages.staffReply({ kind: 'chat', id: second.escalationId, body: 'Answer two.', clientRequestId: skipRetryId, actor });
    expect(skipped.notice).toEqual({ bell: true, pushAccepted: 0, email: 'email_opted_out' });
    // A retried click shows the final skip and sends nothing again.
    jest.clearAllMocks();
    expect((await PortalMessages.staffReply({ kind: 'chat', id: second.escalationId, body: 'Answer two.', clientRequestId: skipRetryId, actor })).notice)
      .toEqual({ bell: true, pushAccepted: 0, email: 'email_opted_out' });
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
    await db('messages').where({ id: skipped.message.id }).update({ created_at: db.raw("now() - interval '10 minutes'") });
    jest.clearAllMocks();
    await PortalMessages.resumePendingNotices();
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalledWith(expect.objectContaining({ messageId: skipped.message.id }));

    // A failure that keeps passing is tried 5 times in all, then left as it is.
    const third = await chat(pat.id, { alert: false });
    AccountMembershipEmail.sendPortalReply.mockResolvedValue({ ok: false, reason: 'provider_down' });
    const stuck = await PortalMessages.staffReply({ kind: 'chat', id: third.escalationId, body: 'Answer three.', actor });
    const backdate = () => db('messages').where({ id: stuck.message.id }).update({
      metadata: db.raw("jsonb_set(metadata, '{notice,claimedAt}', to_jsonb((now() - interval '3 minutes')::text))"),
      created_at: db.raw("now() - interval '10 minutes'"),
    });
    // The send above was try 1; four sweeps make tries 2-5, and a sixth finds nothing pending.
    for (let i = 0; i < 4; i += 1) { await backdate(); await PortalMessages.resumePendingNotices(); }
    await PortalMessages.resumePendingNotices();
    const finalNotice = (await db('messages').where({ id: stuck.message.id }).first('metadata')).metadata.notice;
    expect(finalNotice).toMatchObject({ bell: true, pushAccepted: 0, email: 'provider_down', pending: false, attempts: 5 });
    expect(AccountMembershipEmail.sendPortalReply.mock.calls.filter(([a]) => a.messageId === stuck.message.id)).toHaveLength(5);
    // Out of tries is final: neither the sweep nor a retried click starts it over.
    AccountMembershipEmail.sendPortalReply.mockResolvedValue({ ok: true, messageId: 'email-1' });
    jest.clearAllMocks();
    await backdate();
    await PortalMessages.resumePendingNotices();
    expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
  });
  test('a try that stopped after the email went out: the next try finishes the email and never pushes', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    // The app push fails for now; the email goes; the process stops before it saves the outcome.
    let atSend = null;
    AccountMembershipEmail.sendPortalReply.mockImplementationOnce(async ({ messageId }) => {
      atSend = (await db('messages').where({ id: messageId }).first('metadata')).metadata.notice;
      return { ok: true, messageId: 'email-1' };
    });
    const answer = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'We will call today.', actor });
    // The move to the email was saved before the email went.
    expect(atSend).toMatchObject({ email: 'sending', pending: true, pushAccepted: 0, attempts: 1 });
    await db('messages').where({ id: answer.message.id }).update({
      metadata: db.raw("jsonb_set(metadata, '{notice}', ?::jsonb || jsonb_build_object('claimedAt', (now() - interval '3 minutes')::text))", [JSON.stringify(atSend)]),
      created_at: db.raw("now() - interval '10 minutes'"),
    });
    // The push provider is back. The sweep's try sends no push: it finishes the email (its own key dedupes it).
    mockPushResult.sent = 1;
    jest.clearAllMocks();
    expect(await PortalMessages.resumePendingNotices()).toBeGreaterThanOrEqual(1);
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith(expect.objectContaining({ messageId: answer.message.id }));
    expect((await db('messages').where({ id: answer.message.id }).first('metadata')).metadata.notice)
      .toMatchObject({ bell: true, pushAccepted: 0, email: 'sent', pending: false, attempts: 2 });
  });

  test('a bell that failed is made by the next try even after the email went: no push and no second email', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    const NotificationService = require('../services/notification-service');
    const bellSpy = jest.spyOn(NotificationService, 'notifyCustomer').mockRejectedValueOnce(new Error('bell write failed'));
    try {
      const answer = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'See you Friday.', actor });
      expect(answer.notice).toEqual({ bell: false, pushAccepted: 0, email: 'sent', pending: true });
      await db('messages').where({ id: answer.message.id }).update({
        metadata: db.raw("jsonb_set(metadata, '{notice,claimedAt}', to_jsonb((now() - interval '3 minutes')::text))"),
        created_at: db.raw("now() - interval '10 minutes'"),
      });
      jest.clearAllMocks();
      expect(await PortalMessages.resumePendingNotices()).toBeGreaterThanOrEqual(1);
      expect(bellSpy).toHaveBeenCalledWith(pat.id, 'service', expect.any(String), expect.any(String), expect.objectContaining({ push: false }));
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
      expect((await db('messages').where({ id: answer.message.id }).first('metadata')).metadata.notice)
        .toMatchObject({ bell: true, email: 'sent', pending: false, attempts: 2 });
      expect(await db('notifications').where({ recipient_type: 'customer', recipient_id: pat.id }).whereRaw("metadata->>'portalMessageId' = ?", [answer.message.id])).toHaveLength(1);
    } finally {
      bellSpy.mockRestore();
    }
  });

  test('an answer waits for a chat turn that holds the session, instead of deadlocking with it', async () => {
    const pat = await customer();
    const { escalationId, sessionId } = await chat(pat.id, { alert: false });
    // A customer turn adding to the hand-off (assistant.js upsertOpenItem): session row first, then the hand-off row.
    const turn = await db.transaction();
    let answer;
    try {
      await turn('agent_sessions').where({ id: sessionId }).forUpdate().first('id');
      answer = PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'We can come Friday.', actor });
      const waiting = async () => (await db.raw("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0].n;
      for (let i = 0; i < 100 && (await waiting()) < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      await turn('ai_escalations').where({ id: escalationId }).update({ customer_message: `${RUN} and Friday works` });
      await turn.commit();
    } catch (err) {
      await turn.rollback().catch(() => {});
      throw err;
    }
    await expect(answer).resolves.toMatchObject({ closed: true });
    expect(await db('ai_escalations').where({ id: escalationId }).first('status', 'customer_message'))
      .toEqual({ status: 'resolved', customer_message: `${RUN} and Friday works` });
  });

  test('gate off: every entry point refuses and nothing is written', async () => {
    const pat = await customer();
    const { escalationId } = await chat(pat.id, { alert: false });
    process.env.GATE_PORTAL_MESSAGES = 'false';
    await expect(PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'x', actor })).rejects.toMatchObject({ status: 404, code: 'disabled' });
    await expect(PortalMessages.customerPost({ customer: pat, body: 'x' })).rejects.toMatchObject({ status: 404 });
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
  test('a customer message rings one bell per thread: a second message rewrites it, a new one comes after Done', async () => {
    const pat = await customer();
    const first = await PortalMessages.customerPost({ customer: pat, body: 'Is the lawn treatment safe for my dog?' });
    expect(first).toMatchObject({ from: 'you', body: 'Is the lawn treatment safe for my dog?' });
    const [row] = await thread(pat.id);
    let bells = await openAdminBells('portalConversationId', row.id);
    expect(bells).toHaveLength(1);
    expect(bells[0].title).toBe(`Comms — Answer Pat Synthetic${RUN}'s portal message`);
    expect(bells[0].metadata).toMatchObject({ customerId: pat.id, portalMessageId: first.id, dedupeKey: `portal-message:${row.id}` });
    expect(portalAskPush.pushPortalAsk).toHaveBeenCalledTimes(1);
    expect(bells[0].body).toBe('They wrote in the portal: “Is the lawn treatment safe for my dog?”');

    const second = await PortalMessages.customerPost({ customer: pat, body: 'Also, can you come Friday? I work Thursday.' });
    bells = await openAdminBells('portalConversationId', row.id);
    expect(bells).toHaveLength(1);
    expect(bells[0].metadata.portalMessageId).toBe(second.id);
    // Two sentences cannot stand in a bell's why: the plain line instead, the whole message in the full text.
    expect(bells[0].body).toBe('They wrote in the portal and are waiting for an answer');
    expect(bells[0].detail).toBe('Also, can you come Friday? I work Thursday.');
    expect(portalAskPush.pushPortalAsk).toHaveBeenCalledTimes(2);

    await db('notifications').whereIn('id', bells.map((b) => b.id)).update({ done_at: new Date() });
    await PortalMessages.customerPost({ customer: pat, body: 'Hello again' });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(1);
    expect((await thread(pat.id))[0].message_count).toBe(3);
  });

  test('the Portal tab lists an unanswered portal message; an answer, Mark handled or Close all older closes it', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    const portalInbox = require('../services/portal-inbox');
    const pat = await customer();
    await PortalMessages.customerPost({ customer: pat, body: 'First question' });
    await PortalMessages.customerPost({ customer: pat, body: 'Second line' });
    const [row] = await thread(pat.id);
    const mineOf = (items) => items.filter((i) => i.kind === 'message' && i.id === row.id);

    let listed = mineOf((await portalInbox.list()).items);
    expect(listed).toEqual([expect.objectContaining({ kind: 'message', customer: expect.objectContaining({ id: pat.id, firstName: 'Pat' }), customerMessage: 'First question\nSecond line', lastAnswer: '' })]);

    // An answer closes it; a new customer message opens it again with only the new words and the answer.
    await PortalMessages.staffReply({ kind: 'message', id: row.id, body: 'Answer one.', actor });
    expect(mineOf((await portalInbox.list()).items)).toEqual([]);
    await PortalMessages.customerPost({ customer: pat, body: 'Thanks, one more thing' });
    listed = mineOf((await portalInbox.list()).items);
    expect(listed[0]).toMatchObject({ customerMessage: 'Thanks, one more thing', lastAnswer: 'Answer one.' });

    // Mark handled through the newest message stamps it once and closes its bell; a second finds nothing open.
    expect(await portalInbox.markMessageHandled(row.id, listed[0].throughId, { technicianId: null, role: 'admin' })).toEqual({ handled: true, open: false });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    expect(await portalInbox.markMessageHandled(row.id, listed[0].throughId, { technicianId: null, role: 'admin' })).toEqual({ handled: false, open: false });
    // A message id that is not this thread's customer message is not something to mark.
    expect(await portalInbox.markMessageHandled(row.id, randomUUID(), { technicianId: null, role: 'admin' })).toBeNull();
    expect(mineOf((await portalInbox.list()).items)).toEqual([]);

    // Close all older: a thread whose open message is 20 days old is stamped handled; nothing is sent.
    await PortalMessages.customerPost({ customer: pat, body: 'Old ask' });
    // Backdate the whole thread as if it were never handled (the handledAt stamp above is from now).
    await db('conversations').where({ id: row.id }).update({
      last_inbound_at: db.raw("now() - interval '20 days'"), last_message_at: db.raw("now() - interval '20 days'"), metadata: db.raw("metadata - 'handledAt'"),
    });
    expect(mineOf((await portalInbox.list()).olderItems)).toHaveLength(1);
    const closed = await portalInbox.closeOlder(new Date(Date.now() - 16 * 24 * 3600 * 1000), { technicianId: null, role: 'admin' });
    expect(closed.messages).toBeGreaterThanOrEqual(1);
    expect(mineOf((await portalInbox.list()).olderItems)).toEqual([]);
    expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(1);

    // Gate off: no message items at all.
    await PortalMessages.customerPost({ customer: pat, body: 'Newest' });
    process.env.GATE_PORTAL_MESSAGES = 'false';
    expect(mineOf((await portalInbox.list()).items)).toEqual([]);
    delete process.env.GATE_PORTAL_INBOX;
  });

  test('a thread\'s bell follows the thread: no close over a newer customer message, no late ring after an answer', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    const portalInbox = require('../services/portal-inbox');
    const { closeItemBells, ringOffice } = PortalMessages.__private;
    const pat = await customer();
    const m1 = await PortalMessages.customerPost({ customer: pat, body: 'Can you come Monday?' });
    const [row] = await thread(pat.id);
    const m2 = await PortalMessages.customerPost({ customer: pat, body: 'Or Tuesday works.' });
    // Mark handled through the message the screen showed (m1): m2 came after, so the item and its bell stay.
    expect(await portalInbox.markMessageHandled(row.id, m1.id, actor)).toEqual({ handled: true, open: true });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(1);
    const item = (await portalInbox.list()).items.find((i) => i.kind === 'message' && i.id === row.id);
    expect(item).toMatchObject({ customerMessage: 'Or Tuesday works.', throughId: m2.id });

    // An answer's bell close that runs after a newer customer message (it saved and rang first) leaves its bell.
    await PortalMessages.staffReply({ kind: 'message', id: row.id, body: 'Tuesday at 9.', actor });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    await PortalMessages.customerPost({ customer: pat, body: 'Great, see you then.' });
    expect(await closeItemBells('message', row.id, actor, row.id)).toBe(0);
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(1);

    // A late ring for a message an answer already covered raises nothing.
    await PortalMessages.staffReply({ kind: 'message', id: row.id, body: 'See you Tuesday.', actor });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    jest.clearAllMocks();
    await ringOffice(pat, row.id, m2);
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    expect(portalAskPush.pushPortalAsk).not.toHaveBeenCalled();

    // Any answer lands in the thread and covers its open message: a reply to a chat hand-off closes that bell too.
    await PortalMessages.customerPost({ customer: pat, body: 'One more question.' });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(1);
    const { escalationId } = await chat(pat.id, { alert: false });
    await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'Answered both.', actor });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    expect((await portalInbox.list()).items.filter((i) => i.kind === 'message' && i.id === row.id)).toEqual([]);
  });

  test('an answer to a portal message closes its bell, and the customer sees both sides in order', async () => {
    const pat = await customer();
    // A request id is matched on its own side of the thread: the same id from the office is a new answer.
    const clientRequestId = randomUUID();
    const asked = await PortalMessages.customerPost({ customer: pat, body: 'When is my next visit?', clientRequestId });
    const [row] = await thread(pat.id);
    const answer = await PortalMessages.staffReply({ kind: 'message', id: row.id, body: 'Thursday morning.', clientRequestId, actor });
    expect(answer.replay).toBeUndefined();
    expect(await PortalMessages.customerPost({ customer: pat, body: 'When is my next visit?', clientRequestId })).toMatchObject({ id: asked.id });
    expect(answer.closed).toBe(true);
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(0);
    const view = await PortalMessages.customerThread(pat.id);
    expect(view.messages.map((m) => [m.id, m.from])).toEqual([[asked.id, 'you'], [answer.message.id, 'waves']]);
    expect(view.unread).toBe(1);
    // A thread id from another customer is not an item this one can be answered on.
    await expect(PortalMessages.staffReply({ kind: 'message', id: randomUUID(), body: 'x', actor })).rejects.toMatchObject({ status: 404 });
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
