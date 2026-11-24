// Real PostgreSQL transactions (rolled back): the production share credit (production-share.js) and its admin routes.
// Credit of each kind of completed stop, shifts, the dated settings (technician row wins, newest on or before the week),
// the preview and the owner-only settings save. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-test-admin'] || null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    req.technician = { email: req.headers['x-test-email'] || '' };
    next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-payroll');
const productionShare = require('../services/production-share');
const { staffWeekStartForWorkDate, addStaffWorkDays } = require('../utils/staff-time-work-date');
const { etDateString } = require('../utils/datetime-et');

jest.setTimeout(60000);

const W = '2026-09-14'; // Monday
const OWNER = 'contact@wavespestcontrol.com';
const day = (n) => addStaffWorkDays(W, n);
// Noon ET of a date (EDT in September).
const noon = (date) => `${date}T16:00:00Z`;

postgres('production share credit', () => {
  let database;
  let server;
  let baseUrl;
  let trx;
  let phone = 5550100;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const ADMIN_ID = randomUUID();

  const tech = async (name) => {
    const id = randomUUID();
    await trx('technicians').insert({ id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00' });
    return id;
  };
  const customer = async (patch = {}) => {
    const id = randomUUID();
    phone += 1;
    await trx('customers').insert({ id, first_name: 'Sample', phone: `+1941${phone}`, ...patch });
    return id;
  };
  // One completed stop.
  const stop = async (technicianId, customerId, date, patch = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: date, service_type: 'General Pest Control',
      status: 'completed', completed_at: noon(date), estimated_price: '100.00', ...patch,
    });
    return id;
  };
  const settings = (technicianId, fromWeek, patch = {}) => trx('production_share_settings').insert({
    technician_id: technicianId, from_week: fromWeek, rate_bps: 1500, bar_type: 'per_shift', bar_cents: 40000,
    callback_stop_value_cents: 9500, ...patch,
  });
  const credits = (technicianId, weekStart = W) => productionShare.weekCredits(trx, technicianId, weekStart);
  const byVisit = (rows, id) => rows.find((row) => row.visitId === id);
  const api = async (method, path, { body, email = OWNER } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, ...(email ? { 'x-test-email': email } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  beforeEach(async () => {
    process.env.GATE_PAYROLL = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_PAYROLL; else process.env.GATE_PAYROLL = OLD_GATE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('credit of a stop', () => {
    it('credits the price before tax of the technician\'s own completed stops, unpaid or not, by ET work date', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const c1 = await customer();
      const s1 = await stop(a, c1, day(0), { estimated_price: '60.00' });
      // 10:30 pm ET on Sunday is 02:30 UTC on Monday: still Sunday's work date, inside the week.
      const late = await stop(a, c1, day(6), { estimated_price: '40.00', completed_at: `${day(7)}T02:30:00Z` });
      await stop(a, c1, day(7), { estimated_price: '70.00' }); // next week
      await stop(a, c1, day(1), { estimated_price: '70.00', status: 'cancelled' });
      await stop(b, c1, day(1), { estimated_price: '70.00' }); // another technician
      await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: 'SAMPLE-1', customer_id: c1, scheduled_service_id: s1, total: '64.80',
        subtotal: '60.00', tax_amount: '4.80', status: 'sent',
      });
      const rows = await credits(a);
      expect(rows.map((row) => [row.workDate, row.kind, row.creditCents])).toEqual([[day(0), 'priced', 6000], [day(6), 'priced', 4000]]);
      expect(byVisit(rows, late).workDate).toBe(day(6));
      expect(productionShare.shiftDays(rows)).toEqual([day(0), day(6)]);
    });

    it('credits the stamped slice of a prepaid plan visit and exposes the refund on the term', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, token: randomUUID().slice(0, 32), invoice_number: 'SAMPLE-2', customer_id: c1, total: '400.00', status: 'paid',
        stripe_payment_intent_id: 'pi_sample_1',
      });
      const termId = randomUUID();
      await trx('annual_prepay_terms').insert({
        id: termId, customer_id: c1, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '400.00',
        prepay_invoice_id: invoiceId, coverage_visit_count: 4,
      });
      await trx('payments').insert({ customer_id: c1, payment_date: '2026-09-02', amount: '400.00', status: 'paid', stripe_payment_intent_id: 'pi_sample_1', refund_amount: '100.00' });
      const visit = await stop(a, c1, day(2), { estimated_price: '120.00', annual_prepay_term_id: termId, prepaid_amount: '90.00', prepaid_method: 'annual_prepay_invoice' });
      const row = byVisit(await credits(a), visit);
      expect(row).toMatchObject({ kind: 'prepaid_plan', creditCents: 9000, needsReview: false });
      // $100 refunded of $400: a quarter of the visit's slice.
      expect(row.refundCents).toBe(2250);
    });

    it('splits a multi-visit job price across its planned visits and ignores a cancelled follow-up', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const first = await stop(a, c1, day(0), { service_type: 'Cockroach Treatment', estimated_price: '300.00' });
      const second = await stop(a, c1, day(3), { service_type: 'Cockroach Follow-up', estimated_price: '0.00', followup_included: true, followup_source_service_id: first });
      await stop(a, c1, day(5), { service_type: 'Cockroach Follow-up', estimated_price: '0.00', followup_included: true, followup_source_service_id: first, status: 'cancelled' });
      let rows = await credits(a);
      expect([byVisit(rows, first), byVisit(rows, second)].map((row) => [row.kind, row.creditCents])).toEqual([['multi_visit_job', 15000], ['multi_visit_job', 15000]]);
      // A third planned visit (not yet done), booked from the second, makes each part a third.
      await trx('scheduled_services').insert({
        customer_id: c1, technician_id: a, scheduled_date: day(10), service_type: 'Cockroach Follow-up', status: 'pending',
        estimated_price: '0.00', followup_included: true, followup_source_service_id: second,
      });
      rows = await credits(a);
      expect([byVisit(rows, first), byVisit(rows, second)].map((row) => row.creditCents)).toEqual([10000, 10000]);
    });

    it('lists an included follow-up with no job, and a job with no price, for review at $0', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const orphan = await stop(a, c1, day(0), { service_type: 'Cockroach Follow-up', estimated_price: '0.00', followup_included: true });
      const unpricedFirst = await stop(a, c1, day(1), { service_type: 'Bed Bug Treatment', estimated_price: null });
      await stop(a, c1, day(2), { service_type: 'Bed Bug Follow-up', estimated_price: '0.00', followup_included: true, followup_source_service_id: unpricedFirst });
      const rows = await credits(a);
      expect(byVisit(rows, orphan)).toMatchObject({ creditCents: 0, needsReview: true });
      expect(byVisit(rows, unpricedFirst)).toMatchObject({ kind: 'multi_visit_job', creditCents: 0, needsReview: true });
    });

    it('pays $0 for a callback on the technician\'s own work within 30 days and the setting for another technician\'s work', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const own = await customer();
      const other = await customer();
      await stop(a, own, '2026-08-20', { estimated_price: '110.00' });
      await stop(b, other, '2026-08-20', { estimated_price: '110.00' });
      const ownCallback = await stop(a, own, day(1), { service_type: 'Pest Control Re-Service', is_callback: true, estimated_price: null });
      const otherCallback = await stop(a, other, day(2), { service_type: 'Pest Control Re-Service', is_callback: true, estimated_price: null });
      await settings(null, '2026-01-05');
      const rows = await credits(a);
      expect(byVisit(rows, ownCallback)).toMatchObject({ kind: 'callback_own', creditCents: 0, needsReview: false });
      expect(byVisit(rows, otherCallback)).toMatchObject({ kind: 'callback_other', creditCents: 9500, needsReview: false });
      // Both still count as route stops: two shifts.
      expect(productionShare.shiftDays(rows)).toEqual([day(1), day(2)]);
    });

    it('never guesses a callback up: no original, own work over 30 days, no technician, no setting all list $0 for review', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const c1 = await customer();
      const c2 = await customer();
      const c3 = await customer();
      const c4 = await customer();
      const lonely = await stop(a, c1, day(0), { service_type: 'Pest Control Re-Service', is_callback: true });
      await stop(a, c2, '2026-07-01', { estimated_price: '110.00' });
      const old = await stop(a, c2, day(1), { service_type: 'Pest Control Re-Service', is_callback: true });
      await stop(null, c3, '2026-09-01', { estimated_price: '110.00' });
      const noTech = await stop(a, c3, day(2), { service_type: 'Pest Control Re-Service', is_callback: true });
      await stop(b, c4, '2026-09-01', { estimated_price: '110.00' });
      const noSetting = await stop(a, c4, day(3), { service_type: 'Pest Control Re-Service', is_callback: true });
      const rows = await credits(a);
      for (const id of [lonely, old, noTech, noSetting]) expect(byVisit(rows, id)).toMatchObject({ creditCents: 0, needsReview: true });
      expect(byVisit(rows, noSetting).reason).toMatch(/no production share setting/);
    });

    it('credits another line\'s work in the same house as no original: the lawn visit is not the pest visit\'s original', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const c1 = await customer();
      await stop(b, c1, '2026-09-01', { service_type: 'Lawn Care Service', estimated_price: '80.00' });
      const callback = await stop(a, c1, day(0), { service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), callback)).toMatchObject({ creditCents: 0, needsReview: true });
    });

    it('credits a free assessment and an always-free visit at $0 without review, and a priced assessment at its price', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer({ billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: '89.00' });
      const free = await stop(a, c1, day(0), { service_type: 'Waves Assessment', estimated_price: null });
      const freeType = await stop(a, c1, day(1), { service_type: 'General Appointment', estimated_price: '50.00' });
      const paid = await stop(a, c1, day(2), { service_type: 'Waves Assessment', estimated_price: '75.00' });
      const rows = await credits(a);
      expect(byVisit(rows, free)).toMatchObject({ kind: 'free_assessment', creditCents: 0, needsReview: false });
      expect(byVisit(rows, freeType)).toMatchObject({ kind: 'free_visit', creditCents: 0, needsReview: false });
      expect(byVisit(rows, paid)).toMatchObject({ kind: 'priced', creditCents: 7500 });
      expect(productionShare.shiftDays(rows)).toHaveLength(3);
    });

    it('never takes a month of dues for one visit: an unpriced dues visit is $0 for review, a per-application fee is its price', async () => {
      const a = await tech('Sample Alpha');
      const member = await customer({ billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: '89.00' });
      const perApp = await customer({ billing_mode: 'per_application', per_application_fee: '65.00' });
      const dues = await stop(a, member, day(0), { estimated_price: null, is_recurring: true });
      const fee = await stop(a, perApp, day(1), { estimated_price: null });
      const zero = await stop(a, member, day(2), { estimated_price: '0.00', primary_line_price: '110.00' });
      const rows = await credits(a);
      expect(byVisit(rows, dues)).toMatchObject({ kind: 'unpriced', creditCents: 0, needsReview: true });
      expect(byVisit(rows, fee)).toMatchObject({ kind: 'priced', creditCents: 6500 });
      expect(byVisit(rows, zero)).toMatchObject({ kind: 'free_visit', creditCents: 0, needsReview: false });
    });

    it('exposes the refund on the stop\'s own invoice without changing the credit', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const visit = await stop(a, c1, day(0), { estimated_price: '100.00' });
      await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: 'SAMPLE-3', customer_id: c1, scheduled_service_id: visit, total: '100.00',
        status: 'paid', stripe_payment_intent_id: 'pi_sample_2',
      });
      await trx('payments').insert({ customer_id: c1, payment_date: '2026-09-15', amount: '100.00', status: 'paid', stripe_payment_intent_id: 'pi_sample_2', refund_amount: '30.00' });
      expect(byVisit(await credits(a), visit)).toMatchObject({ creditCents: 10000, refundCents: 3000 });
    });
  });

  describe('settings by pay week', () => {
    it('reads the newest row on or before the week, and the technician row wins over the default', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      expect(await productionShare.settingsFor(trx, a, W)).toBeNull();
      await settings(null, '2026-08-31', { rate_bps: 1000 });
      await settings(null, '2026-09-14', { rate_bps: 1200 });
      await settings(null, '2026-09-21', { rate_bps: 1900 });
      await settings(a, '2026-09-07', { rate_bps: 1500, bar_type: 'weekly', bar_cents: 300000 });
      expect(await productionShare.settingsFor(trx, b, W)).toMatchObject({ rateBps: 1200, technicianId: null, fromWeek: '2026-09-14' });
      expect(await productionShare.settingsFor(trx, b, '2026-09-07')).toMatchObject({ rateBps: 1000 });
      expect(await productionShare.settingsFor(trx, a, W)).toMatchObject({ rateBps: 1500, barType: 'weekly', barCents: 300000, technicianId: a });
      expect(await productionShare.settingsFor(trx, b, '2026-08-24')).toBeNull();
    });

    it('refuses a row that is not a Monday, a rate over 100%, or a second default for one week', async () => {
      await settings(null, '2026-09-14');
      for (const patch of [{ from_week: '2026-09-15' }, { rate_bps: 10001 }, { bar_type: 'daily' }, { bar_cents: -1 }]) {
        await trx.raw('SAVEPOINT attempt');
        await expect(trx('production_share_settings').insert({
          from_week: '2026-09-21', rate_bps: 1500, bar_type: 'weekly', bar_cents: 1, callback_stop_value_cents: 0, ...patch,
        })).rejects.toThrow();
        await trx.raw('ROLLBACK TO SAVEPOINT attempt');
      }
      await trx.raw('SAVEPOINT attempt');
      await expect(settings(null, '2026-09-14')).rejects.toThrow();
      await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    });
  });

  describe('routes', () => {
    it('previews the week: shifts, credit, bar, share and the stops to review, for the owner account only', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      await stop(a, c1, day(0), { estimated_price: '600.00' });
      await stop(a, c1, day(0), { estimated_price: '400.00' });
      await stop(a, c1, day(1), { estimated_price: '500.00' });
      await stop(a, c1, day(2), { estimated_price: null });
      await settings(null, '2026-09-07');
      const shown = await api('GET', `/production-share/preview?technicianId=${a}&weekStart=${W}`);
      expect(shown.status).toBe(200);
      expect(shown.body).toMatchObject({
        technician: { id: a, name: 'Sample Alpha' }, weekStart: W, weekEnd: day(6), shifts: 3, creditedCents: 150000,
        barCents: 120000, aboveBarCents: 30000, shareCents: 4500, configured: true,
      });
      expect(shown.body.needsReview).toHaveLength(1);
      expect(shown.body.stops).toHaveLength(4);
      expect(shown.body.settings).toMatchObject({ rateBps: 1500, barType: 'per_shift' });
      expect((await api('GET', `/production-share/preview?technicianId=${a}&weekStart=${W}`, { email: 'someone@example.com' })).status).toBe(403);
    });

    it('answers an unset week with $0 and refuses a bad technician or a week that is not a Monday', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      await stop(a, c1, day(0), { estimated_price: '5000.00' });
      expect((await api('GET', `/production-share/preview?technicianId=${a}&weekStart=${W}`)).body)
        .toMatchObject({ configured: false, shareCents: 0, creditedCents: 500000, settings: null });
      expect((await api('GET', `/production-share/preview?technicianId=${a}&weekStart=${day(1)}`)).status).toBe(400);
      expect((await api('GET', `/production-share/preview?technicianId=nope&weekStart=${W}`)).status).toBe(404);
      expect((await api('GET', `/production-share/preview?technicianId=${randomUUID()}&weekStart=${W}`)).status).toBe(404);
    });

    it('saves settings for the owner account only, audited, from this week by default, and replaces the same week', async () => {
      const a = await tech('Sample Alpha');
      const thisWeek = staffWeekStartForWorkDate(etDateString());
      const body = { technicianId: null, rateBps: 1500, barType: 'per_shift', barCents: 90000, callbackStopValueCents: 9000 };
      expect((await api('PUT', '/production-share/settings', { body, email: 'someone@example.com' })).status).toBe(403);
      const saved = await api('PUT', '/production-share/settings', { body });
      expect(saved.status).toBe(200);
      expect(saved.body.settings).toMatchObject({ technicianId: null, fromWeek: thisWeek, rateBps: 1500, barCents: 90000 });
      await api('PUT', '/production-share/settings', { body: { ...body, rateBps: 1600 } });
      const rows = await trx('production_share_settings').whereNull('technician_id');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rate_bps: 1600, created_by: ADMIN_ID });
      const own = await api('PUT', '/production-share/settings', { body: { ...body, technicianId: a, barType: 'weekly', barCents: 270000, fromWeek: addStaffWorkDays(thisWeek, 7) } });
      expect(own.body.settings).toMatchObject({ technicianId: a, barType: 'weekly' });
      const audits = await trx('audit_log').where({ action: 'payroll.production_share_settings_changed' });
      expect(audits).toHaveLength(3);
      expect(audits[0]).toMatchObject({ actor_id: ADMIN_ID });
    });

    it('refuses settings that are wrong: a rate over 100%, a bad bar, a past week, a week that is not a Monday, an unknown technician', async () => {
      const thisWeek = staffWeekStartForWorkDate(etDateString());
      const good = { technicianId: null, rateBps: 1500, barType: 'weekly', barCents: 100, callbackStopValueCents: 0 };
      const put = (patch) => api('PUT', '/production-share/settings', { body: { ...good, ...patch } });
      expect((await put({ rateBps: 10001 })).status).toBe(400);
      expect((await put({ rateBps: 15.5 })).status).toBe(400);
      expect((await put({ barType: 'daily' })).status).toBe(400);
      expect((await put({ barCents: -5 })).status).toBe(400);
      expect((await put({ barCents: '12.50' })).status).toBe(400);
      expect((await put({ extra: 1 })).status).toBe(400);
      expect((await put({ fromWeek: addStaffWorkDays(thisWeek, -7) })).status).toBe(409);
      expect((await put({ fromWeek: addStaffWorkDays(thisWeek, 8) })).status).toBe(400);
      expect((await put({ technicianId: randomUUID() })).status).toBe(404);
      expect((await put({ technicianId: 'nope' })).status).toBe(400);
      expect(await trx('production_share_settings').count({ n: '*' }).first()).toMatchObject({ n: '0' });
    });
  });
});
