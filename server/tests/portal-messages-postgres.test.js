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
// The marker connection (models/marker-db.js) is the test database here; the text's mark must go through it.
jest.mock('../models/marker-db', () => jest.fn(() => require('../models/db')));
jest.mock('../services/account-membership-email', () => ({
  sendPortalReply: jest.fn(async () => ({ ok: true, messageId: 'email-1' })),
  sendRequestUpdated: jest.fn(async () => ({ ok: true })),
}));
const mockPushResult = { subscriptions: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: jest.fn(async () => mockPushResult),
  resolveNotificationPropertyId: jest.fn(async () => null),
}));
// GATE_PORTAL_ANSWER_TEXT: only the answer's own texts are faked; any other send is the real one. The fake keeps
// twilio.js's order against the real database: the caller's locked handoff (its locks and its row read), then the
// caller's onDispatchStart (the durable mark), then the request, which "takes" the text (`requests`). A throw before
// the request is a refusal (SMS_HANDOFF_CHECK_FAILED), as twilio.js reads it; an error with no providerOutcome is
// thrown before the handoff (the send step tags every later throw). Hooks: `beforeHandoff` (a write that lands
// between the read and the send), `afterStart` (just after the mark), and `refuseAfterStart` (a check after the mark
// refuses: the fake calls onDispatchAbort, then `afterUndo`, and refuses with that code). The outcome is set per test.
const mockAnswerText = {
  result: null, error: null, beforeHandoff: null, afterStart: null, refuseAfterStart: null, afterUndo: null, requests: [],
};
jest.mock('../services/messaging/send-customer-message', () => {
  const actual = jest.requireActual('../services/messaging/send-customer-message');
  return {
    ...actual,
    sendCustomerMessage: jest.fn(async (input) => {
      if (input?.entryPoint !== 'admin_portal_answer') return actual.sendCustomerMessage(input);
      if (mockAnswerText.error && !mockAnswerText.error.providerOutcome) throw mockAnswerText.error;
      if (mockAnswerText.beforeHandoff) await mockAnswerText.beforeHandoff(input);
      let reached = false;
      let verdict;
      try {
        verdict = await input.withSmsHandoff(async () => {
          if (input.onDispatchStart) await input.onDispatchStart();
          if (mockAnswerText.afterStart) await mockAnswerText.afterStart(input);
          if (mockAnswerText.refuseAfterStart) {
            await input.onDispatchAbort();
            if (mockAnswerText.afterUndo) await mockAnswerText.afterUndo(input);
            return { ok: false, code: mockAnswerText.refuseAfterStart };
          }
          reached = true;
          mockAnswerText.requests.push(input);
          return { ok: true };
        });
      } catch (err) {
        if (reached) throw err;
        verdict = { ok: false, code: 'SMS_HANDOFF_CHECK_FAILED' };
      }
      if (!reached) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: verdict?.code || 'SMS_HANDOFF_CHECK_FAILED' };
      if (mockAnswerText.error) throw mockAnswerText.error;
      return mockAnswerText.result;
    }),
  };
});
jest.mock('../services/portal-ask-push', () => ({
  pushPortalAsk: jest.fn(async () => ({ sent: true })),
  shortName: (first, last) => [first, last ? `${last[0]}.` : ''].filter(Boolean).join(' '),
}));

// The photo bucket: a stored photo gets a key under the customer's folder, a view link names its lifetime.
const mockBucket = { stored: [], deleted: [] };
jest.mock('../utils/funnel-photos', () => ({
  ...jest.requireActual('../utils/funnel-photos'),
  uploadFunnelPhotoToS3: jest.fn(async ({ rowId, keyPrefix, index }) => {
    const key = `photos/${rowId}/${keyPrefix}_${index}_${mockBucket.stored.length}.jpg`;
    mockBucket.stored.push(key);
    return key;
  }),
}));
jest.mock('../services/photos', () => ({
  CUSTOMER_DWELL_TTL_SECONDS: 86400,
  getViewUrl: jest.fn(async (key, ttl) => `https://bucket.example/view?photo=${encodeURIComponent(key)}&ttl=${ttl}`),
  deletePhoto: jest.fn(async (key) => { mockBucket.deleted.push(key); }),
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
    delete process.env.GATE_PORTAL_ANSWER_TEXT;
    if (!db) return;
    const threads = await db('conversations').whereIn('customer_id', ids.customers).where({ channel: 'portal' }).pluck('id');
    await db('notifications').whereRaw("title like ? or metadata->>'portalConversationId' = any(?) or recipient_id = any(?)", [`%${RUN}%`, threads, ids.customers]).del();
    await db('conversations').whereIn('id', threads).del();
    await db('sms_log').whereIn('customer_id', ids.customers).del();
    await db('service_requests').whereIn('id', ids.requests).del();
    await db('agent_sessions').whereIn('id', ids.sessions).del();
    await db('customers').whereIn('id', ids.customers).del();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_PORTAL_MESSAGES = 'true';
    delete process.env.GATE_PORTAL_ANSWER_TEXT;
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
    const notifyAdmin = jest.spyOn(require('../services/notification-service'), 'notifyAdmin');
    const first = await PortalMessages.customerPost({ customer: pat, body: 'Is the lawn treatment safe for my dog?' });
    // The bell is written on the locked thread's own transaction: no second connection while the lock is held.
    expect(notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String), expect.objectContaining({ trx: expect.anything() }));
    notifyAdmin.mockRestore();
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

    // The same words again are a new message: the bell is rewritten to it and rings again.
    const third = await PortalMessages.customerPost({ customer: pat, body: 'Also, can you come Friday? I work Thursday.' });
    bells = await openAdminBells('portalConversationId', row.id);
    expect(bells).toHaveLength(1);
    expect(bells[0].metadata.portalMessageId).toBe(third.id);
    expect(bells[0].read_at).toBeNull();
    expect(portalAskPush.pushPortalAsk).toHaveBeenCalledTimes(3);

    await db('notifications').whereIn('id', bells.map((b) => b.id)).update({ done_at: new Date() });
    await PortalMessages.customerPost({ customer: pat, body: 'Hello again' });
    expect(await openAdminBells('portalConversationId', row.id)).toHaveLength(1);
    expect((await thread(pat.id))[0].message_count).toBe(4);
  });

  test('the Portal tab lists an unanswered portal message; an answer, Mark handled or Close all older closes it', async () => {
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
  });

  test('a thread\'s bell follows the thread: no close over a newer customer message, no late ring after an answer', async () => {
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

  test('two sends whose rings run late in reverse order: the bell keeps the newest words', async () => {
    const pat = await customer();
    const { ringOffice } = PortalMessages.__private;
    const m1 = await PortalMessages.customerPost({ customer: pat, body: 'Is Monday open?' });
    const m2 = await PortalMessages.customerPost({ customer: pat, body: 'Never mind, Tuesday is better.' });
    const [row] = await thread(pat.id);
    jest.clearAllMocks();
    // m1's ring arriving after m2's would put back stale words and ring the office again: it does nothing.
    await ringOffice(pat, row.id, m1);
    const bells = await openAdminBells('portalConversationId', row.id);
    expect(bells).toHaveLength(1);
    expect(bells[0].metadata.portalMessageId).toBe(m2.id);
    expect(bells[0].detail).toBe('Never mind, Tuesday is better.');
    expect(portalAskPush.pushPortalAsk).not.toHaveBeenCalled();
  });

  // The Messages page promises an answer "usually within one business hour". The late re-ring
  // (portal-late-rering.js) read chat hand-offs and requests only, so a message nobody answered never rang again.
  test('an unanswered portal message rings once more after its business hour: not before, not with the gate off, not over a person\'s text, not once the thread is answered, never twice', async () => {
    const { runPortalLateRering, dueAtFor, STILL_WAITING } = require('../services/portal-late-rering');
    const { bellEventAt } = require('../services/admin-alert-relevance');
    const { DONE_CLEARED } = require('../services/notification-service')._private;
    const cases = { waiting: await customer('Wait'), texted: await customer('Text'), answered: await customer('Done') };
    const rows = {};
    for (const [key, c] of Object.entries(cases)) {
      await PortalMessages.customerPost({ customer: c, body: 'Can you come Friday?' });
      const [row] = await thread(c.id);
      const [bell] = await openAdminBells('portalConversationId', row.id);
      rows[key] = { threadId: row.id, bellId: bell.id, askedAt: bellEventAt(bell), dueAt: dueAtFor(bellEventAt(bell)) };
    }
    const bellNow = (key) => db('notifications').where({ id: rows[key].bellId }).first();
    const stamped = async () => (await Promise.all(Object.keys(rows).map(async (key) => ((await bellNow(key)).metadata.lateReRungAt ? key : null)))).filter(Boolean);
    const dues = Object.values(rows).map((r) => r.dueAt.getTime());
    const beforeDue = new Date(Math.min(...dues) - 60 * 1000);
    const afterDue = new Date(Math.max(...dues) + 60 * 1000);

    // A person texted this customer after their message: reached, so not "still waiting".
    await db('sms_log').insert({
      direction: 'outbound', from_phone: '+15555559100', to_phone: cases.texted.phone, customer_id: cases.texted.id,
      message_body: 'Yes, Friday works.', message_type: 'manual', status: 'delivered', twilio_sid: `SMO${RUN}${randomUUID().slice(0, 8)}`,
      metadata: JSON.stringify({ human_authored: true }), created_at: new Date(rows.texted.askedAt.getTime() + 60 * 1000),
    });
    // The office answered in the portal and the bell is open all the same (a person pressed Reopen on it).
    await PortalMessages.staffReply({ kind: 'message', id: rows.answered.threadId, body: 'Friday at 9.', actor });
    await db('notifications').where({ id: rows.answered.bellId }).update(DONE_CLEARED);

    await runPortalLateRering({ now: beforeDue });
    expect(await stamped()).toEqual([]);
    process.env.GATE_PORTAL_MESSAGES = 'false';
    await runPortalLateRering({ now: afterDue });
    expect(await stamped()).toEqual([]);

    process.env.GATE_PORTAL_MESSAGES = 'true';
    await db('notifications').where({ id: rows.waiting.bellId }).update({ read_at: new Date() });
    await runPortalLateRering({ now: afterDue });
    expect(await stamped()).toEqual(['waiting']);
    const rung = await bellNow('waiting');
    expect(rung.body).toBe(`${STILL_WAITING}. They wrote in the portal: “Can you come Friday?”`);
    expect([rung.read_at, rung.done_at]).toEqual([null, null]);
    // The same row, still the thread's bell: its identity is intact and the ask stays its boundary.
    expect(rung.metadata).toMatchObject({
      customerId: cases.waiting.id, portalConversationId: rows.waiting.threadId, dedupeKey: `portal-message:${rows.waiting.threadId}`,
      askedAt: rows.waiting.askedAt.toISOString(), lateReRungAt: afterDue.toISOString(), contact: true,
    });

    // Never a second time, and an answer still closes the bell that rang twice.
    await runPortalLateRering({ now: new Date(afterDue.getTime() + 3 * 60 * 60 * 1000) });
    expect((await bellNow('waiting')).created_at.getTime()).toBe(rung.created_at.getTime());
    await PortalMessages.staffReply({ kind: 'message', id: rows.waiting.threadId, body: 'Yes, Friday at 10.', actor });
    expect(await openAdminBells('portalConversationId', rows.waiting.threadId)).toHaveLength(0);
  }, 60000);

  test('the office reads the whole thread behind a message item, every body whole', async () => {
    const pat = await customer();
    const long = `${'We have ants in the kitchen. '.repeat(60)}End.`.slice(0, 1990);
    await PortalMessages.customerPost({ customer: pat, body: long });
    await PortalMessages.customerPost({ customer: pat, body: 'Also the garage.' });
    const [row] = await thread(pat.id);
    const item = (await require('../services/portal-inbox').list()).items.find((i) => i.kind === 'message' && i.id === row.id);
    expect(item.customerMessage.length).toBeLessThan(long.length);
    const page = await PortalMessages.staffThread(row.id);
    expect(page).toMatchObject({ hasMore: false });
    expect(page.messages.map((m) => [m.direction, m.body])).toEqual([['inbound', long], ['inbound', 'Also the garage.']]);
    await expect(PortalMessages.staffThread(randomUUID())).rejects.toMatchObject({ status: 404 });
    process.env.GATE_PORTAL_MESSAGES = 'false';
    await expect(PortalMessages.staffThread(row.id)).rejects.toMatchObject({ status: 404 });
  });

  const jpeg = async () => ({
    mimetype: 'image/jpeg',
    buffer: await require('sharp')({ create: { width: 12, height: 12, channels: 3, background: '#7a8' } }).jpeg().toBuffer(),
  });

  test('a photo with no words is saved under the customer folder, shows as a signed link on both sides, lists as [Photo], and rings the office', async () => {
    const pat = await customer();
    const sent = await PortalMessages.customerPost({ customer: pat, body: '', files: [await jpeg()] });
    const key = mockBucket.stored.at(-1);
    expect(key.startsWith(`photos/portal-messages/${pat.id}/photo_0_`)).toBe(true);
    expect(sent).toEqual({ id: sent.id, from: 'you', body: '', createdAt: expect.anything(), photos: [{ url: `https://bucket.example/view?photo=${encodeURIComponent(key)}&ttl=86400` }] });

    const [row] = await thread(pat.id);
    const saved = await db('messages').where({ id: sent.id }).first('body', 'media');
    expect(saved.body).toBeNull();
    expect(saved.media).toEqual([{ type: 'photo', key, contentType: 'image/jpeg', size: expect.any(Number) }]);

    // The customer's page and the office's thread carry a link each, never the key or the stored row.
    const mine = await PortalMessages.customerThread(pat.id);
    expect(mine.messages).toEqual([sent]);
    const office = await PortalMessages.staffThread(row.id);
    expect(office.messages).toEqual([expect.objectContaining({ direction: 'inbound', body: '', photos: [{ url: expect.stringContaining('&ttl=3600') }] })]);
    expect(Object.keys(office.messages[0])).not.toContain('media');

    const item = (await require('../services/portal-inbox').list()).items.find((i) => i.kind === 'message' && i.id === row.id);
    expect(item.customerMessage).toBe('[Photo]');
    const [bell] = await openAdminBells('portalConversationId', row.id);
    expect(bell.body).toBe('They sent a photo in the portal and are waiting for an answer');
    expect(bell.metadata).toMatchObject({ portalMessageId: sent.id });

    // Words and a photo: the words lead and the preview marks the photo.
    await PortalMessages.customerPost({ customer: pat, body: 'By the back door.', files: [await jpeg()] });
    const again = (await require('../services/portal-inbox').list()).items.find((i) => i.kind === 'message' && i.id === row.id);
    expect(again.customerMessage).toBe('[Photo]\nBy the back door. [Photo]');
  });

  test('a refused photo saves nothing and leaves nothing in the bucket; a retried send keeps one message and one set of photos', async () => {
    const pat = await customer();
    mockBucket.deleted.length = 0;
    const before = mockBucket.stored.length;
    await expect(PortalMessages.customerPost({ customer: pat, body: 'Look', files: [await jpeg(), { mimetype: 'image/jpeg', buffer: Buffer.from('not a picture') }] }))
      .rejects.toMatchObject({ code: 'invalid_photo', status: 400 });
    // The first photo was stored before the second was refused: it is removed again.
    expect(mockBucket.deleted).toEqual(mockBucket.stored.slice(before));
    await expect(PortalMessages.customerPost({ customer: pat, body: '', files: [await jpeg(), await jpeg(), await jpeg(), await jpeg()] }))
      .rejects.toMatchObject({ code: 'too_many_photos', status: 400 });
    await expect(PortalMessages.customerPost({ customer: pat, body: '   ' })).rejects.toMatchObject({ code: 'empty', status: 400 });
    expect(await thread(pat.id)).toEqual([]);

    const requestId = randomUUID();
    const first = await PortalMessages.customerPost({ customer: pat, body: '', clientRequestId: requestId, files: [await jpeg()] });
    const kept = mockBucket.stored.at(-1);
    mockBucket.deleted.length = 0;
    const retry = await PortalMessages.customerPost({ customer: pat, body: '', clientRequestId: requestId, files: [await jpeg()] });
    expect(retry).toEqual(first);
    expect(mockBucket.deleted).toEqual([mockBucket.stored.at(-1)]);
    expect(mockBucket.deleted).not.toContain(kept);
    const [row] = await thread(pat.id);
    expect(await db('messages').where({ conversation_id: row.id })).toHaveLength(1);
  });

  test('the after-hours assistant is started for words alone, never for a message with a photo', async () => {
    const pat = await customer();
    process.env.GATE_PORTAL_MESSAGES_NIGHT_AI = 'true';
    const answer = jest.spyOn(require('../services/portal-messages-night-ai'), 'answerAfterHours').mockResolvedValue(null);
    try {
      await PortalMessages.customerPost({ customer: pat, body: 'What is this?', files: [await jpeg()] });
      expect(answer).not.toHaveBeenCalled();
      await PortalMessages.customerPost({ customer: pat, body: 'Hello?' });
      expect(answer).toHaveBeenCalledTimes(1);
    } finally {
      answer.mockRestore();
      delete process.env.GATE_PORTAL_MESSAGES_NIGHT_AI;
    }
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

  describe('GATE_PORTAL_ANSWER_TEXT: the answer goes by text', () => {
    let SendCustomerMessage;
    const ACCEPTED = { sent: true, blocked: false, deliveryOutcome: 'accepted' };
    beforeAll(() => { SendCustomerMessage = require('../services/messaging/send-customer-message'); });
    beforeEach(() => {
      process.env.GATE_PORTAL_ANSWER_TEXT = 'true';
      Object.assign(mockAnswerText, {
        result: ACCEPTED, error: null, beforeHandoff: null, afterStart: null, refuseAfterStart: null, afterUndo: null, requests: [],
      });
    });
    // The answer's texts this test sent, for one answer.
    const answerTexts = (messageId) => SendCustomerMessage.sendCustomerMessage.mock.calls.map(([input]) => input)
      .filter((input) => input.entryPoint === 'admin_portal_answer' && (!messageId || input.metadata?.portalMessageId === messageId));
    const storedNotice = async (messageId) => (await db('messages').where({ id: messageId }).first('metadata')).metadata.notice;
    // A staff press from a reply form that showed the live way (the list's answerByText at the press).
    const staffPress = (input) => PortalMessages.staffReply({ shownByText: process.env.GATE_PORTAL_ANSWER_TEXT === 'true', ...input });
    // As if a try stopped mid-notice: `notice` stored, claimed 3 minutes ago (stale), the answer `ageMinutes` old.
    const stopped = (messageId, notice, ageMinutes = 0) => db('messages').where({ id: messageId }).update({
      metadata: db.raw("jsonb_set(metadata, '{notice}', ?::jsonb)", [JSON.stringify({ ...notice, pending: true, claimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() })]),
      created_at: db.raw('now() - make_interval(mins => ?)', [ageMinutes]),
    });

    test('a staff answer is the in-app bell plus one text that carries it: no push, no email, and a retried click sends nothing more', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const clientRequestId = randomUUID();
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'Yes, we can bundle them.', clientRequestId, actor });
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'sent', email: 'not_needed' });
      const bell = await db('notifications').where({ recipient_type: 'customer', recipient_id: pat.id }).whereRaw("metadata->>'portalMessageId' = ?", [result.message.id]).first();
      expect(bell).toMatchObject({ title: 'New message from Waves', link: '/?tab=messages' });
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
      expect(answerTexts()).toEqual([expect.objectContaining({
        to: pat.phone,
        body: "Hi Pat, here's our answer from Waves: Yes, we can bundle them.",
        channel: 'sms',
        audience: 'customer',
        purpose: 'support_resolution',
        customerId: pat.id,
        identityTrustLevel: 'phone_matches_customer',
        entryPoint: 'admin_portal_answer',
        withSmsHandoff: expect.any(Function),
        metadata: { original_message_type: 'portal_answer', portalMessageId: result.message.id },
      })]);
      expect(await storedNotice(result.message.id)).toMatchObject({ bell: true, pushAccepted: 0, text: 'sent', email: 'not_needed', pending: false });
      jest.clearAllMocks();
      const again = await staffPress({ kind: 'chat', id: escalationId, body: 'Yes, we can bundle them.', clientRequestId, actor });
      expect(again).toMatchObject({ replay: true, notice: result.notice });
      expect(answerTexts()).toEqual([]);
    });

    test('a text the checks refuse (STOP, no consent) moves to the email in the same try, and a later try never texts', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      mockAnswerText.result = { sent: false, blocked: true, code: 'SUPPRESSED', deliveryOutcome: 'not_sent' };
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'We will call today.', actor });
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(answerTexts(result.message.id)).toHaveLength(1);
      expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith({ customerId: pat.id, messageId: result.message.id, body: 'We will call today.' });
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      expect(await storedNotice(result.message.id)).toMatchObject({ text: 'not_sent', textCode: 'SUPPRESSED', email: 'sent', pending: false });
      // An email that failed waits for its next try, which sends the email only.
      AccountMembershipEmail.sendPortalReply.mockResolvedValueOnce({ ok: false, reason: 'provider_error' });
      const other = await chat(pat.id, { alert: false });
      const failed = await staffPress({ kind: 'chat', id: other.escalationId, body: 'We will call tomorrow.', actor });
      expect(failed.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'provider_error', pending: true });
      jest.clearAllMocks();
      mockAnswerText.result = ACCEPTED;
      await stopped(failed.message.id, await storedNotice(failed.message.id), 10);
      expect(await PortalMessages.resumePendingNotices()).toBeGreaterThanOrEqual(1);
      expect(answerTexts(failed.message.id)).toEqual([]);
      expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith(expect.objectContaining({ messageId: failed.message.id }));
      expect(await storedNotice(failed.message.id)).toMatchObject({ text: 'not_sent', email: 'sent', pending: false });
    });

    test('a text that may have gone out counts as sent (no email), and a try that stopped mid-text never texts again', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      mockAnswerText.result = { sent: false, blocked: false, code: 'PROVIDER_TIMEOUT', deliveryOutcome: 'uncertain' };
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'Your tech is on the way.', actor });
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'uncertain', email: 'not_needed' });
      expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();

      mockAnswerText.result = ACCEPTED;
      const other = await chat(pat.id, { alert: false });
      const clientRequestId = randomUUID();
      const first = await staffPress({ kind: 'chat', id: other.escalationId, body: 'See you Monday.', clientRequestId, actor });
      expect(first.notice).toMatchObject({ text: 'sent' });
      // The process stopped after the move to the text: the text may be out.
      await stopped(first.message.id, { bell: true, pushAccepted: 0, text: 'sending', attempts: 1 });
      jest.clearAllMocks();
      const again = await staffPress({ kind: 'chat', id: other.escalationId, body: 'See you Monday.', clientRequestId, actor });
      expect(again.notice).toEqual({ bell: true, pushAccepted: 0, text: 'uncertain', email: 'not_needed' });
      expect(answerTexts()).toEqual([]);
      expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
    });

    test('a send that throws: after the provider took the text it is sent; before, the email goes', async () => {
      const pat = await customer();
      const one = await chat(pat.id, { alert: false });
      mockAnswerText.error = Object.assign(new Error('audit write failed'), { providerOutcome: { sent: true, deliveryOutcome: 'accepted' } });
      const taken = await staffPress({ kind: 'chat', id: one.escalationId, body: 'Yes.', actor });
      expect(taken.notice).toEqual({ bell: true, pushAccepted: 0, text: 'sent', email: 'not_needed' });
      expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
      const two = await chat(pat.id, { alert: false });
      mockAnswerText.error = new Error('lookup failed');
      const lost = await staffPress({ kind: 'chat', id: two.escalationId, body: 'No.', actor });
      expect(lost.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(lost.message.id)).toMatchObject({ textCode: 'SEND_FAILED' });
    });

    test('the sweep never starts a text: a notice it finishes goes by email; only the staff press texts', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const answer = await staffPress({ kind: 'chat', id: escalationId, body: 'Booked for Friday.', actor });
      // As if the process stopped right after the save, before any step.
      await stopped(answer.message.id, { attempts: 1 }, 10);
      jest.clearAllMocks();
      expect(await PortalMessages.resumePendingNotices()).toBeGreaterThanOrEqual(1);
      expect(answerTexts()).toEqual([]);
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith(expect.objectContaining({ messageId: answer.message.id }));
      const notice = await storedNotice(answer.message.id);
      expect(notice).toMatchObject({ bell: true, pushAccepted: 0, email: 'sent', pending: false });
      // The text part is recorded all the same, so the staff screen never reads a text-way notice as the push way.
      expect(notice).toMatchObject({ text: 'not_sent', textCode: 'SWEEP_NO_TEXT' });
    });

    test('a phone corrected at the send gets no text: the locked handoff re-reads the number, and the email goes', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const corrected = phone();
      mockAnswerText.beforeHandoff = () => db('customers').where({ id: pat.id }).update({ phone: corrected });
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'See you Tuesday.', actor });
      expect(answerTexts()).toEqual([expect.objectContaining({ to: pat.phone })]);
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(result.message.id)).toMatchObject({ text: 'not_sent', textCode: 'RECIPIENT_CHANGED', email: 'sent', pending: false });
      expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledTimes(1);
    });

    test('the number is bound when the answer is saved: a phone corrected after the save gets the email', async () => {
      const NotificationService = require('../services/notification-service');
      const pat = await customer();
      const one = await chat(pat.id, { alert: false });
      // The phone changes after the save and before the text step (the bell goes in between).
      const realNotify = NotificationService.notifyCustomer;
      const spy = jest.spyOn(NotificationService, 'notifyCustomer').mockImplementationOnce(async (...args) => {
        await db('customers').where({ id: pat.id }).update({ phone: phone() });
        return realNotify.apply(NotificationService, args);
      });
      const moved = await staffPress({ kind: 'chat', id: one.escalationId, body: 'See you Tuesday.', actor });
      spy.mockRestore();
      expect((await db('messages').where({ id: moved.message.id }).first('metadata')).metadata.answerTextTo).toBe(pat.phone);
      expect(answerTexts()).toEqual([]);
      expect(moved.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(moved.message.id)).toMatchObject({ textCode: 'RECIPIENT_CHANGED' });
    });

    test('an answer that carries a portal link gets no text (the composer checks who owns such a link): the email goes', async () => {
      const { publicPortalUrl } = require('../utils/portal-url');
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      // A bare link on its own line (the shared run scan drops the line break and can miss it).
      const body = `Sign here:\n${new URL(publicPortalUrl()).host}/contract/${randomUUID()}`;
      const result = await staffPress({ kind: 'chat', id: escalationId, body, actor });
      expect(answerTexts()).toEqual([]);
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(result.message.id)).toMatchObject({ textCode: 'ANSWER_HAS_LINK' });
      expect(AccountMembershipEmail.sendPortalReply).toHaveBeenCalledWith({ customerId: pat.id, messageId: result.message.id, body });
    });

    test('a Waves link the greeting would carry (the stored first name, as the text sends it) gets no text: the email goes', async () => {
      const { OWN_DOMAIN } = require('../utils/signed-link-redaction');
      const pat = await customer();
      // The send step folds the mark away (gsmSafeName): the greeting would carry the host the stored name does not.
      await db('customers').where({ id: pat.id }).update({ first_name: `${OWN_DOMAIN[0]}\u0302${OWN_DOMAIN.slice(1)}/c` });
      const { escalationId } = await chat(pat.id, { alert: false });
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'See you Tuesday.', actor });
      expect(answerTexts()).toEqual([]);
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(result.message.id)).toMatchObject({ textCode: 'ANSWER_HAS_LINK' });
    });

    test("a link on another host that serves the portal (the deployment's own host) gets no text: the email goes", async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      process.env.RAILWAY_PUBLIC_DOMAIN = 'answers-alias.example.test';
      try {
        const result = await staffPress({ kind: 'chat', id: escalationId, body: `Pay here: https://answers-alias.example.test/pay/${randomUUID()}`, actor });
        expect(answerTexts()).toEqual([]);
        expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
        expect(await storedNotice(result.message.id)).toMatchObject({ textCode: 'ANSWER_HAS_LINK' });
      } finally {
        delete process.env.RAILWAY_PUBLIC_DOMAIN;
      }
    });

    test('a gate turned off while the text waited for its locks sends no text: the email goes', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      // The kill lands after the text step's first gate read, before the locked handoff.
      mockAnswerText.beforeHandoff = async () => { process.env.GATE_PORTAL_ANSWER_TEXT = 'false'; };
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'See you Tuesday.', actor });
      expect(mockAnswerText.requests).toEqual([]);
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(result.message.id)).toMatchObject({ textCode: 'TEXT_GATE_OFF' });
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
    });

    test('the move to the text is saved at the provider boundary only; a check after it takes it back, and the email goes', async () => {
      const pat = await customer();
      const one = await chat(pat.id, { alert: false });
      const seen = [];
      const look = async (input) => { seen.push((await storedNotice(input.metadata.portalMessageId)).text); };
      Object.assign(mockAnswerText, { beforeHandoff: look, afterStart: look });
      const sent = await staffPress({ kind: 'chat', id: one.escalationId, body: 'Yes.', actor });
      // Nothing marked before the boundary: a try that stops there leaves its notice to the email. The mark is written
      // through the marker connection, not a second root-pool connection inside the held handoff.
      expect(seen).toEqual([undefined, 'sending']);
      expect(require('../models/marker-db')).toHaveBeenCalled();
      expect(sent.notice).toEqual({ bell: true, pushAccepted: 0, text: 'sent', email: 'not_needed' });
      seen.length = 0;
      Object.assign(mockAnswerText, { beforeHandoff: null, refuseAfterStart: 'QUIET_HOURS_HOLD', afterUndo: look });
      const two = await chat(pat.id, { alert: false });
      const held = await staffPress({ kind: 'chat', id: two.escalationId, body: 'No.', actor });
      expect(seen).toEqual(['sending', undefined]);
      expect(mockAnswerText.requests).toHaveLength(1);
      expect(held.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(held.message.id)).toMatchObject({ textCode: 'QUIET_HOURS_HOLD' });
    });

    test('a try that lost its claim before the boundary sends nothing: no request, no email, the new holder\'s notice stands', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const taken = new Date(Date.now() + 1000).toISOString();
      // Another try takes the claim between this try's checks and its mark.
      mockAnswerText.beforeHandoff = (input) => db('messages').where({ id: input.metadata.portalMessageId })
        .update({ metadata: db.raw("jsonb_set(metadata, '{notice,claimedAt}', to_jsonb(?::text))", [taken]) });
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'Yes.', actor });
      expect(mockAnswerText.requests).toEqual([]);
      expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
      const notice = await storedNotice(result.message.id);
      expect(notice).toMatchObject({ claimedAt: taken, pending: true });
      expect(notice.text).toBeUndefined();
      expect(result.notice).toEqual({ pending: true });
    });

    test('a number the send step would text as another one (+45 and eight digits) gets no text: the email goes', async () => {
      const pat = await customer();
      await db('customers').where({ id: pat.id }).update({ phone: '+4512345678' });
      const { escalationId } = await chat(pat.id, { alert: false });
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'Yes.', actor });
      expect(answerTexts()).toEqual([]);
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(result.message.id)).toMatchObject({ textCode: 'NO_TEXT_NUMBER' });
    });

    test('a missing bell is tried again with no second text: the text receipt stands to the last try', async () => {
      const NotificationService = require('../services/notification-service');
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const clientRequestId = randomUUID();
      const failing = jest.spyOn(NotificationService, 'notifyCustomer').mockResolvedValue(null);
      try {
        const first = await staffPress({ kind: 'chat', id: escalationId, body: 'We can come Monday.', clientRequestId, actor });
        expect(first.notice).toEqual({ bell: false, pushAccepted: 0, text: 'sent', email: 'not_needed', pending: true });
        // The last try (attempts: 5) still has no bell: the notice ends with its text receipt, and nothing else goes.
        await stopped(first.message.id, { ...(await storedNotice(first.message.id)), attempts: 4 });
        jest.clearAllMocks();
        const last = await staffPress({ kind: 'chat', id: escalationId, body: 'We can come Monday.', clientRequestId, actor });
        expect(last.notice).toEqual({ bell: false, pushAccepted: 0, text: 'sent', email: 'not_needed' });
        expect(answerTexts()).toEqual([]);
        expect(AccountMembershipEmail.sendPortalReply).not.toHaveBeenCalled();
        expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      } finally {
        failing.mockRestore();
      }
    });

    test('the way is fixed when the answer is saved: one saved with the gate off never texts; one saved with it on never pushes', async () => {
      const pat = await customer();
      const one = await chat(pat.id, { alert: false });
      const two = await chat(pat.id, { alert: false });
      const offId = randomUUID();
      const onId = randomUUID();
      // Saved with the gate off (the push way), then the gate goes on: a retried click pushes, never texts.
      process.env.GATE_PORTAL_ANSWER_TEXT = 'false';
      const off = await staffPress({ kind: 'chat', id: one.escalationId, body: 'On our way.', clientRequestId: offId, actor });
      expect((await db('messages').where({ id: off.message.id }).first('metadata')).metadata.noticeMode).toBeUndefined();
      await stopped(off.message.id, { attempts: 1 });
      process.env.GATE_PORTAL_ANSWER_TEXT = 'true';
      jest.clearAllMocks();
      mockPushResult.sent = 1;
      const offAgain = await staffPress({ kind: 'chat', id: one.escalationId, body: 'On our way.', clientRequestId: offId, actor });
      expect(offAgain.notice).toEqual({ bell: true, pushAccepted: 1, email: 'not_needed' });
      expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(answerTexts()).toEqual([]);
      // Saved with the gate on (the text way), then the gate goes off (the kill): a retried click emails, never pushes.
      mockPushResult.sent = 0;
      const on = await staffPress({ kind: 'chat', id: two.escalationId, body: 'Running late.', clientRequestId: onId, actor });
      expect((await db('messages').where({ id: on.message.id }).first('metadata')).metadata.noticeMode).toBe('text');
      await stopped(on.message.id, { bell: true, pushAccepted: 0, attempts: 1 });
      process.env.GATE_PORTAL_ANSWER_TEXT = 'false';
      jest.clearAllMocks();
      mockPushResult.sent = 1;
      const onAgain = await staffPress({ kind: 'chat', id: two.escalationId, body: 'Running late.', clientRequestId: onId, actor });
      expect(onAgain.notice).toEqual({ bell: true, pushAccepted: 0, text: 'not_sent', email: 'sent' });
      expect(await storedNotice(on.message.id)).toMatchObject({ textCode: 'TEXT_GATE_OFF' });
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      expect(answerTexts()).toEqual([]);
    });

    test('a new answer goes only the way its reply form showed: a flip while the draft was open saves nothing; a retried click still returns the first answer', async () => {
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const savedFor = () => db('messages').whereRaw("metadata->'portalItem'->>'id' = ?", [escalationId]);
      // The form showed the app-or-email way (or sent no way: an old tab); the gate is on now.
      for (const shown of [{ shownByText: false }, {}]) {
        await expect(PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'See you Tuesday.', ...shown, actor }))
          .rejects.toMatchObject({ code: 'notice_way_changed', status: 409 });
      }
      expect(await savedFor()).toEqual([]);
      expect(answerTexts()).toEqual([]);
      // Pressed again from a form that shows the text way: it goes. Its retried click returns it, whatever the form shows.
      const clientRequestId = randomUUID();
      const sent = await staffPress({ kind: 'chat', id: escalationId, body: 'See you Tuesday.', clientRequestId, actor });
      expect(sent.notice).toEqual({ bell: true, pushAccepted: 0, text: 'sent', email: 'not_needed' });
      const again = await PortalMessages.staffReply({ kind: 'chat', id: escalationId, body: 'See you Tuesday.', clientRequestId, shownByText: false, actor });
      expect(again).toMatchObject({ replay: true, message: { id: sent.message.id } });
      expect(await savedFor()).toHaveLength(1);
      expect(answerTexts()).toHaveLength(1);
    });

    test('a long answer sends its first part and the portal link, inside 3 segments', async () => {
      const { countSegments } = require('../services/messaging/segment-counter');
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const body = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
      await staffPress({ kind: 'chat', id: escalationId, body, actor });
      const [sent] = answerTexts();
      expect(sent.body).toMatch(/^Hi Pat, here's our answer from Waves: word0 .*\.\.\. Read the rest in your portal: \S+\/\?tab=messages&notificationProperty=\S+$/);
      expect(sent.body.endsWith(`notificationProperty=${pat.id}`)).toBe(true);
      expect(countSegments(sent.body).segmentCount).toBeLessThanOrEqual(3);
    });

    test('gate off: the push, else the email, as before, and no text', async () => {
      process.env.GATE_PORTAL_ANSWER_TEXT = 'false';
      const pat = await customer();
      const { escalationId } = await chat(pat.id, { alert: false });
      const result = await staffPress({ kind: 'chat', id: escalationId, body: 'Answer.', actor });
      expect(result.notice).toEqual({ bell: true, pushAccepted: 0, email: 'sent' });
      expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(answerTexts()).toEqual([]);
    });
  });
});
