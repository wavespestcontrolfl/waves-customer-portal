/**
 * The daily archive sweep does not treat a completed Waves Assessment as a
 * conversion — real migrated Postgres, the real sweep query.
 *
 * Owner ruling 2026-09-08 (assessment-booking.js): an assessment is a free
 * consultation, not a sale. Prod 2026-10-29: the sweep archived a viewed
 * commercial proposal as converted_other_path because the customer's only
 * completed visit was a free assessment booked after the estimate; the
 * customer link then answered 404. A paid invoice or a completed paid
 * visit still archives.
 *
 * Needs DATABASE_URL pointing at a local, migrated, disposable database.
 * Every fixture rolls back; all data is synthetic.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
if (!SKIP && !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('estimate-conversion-sweep-assessment-postgres requires a local database.');
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

postgres('estimate archive sweep — a completed Waves Assessment is not a conversion', () => {
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

  async function serviceId(trx, key) {
    const row = await trx('services').where({ service_key: key }).first('id');
    if (!row) throw new Error(`catalog row ${key} missing — run migrations`);
    return row.id;
  }

  async function paidServiceId(trx) {
    const row = await trx('services').whereNot({ service_key: 'lawn_inspection' }).first('id');
    if (!row) throw new Error('no paid catalog row — run migrations');
    return row.id;
  }

  // A customer with a viewed estimate created 5 days ago and nothing else.
  async function fixture(trx) {
    const customerId = randomUUID();
    const tag = customerId.slice(0, 8);
    await trx('customers').insert({
      id: customerId,
      first_name: 'Synthetic',
      last_name: 'Sweeplane',
      phone: `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`,
      email: `qa-${tag}@example.test`,
      active: true,
      address_line1: '123 Synthetic Ave',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    });
    const estimateId = randomUUID();
    await trx('estimates').insert({
      id: estimateId,
      customer_id: customerId,
      status: 'viewed',
      token: randomUUID().replace(/-/g, ''),
      customer_name: 'Synthetic Sweeplane',
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 0,
      estimate_data: JSON.stringify({}),
      sent_at: daysAgo(5),
      created_at: daysAgo(5),
    });
    return { customerId, estimateId };
  }

  // A visit created AFTER the estimate and completed yesterday.
  async function completedVisit(trx, { customerId, serviceKey, serviceType, serviceIdOverride }) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      service_id: serviceIdOverride !== undefined
        ? serviceIdOverride
        : (serviceKey ? await serviceId(trx, serviceKey) : null),
      service_type: serviceType,
      scheduled_date: dateOnly(daysAgo(1)),
      window_start: '09:00',
      window_end: '11:00',
      status: 'completed',
      completed_at: daysAgo(1),
      created_at: daysAgo(3),
    });
    return id;
  }

  const row = (estimateId) => mockTransaction('estimates').where({ id: estimateId }).first();

  test('(a) a completed assessment linked to lawn_inspection leaves the estimate open', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    await completedVisit(mockTransaction, { customerId, serviceKey: 'lawn_inspection', serviceType: 'Waves Assessment' });

    await guard.archiveConvertedOpenEstimates();

    const after = await row(estimateId);
    expect(after.archived_at).toBeNull();
    expect(after.disposition).toBeNull();
    expect(after.status).toBe('viewed');
    // The post-6:00 convergence check reads the same query: nothing to report.
    const stuck = await guard.convertedOpenEstimatesQuery().select('estimates.id');
    expect(stuck.map((r) => r.id)).not.toContain(estimateId);
    // The staff archive route classifies with the same predicates: unresolved.
    const staffConverted = await mockTransaction('estimates')
      .where({ id: estimateId })
      .whereNotNull('customer_id')
      .modify(guard.whereConversionEligibilitySignal)
      .modify(guard.whereNoConversionBeforeEstimate)
      .first('id');
    expect(staffConverted).toBeUndefined();
  });

  test('(b) a completed paid-service visit archives as converted_other_path', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    await completedVisit(mockTransaction, {
      customerId, serviceIdOverride: await paidServiceId(mockTransaction), serviceType: 'Lawn Care',
    });

    const res = await guard.archiveConvertedOpenEstimates();

    expect(res.rows.map((r) => r.id)).toContain(estimateId);
    const after = await row(estimateId);
    expect(after.archived_at).not.toBeNull();
    expect(after.disposition).toBe('converted_other_path');
    expect(after.disposition_source).toBe('system');
  });

  test('(c) a legacy assessment row with no service_id is left alone', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    await completedVisit(mockTransaction, { customerId, serviceIdOverride: null, serviceType: 'Waves Assessment' });

    await guard.archiveConvertedOpenEstimates();

    const after = await row(estimateId);
    expect(after.archived_at).toBeNull();
    expect(after.disposition).toBeNull();
  });

  test('(d) a paid invoice after the estimate still archives', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    await mockTransaction('invoices').insert({
      customer_id: customerId,
      token: randomUUID().replace(/-/g, ''),
      invoice_number: `QA-${randomUUID().slice(0, 8)}`,
      status: 'paid',
      paid_at: daysAgo(1),
      created_at: daysAgo(2),
    });

    const res = await guard.archiveConvertedOpenEstimates();

    expect(res.rows.map((r) => r.id)).toContain(estimateId);
    expect((await row(estimateId)).disposition).toBe('converted_other_path');
  });

  test('(e) an assessment next to a completed paid visit still archives', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    await completedVisit(mockTransaction, { customerId, serviceKey: 'lawn_inspection', serviceType: 'Waves Assessment' });
    await completedVisit(mockTransaction, {
      customerId, serviceIdOverride: await paidServiceId(mockTransaction), serviceType: 'Lawn Care',
    });

    await guard.archiveConvertedOpenEstimates();

    expect((await row(estimateId)).disposition).toBe('converted_other_path');
  });

  test('(f) catalog identity wins: a visit repointed to a paid service keeps counting', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    // Stale "Waves Assessment" snapshot, but the catalog link is a paid service.
    await completedVisit(mockTransaction, {
      customerId, serviceIdOverride: await paidServiceId(mockTransaction), serviceType: 'Waves Assessment',
    });

    await guard.archiveConvertedOpenEstimates();

    expect((await row(estimateId)).disposition).toBe('converted_other_path');
  });

  test('(g) an assessment completed BEFORE the estimate still keeps it (broad disqualifier unchanged)', async () => {
    const { customerId, estimateId } = await fixture(mockTransaction);
    await mockTransaction('scheduled_services').insert({
      id: randomUUID(),
      customer_id: customerId,
      service_id: await serviceId(mockTransaction, 'lawn_inspection'),
      service_type: 'Waves Assessment',
      scheduled_date: dateOnly(daysAgo(9)),
      window_start: '09:00',
      window_end: '11:00',
      status: 'completed',
      completed_at: daysAgo(9),
      created_at: daysAgo(10),
    });
    // A paid invoice lands afterward: the pre-estimate assessment still
    // counts as prior evidence, so the estimate stays open.
    await mockTransaction('invoices').insert({
      customer_id: customerId,
      token: randomUUID().replace(/-/g, ''),
      invoice_number: `QA-${randomUUID().slice(0, 8)}`,
      status: 'paid',
      paid_at: daysAgo(1),
      created_at: daysAgo(1),
    });

    await guard.archiveConvertedOpenEstimates();

    expect((await row(estimateId)).archived_at).toBeNull();
  });
});
