/**
 * Audit repro r1-sched-visits-1 — in-person series prepayment fans across
 * booster rows (and splits over however many rows were placed).
 *
 * Real Postgres (DATABASE_URL must point at a private clone of waves_audit_tpl).
 * The family is inserted EXACTLY the way POST /api/admin/schedule inserts it
 * (routes/admin-schedule.js:7429-7437: booster rows carry is_recurring:false,
 * recurring_parent_id: svc.id, status 'pending'), then stampSeriesPrepaid is
 * called with the same arguments the route passes at :7540-7546.
 *
 * Asserts the EXPECTED behaviour: a $400 prepay for a 4-visit quarterly plan
 * stamps $100 on each of the 4 base visits and nothing on the 2 boosters; a
 * short-placed series never stamps a row above its own per-visit price.
 *
 * Skips cleanly without DATABASE_URL (never touches an unrelated/production
 * database — see the CLAUDE.md dev-workflow rule).
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { stampSeriesPrepaid } = require('../services/prepaid-series');
const { assertPrepayTotalMatchesPricing } = require('../routes/admin-schedule')._test;

const PER_VISIT = 100;

postgres('r1-sched-visits-1: in-person series prepay vs booster rows', () => {
  let database;
  let trx;
  let customerId;

  beforeAll(() => {
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    const [customer] = await trx('customers').insert({
      first_name: 'Audit', last_name: 'Repro', phone: `r1-${Date.now()}`,
      email: `audit-r1-${Date.now()}@example.invalid`, address_line1: '1 Test Ln', city: 'Test', zip: '00000',
      active: true, pipeline_stage: 'active_customer',
    }).returning('id');
    customerId = customer.id || customer;
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function insertFamily({ boosterDates = [], childDates = ['2027-02-02', '2027-05-03', '2027-08-02'] } = {}) {
    const [parent] = await trx('scheduled_services').insert({
      customer_id: customerId, scheduled_date: '2026-11-02', service_type: 'Quarterly Pest Control',
      status: 'pending', is_recurring: true, estimated_price: PER_VISIT,
    }).returning('id');
    const parentId = parent.id || parent;
    for (const d of childDates) {
      await trx('scheduled_services').insert({
        customer_id: customerId, scheduled_date: d, service_type: 'Quarterly Pest Control',
        status: 'pending', is_recurring: true, recurring_parent_id: parentId, estimated_price: PER_VISIT,
      });
    }
    for (const d of boosterDates) {
      // Mirrors admin-schedule.js:7429-7437 boosterData
      await trx('scheduled_services').insert({
        customer_id: customerId, scheduled_date: d, service_type: 'Quarterly Pest Control',
        status: 'pending', is_recurring: false, recurring_parent_id: parentId, estimated_price: PER_VISIT,
      });
    }
    return { parentId };
  }

  async function family(parentId) {
    return trx('scheduled_services')
      .where(function () { this.where('recurring_parent_id', parentId).orWhere('id', parentId); })
      .orderBy('scheduled_date')
      .select('id', 'scheduled_date', 'is_recurring', 'prepaid_amount', 'prepaid_method');
  }

  test('$400 for 4 quarterly visits + 2 boosters stamps $100 on each base visit and nothing on boosters', async () => {
    const { parentId } = await insertFamily({ boosterDates: ['2026-12-15', '2027-01-15'] });

    // Route-side check the POST runs first (admin-schedule.js:7540): passes,
    // because plannedCount counts base visits only (4), not boosters.
    expect(() => assertPrepayTotalMatchesPricing({ totalAmount: 400, finalPrice: PER_VISIT, plannedCount: 4 })).not.toThrow();

    const result = await stampSeriesPrepaid(trx, {
      anchorServiceId: parentId, totalAmount: 400, method: 'cash', note: null, useExistingTransaction: true,
    });
    const rows = await family(parentId);
    console.log('stamp result', JSON.stringify({ visitsCovered: result.visitsCovered, perVisitAmount: result.perVisitAmount }),
      '\nrows', JSON.stringify(rows.map((r) => ({ date: r.scheduled_date instanceof Date ? r.scheduled_date.toISOString().slice(0, 10) : r.scheduled_date, is_recurring: r.is_recurring, prepaid_amount: r.prepaid_amount })), null, 1));

    const base = rows.filter((r) => r.is_recurring === true);
    const boosters = rows.filter((r) => r.is_recurring === false);
    expect(base).toHaveLength(4);
    expect(boosters).toHaveLength(2);

    // EXPECTED: base visits fully covered at the per-visit price.
    for (const r of base) expect(Number(r.prepaid_amount)).toBe(PER_VISIT);
    // EXPECTED: boosters (separately billable) carry no share of the base prepay.
    for (const r of boosters) expect(r.prepaid_amount).toBeNull();
  });

  test('variant B: $400 validated against plannedCount=4 still stamps when only 3 rows were placed (no row above the per-visit price)', async () => {
    const { parentId } = await insertFamily({ childDates: ['2027-02-02', '2027-05-03'] }); // parent + 2 = 3 placed
    // Route-side gate passes: it compares to plannedCount (4), not rows placed (3).
    expect(() => assertPrepayTotalMatchesPricing({ totalAmount: 400, finalPrice: PER_VISIT, plannedCount: 4 })).not.toThrow();
    await stampSeriesPrepaid(trx, {
      anchorServiceId: parentId, totalAmount: 400, method: 'cash', note: null, useExistingTransaction: true,
    });
    const rows = await family(parentId);
    console.log('variant B rows', JSON.stringify(rows.map((r) => Number(r.prepaid_amount))));
    expect(rows).toHaveLength(3);
    // EXPECTED: no row is stamped above the per-visit price.
    for (const r of rows) expect(Number(r.prepaid_amount)).toBeLessThanOrEqual(PER_VISIT);
  });
});
