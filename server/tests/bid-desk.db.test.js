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
jest.mock('../services/admin-alert-episodes', () => ({
  ...jest.requireActual('../services/admin-alert-episodes'),
  raiseAdminAlertWithReopen: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = 'actor-1'; next(); },
  requireAdmin: (req, res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261022090000_bid_desk');
const retryMigration = require('../models/migrations/20261022100000_bid_desk_alert_retry_and_cursor_index');
const checklistMigration = require('../models/migrations/20261023130000_bid_desk_checklist');
const service = require('../services/bid-desk');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { raiseAdminAlertWithReopen } = require('../services/admin-alert-episodes');

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
    raiseAdminAlertWithReopen.mockReset();
    raiseAdminAlertWithReopen.mockImplementation(async () => ({ id: randomUUID(), deduped: false, rang: true }));
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_BID_DESK;
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  async function storeEmail(over = {}) {
    const id = over.id || randomUUID();
    await mockPg('emails').insert({
      id, gmail_id: `g-${id}`, gmail_thread_id: `t-${id}`, from_address: 'invites@buildingconnected.com', from_name: 'Fixture Build Co via BuildingConnected',
      subject: 'Fixture Build Co has invited you to bid on Sample Ridge Residences', body_text: BC_BODY(), received_at: new Date(NOW.getTime() - 60000), ...over,
      // The job's cursor is the INSERT time. Unless a test says otherwise, a row is stored when it was received.
      created_at: over.created_at || over.received_at || new Date(NOW.getTime() - 60000),
      // Already classified by the sync unless a test says otherwise (an unclassified row is held; see "settle").
      classification: over.classification !== undefined ? over.classification : 'other',
      // Gmail's stored Authentication-Results: aligned DKIM for the sender's own domain unless a test says otherwise.
      authentication_results: over.authentication_results !== undefined ? over.authentication_results
        : `mx.google.com; dkim=pass header.i=@${String(over.from_address || 'invites@buildingconnected.com').split('@')[1]}`,
    });
    return mockPg('emails').where({ id }).first();
  }
  const bidRow = (id) => mockPg('bid_opportunities').where({ id }).first();
  const links = (bidId) => mockPg('bid_opportunity_emails').where({ bid_id: bidId }).orderBy('received_at');
  // Every ring, from either path (reminders go through the shared reopen helper), as [category, spec, opts].
  const rung = (kind) => [
    ...raiseAdminAlert.mock.calls,
    ...raiseAdminAlertWithReopen.mock.calls.map(([category, , , opts]) => [category, null, opts]),
  ].filter(([, , opts]) => opts.dedupeKey.startsWith(`bid-desk:${kind}:`));
  const version = async (id) => (await call('GET', `/${id}`)).body.bid.updated_at;
  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}/api/admin/bid-desk${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  test('the migrations are reversible', async () => {
    // The checklist table (GATE_BID_CHECKLIST) references bid_opportunities, so it goes first and comes back last.
    await checklistMigration.down(mockPg);
    await retryMigration.down(mockPg);
    expect(await mockPg.schema.hasColumn('bid_opportunity_emails', 'alert_kind')).toBe(false);
    await migration.down(mockPg);
    expect(await mockPg.schema.hasTable('bid_opportunities')).toBe(false);
    await migration.up(mockPg);
    await retryMigration.up(mockPg);
    await checklistMigration.up(mockPg);
    expect(await mockPg.schema.hasTable('bid_opportunities')).toBe(true);
    expect(await mockPg.schema.hasColumn('bid_opportunity_emails', 'alert_kind')).toBe(true);
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
      // Filing itself fails (a trigger inside this test's rolled-back transaction).
      await mockPg.raw("CREATE FUNCTION pg_temp.bid_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'filing down'; END $$");
      await mockPg.raw('CREATE TRIGGER bid_fail BEFORE INSERT ON bid_opportunities FOR EACH ROW EXECUTE FUNCTION pg_temp.bid_fail()');
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ failed: 1 });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ failed: 1 });
      expect(await mockPg('bid_opportunities').count('* as n').first()).toMatchObject({ n: '0' });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ failed: 1 });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ read: 0 });
    });

    test('a bell outage never loses the bid: it is filed, the bell is owed, and a later tick rings it once', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ received_at: new Date(NOW.getTime() - 20 * 60000) });
      raiseAdminAlert.mockRejectedValue(new Error('bell down'));
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ filed: 1, created: 1, failed: 0, owedAlerts: 0 });
      const bid = await mockPg('bid_opportunities').first();
      expect(bid.notified_at).toBeNull();
      expect(await mockPg('bid_opportunity_emails').where({ bid_id: bid.id }).first()).toMatchObject({ alert_kind: 'new', alerted_at: null });
      raiseAdminAlert.mockReset();
      raiseAdminAlert.mockImplementation(async (_category, spec) => { composeAdminAlert(spec); return { id: randomUUID(), deduped: false }; });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ owedAlerts: 1 });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ owedAlerts: 0 });
      expect(rung('new')).toHaveLength(1);
      expect((await bidRow(bid.id)).notified_at).not.toBeNull();
    });

    test('an owed addendum bell after the date was confirmed is dropped without ringing', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first);
      raiseAdminAlert.mockRejectedValue(new Error('bell down'));
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', received_at: new Date(NOW.getTime() - 30000) }));
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_confirmed: true, needs_date_confirmation: false });
      raiseAdminAlert.mockReset();
      expect(await service.deliverOwedAlerts()).toBe(0);
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('an owed bell on a bid decided meanwhile is dropped without ringing', async () => {
      raiseAdminAlert.mockRejectedValue(new Error('bell down'));
      const { bidId } = await service.ingestEmail(await storeEmail());
      await mockPg('bid_opportunities').where({ id: bidId }).update({ status: 'no_bid' });
      raiseAdminAlert.mockReset();
      expect(await service.deliverOwedAlerts()).toBe(0);
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      expect((await mockPg('bid_opportunity_emails').where({ bid_id: bidId }).first()).alerted_at).not.toBeNull();
    });

    test('mail the sync stored as spam never becomes a bid', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ classification: 'spam', subject: 'RFP: urgent', received_at: new Date(NOW.getTime() - 20 * 60000) });
      await storeEmail({ label_ids: JSON.stringify(['SPAM']), subject: 'Invitation to bid', received_at: new Date(NOW.getTime() - 15 * 60000) });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ filed: 0, created: 0 });
      expect(await service.ingestEmail(await storeEmail({ classification: 'spam' }))).toEqual({ skipped: 'spam' });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('a signed Blue Book invite in Gmail Spam is filed and rings; forged or blocked ones are not', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      const bluebook = (over = {}) => storeEmail({
        from_address: 'FixtureBuild.oneteam.build@bbbid.thebluebook.com', from_name: 'Fixture Build via The Blue Book',
        subject: 'Invitation to Bid', label_ids: JSON.stringify(['UNREAD', 'SPAM']),
        body_text: [
          'Bid is due by 2:00 PM (Eastern) on October 20, 2026',
          'You\u2019ve been invited to bid on a - Gas Station Project in Sampleton, FL.',
          'We are looking for', 'Pest Control--Exterminating.',
          "Fixture Build Co. is sharing this project opportunity with you through The Blue Book Network's ONETEAM.",
        ].join('\n'),
        ...over,
      });
      // Not signed by the Blue Book domain: Gmail's SPAM label holds.
      await bluebook({ authentication_results: 'mx.google.com; dkim=fail header.i=@bbbid.thebluebook.com; spf=softfail smtp.mailfrom=x@elsewhere.example', received_at: new Date(NOW.getTime() - 25 * 60000) });
      // A sender-typed MAIL FROM that fakes a DKIM pass fools only the loose reader (GATE_EMAIL_AUTH_STRICT is off
      // here): it never passes Gmail Spam.
      await bluebook({
        authentication_results: 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x dkim=pass header.d=bbbid.thebluebook.com y"@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom="x dkim=pass header.d=bbbid.thebluebook.com y"@evil.example',
        received_at: new Date(NOW.getTime() - 22 * 60000),
      });
      // Our own spam classification (a blocked sender) holds even when signed.
      await bluebook({ classification: 'spam', received_at: new Date(NOW.getTime() - 20 * 60000) });
      // Any other sender in Gmail Spam still holds.
      await storeEmail({ label_ids: JSON.stringify(['SPAM']), subject: 'Invitation to bid', received_at: new Date(NOW.getTime() - 18 * 60000) });
      const signed = await bluebook({ received_at: new Date(NOW.getTime() - 15 * 60000) });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ filed: 1, created: 1 });
      const link = await mockPg('bid_opportunity_emails').where({ email_id: signed.id }).first();
      expect(await bidRow(link.bid_id)).toMatchObject({
        source: 'bluebook', gc_or_agency: 'Fixture Build Co.', project_title: 'Gas Station Project in Sampleton, FL',
        package_name: 'Pest Control--Exterminating', location: 'Sampleton, FL', due_confirmed: false,
        due_source_line: 'Bid is due by 2:00 PM (Eastern) on October 20, 2026',
      });
      expect((await bidRow(link.bid_id)).due_at.toISOString()).toBe('2026-10-20T18:00:00.000Z');
      expect(rung('new')).toHaveLength(1);
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
      const due = (await bidRow(id)).due_at.toISOString();
      expect(rung('remind')[0][2].dedupeKey).toBe(`bid-desk:remind:${id}:7d:${due}`);
      const later = new Date(NOW.getTime() + 5 * DAY);
      expect(await service.sendDueReminders({ now: later })).toBe(1);
      expect(await service.sendDueReminders({ now: later })).toBe(0);
      expect(rung('remind').map((c) => c[2].dedupeKey)).toEqual([`bid-desk:remind:${id}:7d:${due}`, `bid-desk:remind:${id}:2d:${due}`]);
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
      expect(rung('remind')[0][2].dedupeKey).toBe(`bid-desk:remind:${id}:2d:${(await bidRow(id)).due_at.toISOString()}`);
      expect(await bidRow(id)).toMatchObject({ reminder_7d_sent_at: expect.any(Date), reminder_2d_sent_at: expect.any(Date) });
    });
  });

  describe('review fixes', () => {
    test('an older message stored after the cursor passed it is still filed (the cursor is the insert time)', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ from_address: 'friend@example.test', subject: 'Lunch?', received_at: new Date(NOW.getTime() - 5 * 60000) });
      await service.runBidDeskTick({ now: NOW });
      // Received two hours ago, stored by a sync retry only now.
      const late = await storeEmail({ received_at: new Date(NOW.getTime() - 2 * 60 * 60000), created_at: new Date(NOW.getTime() - 60000) });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ filed: 1, created: 1 });
      expect((await mockPg('bid_opportunities').first()).first_email_id).toBe(late.id);
    });

    test('a row that commits behind the cursor inside the recheck window is filed on the next tick', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ from_address: 'friend@example.test', subject: 'Lunch?', created_at: new Date(NOW.getTime() - 5 * 60000), received_at: new Date(NOW.getTime() - 5 * 60000) });
      await service.runBidDeskTick({ now: NOW });
      const behind = await storeEmail({ created_at: new Date(NOW.getTime() - 15 * 60000), received_at: new Date(NOW.getTime() - 15 * 60000) });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ read: 0, filed: 1, created: 1 });
      expect((await mockPg('bid_opportunities').first()).first_email_id).toBe(behind.id);
    });

    test('a changed due date gets its own reminders', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail({ body_text: 'x', gmail_thread_id: `t-${randomUUID()}`, subject: `RFP ${randomUUID()}` }));
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: new Date(NOW.getTime() + 6 * DAY), due_confirmed: true });
      raiseAdminAlert.mockClear();
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      // The operator moves the date (the PATCH clears both stamps).
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: new Date(NOW.getTime() + 5 * DAY), reminder_7d_sent_at: null, reminder_2d_sent_at: null });
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      const keys = rung('remind').map((c) => c[2].dedupeKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
    });

    test('current mail on a bid the backfill filed as history makes it live, with its bell', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first, { historical: true });
      raiseAdminAlert.mockClear();
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 2', received_at: new Date(NOW.getTime() - 30000) }));
      expect(await bidRow(bidId)).toMatchObject({ historical: false, needs_date_confirmation: true });
      expect(rung('addendum')).toHaveLength(1);
      expect(rung('addendum')[0][2].dedupeKey.startsWith(`bid-desk:addendum:${bidId}:`)).toBe(true);
    });

    test('a decided bid does not swallow a new solicitation with the same project and package', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail());
      await mockPg('bid_opportunities').where({ id: bidId }).update({ status: 'lost' });
      const again = await service.ingestEmail(await storeEmail());
      expect(again.created).toBe(true);
      expect(again.bidId).not.toBe(bidId);
    });

    test('the late pass pages past non-bid mail to a late bid row', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ from_address: 'friend@example.test', subject: 'Lunch?', created_at: new Date(NOW.getTime() - 2 * 60000), received_at: new Date(NOW.getTime() - 2 * 60000) });
      await service.runBidDeskTick({ now: NOW, limit: 2 });
      // Three non-bid rows and then a bid row commit behind the cursor, all inside the recheck window.
      for (let i = 0; i < 3; i += 1) {
        await storeEmail({ from_address: 'friend@example.test', subject: `Note ${i}`, created_at: new Date(NOW.getTime() - (20 - i) * 60000), received_at: new Date(NOW.getTime() - (20 - i) * 60000) });
      }
      const bidMail = await storeEmail({ created_at: new Date(NOW.getTime() - 10 * 60000), received_at: new Date(NOW.getTime() - 10 * 60000) });
      expect(await service.runBidDeskTick({ now: NOW, limit: 2 })).toMatchObject({ created: 1 });
      expect((await mockPg('bid_opportunities').first()).first_email_id).toBe(bidMail.id);
    });

    test('a date waiting on an addendum check gets no reminder until it is confirmed again', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail({ body_text: 'x', gmail_thread_id: `t-${randomUUID()}`, subject: `RFP ${randomUUID()}` }));
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: new Date(NOW.getTime() + 6 * DAY), due_confirmed: true, needs_date_confirmation: true });
      raiseAdminAlert.mockClear();
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      await mockPg('bid_opportunities').where({ id: bidId }).update({ needs_date_confirmation: false });
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
    });

    test('a very long subject still files (the grouping key is capped)', async () => {
      const subject = `RFP ${'Sample long solicitation title words '.repeat(400)}`;
      const out = await service.ingestEmail(await storeEmail({ from_address: 'buyer@sample-county.example', subject, body_text: 'x' }));
      expect(out.created).toBe(true);
      // Not a provider template: no cross-thread key at all.
      expect((await bidRow(out.bidId)).group_key).toBeNull();
    });

    test('old mail the backfill attaches to a live bid changes no date state', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first);
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_confirmed: true });
      raiseAdminAlert.mockClear();
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', body_text: BC_BODY('Sample Ridge Residences', 'October 30, 2026'), received_at: new Date(NOW.getTime() - 90 * DAY) }), { historical: true });
      expect(await bidRow(bidId)).toMatchObject({ needs_date_confirmation: false, due_confirmed: true, historical: false });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('a date changed and changed back reminds through the shared reopen path under the same key', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail({ body_text: 'x', gmail_thread_id: `t-${randomUUID()}`, subject: `RFP ${randomUUID()}` }));
      const dateA = new Date('2026-10-07T14:00:00Z'); // 10:00 ET, 6 days after NOW
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: dateA, due_confirmed: true });
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect((await call('PATCH', `/${bidId}`, { due_at: '2026-10-06T10:00', expected_updated_at: await version(bidId) })).status).toBe(200);
      expect((await call('PATCH', `/${bidId}`, { due_at: '2026-10-07T10:00', expected_updated_at: await version(bidId) })).status).toBe(200);
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      const keys = raiseAdminAlertWithReopen.mock.calls.map(([, , , opts]) => opts.dedupeKey);
      // The helper reopens an auto-closed episode under the same key; the key is the window plus the date.
      expect(keys).toEqual([`bid-desk:remind:${bidId}:7d:${dateA.toISOString()}`, `bid-desk:remind:${bidId}:7d:${dateA.toISOString()}`]);
    });

    test('a stranger using a GC display name does not attach an addendum to its bid', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail({ from_address: 'bids@fixture-gc.example', from_name: 'Fixture Build Co', subject: 'RFP: Sample Clinic pest control', body_text: 'x' }));
      const spoof = await service.ingestEmail(await storeEmail({ from_address: 'someone@elsewhere.example', from_name: 'Fixture Build Co', subject: 'Addendum: RFP: Sample Clinic pest control', body_text: 'x' }));
      expect(spoof.bidId).not.toBe(bidId);
      expect(await bidRow(bidId)).toMatchObject({ needs_date_confirmation: false });
    });

    test('two generic "Invitation to Bid" emails from one buyer in different threads are two bids', async () => {
      const one = await service.ingestEmail(await storeEmail({ from_address: 'purchasing@samplecity.gov', subject: 'Invitation to Bid', body_text: 'See the portal.' }));
      const two = await service.ingestEmail(await storeEmail({ from_address: 'purchasing@samplecity.gov', subject: 'Invitation to Bid', body_text: 'See the portal.' }));
      expect(two.created).toBe(true);
      expect(two.bidId).not.toBe(one.bidId);
    });

    test('a provider reminder in the thread with a different due date flags the date and rings', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first);
      raiseAdminAlert.mockClear();
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Reminder', body_text: BC_BODY('Sample Ridge Residences', 'October 27, 2026'), received_at: new Date(NOW.getTime() - 30000) }));
      expect(await bidRow(bidId)).toMatchObject({ needs_date_confirmation: true });
      expect(rung('addendum')).toHaveLength(1);
    });

    test('a bid filed from a plain email takes the key of the first template email in its thread', async () => {
      const plain = await storeEmail({ from_address: 'pat.sample@fixture-gc.example', subject: 'RFP: Sample Ridge Residences', body_text: 'x' });
      const { bidId } = await service.ingestEmail(plain);
      expect((await bidRow(bidId)).group_key).toBeNull();
      await service.ingestEmail(await storeEmail({ gmail_thread_id: plain.gmail_thread_id, received_at: new Date(NOW.getTime() - 30000) }));
      expect((await bidRow(bidId)).group_key).toBe('fixture build co|sample ridge residences#pest control');
      // A later template invite in another thread now joins the same bid.
      expect(await service.ingestEmail(await storeEmail({ received_at: new Date(NOW.getTime() - 20000) }))).toMatchObject({ bidId, created: false });
    });

    test('a forged BuildingConnected email (no aligned SPF/DKIM) is not read as a template and joins nothing', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail());
      const forged = await service.ingestEmail(await storeEmail({ authentication_results: 'mx.google.com; dkim=fail header.i=@buildingconnected.com; spf=softfail smtp.mailfrom=x@elsewhere.example', subject: 'Addendum 1', received_at: new Date(NOW.getTime() - 30000) }));
      expect(forged.bidId).not.toBe(bidId);
      expect(await bidRow(bidId)).toMatchObject({ needs_date_confirmation: false });
      expect(await bidRow(forged.bidId)).toMatchObject({ source: 'email_subject', gc_or_agency: null, due_at: null, group_key: null });
    });

    test('settle: a row the classifier has not seen yet is held, then filed once it is classified', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      const fresh = await storeEmail({ classification: null, created_at: new Date(NOW.getTime() - 2 * 60000), received_at: new Date(NOW.getTime() - 2 * 60000) });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ created: 0 });
      await mockPg('emails').where({ id: fresh.id }).update({ classification: 'lead_inquiry' });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ created: 1 });
    });

    test('settle: a row the classifier marked spam meanwhile is never filed', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      const fresh = await storeEmail({ classification: null, created_at: new Date(NOW.getTime() - 2 * 60000), received_at: new Date(NOW.getTime() - 2 * 60000) });
      await service.runBidDeskTick({ now: NOW });
      await mockPg('emails').where({ id: fresh.id }).update({ classification: 'spam' });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ created: 0 });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('settle: an unclassified row older than the settle time is filed (a classifier outage does not stop the desk)', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ classification: null, created_at: new Date(NOW.getTime() - 20 * 60000), received_at: new Date(NOW.getTime() - 20 * 60000) });
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ created: 1 });
    });

    test('a backfill run before the first tick leaves recent mail to the live intake, which files it with its bell', async () => {
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await storeEmail({ created_at: new Date(NOW.getTime() - 3 * DAY), received_at: new Date(NOW.getTime() - 3 * DAY), body_text: BC_BODY('Older Fixture Plaza') });
      const recent = await storeEmail({ created_at: new Date(NOW.getTime() - 30 * 60000), received_at: new Date(NOW.getTime() - 30 * 60000) });
      expect(await service.runBackfill({ days: 180, dryRun: false, now: NOW })).toMatchObject({ created: 1 });
      expect(await mockPg('bid_opportunity_emails').where({ email_id: recent.id }).first()).toBeUndefined();
      expect(await service.runBidDeskTick({ now: NOW })).toMatchObject({ created: 1 });
      const live = await mockPg('bid_opportunities').where({ first_email_id: recent.id }).first();
      expect(live).toMatchObject({ historical: false });
      expect(rung('new')).toHaveLength(1);
    });

    test('the backfill leaves rows after the cursor id to the live intake, even at the same created_at', async () => {
      const at = new Date(NOW.getTime() - 3 * DAY);
      const a = await storeEmail({ id: '00000000-0000-4000-8000-000000000001', created_at: at, received_at: at, body_text: BC_BODY('Alpha Fixture Plaza') });
      const b = await storeEmail({ id: '00000000-0000-4000-8000-000000000002', created_at: at, received_at: at, body_text: BC_BODY('Beta Fixture Plaza') });
      // The live cursor stopped between the two rows.
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      await mockPg('system_settings').insert({ key: service.WATERMARK_KEY, value: JSON.stringify({ at: (await mockPg.raw('SELECT ?::timestamptz::text AS t', [at])).rows[0].t, id: a.id }), category: 'bid_desk', description: 'test' });
      expect(await service.runBackfill({ days: 180, dryRun: false, now: NOW })).toMatchObject({ created: 1 });
      expect(await mockPg('bid_opportunity_emails').where({ email_id: a.id }).first()).toBeTruthy();
      expect(await mockPg('bid_opportunity_emails').where({ email_id: b.id }).first()).toBeUndefined();
    });

    test('the backfill dry run counts a later email that would join an earlier match by thread', async () => {
      const first = await storeEmail({ created_at: new Date(NOW.getTime() - 3 * DAY), received_at: new Date(NOW.getTime() - 3 * DAY) });
      await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Quick question', body_text: 'Can you make the walk?', created_at: new Date(NOW.getTime() - 2 * DAY), received_at: new Date(NOW.getTime() - 2 * DAY) });
      const dry = await service.runBackfill({ days: 180, dryRun: true, now: NOW });
      const real = await service.runBackfill({ days: 180, dryRun: false, now: NOW });
      expect(dry.matched).toBe(2);
      expect(real).toMatchObject({ matched: 2, created: 1, attached: 1 });
    });

    test('a follow-up that supplies the first due date flags it and rings', async () => {
      const first = await storeEmail({ body_text: BC_BODY().replace(/Bid Due: .*/, '') });
      const { bidId } = await service.ingestEmail(first);
      expect((await bidRow(bidId)).due_at).toBeNull();
      await mockPg('bid_opportunities').where({ id: bidId }).update({ status: 'bid' });
      raiseAdminAlert.mockClear();
      await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Reminder', received_at: new Date(NOW.getTime() - 30000) }));
      expect(await bidRow(bidId)).toMatchObject({ needs_date_confirmation: true, due_confirmed: false });
      expect(rung('addendum')).toHaveLength(1);
    });

    test('reminded bids do not fill the candidate list', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail({ body_text: 'x', gmail_thread_id: `t-${randomUUID()}`, subject: `RFP ${randomUUID()}` }));
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: new Date(NOW.getTime() + 6 * DAY), due_confirmed: true, reminder_7d_sent_at: NOW });
      raiseAdminAlert.mockClear();
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      expect((await bidRow(bidId)).updated_at).toBeTruthy();
    });

    test('saving a decision or a confirmed date closes the bell rows whose condition is met', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail());
      const insertAlert = (key) => mockPg('notifications').insert({ recipient_type: 'admin', category: 'lead', title: 't', body: 'b', metadata: JSON.stringify({ dedupeKey: key }) });
      await insertAlert(`bid-desk:new:${bidId}`);
      await insertAlert(`bid-desk:addendum:${bidId}:${randomUUID()}`);
      await mockPg('bid_opportunities').where({ id: bidId }).update({ needs_date_confirmation: true });
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true, expected_updated_at: await version(bidId) })).status).toBe(200);
      const open = async () => (await mockPg('notifications').whereRaw("metadata->>'dedupeKey' like ?", [`bid-desk:%${bidId}%`])
        .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'").select('metadata')).map((r) => r.metadata.dedupeKey);
      expect(await open()).toEqual([`bid-desk:new:${bidId}`]);
      expect((await call('PATCH', `/${bidId}`, { status: 'no_bid' })).status).toBe(200);
      expect(await open()).toEqual([]);
    });

    test('confirming a date leaves the bell for a closed SAM.gov notice open until the bid is decided', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail());
      await mockPg('bid_opportunities').where({ id: bidId }).update({ source: 'sam_gov', external_id: `c-${bidId}`, source_active: false, needs_date_confirmation: true });
      const closedKey = `bid-desk:addendum:${bidId}:sam:inactive`;
      // A deadline moved on a notice already closed is still a closure bell (addendumSpec), so it stays too.
      const movedKey = `bid-desk:addendum:${bidId}:sam:2026-11-05T19:00:00.000Z`;
      const emailKey = `bid-desk:addendum:${bidId}:${randomUUID()}`;
      for (const key of [closedKey, movedKey, emailKey]) {
        await mockPg('notifications').insert({ recipient_type: 'admin', category: 'lead', title: 't', body: 'b', metadata: JSON.stringify({ dedupeKey: key }) });
      }
      const open = async () => (await mockPg('notifications').whereRaw("metadata->>'dedupeKey' like ?", [`bid-desk:addendum:${bidId}:%`])
        .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'").select('metadata')).map((r) => r.metadata.dedupeKey);
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true, expected_updated_at: await version(bidId) })).status).toBe(200);
      expect((await open()).sort()).toEqual([closedKey, movedKey].sort());
      expect((await call('PATCH', `/${bidId}`, { status: 'no_bid' })).status).toBe(200);
      expect(await open()).toEqual([]);
    });

    test('a changed date closes the reminders sent for the old one', async () => {
      const { bidId } = await service.ingestEmail(await storeEmail());
      const key = `bid-desk:remind:${bidId}:7d:2026-10-21T03:59:00.000Z`;
      await mockPg('notifications').insert({ recipient_type: 'admin', category: 'lead', title: 't', body: 'b', metadata: JSON.stringify({ dedupeKey: key }) });
      expect((await call('PATCH', `/${bidId}`, { due_at: '2026-10-28T14:00', expected_updated_at: await version(bidId) })).status).toBe(200);
      const row = await mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key]).first('metadata');
      expect(row.metadata.autoCleared).toBe(true);
    });

    test('the backfill attaching an old addendum to a live open bid rings nothing', async () => {
      const first = await storeEmail();
      const { bidId } = await service.ingestEmail(first);
      raiseAdminAlert.mockClear();
      const out = await service.ingestEmail(await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', received_at: new Date(NOW.getTime() - 30000) }), { historical: true });
      expect(out).toMatchObject({ bidId, created: false, kind: 'addendum' });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });
  });

  describe('packages', () => {
    test('two packages of one project are two bids; a later email naming no package joins the only bid', async () => {
      const termite = await service.ingestEmail(await storeEmail({ body_text: BC_BODY().replace(': Pest Control', ': Termite Treatment') }));
      const access = await service.ingestEmail(await storeEmail({ body_text: BC_BODY().replace(': Pest Control', ': Access Control') }));
      expect(access.bidId).not.toBe(termite.bidId);
      // With two bids on the project, an email with no package is not guessed into either.
      const bare = BC_BODY().replace(': Pest Control', '');
      expect((await service.ingestEmail(await storeEmail({ body_text: bare }))).created).toBe(true);
    });

    test('with one bid on the project, an email naming no package joins it', async () => {
      const only = await service.ingestEmail(await storeEmail());
      const bare = BC_BODY().replace(': Pest Control', '');
      expect(await service.ingestEmail(await storeEmail({ body_text: bare }))).toMatchObject({ bidId: only.bidId, created: false });
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
      // A date save without the version the page showed is refused.
      expect((await call('PATCH', `/${bidId}`, { due_at: '2026-10-28T14:00' })).status).toBe(409);
      const typed = await call('PATCH', `/${bidId}`, { due_at: '2026-10-28T14:00', expected_updated_at: await version(bidId) });
      expect(typed.status).toBe(200);
      const row = await bidRow(bidId);
      expect(row.due_at.toISOString()).toBe('2026-10-28T18:00:00.000Z');
      // The typed date is not the email's date: the email line no longer describes it.
      expect(row).toMatchObject({ due_confirmed: true, needs_date_confirmation: false, reminder_7d_sent_at: null, reminder_2d_sent_at: null, due_source_line: null });
      await call('PATCH', `/${bidId}`, { due_at: null, expected_updated_at: await version(bidId) });
      expect(await bidRow(bidId)).toMatchObject({ due_at: null, due_confirmed: false, due_source_line: null });
      // Only one real Eastern clock reading is accepted.
      for (const bad of ['2026-02-30T10:00', '2026-10-05T24:00', '2026-10-05T99:99', '2026-03-08T02:30', '2026-11-01T01:30']) {
        expect((await call('PATCH', `/${bidId}`, { due_at: bad, expected_updated_at: await version(bidId) })).status).toBe(400);
      }
      expect((await call('PATCH', `/${bidId}`, { due_at: '2026-11-01T03:30', expected_updated_at: await version(bidId) })).status).toBe(200);
    });

    test('confirm_due confirms the date as read; with no date it is refused', async () => {
      const { bidId } = await filed();
      // The page sends the version it showed; a bid changed since then (an addendum filed) is refused.
      const seen = await version(bidId);
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true })).status).toBe(409);
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true, expected_updated_at: '2026-01-01T00:00:00.000Z' })).status).toBe(409);
      expect(await bidRow(bidId)).toMatchObject({ due_confirmed: false });
      // A second addendum on an already-flagged bid changes no field but still moves the version.
      await mockPg('bid_opportunities').where({ id: bidId }).update({ needs_date_confirmation: true });
      const flagged = (await call('GET', `/${bidId}`)).body.bid.updated_at;
      await service.ingestEmail(await storeEmail({ gmail_thread_id: (await bidRow(bidId)).gmail_thread_id, subject: 'Addendum 2', body_text: 'See the portal.', received_at: new Date(NOW.getTime() - 20000) }));
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true, expected_updated_at: flagged })).status).toBe(409);
      const current = (await call('GET', `/${bidId}`)).body.bid.updated_at;
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true, expected_updated_at: current })).status).toBe(200);
      expect(seen).toBeTruthy();
      expect(await bidRow(bidId)).toMatchObject({ due_confirmed: true, needs_date_confirmation: false });
      await mockPg('bid_opportunities').where({ id: bidId }).update({ due_at: null, due_confirmed: false });
      expect((await call('PATCH', `/${bidId}`, { confirm_due: true, expected_updated_at: await version(bidId) })).status).toBe(400);
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
