/**
 * Expired estimates whose customer later booked count as WON — real migrated
 * Postgres, the real reclaim query (estimate-conversion-guard.js).
 *
 * Owner request 2026-11-24: an estimate that expired before its customer's
 * first-ever paid invoice or completed visit is a win routed around the
 * estimate. The daily pass stamps converted_other_path and nothing else.
 *
 * Needs DATABASE_URL pointing at a local, migrated, disposable database.
 * Every fixture rolls back; all data is synthetic.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
if (!SKIP && !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('estimate-expired-booked-won-postgres requires a local database.');
}

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  database.fn = { now: () => new Date() };
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const dateOnly = (d) => d.toISOString().slice(0, 10);

// The estimate went out 150 days ago and expired 143 days ago.
const SENT_DAYS_AGO = 150;
const sentPlus = (n) => daysAgo(SENT_DAYS_AGO - n);

postgres('expired estimate reclaim — booked after expiry counts as won', () => {
  let db;
  let guard;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    guard = require('../services/estimate-conversion-guard');
  });

  beforeEach(async () => { mockTransaction = await db.transaction(); });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  async function customer(trx) {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await trx('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: 'Reclaimlane',
      phone: `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`,
      email: `qa-${tag}@example.test`,
      active: true,
      address_line1: '123 Synthetic Ave',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    });
    return id;
  }

  async function expiredEstimate(trx, customerId, overrides = {}) {
    const id = randomUUID();
    await trx('estimates').insert({
      id,
      customer_id: customerId,
      status: 'expired',
      token: randomUUID().replace(/-/g, ''),
      customer_name: 'Synthetic Reclaimlane',
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 0,
      estimate_data: JSON.stringify({}),
      sent_at: daysAgo(SENT_DAYS_AGO),
      created_at: daysAgo(SENT_DAYS_AGO),
      expires_at: daysAgo(SENT_DAYS_AGO - 7),
      disposition: 'expired_viewed',
      disposition_source: 'system',
      disposition_at: daysAgo(SENT_DAYS_AGO - 7),
      ...overrides,
    });
    return id;
  }

  async function paidInvoice(trx, customerId, { paidAt, createdAt = paidAt }) {
    await trx('invoices').insert({
      customer_id: customerId,
      token: randomUUID().replace(/-/g, ''),
      invoice_number: `QA-${randomUUID().slice(0, 8)}`,
      status: 'paid',
      paid_at: paidAt,
      created_at: createdAt,
    });
  }

  async function completedVisit(trx, customerId, completedAt, createdAt = completedAt) {
    const paid = await trx('services').whereNot({ service_key: 'lawn_inspection' }).first('id');
    await trx('scheduled_services').insert({
      id: randomUUID(),
      customer_id: customerId,
      service_id: paid.id,
      service_type: 'Lawn Care',
      scheduled_date: dateOnly(completedAt),
      window_start: '09:00',
      window_end: '11:00',
      status: 'completed',
      completed_at: completedAt,
      created_at: createdAt,
    });
  }

  const row = (id) => mockTransaction('estimates').where({ id }).first();

  test('(a) first-ever payment inside 90 days of sent_at stamps the win and nothing else', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust);
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(30) });
    const before = await row(id);

    const res = await guard.reclaimExpiredConvertedEstimates();

    expect(res.rows.map((r) => r.id)).toContain(id);
    const after = await row(id);
    expect(after.disposition).toBe('converted_other_path');
    expect(after.disposition_source).toBe('system');
    expect(new Date(after.disposition_at).getTime()).toBeGreaterThan(new Date(before.disposition_at).getTime());
    // Lifecycle fields are untouched: it stays expired, un-archived.
    expect(after.status).toBe('expired');
    expect(after.archived_at).toBeNull();
    expect(new Date(after.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
    expect(after.sent_at.getTime()).toBe(before.sent_at.getTime());
  });

  test('(b) a completed paid visit inside the window stamps it, and a second run is a no-op', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust, { disposition: null, disposition_source: null, disposition_at: null });
    await completedVisit(mockTransaction, cust, sentPlus(60), sentPlus(45));

    expect((await guard.reclaimExpiredConvertedEstimates()).rows.map((r) => r.id)).toContain(id);
    expect((await row(id)).disposition).toBe('converted_other_path');
    expect((await guard.reclaimExpiredConvertedEstimates()).rows.map((r) => r.id)).not.toContain(id);
  });

  test('(c) day 89 counts, day 120 does not', async () => {
    const early = await customer(mockTransaction);
    const earlyId = await expiredEstimate(mockTransaction, early, { disposition: 'expired_unviewed' });
    await paidInvoice(mockTransaction, early, { paidAt: sentPlus(89) });
    const late = await customer(mockTransaction);
    const lateId = await expiredEstimate(mockTransaction, late);
    await paidInvoice(mockTransaction, late, { paidAt: sentPlus(120) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(earlyId)).disposition).toBe('converted_other_path');
    expect((await row(lateId)).disposition).toBe('expired_viewed');
  });

  test('(d) a customer who converted BEFORE the estimate is left alone', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust);
    await paidInvoice(mockTransaction, cust, { paidAt: daysAgo(SENT_DAYS_AGO + 40) });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(20) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(id)).disposition).toBe('expired_viewed');
  });

  test('(e) a staff or customer disposition, an unsent draft and an archived row are untouched', async () => {
    const staffCust = await customer(mockTransaction);
    const staffId = await expiredEstimate(mockTransaction, staffCust, { disposition: 'declined_price', disposition_source: 'staff' });
    await paidInvoice(mockTransaction, staffCust, { paidAt: sentPlus(10) });

    const declinedCust = await customer(mockTransaction);
    const declinedId = await expiredEstimate(mockTransaction, declinedCust, { disposition: 'declined_by_customer', disposition_source: 'customer' });
    await paidInvoice(mockTransaction, declinedCust, { paidAt: sentPlus(10) });

    const unsentCust = await customer(mockTransaction);
    const unsentId = await expiredEstimate(mockTransaction, unsentCust, { disposition: 'expired_unsent' });
    await paidInvoice(mockTransaction, unsentCust, { paidAt: sentPlus(10) });

    const archivedCust = await customer(mockTransaction);
    const archivedId = await expiredEstimate(mockTransaction, archivedCust, { archived_at: daysAgo(100) });
    await paidInvoice(mockTransaction, archivedCust, { paidAt: sentPlus(10) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(staffId)).disposition).toBe('declined_price');
    expect((await row(declinedId)).disposition).toBe('declined_by_customer');
    expect((await row(unsentId)).disposition).toBe('expired_unsent');
    expect((await row(archivedId)).disposition).toBe('expired_viewed');
  });

  test('(f) a live sent estimate is not this pass\'s business (the archive sweep owns it)', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust, { status: 'sent', expires_at: null, disposition: null, disposition_source: null, disposition_at: null });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(10) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(id)).disposition).toBeNull();
  });
});
