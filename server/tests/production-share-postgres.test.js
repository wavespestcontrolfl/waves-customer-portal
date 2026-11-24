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
// The same house on two visits: callbacks need a property or an address on file to find the work they follow.
const HOME = { service_address_line1: '1 Sample Street', service_address_zip: '34201' };
const OTHER_HOME = { service_address_line1: '9 Other Road', service_address_zip: '34202' };

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
  // One completed stop, with its closeout record (`record`: 'completed' by default; 'incomplete', 'inspection_only' or
  // 'customer_declined' for a visit that did no work; false for none).
  const stop = async (technicianId, customerId, date, { record = 'completed', ...patch } = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: date, service_type: 'General Pest Control',
      status: 'completed', completed_at: noon(date), estimated_price: '100.00', ...patch,
    });
    if (record) {
      await trx('service_records').insert({
        customer_id: customerId, technician_id: technicianId, service_date: date, service_type: patch.service_type || 'General Pest Control',
        scheduled_service_id: id, status: record === 'incomplete' ? 'incomplete' : 'completed',
        structured_notes: JSON.stringify({ visitOutcome: record }),
      });
    }
    return id;
  };
  const invoice = async (customerId, patch = {}) => {
    const id = randomUUID();
    await trx('invoices').insert({
      id, token: randomUUID().slice(0, 32), invoice_number: `S-${id.slice(0, 8)}`, customer_id: customerId, status: 'sent',
      subtotal: '100.00', discount_amount: '0.00', tax_amount: '0.00', total: '100.00', ...patch,
    });
    return id;
  };
  const refund = (customerId, intent, amount) => trx('payments').insert({
    customer_id: customerId, payment_date: '2026-09-15', amount: '500.00', status: 'paid', stripe_payment_intent_id: intent, refund_amount: amount,
  });
  // A completion packet (one invoice for several visits of one stop) with the given visits as its items.
  const packet = async (customerId, invoiceId, visitIds, key) => {
    const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W, stop_base_key: key, created_by: 'test' }).returning('id');
    const [row] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: key, request_hash: 'h', payload: {} }).returning('id');
    for (const id of visitIds) {
      await trx('visit_completion_packet_items').insert({ packet_id: row.id, scheduled_service_id: id, derived_idempotency_key: `${key}-${id}`, invoice_id: invoiceId });
    }
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
      // The one stamped visit of the term takes the whole $100 refunded on the term invoice.
      expect(row.refundCents).toBe(10000);
    });

    it('splits a two-treatment package price across its two sold visits, whatever is booked: a missing or replaced visit 2 never moves a credit', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const first = await stop(a, c1, day(0), { ...pkg, estimated_price: '300.00' });
      // Visit 2 not booked yet: visit 1 still earns half, not the whole price.
      expect(byVisit(await credits(a), first)).toMatchObject({ kind: 'multi_visit_job', creditCents: 15000, reason: 'Part 1 of 2 of the job price' });
      // Visit 2 booked, cancelled and booked again: the replacement is the second visit.
      await stop(a, c1, day(2), { ...pkg, estimated_price: '0.00', followup_included: true, followup_source_service_id: first, status: 'cancelled', record: false });
      const second = await stop(a, c1, day(3), { ...pkg, estimated_price: '0.00', followup_included: true, followup_source_service_id: first });
      const rows = await credits(a);
      expect([byVisit(rows, first), byVisit(rows, second)].map((row) => [row.kind, row.creditCents])).toEqual([['multi_visit_job', 15000], ['multi_visit_job', 15000]]);
    });

    it('lists a job whose sold visit count is unknown, or that has more visits than were sold, for review at $0', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const unknown = await stop(a, c1, day(0), { service_type: 'Trapping Program', service_key_snapshot: 'rodent_trapping', estimated_price: '300.00' });
      await stop(a, c1, day(3), { service_type: 'Trapping Check', estimated_price: '0.00', followup_included: true, followup_source_service_id: unknown });
      expect(byVisit(await credits(a), unknown)).toMatchObject({ creditCents: 0, needsReview: true, reason: expect.stringMatching(/sold with cannot be established/) });
      const c2 = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(a, c2, day(0), { ...pkg, estimated_price: '300.00' });
      const second = await stop(a, c2, day(1), { ...pkg, estimated_price: '0.00', followup_included: true, followup_source_service_id: root });
      const third = await stop(a, c2, day(2), { ...pkg, estimated_price: '0.00', followup_included: true, followup_source_service_id: second });
      const rows = await credits(a);
      for (const id of [root, second, third]) expect(byVisit(rows, id)).toMatchObject({ creditCents: 0, needsReview: true });
    });

    it('lists an included follow-up with no job, and a job with no price, for review at $0', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const orphan = await stop(a, c1, day(0), { service_type: 'Cockroach Follow-up', estimated_price: '0.00', followup_included: true });
      const unpricedFirst = await stop(a, c1, day(1), { service_type: 'Bed Bug Treatment', service_key_snapshot: 'bed_bug_treatment', estimated_price: null });
      await stop(a, c1, day(2), { service_type: 'Bed Bug Follow-up', service_key_snapshot: 'bed_bug_treatment', estimated_price: '0.00', followup_included: true, followup_source_service_id: unpricedFirst });
      const rows = await credits(a);
      expect(byVisit(rows, orphan)).toMatchObject({ creditCents: 0, needsReview: true });
      expect(byVisit(rows, unpricedFirst)).toMatchObject({ kind: 'multi_visit_job', creditCents: 0, needsReview: true });
    });

    it('pays $0 for a callback on the technician\'s own work within 30 days and the setting for another technician\'s work', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const own = await customer();
      const other = await customer();
      await stop(a, own, '2026-08-20', { estimated_price: '110.00', ...HOME });
      await stop(b, other, '2026-08-20', { estimated_price: '110.00', ...HOME });
      const ownCallback = await stop(a, own, day(1), { service_type: 'Pest Control Re-Service', is_callback: true, estimated_price: null, ...HOME });
      const otherCallback = await stop(a, other, day(2), { service_type: 'Pest Control Re-Service', is_callback: true, estimated_price: null, ...HOME });
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
      const lonely = await stop(a, c1, day(0), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
      await stop(a, c2, '2026-07-01', { estimated_price: '110.00', ...HOME });
      const old = await stop(a, c2, day(1), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
      await stop(null, c3, '2026-09-01', { estimated_price: '110.00', ...HOME });
      const noTech = await stop(a, c3, day(2), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
      await stop(b, c4, '2026-09-01', { estimated_price: '110.00', ...HOME });
      const noSetting = await stop(a, c4, day(3), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
      const rows = await credits(a);
      for (const id of [lonely, old, noTech, noSetting]) expect(byVisit(rows, id)).toMatchObject({ creditCents: 0, needsReview: true });
      expect(byVisit(rows, noSetting).reason).toMatch(/no production share setting/);
    });

    it('finds no original for a callback when the earlier work in the same house is another line', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const c1 = await customer();
      await stop(b, c1, '2026-09-01', { service_type: 'Lawn Care Service', estimated_price: '80.00', ...HOME });
      const callback = await stop(a, c1, day(0), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
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

    it('never takes a month of dues, or today\'s per-application fee, for one past visit: no recorded price = $0 for review', async () => {
      const a = await tech('Sample Alpha');
      const member = await customer({ billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: '89.00' });
      const perApp = await customer({ billing_mode: 'per_application', per_application_fee: '65.00' });
      const dues = await stop(a, member, day(0), { estimated_price: null, is_recurring: true });
      const fee = await stop(a, perApp, day(1), { estimated_price: null });
      const recorded = await stop(a, perApp, day(2), { estimated_price: '58.00' }); // the price recorded on this visit, not today's fee
      const zero = await stop(a, member, day(3), { estimated_price: '0.00', primary_line_price: '110.00' });
      const rows = await credits(a);
      expect(byVisit(rows, dues)).toMatchObject({ kind: 'unpriced', creditCents: 0, needsReview: true });
      expect(byVisit(rows, fee)).toMatchObject({ kind: 'unpriced', creditCents: 0, needsReview: true });
      expect(byVisit(rows, recorded)).toMatchObject({ kind: 'priced', creditCents: 5800 });
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

  describe('what a visit was billed', () => {
    it('credits the pre-tax amount of the visit\'s invoice, paid or not, and a later fee change does not move it', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const visit = await stop(a, c1, day(0), { estimated_price: '120.00' }); // the price has since been changed
      await invoice(c1, { scheduled_service_id: visit, subtotal: '80.00', discount_amount: '5.00', tax_amount: '6.00', total: '81.00', status: 'sent' });
      expect(byVisit(await credits(a), visit)).toMatchObject({ kind: 'priced', creditCents: 7500, needsReview: false });
    });

    it('ignores draft and void invoices and falls back to the visit price', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const visit = await stop(a, c1, day(0), { estimated_price: '120.00' });
      await invoice(c1, { scheduled_service_id: visit, subtotal: '50.00', total: '50.00', status: 'void' });
      await invoice(c1, { scheduled_service_id: visit, subtotal: '60.00', total: '60.00', status: 'draft' });
      expect(byVisit(await credits(a), visit)).toMatchObject({ creditCents: 12000 });
    });

    it('finds an invoice linked only through the visit\'s service record', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const visit = await stop(a, c1, day(0), { estimated_price: '120.00' });
      const record = await trx('service_records').where({ scheduled_service_id: visit }).first('id'); // the closeout record the stop was given
      await invoice(c1, { service_record_id: record.id, subtotal: '90.00', total: '90.00' });
      expect(byVisit(await credits(a), visit)).toMatchObject({ creditCents: 9000 });
    });

    it('credits treatment work named "Initial", and leaves out only a setup FEE line (by the setup-fee classifier)', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const c2 = await customer();
      const c3 = await customer();
      const alone = await stop(a, c1, day(0), { estimated_price: '150.00' });
      await invoice(c1, { scheduled_service_id: alone, subtotal: '150.00', total: '150.00', line_items: JSON.stringify([{ description: 'Initial Pest Cleanout', amount: 150 }]) });
      // A $150 cleanout and a $25 add-on are both the visit's work.
      const withAddon = await stop(a, c2, day(1), { estimated_price: '175.00' });
      await invoice(c2, {
        scheduled_service_id: withAddon, subtotal: '175.00', total: '175.00',
        line_items: JSON.stringify([{ description: 'Initial Pest Cleanout', amount: 150 }, { description: 'Wasp nest removal', amount: 25 }]),
      });
      // A real setup fee line is not the visit's price.
      const combined = await stop(a, c3, day(2), { estimated_price: '219.00' });
      await invoice(c3, {
        scheduled_service_id: combined, subtotal: '219.00', total: '219.00',
        line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }, { description: 'Quarterly Pest Service', amount: 120 }]),
      });
      const rows = await credits(a);
      expect(byVisit(rows, alone)).toMatchObject({ kind: 'priced', creditCents: 15000 });
      expect(byVisit(rows, withAddon)).toMatchObject({ kind: 'priced', creditCents: 17500 });
      expect(byVisit(rows, combined)).toMatchObject({ kind: 'priced', creditCents: 12000 });
    });

    it('leaves a monthly dues line out of the visit credit and falls back to the price recorded on the visit, else review', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const dues = { description: 'WaveGuard Monthly dues', amount: 89, membership_dues_month: '2026-09' };
      const recorded = await stop(a, c1, day(0), { estimated_price: '60.00' });
      await invoice(c1, { scheduled_service_id: recorded, subtotal: '89.00', total: '89.00', line_items: JSON.stringify([dues]) });
      const none = await stop(a, c1, day(1), { estimated_price: null });
      await invoice(c1, { scheduled_service_id: none, subtotal: '89.00', total: '89.00', line_items: JSON.stringify([dues]) });
      const mixed = await stop(a, c1, day(2), { estimated_price: '70.00' });
      await invoice(c1, { scheduled_service_id: mixed, subtotal: '149.00', total: '149.00', line_items: JSON.stringify([dues, { description: 'Pest service', amount: 60 }]) });
      const rows = await credits(a);
      expect(byVisit(rows, recorded)).toMatchObject({ kind: 'priced', creditCents: 6000, needsReview: false });
      expect(byVisit(rows, none)).toMatchObject({ kind: 'unpriced', creditCents: 0, needsReview: true });
      expect(byVisit(rows, mixed)).toMatchObject({ kind: 'priced', creditCents: 6000 });
    });

    it('finds the invoice through any service record of the visit, not only the latest', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const visit = await stop(a, c1, day(0), { estimated_price: '120.00' });
      const first = await trx('service_records').where({ scheduled_service_id: visit }).first('id');
      // A later closeout record: the closeout outcome reads it, the invoice hangs on the first.
      await trx('service_records').insert({
        customer_id: c1, technician_id: a, service_date: day(0), service_type: 'General Pest Control', scheduled_service_id: visit,
        status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed' }), created_at: new Date(Date.now() + 60000),
      });
      await invoice(c1, { service_record_id: first.id, subtotal: '90.00', total: '90.00' });
      expect(byVisit(await credits(a), visit)).toMatchObject({ kind: 'priced', creditCents: 9000 });
    });

    it('splits a completion-packet invoice across all its visits by visit price, to the cent, and counts its refund once', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      const c1 = await customer();
      const v1 = await stop(a, c1, day(0), { estimated_price: '60.00' });
      const v2 = await stop(b, c1, day(0), { estimated_price: '40.00' }); // another technician's visit on the same invoice
      const v3 = await stop(a, c1, day(1), { estimated_price: '20.00' });
      const shared = await invoice(c1, { subtotal: '120.01', total: '120.01', stripe_payment_intent_id: 'pi_shared' });
      await packet(c1, shared, [v1, v2, v3], 'k1');
      await refund(c1, 'pi_shared', '10.01');
      const rows = await credits(a);
      const mine = [byVisit(rows, v1), byVisit(rows, v3)];
      const other = (await credits(b))[0];
      // 120.01 across 60 : 40 : 20 is 60.00 + 40.00 + 20.01 (the odd cent to the largest remainder, ties by id).
      expect(mine[0].creditCents + other.creditCents + mine[1].creditCents).toBe(12001);
      expect(mine.map((row) => row.kind)).toEqual(['priced', 'priced']);
      expect(mine[0].refundCents + other.refundCents + mine[1].refundCents).toBe(1001);
      expect(mine[0].creditCents).toBeGreaterThanOrEqual(6000);
    });

    it('flags the stops of a shared invoice that cannot be split, and keeps its refund visible instead of pricing them from the visit', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const v1 = await stop(a, c1, day(0), { estimated_price: '60.00' });
      const v2 = await stop(a, c1, day(1), { estimated_price: null, primary_line_price: null });
      const shared = await invoice(c1, { subtotal: '99.00', total: '99.00', stripe_payment_intent_id: 'pi_unsplit' });
      await packet(c1, shared, [v1, v2], 'k2');
      await refund(c1, 'pi_unsplit', '12.00');
      const rows = await credits(a);
      for (const id of [v1, v2]) {
        expect(byVisit(rows, id)).toMatchObject({ creditCents: 0, needsReview: true, reason: expect.stringMatching(/cannot be split/) });
        expect(byVisit(rows, id).unallocatedRefunds).toEqual([{ invoiceId: shared, refundCents: 1200 }]);
      }
      const shown = await productionShare.previewWeek(a, W, trx);
      expect(shown.unallocatedRefundCents).toBe(1200); // the one invoice, once
      expect(shown.needsReview).toHaveLength(2);
    });

    it('takes a job price from the first visit\'s invoice', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const first = await stop(a, c1, day(0), { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control', estimated_price: '300.00' });
      await stop(a, c1, day(3), { service_type: 'Cockroach Follow-up', service_key_snapshot: 'cockroach_control', estimated_price: '0.00', followup_included: true, followup_source_service_id: first });
      await invoice(c1, { scheduled_service_id: first, subtotal: '200.00', total: '200.00' });
      expect(byVisit(await credits(a), first)).toMatchObject({ kind: 'multi_visit_job', creditCents: 10000 });
    });

    it('counts a rescheduled follow-up as a planned visit of its job', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const first = await stop(a, c1, day(0), { service_type: 'Bed Bug Treatment', service_key_snapshot: 'bed_bug_treatment', estimated_price: '300.00' });
      await trx('scheduled_services').insert({
        customer_id: c1, technician_id: a, scheduled_date: day(10), service_type: 'Bed Bug Follow-up', service_key_snapshot: 'bed_bug_treatment', status: 'rescheduled',
        estimated_price: '0.00', followup_included: true, followup_source_service_id: first,
      });
      expect(byVisit(await credits(a), first)).toMatchObject({ creditCents: 15000, reason: 'Part 1 of 2 of the job price' });
    });
  });

  describe('refunds on a prepaid plan', () => {
    it('counts a term refund once, spread over the whole term\'s stamped visits so the shares add up exactly', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const termInvoice = await invoice(c1, { total: '100.00', subtotal: '100.00', stripe_payment_intent_id: 'pi_term', status: 'paid' });
      const termId = randomUUID();
      await trx('annual_prepay_terms').insert({
        id: termId, customer_id: c1, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '100.00',
        prepay_invoice_id: termInvoice, coverage_visit_count: 3,
      });
      await trx('invoices').where({ id: termInvoice }).update({ annual_prepay_term_id: termId });
      await refund(c1, 'pi_term', '10.00');
      const stamp = { annual_prepay_term_id: termId, prepaid_method: 'annual_prepay_invoice' };
      const v1 = await stop(a, c1, day(0), { ...stamp, prepaid_amount: '33.33' });
      const v2 = await stop(a, c1, day(1), { ...stamp, prepaid_amount: '33.33' });
      const v3 = await stop(a, c1, day(2), { ...stamp, prepaid_amount: '33.34' });
      // The term invoice is also (wrongly) linked straight to one visit: it must not be counted a second time.
      await trx('invoices').where({ id: termInvoice }).update({ scheduled_service_id: v1 });
      const rows = await credits(a);
      const refunds = [v1, v2, v3].map((id) => byVisit(rows, id).refundCents);
      expect(refunds.reduce((x, y) => x + y, 0)).toBe(1000);
      expect(refunds).toEqual([333, 333, 334]);
      expect([v1, v2, v3].map((id) => byVisit(rows, id).creditCents)).toEqual([3333, 3333, 3334]);
    });

    it('spreads the refund over visits of the term in other weeks too', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const termInvoice = await invoice(c1, { total: '100.00', stripe_payment_intent_id: 'pi_term2', status: 'paid' });
      const termId = randomUUID();
      await trx('annual_prepay_terms').insert({
        id: termId, customer_id: c1, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '100.00',
        prepay_invoice_id: termInvoice, coverage_visit_count: 2,
      });
      await refund(c1, 'pi_term2', '10.00');
      const stamp = { annual_prepay_term_id: termId, prepaid_method: 'annual_prepay_invoice', prepaid_amount: '50.00' };
      const inWeek = await stop(a, c1, day(0), stamp);
      await stop(a, c1, day(14), stamp);
      expect(byVisit(await credits(a), inWeek).refundCents).toBe(500);
    });
  });

  describe('whether the work was performed', () => {
    it('credits $0 to a stop closed out incomplete, declined or inspection only (still a shift), and lists a stop with no closeout record for review', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const incomplete = await stop(a, c1, day(0), { estimated_price: '100.00', record: 'incomplete' });
      const inspection = await stop(a, c1, day(1), { estimated_price: '100.00', record: 'inspection_only' });
      const declined = await stop(a, c1, day(2), { estimated_price: '100.00', record: 'customer_declined' });
      const none = await stop(a, c1, day(3), { estimated_price: '100.00', record: false });
      const done = await stop(a, c1, day(4), { estimated_price: '100.00' });
      const rows = await credits(a);
      for (const id of [incomplete, inspection, declined]) expect(byVisit(rows, id)).toMatchObject({ kind: 'not_performed', creditCents: 0, needsReview: false });
      expect(byVisit(rows, none)).toMatchObject({ kind: 'unverified', creditCents: 0, needsReview: true });
      expect(byVisit(rows, done)).toMatchObject({ kind: 'priced', creditCents: 10000 });
      expect(productionShare.shiftDays(rows)).toHaveLength(5);
    });

    it('never takes a visit that did no work as the original of a callback', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      await settings(null, '2026-01-05');
      const c1 = await customer();
      await stop(b, c1, '2026-09-01', { ...HOME, estimated_price: '110.00' });
      await stop(a, c1, '2026-09-10', { ...HOME, estimated_price: '110.00', record: 'inspection_only' });
      const callback = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      // Own inspection-only visit is skipped: the original is the other technician's real treatment.
      expect(byVisit(await credits(a), callback)).toMatchObject({ kind: 'callback_other', creditCents: 9500 });
      // An earlier visit with no closeout record cannot be called the original, or not the original.
      const c2 = await customer();
      await stop(b, c2, '2026-09-10', { ...HOME, estimated_price: '110.00', record: false });
      const lost = await stop(a, c2, day(1), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), lost)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/no completion record/) });
    });
  });

  describe('annual prepay stamps', () => {
    const term = async (c1, invoiceKey) => {
      const termInvoice = await invoice(c1, { total: '100.00', stripe_payment_intent_id: invoiceKey, status: 'paid' });
      const id = randomUUID();
      await trx('annual_prepay_terms').insert({
        id, customer_id: c1, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '100.00',
        prepay_invoice_id: termInvoice, coverage_visit_count: 2,
      });
      return id;
    };

    it('reads the annual stamp, not the term link: a stamp with no term is listed for review, a cash prepayment on a term visit is priced as a visit', async () => {
      const a = await tech('Sample Alpha');
      const c1 = await customer();
      const termId = await term(c1, 'pi_stamp');
      const detached = await stop(a, c1, day(0), { prepaid_method: 'annual_prepay_invoice', prepaid_amount: '50.00', estimated_price: '120.00' });
      const cash = await stop(a, c1, day(1), { annual_prepay_term_id: termId, prepaid_method: 'cash', prepaid_amount: '70.00', estimated_price: '90.00' });
      const annual = await stop(a, c1, day(2), { annual_prepay_term_id: termId, prepaid_method: 'annual_prepay_invoice', prepaid_amount: '50.00', estimated_price: '120.00' });
      await refund(c1, 'pi_stamp', '10.00');
      const rows = await credits(a);
      expect(byVisit(rows, detached)).toMatchObject({ kind: 'prepaid_plan', creditCents: 0, needsReview: true });
      expect(byVisit(rows, cash)).toMatchObject({ kind: 'priced', creditCents: 9000, refundCents: 0 });
      // The term's refund goes to the one annual-stamped visit of the term, not to the cash-prepaid one.
      expect(byVisit(rows, annual)).toMatchObject({ kind: 'prepaid_plan', creditCents: 5000, refundCents: 1000 });
    });
  });

  describe('the work a callback follows', () => {
    const setup = async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      await settings(null, '2026-01-05');
      return { a, b, c1: await customer() };
    };

    it('is the work that came before it: a visit completed after the callback is not its original', async () => {
      const { a, b, c1 } = await setup();
      await stop(b, c1, day(0), { ...HOME, estimated_price: '110.00', completed_at: '2026-09-14T13:00:00Z' }); // earlier same day, another technician
      const callback = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true, completed_at: '2026-09-14T18:00:00Z' });
      await stop(a, c1, day(0), { ...HOME, estimated_price: '90.00', completed_at: '2026-09-14T21:00:00Z' }); // later the same day, own
      expect(byVisit(await credits(a), callback)).toMatchObject({ kind: 'callback_other', creditCents: 9500 });
    });

    it('goes to review when a same-day visit cannot be ordered against the callback', async () => {
      const { a, b, c1 } = await setup();
      await stop(b, c1, day(0), { ...HOME, estimated_price: '110.00', completed_at: null, scheduled_date: day(0) });
      const callback = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), callback)).toMatchObject({ creditCents: 0, needsReview: true });
      expect(byVisit(await credits(a), callback).reason).toMatch(/order of the two cannot be read/);
    });

    it('ignores work on a later date', async () => {
      const { a, b, c1 } = await setup();
      await stop(b, c1, day(3), { ...HOME, estimated_price: '110.00' });
      const callback = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), callback)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/No earlier completed work/) });
    });

    it('never takes a re-service as the original, by flag, catalog key, name or type, and uses the real work before it', async () => {
      const { a, b, c1 } = await setup();
      await stop(b, c1, '2026-09-01', { ...HOME, estimated_price: '110.00' });
      // Later re-services of the same line: flagged, named, and typed only.
      await stop(a, c1, '2026-09-10', { ...HOME, is_callback: true, estimated_price: null });
      await stop(a, c1, '2026-09-11', { ...HOME, service_type: 'Pest Control Re-Service', estimated_price: null });
      await stop(a, c1, '2026-09-12', { ...HOME, service_type: 'Pest re service visit', estimated_price: null, is_callback: false });
      const catalog = await trx('services').where({ service_key: 'pest_re_service' }).first('id');
      await stop(a, c1, '2026-09-13', { ...HOME, service_type: 'Visit', service_id: catalog.id, estimated_price: null });
      const callback = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      // The only real original is the other technician's visit on 09-01: the route-average value, not $0 on "own work".
      expect(byVisit(await credits(a), callback)).toMatchObject({ kind: 'callback_other', creditCents: 9500 });
    });

    it('matches the property by id or by address, never every property, and sends unknown ones to review', async () => {
      const { a, b, c1 } = await setup();
      // Another house of the same customer, done by another technician, is not the original.
      await stop(b, c1, '2026-09-01', { ...OTHER_HOME, estimated_price: '110.00' });
      const noWhere = await stop(a, c1, day(0), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
      expect(byVisit(await credits(a), noWhere)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/No earlier completed work/) });
      // The same house found by address, with no property id on either side.
      await stop(b, c1, '2026-09-02', { ...HOME, estimated_price: '110.00' });
      expect(byVisit(await credits(a), noWhere)).toMatchObject({ kind: 'callback_other' });
      // An earlier visit with no property and no address is unknown: never guessed to be the same house.
      const c2 = await customer();
      await stop(b, c2, '2026-09-01', { estimated_price: '110.00' });
      const lost = await stop(a, c2, day(0), { service_type: 'Pest Control Re-Service', is_callback: true, ...HOME });
      expect(byVisit(await credits(a), lost)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/cannot be tied to this property/) });
    });

    it('reads the unit as part of the address: another unit is another home, an unnamed unit is ambiguous', async () => {
      const { a, b, c1 } = await setup();
      await stop(b, c1, '2026-09-01', { ...HOME, service_address_line2: 'Apt 2', estimated_price: '110.00' });
      const apt1 = await stop(a, c1, day(0), { ...HOME, service_address_line2: 'Apt 1', service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), apt1)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/No earlier completed work/) });
      const noUnit = await stop(a, c1, day(1), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), noUnit)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/cannot be tied to this property/) });
      const apt2 = await stop(a, c1, day(2), { ...HOME, service_address_line2: 'apt  2', service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), apt2)).toMatchObject({ kind: 'callback_other' });
    });

    it('checks every plausible latest visit before choosing the original technician', async () => {
      const { a, b, c1 } = await setup();
      // Same earlier day: one timed visit by Bravo and one with no completion time by Alpha. Which came last is unknown.
      await stop(b, c1, '2026-09-10', { ...HOME, estimated_price: '110.00', completed_at: '2026-09-10T15:00:00Z' });
      await stop(a, c1, '2026-09-10', { ...HOME, estimated_price: '110.00', completed_at: null });
      const callback = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), callback)).toMatchObject({ needsReview: true, reason: expect.stringMatching(/which came last cannot be read/) });
      // The same pair by one technician is not ambiguous about who did the work.
      const c2 = await customer();
      await stop(a, c2, '2026-09-10', { ...HOME, estimated_price: '110.00', completed_at: '2026-09-10T15:00:00Z' });
      await stop(a, c2, '2026-09-10', { ...HOME, estimated_price: '110.00', completed_at: null });
      const own = await stop(a, c2, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), own)).toMatchObject({ kind: 'callback_own' });
    });

    it('compares technician ids as the database spells them, whatever case the caller used', async () => {
      const { a, b, c1 } = await setup();
      await trx('production_share_settings').insert({ technician_id: a, from_week: '2026-09-07', rate_bps: 2000, bar_type: 'weekly', bar_cents: 1, callback_stop_value_cents: 7700 });
      await stop(a, c1, '2026-09-01', { ...HOME, estimated_price: '110.00' });
      await stop(b, c1, '2026-09-02', { ...HOME, estimated_price: '110.00' });
      const own = await stop(a, c1, day(0), { ...HOME, service_type: 'Pest Control Re-Service', is_callback: true });
      const rows = await productionShare.weekCredits(trx, a.toUpperCase(), W);
      // The latest earlier work is Bravo's, so the callback is credited at Alpha's own setting (7700), found with the capitalised id.
      expect(byVisit(rows, own)).toMatchObject({ kind: 'callback_other', creditCents: 7700 });
      expect((await productionShare.previewWeek(a.toUpperCase(), W, trx)).technician.id).toBe(a);
      expect((await productionShare.settingsFor(trx, a.toUpperCase(), W))).toMatchObject({ technicianId: a, rateBps: 2000 });
    });

    it('matches by property id when both visits carry one', async () => {
      const { a, b, c1 } = await setup();
      const props = [];
      for (const line of ['1 A St', '2 B St']) {
        const [row] = await trx('customer_properties').insert({ customer_id: c1, address_line1: line, zip: '34201' }).returning('id');
        props.push(row.id);
      }
      await stop(b, c1, '2026-09-01', { property_id: props[1], estimated_price: '110.00' });
      const callback = await stop(a, c1, day(0), { property_id: props[0], service_type: 'Pest Control Re-Service', is_callback: true });
      expect(byVisit(await credits(a), callback)).toMatchObject({ needsReview: true });
      await stop(b, c1, '2026-09-02', { property_id: props[0], estimated_price: '110.00' });
      expect(byVisit(await credits(a), callback)).toMatchObject({ kind: 'callback_other' });
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
