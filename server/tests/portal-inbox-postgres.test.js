/**
 * Portal inbox against live Postgres (GATE_PORTAL_INBOX): the list rules, the
 * 14-day split, the staff-made exclusion, the "alert marked Done" hiding rule,
 * and Close all older (one transaction, only rows at or before the cutoff,
 * alerts closed, an audit row, and NO customer email). Every row is synthetic
 * and tagged with this run's id; cleanup removes only those rows. It refuses
 * any database but a private QA one or CI's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'portal-inbox-postgres-only';

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendRequestUpdated: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.technicianId = null; req.techRole = 'admin'; next(); },
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('portal inbox (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days) => new Date(Date.now() - days * DAY);
  const ids = { customers: [], sessions: [], escalations: [], requests: [], alerts: [] };
  let db;
  let portalInbox;
  let AccountMembershipEmail;
  let customerId;
  let server;
  let base;

  const phone = () => `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`;

  async function chat({ daysOld, status = 'pending', channel = 'portal_chat', alerts = [], message }) {
    const [session] = await db('agent_sessions').insert({ customer_id: customerId, channel, channel_identifier: `t-${RUN}-${randomUUID()}`, status: 'escalated' }).returning('id');
    ids.sessions.push(session.id);
    const text = message || `${RUN} chat asking about a pest question ${daysOld}d`;
    const when = ago(daysOld);
    await db('agent_messages').insert([
      { conversation_id: session.id, role: 'user', content: text, channel, created_at: ago(daysOld + 0.001) },
      { conversation_id: session.id, role: 'assistant', content: `Reply to ${text}`, channel, created_at: when },
    ]);
    const [esc] = await db('ai_escalations').insert({
      conversation_id: session.id, customer_id: customerId, reason: 'complex_question', summary: 'needs a person',
      customer_message: text, status, priority: 'normal', created_at: when,
    }).returning('id');
    ids.escalations.push(esc.id);
    for (const done of alerts) {
      const [n] = await db('notifications').insert({
        recipient_type: 'admin', category: 'alert', title: `Comms - ${RUN}`, body: 'x',
        metadata: JSON.stringify({ escalationId: esc.id }), done_at: done ? new Date() : null,
      }).returning('id');
      ids.alerts.push(n.id);
    }
    return esc.id;
  }

  async function request({ daysOld, status = 'new', source = null, withAlert = false }) {
    const [row] = await db('service_requests').insert({
      customer_id: customerId, category: 'general', subject: `${RUN} request ${daysOld}d`, description: 'Please call me',
      status, source, created_at: ago(daysOld),
    }).returning('id');
    ids.requests.push(row.id);
    if (withAlert) {
      const [n] = await db('notifications').insert({
        recipient_type: 'admin', category: 'service', title: `Customers - ${RUN}`, body: 'x',
        metadata: JSON.stringify({ requestId: row.id }),
      }).returning('id');
      ids.alerts.push(n.id);
    }
    return row.id;
  }

  const mine = (items) => items.filter((i) => ids.escalations.includes(i.id) || ids.requests.includes(i.id));

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    portalInbox = require('../services/portal-inbox');
    AccountMembershipEmail = require('../services/account-membership-email');
    const [customer] = await db('customers').insert({ first_name: 'Pat', last_name: `Synthetic${RUN}`, phone: phone() }).returning('id');
    customerId = customer.id;
    ids.customers.push(customerId);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/portal-inbox', require('../routes/admin-portal-inbox'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/admin/portal-inbox`;
  }, 60000);

  afterAll(async () => {
    delete process.env.GATE_PORTAL_INBOX;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!db) return;
    await db('notifications').whereIn('id', ids.alerts).del();
    await db('service_requests').whereIn('id', ids.requests).del();
    await db('agent_sessions').whereIn('id', ids.sessions).del();
    await db('customers').whereIn('id', ids.customers).del();
  });

  beforeEach(() => { jest.clearAllMocks(); process.env.GATE_PORTAL_INBOX = 'true'; });

  test('the list holds the last 14 days of open portal chat hand-offs and customer requests, newest first', async () => {
    const recentChat = await chat({ daysOld: 1 });
    const olderChat = await chat({ daysOld: 20 });
    const smsChat = await chat({ daysOld: 1, channel: 'sms' });
    const resolvedChat = await chat({ daysOld: 1, status: 'resolved' });
    const recentRequest = await request({ daysOld: 2 });
    const olderRequest = await request({ daysOld: 30 });
    const staffRequest = await request({ daysOld: 2, source: 'admin' });
    const closedRequest = await request({ daysOld: 2, status: 'resolved' });
    const cancelledRequest = await request({ daysOld: 2, status: 'cancelled' });
    const portalRequest = await request({ daysOld: 3, source: 'portal' });

    const before = await portalInbox.list();
    const shown = mine(before.items);
    expect(shown.map((i) => i.id)).toEqual([recentChat, recentRequest, portalRequest]);
    expect(new Date(before.cutoff).getTime()).toBeLessThan(Date.now() - 13.9 * DAY);
    const chatItem = shown.find((i) => i.id === recentChat);
    expect(chatItem).toMatchObject({ kind: 'chat', customer: { id: customerId, firstName: 'Pat', hasTexts: false } });
    expect(chatItem.customer.phone).toMatch(/\d{10}/);
    // total counts every open item in the window, however many are listed
    // (other suites may add rows meanwhile, so only a lower bound is stable).
    expect(Number.isInteger(before.total)).toBe(true);
    expect(before.total).toBeGreaterThanOrEqual(shown.length);
    expect(chatItem.customerMessage).toContain('chat asking about a pest question 1d');
    expect(chatItem.assistantReply).toBe(`Reply to ${chatItem.customerMessage}`);
    expect(shown.find((i) => i.id === recentRequest)).toMatchObject({ kind: 'request', category: 'general', status: 'new', description: 'Please call me' });
    for (const hidden of [olderChat, smsChat, resolvedChat, olderRequest, staffRequest, closedRequest, cancelledRequest]) {
      expect(shown.map((i) => i.id)).not.toContain(hidden);
    }
    // The older split counts open items past the window; the two older fixtures are in it.
    expect(before.older.chats).toBeGreaterThanOrEqual(1);
    expect(before.older.requests).toBeGreaterThanOrEqual(1);
    const summary = await portalInbox.summary();
    expect(summary.count).toBeGreaterThanOrEqual(3);
  });

  test('a chat whose only admin alert is Done is hidden; no alert or one open alert keeps it listed', async () => {
    const noAlert = await chat({ daysOld: 1 });
    const doneAlert = await chat({ daysOld: 1, alerts: [true] });
    const openAlert = await chat({ daysOld: 1, alerts: [false] });
    const mixed = await chat({ daysOld: 1, alerts: [true, false] });
    const shown = mine((await portalInbox.list()).items).map((i) => i.id);
    expect(shown).toEqual(expect.arrayContaining([noAlert, openAlert, mixed]));
    expect(shown).not.toContain(doneAlert);
  });

  test('close-older closes only rows at or before the cutoff, closes their alerts, sends no email, and audits once', async () => {
    const oldChat = await chat({ daysOld: 21, alerts: [false] });
    const edgeChat = await chat({ daysOld: 14.5, alerts: [false] });
    const oldRequest = await request({ daysOld: 22, withAlert: true });
    const edgeRequest = await request({ daysOld: 14.5, withAlert: true });
    const staffOld = await request({ daysOld: 22, source: 'admin' });
    const cutoff = ago(16);

    const closed = await portalInbox.closeOlder(cutoff, { technicianId: null, role: 'admin' });
    expect(closed.chats).toBeGreaterThanOrEqual(1);
    expect(closed.requests).toBeGreaterThanOrEqual(1);

    const chats = await db('ai_escalations').whereIn('id', [oldChat, edgeChat]).select('id', 'status', 'resolution_notes');
    expect(chats.find((r) => r.id === oldChat)).toMatchObject({ status: 'dismissed', resolution_notes: expect.stringContaining('No customer message') });
    expect(chats.find((r) => r.id === edgeChat).status).toBe('pending');

    const requests = await db('service_requests').whereIn('id', [oldRequest, edgeRequest, staffOld]).select('id', 'status', 'resolved_at', 'status_version', 'admin_notes');
    const oldRow = requests.find((r) => r.id === oldRequest);
    expect(oldRow).toMatchObject({ status: 'resolved', status_version: 1 });
    expect(oldRow.resolved_at).not.toBeNull();
    expect(oldRow.admin_notes).toContain('Closed as older than 14 days (Portal tab). No email sent.');
    expect(requests.find((r) => r.id === edgeRequest).status).toBe('new');
    expect(requests.find((r) => r.id === staffOld).status).toBe('new');

    const alerts = await db('notifications').whereIn('id', ids.alerts).select('id', 'metadata', 'done_at');
    const alertFor = (key, id) => alerts.find((a) => a.metadata?.[key] === id);
    expect(alertFor('escalationId', oldChat).done_at).not.toBeNull();
    expect(alertFor('escalationId', edgeChat).done_at).toBeNull();
    expect(alertFor('requestId', oldRequest).done_at).not.toBeNull();
    expect(alertFor('requestId', edgeRequest).done_at).toBeNull();

    expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
    const audit = await db('audit_log').where({ action: 'portal_inbox.close_older' }).orderBy('created_at', 'desc').first();
    expect(audit.metadata).toMatchObject({ chats: closed.chats, requests: closed.requests });
  });

  test('the routes answer the same through HTTP: gate on lists, gate off is dark, a recent cutoff is refused', async () => {
    const recent = await request({ daysOld: 1 });
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(mine(body.items).map((i) => i.id)).toContain(recent);
    expect((await (await fetch(`${base}/summary`)).json()).count).toBeGreaterThanOrEqual(1);

    const refused = await fetch(`${base}/close-older`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cutoff: ago(10).toISOString() }) });
    expect(refused.status).toBe(400);
    expect((await db('service_requests').where({ id: recent }).first()).status).toBe('new');

    process.env.GATE_PORTAL_INBOX = 'false';
    expect(await (await fetch(`${base}/summary`)).json()).toEqual({ enabled: false });
    expect((await fetch(base)).status).toBe(404);
  });
});
