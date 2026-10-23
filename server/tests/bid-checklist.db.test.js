// Bid Desk checklist (GATE_BID_CHECKLIST) through PostgreSQL: the migration (down, up, up again), the new bid fields, the
// estimate link, the documents, the checklist routes, and the 14-day, questions and job-walk reminders with their
// invariants. Every write runs in a transaction that is rolled back. Synthetic senders, projects and files only.
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
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = global.__actorId || 'actor-1'; next(); },
  requireAdmin: (req, res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261023130000_bid_desk_checklist');
const service = require('../services/bid-desk');
const { raiseAdminAlertWithReopen } = require('../services/admin-alert-episodes');
const { templateRows } = require('../../shared/bid-checklist-templates.cjs');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let server;
let baseUrl;

const NOW = new Date('2026-10-01T14:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const BC_BODY = [
  'Fixture Build Co has invited you to bid on Sample Ridge Residences: Pest Control',
  'Location: 100 Fixture Way, Sampleville, FL 34000',
  'Bid Due: October 20, 2026',
  'Lead: Pat Sample | pat.sample@fixture-gc.example',
].join('\n');

describeDb('Bid Desk checklist (PostgreSQL)', () => {
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
    process.env.GATE_BID_CHECKLIST = 'true';
    delete global.__actorId;
    raiseAdminAlertWithReopen.mockReset();
    raiseAdminAlertWithReopen.mockImplementation(async (_category, headline, why) => { expect(headline.length).toBeGreaterThan(0); expect(why.length).toBeGreaterThan(0); return { id: randomUUID(), deduped: false, rang: true }; });
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_BID_DESK;
    delete process.env.GATE_BID_CHECKLIST;
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  async function storeEmail(over = {}) {
    const id = over.id || randomUUID();
    await mockPg('emails').insert({
      id, gmail_id: `g-${id}`, gmail_thread_id: `t-${id}`, from_address: 'invites@buildingconnected.com', from_name: 'Fixture Build Co via BuildingConnected',
      subject: `Fixture Build Co has invited you to bid on Sample Ridge ${id.slice(0, 6)}`, body_text: BC_BODY, received_at: new Date(NOW.getTime() - 60000), ...over,
      created_at: over.created_at || over.received_at || new Date(NOW.getTime() - 60000),
      classification: 'other',
      authentication_results: 'mx.google.com; dkim=pass header.i=@buildingconnected.com',
    });
    return mockPg('emails').where({ id }).first();
  }
  async function newBid(over = {}) {
    const { bidId } = await service.ingestEmail(await storeEmail({ body_text: 'x', subject: `RFP ${randomUUID()}` }));
    if (Object.keys(over).length) await mockPg('bid_opportunities').where({ id: bidId }).update(over);
    return bidId;
  }
  const bidRow = (id) => mockPg('bid_opportunities').where({ id }).first();
  const items = (bidId) => mockPg('bid_checklist_items').where({ bid_id: bidId }).orderBy('position');
  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}/api/admin/bid-desk${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const rungKeys = () => raiseAdminAlertWithReopen.mock.calls.map(([, , , opts]) => opts.dedupeKey);
  const estimate = async (over = {}) => {
    const [row] = await mockPg('estimates').insert({ customer_name: 'Fixture Build Co', estimate_slug: `EST-${Math.floor(Math.random() * 1e6)}`, ...over }).returning('*');
    return row;
  };

  describe('migration', () => {
    test('down removes the table and every column, up restores them, and a second up changes nothing', async () => {
      const columns = ['solicitation_type', 'scored', 'job_walk_mandatory', 'job_walk_confirmed', 'estimate_id', 'submitted_at', 'submission_confirmation',
        'reminder_14d_sent_at', 'questions_reminder_sent_at', 'job_walk_reminder_sent_at'];
      await migration.down(mockPg);
      expect(await mockPg.schema.hasTable('bid_checklist_items')).toBe(false);
      for (const column of columns) expect(await mockPg.schema.hasColumn('bid_opportunities', column)).toBe(false);
      await migration.down(mockPg); // idempotent in both directions
      await migration.up(mockPg);
      await migration.up(mockPg);
      expect(await mockPg.schema.hasTable('bid_checklist_items')).toBe(true);
      for (const column of columns) expect(await mockPg.schema.hasColumn('bid_opportunities', column)).toBe(true);
    });

    test('the type is checked by the database, the walk flag defaults to false, and the foreign keys behave', async () => {
      const bidId = await newBid();
      await expect(mockPg.transaction((t) => t('bid_opportunities').where({ id: bidId }).update({ solicitation_type: 'carrier_pigeon' }))).rejects.toThrow(/solicitation_type_check/);
      for (const type of migration.TYPES) await mockPg('bid_opportunities').where({ id: bidId }).update({ solicitation_type: type });
      expect(await bidRow(bidId)).toMatchObject({ job_walk_mandatory: false, job_walk_confirmed: false, scored: null, estimate_id: null, submitted_at: null });
      const est = await estimate();
      await mockPg('bid_opportunities').where({ id: bidId }).update({ estimate_id: est.id });
      await mockPg('bid_checklist_items').insert({ bid_id: bidId, position: 1, section: 'custom', label: 'Line' });
      // Deleting the estimate leaves the bid (the link is cleared); deleting the bid takes its lines with it.
      await mockPg('estimates').where({ id: est.id }).del();
      expect((await bidRow(bidId)).estimate_id).toBeNull();
      await mockPg('bid_opportunities').where({ id: bidId }).del();
      expect(await items(bidId)).toHaveLength(0);
    });
  });

  describe('gate off', () => {
    beforeEach(() => { delete process.env.GATE_BID_CHECKLIST; });

    test('the new fields are refused, the checklist routes answer 404, and the replies carry no new keys', async () => {
      const bidId = await newBid();
      const before = await bidRow(bidId);
      expect((await call('PATCH', `/${bidId}`, { solicitationType: 'rfp' })).status).toBe(400);
      expect((await call('PATCH', `/${bidId}`, { jobWalkMandatory: true })).status).toBe(400);
      expect((await call('POST', `/${bidId}/checklist/start`, {})).status).toBe(404);
      expect((await call('GET', '/estimates?q=Fixture')).status).toBe(404);
      expect(await items(bidId)).toHaveLength(0);
      const detail = await call('GET', `/${bidId}`);
      expect(Object.keys(detail.body).sort()).toEqual(['bid', 'emails']);
      for (const key of ['solicitation_type', 'scored', 'estimate_id', 'submitted_at', 'checklist_progress']) expect(detail.body.bid).not.toHaveProperty(key);
      const list = await call('GET', '/');
      expect(list.body).not.toHaveProperty('checklist_live');
      expect(list.body.bids[0]).not.toHaveProperty('checklist_progress');
      expect(await bidRow(bidId)).toEqual(before);
    });

    test('the original fields still save, and a changed walk or questions date still clears its stamp', async () => {
      const bidId = await newBid({ job_walk_reminder_sent_at: NOW, questions_reminder_sent_at: NOW });
      const res = await call('PATCH', `/${bidId}`, { job_walk_at: '2026-10-10T09:00', questions_due_at: '2026-10-08T17:00', decision_note: 'x' });
      expect(res.status).toBe(200);
      expect(await bidRow(bidId)).toMatchObject({ job_walk_reminder_sent_at: null, questions_reminder_sent_at: null });
    });

    test('only the 7-day and 2-day reminders fire, and the date reminders do not', async () => {
      await newBid({ due_at: new Date(NOW.getTime() + 10 * DAY), due_confirmed: true, questions_due_at: new Date(NOW.getTime() + 1 * DAY), job_walk_at: new Date(NOW.getTime() + 1 * DAY) });
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      expect(raiseAdminAlertWithReopen).not.toHaveBeenCalled();
      const soon = await newBid({ due_at: new Date(NOW.getTime() + 6 * DAY), due_confirmed: true });
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect(rungKeys()).toEqual([`bid-desk:remind:${soon}:7d:${(await bidRow(soon)).due_at.toISOString()}`]);
    });
  });

  describe('bid fields', () => {
    test('type, scoring, dates, walk flag, submission record and estimate save, and the detail carries them', async () => {
      const bidId = await newBid();
      const est = await estimate({ estimate_slug: 'EST-1001' });
      const res = await call('PATCH', `/${bidId}`, {
        solicitationType: 'itb', scored: false, questionsDueAt: '2026-10-08T17:00', jobWalkAt: '2026-10-09T09:30', jobWalkMandatory: true,
        estimateId: est.id, submittedAt: '2026-10-19T15:45', submissionConfirmation: ' Receipt 55 ',
      });
      expect(res.status).toBe(200);
      const row = await bidRow(bidId);
      expect(row).toMatchObject({ solicitation_type: 'itb', scored: false, job_walk_mandatory: true, job_walk_confirmed: true, estimate_id: est.id, submission_confirmation: 'Receipt 55' });
      expect(row.questions_due_at.toISOString()).toBe('2026-10-08T21:00:00.000Z'); // 17:00 ET (EDT)
      expect(row.job_walk_at.toISOString()).toBe('2026-10-09T13:30:00.000Z');
      expect(row.submitted_at.toISOString()).toBe('2026-10-19T19:45:00.000Z');
      const detail = (await call('GET', `/${bidId}`)).body;
      expect(detail.checklist_live).toBe(true);
      expect(detail.bid).toMatchObject({ solicitation_type: 'itb', scored: false, estimate_id: est.id });
      expect(detail.estimate).toEqual({ id: est.id, slug: 'EST-1001', name: 'Fixture Build Co', status: 'draft', proposal_path: `/admin/estimates/${est.id}/proposal` });
      // null clears.
      expect((await call('PATCH', `/${bidId}`, { solicitationType: null, scored: null, estimateId: null, submittedAt: null, submissionConfirmation: '' })).status).toBe(200);
      expect(await bidRow(bidId)).toMatchObject({ solicitation_type: null, scored: null, estimate_id: null, submitted_at: null, submission_confirmation: null });
      expect((await call('GET', `/${bidId}`)).body.estimate).toBeNull();
    });

    test('an estimate that does not exist is refused and nothing else in the request is saved', async () => {
      const bidId = await newBid();
      const res = await call('PATCH', `/${bidId}`, { estimateId: randomUUID(), solicitationType: 'rfp' });
      expect(res.status).toBe(400);
      expect(await bidRow(bidId)).toMatchObject({ estimate_id: null, solicitation_type: null });
    });

    test('setting the status to submitted needs none of the submission fields', async () => {
      const bidId = await newBid();
      expect((await call('PATCH', `/${bidId}`, { status: 'submitted' })).status).toBe(200);
      expect(await bidRow(bidId)).toMatchObject({ status: 'submitted', submitted_at: null, submission_confirmation: null });
    });

    test('the estimate search finds by number or customer name and links to the proposal page', async () => {
      const est = await estimate({ estimate_slug: 'EST-7777', customer_name: 'Sample HOA' });
      await estimate({ estimate_slug: 'EST-8888', customer_name: 'Other Fixture', archived_at: new Date() });
      const bySlug = (await call('GET', '/estimates?q=EST-7777')).body.estimates;
      expect(bySlug).toEqual([{ id: est.id, slug: 'EST-7777', name: 'Sample HOA', status: 'draft', proposal_path: `/admin/estimates/${est.id}/proposal` }]);
      expect((await call('GET', '/estimates?q=sample%20hoa')).body.estimates.map((e) => e.id)).toEqual([est.id]);
      expect((await call('GET', `/estimates?q=${est.id}`)).body.estimates.map((e) => e.id)).toEqual([est.id]);
      expect((await call('GET', '/estimates?q=EST-8888')).body.estimates).toEqual([]); // archived
      expect((await call('GET', '/estimates?q=%25')).body.estimates).toEqual([]); // a wildcard is a plain character
    });

    test('the list adds checklist progress per bid', async () => {
      const bidId = await newBid();
      await call('POST', `/${bidId}/checklist/start`, { type: 'quote' });
      const [first] = await items(bidId);
      await call('PATCH', `/${bidId}/checklist/${first.id}`, { checked: true });
      const list = (await call('GET', '/')).body;
      expect(list.checklist_live).toBe(true);
      expect(list.bids.find((b) => b.id === bidId).checklist_progress).toEqual({ checked: 1, required: 13 });
    });
  });

  describe('documents', () => {
    test('the list is the attachments of every email on the bid, by reference, in order', async () => {
      const first = await storeEmail({ received_at: new Date(NOW.getTime() - 120000) });
      const { bidId } = await service.ingestEmail(first);
      const second = await storeEmail({ gmail_thread_id: first.gmail_thread_id, subject: 'Addendum 1', body_text: 'x', received_at: new Date(NOW.getTime() - 60000) });
      await service.ingestEmail(second);
      const stranger = await storeEmail({ subject: 'Unrelated', body_text: 'x' });
      await mockPg('email_attachments').insert([
        { email_id: second.id, gmail_attachment_id: 'g-2', filename: 'addendum-1.pdf', mime_type: 'application/pdf', size_bytes: 20480 },
        { email_id: first.id, gmail_attachment_id: 'g-1', filename: 'bid-form.pdf', mime_type: 'application/pdf', size_bytes: 1024 },
        { email_id: first.id, gmail_attachment_id: null, filename: 'no-download.txt', mime_type: 'text/plain', size_bytes: null },
        { email_id: stranger.id, gmail_attachment_id: 'g-9', filename: 'not-this-bid.pdf', mime_type: 'application/pdf', size_bytes: 5 },
      ]);
      const { documents } = (await call('GET', `/${bidId}`)).body;
      expect(documents.map((d) => d.name).sort()).toEqual(['addendum-1.pdf', 'bid-form.pdf', 'no-download.txt']);
      expect(documents.map((d) => d.email_id)).toEqual([first.id, first.id, second.id]); // oldest email first
      const form = documents.find((d) => d.name === 'bid-form.pdf');
      expect(form).toMatchObject({ size: 1024, mime_type: 'application/pdf', email_id: first.id, email_subject: first.subject, download_path: `/admin/email/message/${first.id}/attachment/g-1` });
      expect(documents.find((d) => d.name === 'no-download.txt')).toMatchObject({ size: null, download_path: null });
    });

    test('a bid with no attachments has an empty list', async () => {
      expect((await call('GET', `/${await newBid()}`)).body.documents).toEqual([]);
    });
  });

  describe('checklist', () => {
    test('start copies the template for the type once; pressing it again changes nothing', async () => {
      const bidId = await newBid();
      const first = await call('POST', `/${bidId}/checklist/start`, { type: 'itb' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ added: 15, existing: 0, type: 'itb' });
      expect(first.body.checklist_progress).toEqual({ checked: 0, required: 15, total: 15 });
      const rows = await items(bidId);
      expect(rows.map((r) => r.template_key)).toEqual(templateRows('itb').map((r) => r.template_key));
      expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i + 1));
      expect((await bidRow(bidId)).solicitation_type).toBe('itb');
      const again = await call('POST', `/${bidId}/checklist/start`, { type: 'itb' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ added: 0, existing: 15 });
      expect(await items(bidId)).toHaveLength(15);
    });

    test('start with no type body uses the bid\'s saved type, else the base list', async () => {
      const typed = await newBid({ solicitation_type: 'federal' });
      expect((await call('POST', `/${typed}/checklist/start`, {})).body.added).toBe(14);
      const untyped = await newBid();
      expect((await call('POST', `/${untyped}/checklist/start`)).body.added).toBe(10);
      expect((await bidRow(untyped)).solicitation_type).toBeNull();
      expect((await call('POST', `/${randomUUID()}/checklist/start`, {})).status).toBe(404);
    });

    test('add=missing adds only the lines the bid lacks, and never brings back one the operator removed', async () => {
      const bidId = await newBid();
      await call('POST', `/${bidId}/checklist/start`, {});
      const custom = (await call('POST', `/${bidId}/checklist`, { label: 'Bring the lift permit', sourceText: 'Page 9, item 4' })).body.item;
      const [removed] = await items(bidId);
      await call('DELETE', `/${bidId}/checklist/${removed.id}`);
      // The type changes to RFP: its five lines are missing, the base lines are carried (the archived one too).
      await call('PATCH', `/${bidId}`, { solicitationType: 'rfp' });
      const res = await call('POST', `/${bidId}/checklist/start?add=missing`, {});
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ added: 5, type: 'rfp' });
      const keys = (await items(bidId)).map((r) => r.template_key);
      expect(keys.filter((k) => k && k.startsWith('rfp.'))).toHaveLength(5);
      expect(keys.filter((k) => k === removed.template_key)).toHaveLength(1); // still the one archived row
      expect((await mockPg('bid_checklist_items').where({ id: removed.id }).first()).archived_at).not.toBeNull();
      // Positions keep growing past the custom line, and a second add=missing adds nothing.
      const last = (await items(bidId)).at(-1);
      expect(last.position).toBeGreaterThan(custom.position);
      expect((await call('POST', `/${bidId}/checklist/start?add=missing`, {})).body.added).toBe(0);
    });

    test('tick stamps the time and the person, untick clears both, and progress counts required lines only', async () => {
      const bidId = await newBid();
      await call('POST', `/${bidId}/checklist/start`, {});
      const staff = randomUUID();
      global.__actorId = staff;
      const [first, second] = await items(bidId);
      const ticked = await call('PATCH', `/${bidId}/checklist/${first.id}`, { checked: true });
      expect(ticked.status).toBe(200);
      expect(ticked.body.item).toMatchObject({ id: first.id, checked_by: staff });
      expect(ticked.body.item.checked_at).toEqual(expect.any(String));
      expect(ticked.body.checklist_progress).toEqual({ checked: 1, required: 10, total: 10 });
      // An optional line does not move the count.
      await call('PATCH', `/${bidId}/checklist/${second.id}`, { required: false });
      const optionalTick = await call('PATCH', `/${bidId}/checklist/${second.id}`, { checked: true });
      expect(optionalTick.body.checklist_progress).toEqual({ checked: 1, required: 9, total: 10 });
      const unticked = await call('PATCH', `/${bidId}/checklist/${first.id}`, { checked: false });
      expect(unticked.body.item).toMatchObject({ checked_at: null, checked_by: null });
      expect(unticked.body.checklist_progress.checked).toBe(0);
    });

    test('a tick by a signed-in person whose id is not a staff uuid still saves, with no checked_by', async () => {
      const bidId = await newBid();
      await call('POST', `/${bidId}/checklist/start`, {});
      const [first] = await items(bidId);
      expect((await call('PATCH', `/${bidId}/checklist/${first.id}`, { checked: true })).body.item).toMatchObject({ checked_by: null });
    });

    test('custom lines carry the cite from the solicitation; edit, notes and archive work; another bid\'s line is not reachable', async () => {
      const bidId = await newBid();
      const other = await newBid();
      const added = await call('POST', `/${bidId}/checklist`, { label: ' Two copies of the bid form ', sourceText: 'Instructions to Bidders, page 3', notes: 'Ask the buyer' });
      expect(added.status).toBe(201);
      expect(added.body.item).toMatchObject({ section: 'custom', template_key: null, label: 'Two copies of the bid form', source_text: 'Instructions to Bidders, page 3', required: true, position: 1 });
      const id = added.body.item.id;
      const edited = await call('PATCH', `/${bidId}/checklist/${id}`, { label: 'Three copies', sourceText: '', notes: 'Done by Pat' });
      expect(edited.body.item).toMatchObject({ label: 'Three copies', source_text: null, notes: 'Done by Pat' });
      expect((await call('PATCH', `/${other}/checklist/${id}`, { checked: true })).status).toBe(404);
      expect((await call('DELETE', `/${other}/checklist/${id}`)).status).toBe(404);
      const archived = await call('DELETE', `/${bidId}/checklist/${id}`);
      expect(archived.status).toBe(200);
      expect(archived.body.checklist_progress).toEqual({ checked: 0, required: 0, total: 0 });
      expect((await call('GET', `/${bidId}`)).body.checklist).toEqual([]);
      expect((await mockPg('bid_checklist_items').where({ id }).first()).archived_at).not.toBeNull();
      expect((await call('PATCH', `/${bidId}/checklist/${id}`, { checked: true })).status).toBe(404); // archived = gone
    });

    test('reorder takes exactly the live lines; a stale or partial list is refused', async () => {
      const bidId = await newBid();
      await call('POST', `/${bidId}/checklist/start`, { type: 'quote' });
      const ids = (await items(bidId)).map((r) => r.id);
      const reversed = [...ids].reverse();
      const ok = await call('POST', `/${bidId}/checklist/reorder`, { ids: reversed });
      expect(ok.status).toBe(200);
      expect(ok.body.checklist.map((r) => r.id)).toEqual(reversed);
      expect((await call('POST', `/${bidId}/checklist/reorder`, { ids: ids.slice(1) })).status).toBe(409);
      expect((await call('POST', `/${bidId}/checklist/reorder`, { ids: [...ids.slice(1), ids[1]] })).status).toBe(409);
      expect((await call('POST', `/${bidId}/checklist/reorder`, { ids: [...ids.slice(1), randomUUID()] })).status).toBe(409);
      expect((await items(bidId)).map((r) => r.id)).toEqual(reversed);
    });

    test('the detail returns the live lines in order with progress', async () => {
      const bidId = await newBid();
      await call('POST', `/${bidId}/checklist/start`, { type: 'quote' });
      const detail = (await call('GET', `/${bidId}`)).body;
      expect(detail.checklist).toHaveLength(13);
      expect(detail.checklist[0]).toMatchObject({ section: 'base', template_key: 'base.bid_form' });
      expect(detail.checklist_progress).toEqual({ checked: 0, required: 13, total: 13 });
    });
  });

  describe('reminders', () => {
    const at = (days) => new Date(NOW.getTime() + days * DAY);
    const stampOf = async (id, column) => (await bidRow(id))[column];

    test('14 days before a confirmed due date: once, before the 7-day and 2-day ones, which still follow', async () => {
      const id = await newBid({ due_at: at(10), due_confirmed: true });
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      const due = (await bidRow(id)).due_at.toISOString();
      expect(rungKeys()).toEqual([`bid-desk:remind:${id}:14d:${due}`]);
      expect(await bidRow(id)).toMatchObject({ reminder_14d_sent_at: expect.any(Date), reminder_7d_sent_at: null, reminder_2d_sent_at: null });
      expect(await service.sendDueReminders({ now: at(4) })).toBe(1); // 6 days left
      expect(await service.sendDueReminders({ now: at(8.5) })).toBe(1); // 1.5 days left
      expect(await service.sendDueReminders({ now: at(8.5) })).toBe(0);
      expect(rungKeys().map((k) => k.split(':')[3])).toEqual(['14d', '7d', '2d']);
    });

    test('a bid first confirmed inside 7 days gets no late 14-day reminder', async () => {
      const id = await newBid({ due_at: at(6), due_confirmed: true });
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect(rungKeys().map((k) => k.split(':')[3])).toEqual(['7d']);
      expect((await bidRow(id)).reminder_14d_sent_at).toBeNull();
    });

    test('an unconfirmed, flagged, historical or decided bid gets none of the three kinds', async () => {
      const soon = { questions_due_at: at(1), job_walk_at: at(1), job_walk_confirmed: true };
      await newBid({ due_at: at(10), due_confirmed: false, ...soon });
      await newBid({ due_at: at(10), due_confirmed: true, needs_date_confirmation: true, ...soon });
      await newBid({ due_at: at(10), due_confirmed: true, historical: true, ...soon });
      await newBid({ due_at: at(10), due_confirmed: true, status: 'no_bid', ...soon });
      await newBid({ due_at: at(10), due_confirmed: true, status: 'submitted', ...soon });
      await newBid({ due_at: at(10), due_confirmed: true, source_active: false, ...soon });
      // The unconfirmed bid still has dates of its own, but a flagged, historical, decided or closed bid is silent;
      // the first bid is the only one whose date reminders may ring (its due date is not confirmed, theirs are).
      const rang = await service.sendDueReminders({ now: NOW });
      expect(rungKeys().filter((k) => k.includes(':remind:'))).toEqual([]);
      expect(rang).toBe(2); // the unconfirmed bid's questions and job walk
      expect(rungKeys().every((k) => k.startsWith('bid-desk:remind-questions:') || k.startsWith('bid-desk:remind-jobwalk:'))).toBe(true);
    });

    test('questions: once, 2 days before, with the date in the key; not earlier, not after', async () => {
      const id = await newBid({ questions_due_at: at(3) });
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      expect(await service.sendDueReminders({ now: at(1.2) })).toBe(1);
      expect(await service.sendDueReminders({ now: at(1.2) })).toBe(0);
      expect(rungKeys()).toEqual([`bid-desk:remind-questions:${id}:${(await bidRow(id)).questions_due_at.toISOString()}`]);
      expect(await stampOf(id, 'questions_reminder_sent_at')).toEqual(expect.any(Date));
      expect(await stampOf(id, 'job_walk_reminder_sent_at')).toBeNull();
      const past = await newBid({ questions_due_at: at(-1) });
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      expect((await bidRow(past)).questions_reminder_sent_at).toBeNull();
    });

    test('job walk: once, 2 days before; the copy says mandatory only for a mandatory walk', async () => {
      const mandatory = await newBid({ job_walk_at: at(1.5), job_walk_confirmed: true, job_walk_mandatory: true });
      const optional = await newBid({ job_walk_at: at(1.5), job_walk_confirmed: true });
      expect(await service.sendDueReminders({ now: NOW })).toBe(2);
      expect(await service.sendDueReminders({ now: NOW })).toBe(0);
      const byBid = Object.fromEntries(raiseAdminAlertWithReopen.mock.calls.map(([, headline, , opts]) => [opts.metadata.bidId, { headline, key: opts.dedupeKey, detail: opts.detail }]));
      expect(byBid[mandatory].headline).toMatch(/mandatory job walk/i);
      expect(byBid[mandatory].detail).toMatch(/mandatory job walk/);
      expect(byBid[optional].headline).toMatch(/job walk/i);
      expect(byBid[optional].headline).not.toMatch(/mandatory/i);
      expect(byBid[optional].key).toBe(`bid-desk:remind-jobwalk:${optional}:${(await bidRow(optional)).job_walk_at.toISOString()}`);
    });

    test('changing a date clears its stamp (and only its stamp) so the new date reminds once more', async () => {
      const id = await newBid({ due_at: at(10), due_confirmed: true, questions_due_at: at(1), job_walk_at: at(1), job_walk_confirmed: true });
      expect(await service.sendDueReminders({ now: NOW })).toBe(3);
      expect(await bidRow(id)).toMatchObject({ reminder_14d_sent_at: expect.any(Date), questions_reminder_sent_at: expect.any(Date), job_walk_reminder_sent_at: expect.any(Date) });

      // The same value again changes no stamp.
      const sameQuestions = (await bidRow(id)).questions_due_at;
      const wall = (date) => new Date(date.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 16); // ET wall time in October
      expect((await call('PATCH', `/${id}`, { questionsDueAt: wall(sameQuestions) })).status).toBe(200);
      expect(await stampOf(id, 'questions_reminder_sent_at')).toEqual(expect.any(Date));

      // A new questions date clears the questions stamp only.
      expect((await call('PATCH', `/${id}`, { questionsDueAt: wall(at(1.5)) })).status).toBe(200);
      expect(await bidRow(id)).toMatchObject({ questions_reminder_sent_at: null, job_walk_reminder_sent_at: expect.any(Date), reminder_14d_sent_at: expect.any(Date) });
      raiseAdminAlertWithReopen.mockClear();
      expect(await service.sendDueReminders({ now: NOW })).toBe(1);
      expect(rungKeys()).toEqual([`bid-desk:remind-questions:${id}:${(await bidRow(id)).questions_due_at.toISOString()}`]);

      // A new job-walk date, then a new due date.
      expect((await call('PATCH', `/${id}`, { jobWalkAt: wall(at(1.6)) })).status).toBe(200);
      expect(await stampOf(id, 'job_walk_reminder_sent_at')).toBeNull();
      const version = (await call('GET', `/${id}`)).body.bid.updated_at;
      expect((await call('PATCH', `/${id}`, { due_at: wall(at(12)), expected_updated_at: version })).status).toBe(200);
      expect(await bidRow(id)).toMatchObject({ reminder_14d_sent_at: null, reminder_7d_sent_at: null, reminder_2d_sent_at: null });
      raiseAdminAlertWithReopen.mockClear();
      expect(await service.sendDueReminders({ now: NOW })).toBe(2); // the job walk and the 14-day reminder for the new date
      expect(rungKeys().map((k) => k.split(':').slice(0, 2).join(':')).sort()).toEqual(['bid-desk:remind', 'bid-desk:remind-jobwalk']);
    });

    describe('the site-visit date confirmation', () => {
      const wall = (date) => new Date(date.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 16); // ET wall time in October

      test('a job-walk date read from a template is not confirmed and never reminds; confirming it reminds once', async () => {
        // The invite carries "Job Walk: October 2, 2026" (read as a date with no time, stored at 23:59 ET).
        const { bidId } = await service.ingestEmail(await storeEmail({ body_text: BC_BODY.replace('Bid Due:', 'Job Walk: October 2, 2026\nBid Due:') }));
        const read = await bidRow(bidId);
        expect(read.job_walk_at).not.toBeNull();
        expect(read.job_walk_confirmed).toBe(false);
        const now = new Date(read.job_walk_at.getTime() - 1.5 * DAY);
        expect(await service.sendDueReminders({ now })).toBe(0);
        expect(raiseAdminAlertWithReopen).not.toHaveBeenCalled();
        const confirmed = await call('PATCH', `/${bidId}`, { jobWalkConfirmed: true });
        expect(confirmed.status).toBe(200);
        expect(await bidRow(bidId)).toMatchObject({ job_walk_confirmed: true });
        expect((await bidRow(bidId)).job_walk_at.toISOString()).toBe(read.job_walk_at.toISOString());
        expect(await service.sendDueReminders({ now })).toBe(1);
        expect(await service.sendDueReminders({ now })).toBe(0);
        expect(rungKeys()).toEqual([`bid-desk:remind-jobwalk:${bidId}:${read.job_walk_at.toISOString()}`]);
      });

      test('retyping the date keeps it confirmed; clearing it resets, and a confirmation needs a date', async () => {
        const id = await newBid({ job_walk_at: at(5), job_walk_confirmed: false });
        expect((await call('PATCH', `/${id}`, { jobWalkAt: wall(at(6)) })).status).toBe(200);
        expect((await bidRow(id)).job_walk_confirmed).toBe(true);
        expect((await call('PATCH', `/${id}`, { jobWalkAt: wall(at(7)) })).status).toBe(200);
        expect((await bidRow(id)).job_walk_confirmed).toBe(true);
        expect((await call('PATCH', `/${id}`, { jobWalkAt: null })).status).toBe(200);
        expect(await bidRow(id)).toMatchObject({ job_walk_at: null, job_walk_confirmed: false });
        const refused = await call('PATCH', `/${id}`, { jobWalkConfirmed: true });
        expect(refused.status).toBe(400);
        expect((await bidRow(id)).job_walk_confirmed).toBe(false);
      });

      test('the gate off refuses jobWalkConfirmed and leaves the flag alone', async () => {
        const id = await newBid({ job_walk_at: at(2), job_walk_confirmed: false });
        delete process.env.GATE_BID_CHECKLIST;
        expect((await call('PATCH', `/${id}`, { jobWalkConfirmed: true })).status).toBe(400);
        expect((await bidRow(id)).job_walk_confirmed).toBe(false);
        expect((await call('GET', `/${id}`)).body.bid).not.toHaveProperty('job_walk_confirmed');
      });
    });

    test('clearing a date retires its reminder, and a decision closes them all', async () => {
      const id = await newBid({ due_at: at(10), due_confirmed: true, questions_due_at: at(1), job_walk_at: at(1), job_walk_confirmed: true });
      const dueIso = (await bidRow(id)).due_at.toISOString();
      const keys = {
        questions: `bid-desk:remind-questions:${id}:${(await bidRow(id)).questions_due_at.toISOString()}`,
        walk: `bid-desk:remind-jobwalk:${id}:${(await bidRow(id)).job_walk_at.toISOString()}`,
        due: `bid-desk:remind:${id}:14d:${dueIso}`,
      };
      for (const key of Object.values(keys)) await mockPg('notifications').insert({ recipient_type: 'admin', category: 'lead', title: 't', body: 'b', metadata: JSON.stringify({ dedupeKey: key }) });
      const cleared = async (key) => (await mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key]).first('metadata')).metadata.autoCleared === true;
      expect((await call('PATCH', `/${id}`, { questionsDueAt: null })).status).toBe(200);
      expect([await cleared(keys.questions), await cleared(keys.walk), await cleared(keys.due)]).toEqual([true, false, false]);
      expect((await call('PATCH', `/${id}`, { status: 'no_bid' })).status).toBe(200);
      expect([await cleared(keys.walk), await cleared(keys.due)]).toEqual([true, true]);
    });

    test('a tick of the job with the gate on runs the new reminders; with it off it does not', async () => {
      await newBid({ questions_due_at: at(1) });
      await mockPg('system_settings').where({ key: service.WATERMARK_KEY }).del();
      delete process.env.GATE_BID_CHECKLIST;
      expect((await service.runBidDeskTick({ now: NOW })).reminders).toBe(0);
      process.env.GATE_BID_CHECKLIST = 'true';
      expect((await service.runBidDeskTick({ now: NOW })).reminders).toBe(1);
    });

    test('all three reminders ring through the shared reopen path with a headline and a why', async () => {
      await newBid({ due_at: at(10), due_confirmed: true, questions_due_at: at(1), job_walk_at: at(1), job_walk_confirmed: true, job_walk_mandatory: true });
      await service.sendDueReminders({ now: NOW });
      // The mocked reopen path asserts a non-empty headline and why for each; the real composer is the one the rules test runs.
      expect(raiseAdminAlertWithReopen).toHaveBeenCalledTimes(3);
    });
  });
});
