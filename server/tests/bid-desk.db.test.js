// Bid Desk (GATE_BID_DESK) through PostgreSQL: the migration (up, down, up), filing and grouping, the addendum rule,
// the 15-minute job and its watermark, reminders, the backfill, the manual mark and the admin routes' writes.
// Every write runs in a transaction that is rolled back. Synthetic senders, projects and addresses only.
// Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = 'actor-1'; next(); },
  requireAdmin: (req, res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261022090000_bid_desk');
const service = require('../services/bid-desk');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let server;
let baseUrl;

const NOW = new Date('2026-10-01T14:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const BC_BODY = (project = 'Sample Ridge Residences', due = 'October 20, 2026') => [
  `Fixture Build Co has invited you to bid on ${project}: Pest Control`,
  'Location: 100 Fixture Way, Sampleville, FL 34000',
  'Job Walk: October 8, 2026',
  `Bid Due: ${due}`,
  'Lead: Pat Sample | pat.sample@fixture-gc.example',
].join('\n');

describeDb('Bid Desk (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    process.env.GATE_BID_DESK = 'true';
    const app = express();
    app.use(express.json());
    app.use('/api/admin/bid-desk', require('../routes/admin-bid-desk'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    raiseAdminAlert.mockReset();
    raiseAdminAlert.mockImplementation(async (_category, spec) => { composeAdminAlert(spec); return { id: randomUUID(), deduped: false }; });
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_BID_DESK;
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  async function storeEmail(over = {}) {
    const id = randomUUID();
    await mockPg('emails').insert({
      id, gmail_id: `g-${id}`, gmail_thread_id: `t-${id}`, from_address: 'invites@buildingconnected.com', from_name: 'Fixture Build Co via BuildingConnected',
      subject: 'Fixture Build Co has invited you to bid on Sample Ridge Residences', body_text: BC_BODY(), received_at: new Date(NOW.getTime() - 60000), ...over,
    });
    return mockPg('emails').where({ id }).first();
  }
  const bidRow = (id) => mockPg('bid_opportunities').where({ id }).first();
  const links = (bidId) => mockPg('bid_opportunity_emails').where({ bid_id: bidId }).orderBy('received_at');
  const rung = (kind) => raiseAdminAlert.mock.calls.filter(([, , opts]) => opts.dedupeKey.startsWith(`bid-desk:${kind}:`));
  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}/api/admin/bid-desk${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  test('the migration is reversible', async () => {
    await migration.down(mockPg);
    expect(await mockPg.schema.hasTable('bid_opportunities')).toBe(false);
    await migration.up(mockPg);
    expect(await mockPg.schema.hasTable('bid_opportunities')).toBe(true);
    expect(await mockPg.schema.hasTable('bid_opportunity_emails')).toBe(true);
    await expect(mockPg('bid_opportunities').insert({ source: 'carrier_pigeon' })).rejects.toThrow(/source_check/);
  });

  describe('filing', () => {
    test('a template invite files one bid with its fields, an unconfirmed date and the line it came from', async () => {
      const email = await storeEmail();
      const out = await service.ingestEmail(email);
      expect(out).toMatchObject({ created: true, kind: 'invite' });
      const bid = await bidRow(out.bidId);
      expect(bid).toMatchObject({
        source: 'buildingconnected', status: 'new', historical: false, due_confirmed: false, needs_date_confirmation: false,
        gc_or_agency: 'Fixture Build Co', project_title: 'Sample Ridge Residences', package_name: 'Pest Control', buyer_email: 'pat.sample@fixture-gc.example',
        due_source_line: 'Bid Due: October 20, 2026', first_email_id: email.id, gmail_thread_id: email.gmail_thread_id,
      });
      expect(bid.due_at.toISOString()).toBe('2026-10-21T03:59:00.000Z');
      expect(bid.notified_at).not.toBeNull();
      expect(rung('new')).toHaveLength(1);
      expect(rung('new')[0][2]).toMatchObject({ bell: true, dedupeKey: `bid-desk:new:${bid.id}` });
    });

    test('filing the same email again changes nothing and rings nothing', async () => {
      const email = await storeEmail();
      await service.ingestEmail(email);
      expect(await service.ingestEmail(email)).toEqual({ skipped: 'already_filed' });
      expect(await mockPg('bid_opportunities').count('* as n').first()).toMatchObject({ n: '1' });
      expect(rung('new')).toHaveLength(1);
    });

    test('a non-bid email files nothing', async () => {
      const email = await storeEmail({ from_address: 'friend@example.test', subject: 'Lunch?', body_text: 'Bid Due: October 20, 2026' });
      expect(await service.ingestEmail(email)).toEqual({ skipped: 'not_bid' });
      expect(await mockPg('bid_opportunities').count('* as n').first()).toMatchObject({ n: '0' });
    });

    test('an email in the same thread, or from the same sender org about the same project, joins the bid', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first);
      const sameThread = await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Reminder: Sample Ridge Residences', body_text: 'See the portal.', received_at: new Date(NOW.getTime() - 50000) });
      const sameProject = await storeEmail({ subject: 'Fixture Build Co has invited you to bid on Sample Ridge Residences', received_at: new Date(NOW.getTime() - 40000) });
      const other = await storeEmail({ body_text: BC_BODY('Other Fixture Plaza'), received_at: new Date(NOW.getTime() - 30000) });
      expect(await service.ingestEmail(sameThread)).toMatchObject({ bidId, created: false, kind: 'reminder' });
      expect(await service.ingestEmail(sameProject)).toMatchObject({ bidId, created: false });
      expect((await service.ingestEmail(other)).bidId).not.toBe(bidId);
      expect((await links(bidId)).map((l) => l.kind)).toEqual(['invite', 'reminder', 'invite']);
    });
  });

  describe('addendum rule', () => {
    test('an addendum never overwrites a confirmed date, flags it, and rings once', async () => {
      const { bidId, } = await service.ingestEmail(await storeEmail());
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_confirmed: true });
      const before = await bidRow(bidId);
      const addendum = await storeEmail({
        gmail_thread_id: before.gmail_thread_id, subject: 'Addendum 1: Sample Ridge Residences',
        body_text: BC_BODY('Sample Ridge Residences', 'October 27, 2026'), received_at: new Date(NOW.getTime() - 30000),
      });
      expect(await service.ingestEmail(addendum)).toMatchObject({ bidId, created: false, kind: 'addendum' });
      const after = await bidRow(bidId);
      expect(after.due_at.toISOString()).toBe(before.due_at.toISOString());
      expect(after.due_source_line).toBe('Bid Due: October 20, 2026');
      expect(after).toMatchObject({ due_confirmed: true, needs_date_confirmation: true });
      expect(rung('addendum')).toHaveLength(1);
      expect(await service.ingestEmail(addendum)).toEqual({ skipped: 'already_filed' });
      expect(rung('addendum')).toHaveLength(1);
    });

    test('an addendum fills a missing date but leaves it unconfirmed; a decided bid is not rung', async () => {
      const first = await storeEmail({ body_text: 'Please see the portal.' });
      const { bidId } = await service.ingestEmail(first);
      expect((await bidRow(bidId)).due_at).toBeNull();
      const addendum = await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', body_text: BC_BODY(), received_at: new Date(NOW.getTime() - 30000) });
      await service.ingestEmail(addendum);
      expect(await bidRow(bidId)).toMatchObject({ due_confirmed: false, needs_date_confirmation: true, due_source_line: 'Bid Due: October 20, 2026' });
      await mockPg('bid_opportunities').where({ id: bidId }).update({ status: 'no_bid' });
      const second = await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 2', body_text: 'x', received_at: new Date(NOW.getTime() - 20000) });
      await service.ingestEmail(second);
      expect(rung('addendum')).toHaveLength(1);
    });
  });

  describe('historical rows', () => {
    test('a historical bid is listed but never rings, and an addendum on it never rings', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first, { historical: true });
      expect(await bidRow(bidId)).toMatchObject({ historical: true, notified_at: null });
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', received_at: new Date(NOW.getTime() - 30000) }), { historical: true });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('the backfill dry-run counts and writes nothing; the real run files historical rows, oldest first, without a bell', async () => {
      await storeEmail({ received_at: new Date(NOW.getTime() - 100 * DAY) });
      await storeEmail({ received_at: new Date(NOW.getTime() - 400 * DAY), body_text: BC_BODY('Too Old Plaza') });
      await storeEmail({ from_address: 'friend@example.test', subject: 'Lunch?', received_at: new Date(NOW.getTime() - 10 * DAY) });
      const dry = await service.runBackfill({ days: 180, dryRun: true, now: NOW });
      expect(dry).toMatchObject({ matched: 1, created: 0 });
      expect(await mockPg('bid_opportunities').count('* as n').first()).toMatchObject({ n: '0' });
      const real = await service.runBackfill({ days: 180, dryRun: false, now: NOW });
      expect(real).toMatchObject({ matched: 1, created: 1, failed: 0 });
      expect(await mockPg('bid_opportunities').where({ historical: true }).count('* as n').first()).toMatchObject({ n: '1' });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      expect(await service.runBackfill({ days: 180, dryRun: false, now: NOW })).toMatchObject({ created: 0, attached: 0 });
    });
  });

  describe('the 15-minute job', () => {
    test('files new mail once, advances the watermark past non-bid mail, and a second tick does nothing', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      const bidMail = await storeEmail({ received_at: new Date(NOW.getTime() - 20 * 60000) });
      await storeEmail({ from_address: 'friend@example.test', subject: 'Lunch?', received_at: new Date(NOW.getTime() - 10 * 60000) });
      await storeEmail({ received_at: new Date(NOW.getTime() - 3 * 60 * 60000) }); // before the first-run window
      const first = await service.runBidDeskTick({ now: NOW });
      expect(first).toMatchObject({ read: 2, filed: 1, created: 1, failed: 0 });
      const state = JSON.parse((await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).first()).value);
      expect(new Date(state.at).getTime()).toBe(new Date(NOW.getTime() - 10 * 60000).getTime());
      expect(rung('new')).toHaveLength(1);
      const second = await service.runBidDeskTick({ now: NOW });
      expect(second).toMatchObject({ read: 0, filed: 0 });
      expect(rung('new')).toHaveLength(1);
      expect((await mockPg('bid_opportunities').first()).first_email_id).toBe(bidMail.id);
    });

    test('a failing email blocks the batch for two ticks, then is skipped', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ received_at: new Date(NOW.getTime() - 20 * 60000) });
      raiseAdminAlert.mockRejectedValue(new Error('bell down'));
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ failed: 1 });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ failed: 1 });
      expect(await mockPg('bid_opportunities').count('* as n').first()).toMatchObject({ n: '0' });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ failed: 1 });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ read: 0 });
    });
  });

  describe('reminders', () => {
    async function confirmedBid(dueInDays, over = {}) {
      const { bidId } = await service.ingestEmail(await storeEmail({ body_text: 'x', gmail_thread_id: `t-${randomUUID()}`, subject: `RFP ${randomUUID()}` }));
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: new Date(NOW.getTime() + dueInDays * DAY), due_confirmed: true, ...over });
      raiseAdminAlert.mockClear();
      return bidId;
    }

    test('7 days then 2 days, each exactly once; the stamps are written', async () => {
      const id = await confirmedBid(6.5);
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      expect(rung('remind')).toHaveLength(1);
      expect(rung('remind')[0][2].dedupeKey).toBe(`bid-desk:remind:${id}:7d`);
      const later = new Date(NOW.getTime() + 5 * DAY);
      expect(await service.sendDueReminders({ now: later })).toBe(1);
      expect(await service.sendDueReminders({ now: later })).toBe(0);
      expect(rung('remind').map((c) => c[2].dedupeKey)).toEqual([`bid-desk:remind:${id}:7d`, `bid-desk:remind:${id}:2d`]);
      expect(await bidRow(id)).toMatchObject({ reminder_7d_sent_at: expect.any(Date), reminder_2d_sent_at: expect.any(Date) });
    });

    test('an unconfirmed date, a historical bid and a decided bid never remind', async () => {
      await confirmedBid(1, { due_confirmed: false });
      await confirmedBid(1, { historical: true });
      await confirmedBid(1, { status: 'no_bid' });
      await confirmedBid(1, { status: 'submitted' });
      await confirmedBid(20);
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('a bid first seen inside 2 days gets one 2-day reminder and never a late 7-day one', async () => {
      const id = await confirmedBid(1);
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect(rung('remind')[0][2].dedupeKey).toBe(`bid-desk:remind:${id}:2d`);
      expect(await bidRow(id)).toMatchObject({ reminder_7d_sent_at: expect.any(Date), reminder_2d_sent_at: expect.any(Date) });
    });
  });

  describe('manual mark', () => {
    test('files a bid from one email with source manual and no bell, and answers the same bid the second time', async () => {
      const email = await storeEmail({ from_address: 'manager@sample-hoa.example', subject: 'Grounds pest control quote', body_text: 'Please send pricing.' });
      const out = await service.markEmailAsBid(email.id);
      expect(out).toMatchObject({ created: true });
      expect(await bidRow(out.bidId)).toMatchObject({ source: 'manual', due_at: null, project_title: null, notified_at: null });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      expect(await service.markEmailAsBid(email.id)).toEqual({ bidId: out.bidId, created: false, alreadyFiled: true });
      expect(await service.markEmailAsBid(randomUUID())).toEqual({ error: 'email_not_found' });
    });
  });

  describe('admin routes', () => {
    async function filed() {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first);
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', body_text: 'x', received_at: new Date(NOW.getTime() - 30000) }));
      return { bidId, first };
    }

    test('list shows the date, its source line, days left and the email count; detail lists the attached emails', async () => {
      const { bidId, first } = await filed();
      const list = await call('GET', '/');
      const row = list.body.bids.find((b) => b.id === bidId);
      expect(row).toMatchObject({ due_confirmed: false, needs_date_confirmation: true, due_source_line: 'Bid Due: October 20, 2026', email_count: 2, first_subject: first.subject });
      expect(typeof row.days_left).toBe('number');
      const detail = await call('GET', `/${bidId}`);
      expect(detail.body.emails.map((e) => e.kind)).toEqual(['invite', 'addendum']);
      expect(detail.body.emails[0]).toMatchObject({ email_id: first.id, subject: first.subject });
      expect((await call('GET', `/${randomUUID()}`)).status).toBe(404);
    });

    test('a typed date is ET, confirmed, clears the flag and restarts the reminders; clearing it un-confirms', async () => {
      const { bidId } = await filed();
      await mockPg('bid_opportunities').where({ id: bidId }).update({ reminder_7d_sent_at: NOW, reminder_2d_sent_at: NOW });
      const typed = await call('PATCH', `/${bidId}`, { due_at: '2026-10-28T14:00' });
      expect(typed.status).toBe(200);
      const row = await bidRow(bidId);
      expect(row.due_at.toISOString()).toBe('2026-10-28T18:00:00.000Z');
      expect(row).toMatchObject({ due_confirmed: true, needs_date_confirmation: false, reminder_7d_sent_at: null, reminder_2d_sent_at: null });
      await call('PATCH', `/${bidId}`, { due_at: null });
      expect(await bidRow(bidId)).toMatchObject({ due_at: null, due_confirmed: false });
      expect((await call('PATCH', `/${bidId}`, { due_at: '2026-02-30T10:00' })).status).toBe(400);
    });

    test('confirm_due confirms the date as read; with no date it is refused', async () => {
      const { bidId } = await filed();
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true })).status).toBe(200);
      expect(await bidRow(bidId)).toMatchObject({ due_confirmed: true, needs_date_confirmation: false });
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: null, due_confirmed: false });
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true })).status).toBe(400);
    });

    test('status and note save together; every status is accepted', async () => {
      const { bidId } = await filed();
      for (const status of ['bid', 'no_bid', 'submitted', 'won', 'lost', 'new']) {
        expect((await call('PATCH', `/${bidId}`, { status, decision_note: `note ${status}` })).status).toBe(200);
        expect(await bidRow(bidId)).toMatchObject({ status, decision_note: `note ${status}` });
      }
      await call('PATCH', `/${bidId}`, { decision_note: '' });
      expect((await bidRow(bidId)).decision_note).toBeNull();
    });

    test('mark an email as a bid by id', async () => {
      const email = await storeEmail({ from_address: 'manager@sample-hoa.example', subject: 'Quote request', body_text: 'x' });
      const made = await call('POST', '/from-email', { email_id: email.id });
      expect(made).toMatchObject({ status: 201, body: { ok: true, created: true } });
      expect((await call('POST', '/from-email', { email_id: email.id })).status).toBe(200);
      expect((await call('POST', '/from-email', { email_id: randomUUID() })).status).toBe(404);
    });
  });
});
