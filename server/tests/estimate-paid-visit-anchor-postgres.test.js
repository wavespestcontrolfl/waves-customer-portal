// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The annual-prepay overlap check must start from the first paid visit of the estimate, never from a free Waves
// Assessment, a callback, a re-service, a cancelled visit or another customer's row linked to the same estimate.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const appDb = require('../models/db');
const { paidEstimateVisitsQuery } = require('../services/assessment-booking');
const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;
const { dateOnlyString } = require('../utils/date-only');

postgres('paid-visit anchor for annual renewals (real PostgreSQL)', () => {
  let database;
  let trx;
  let customerId;
  let estimateId;

  async function addCustomer(db, id, label) {
    await db('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: label,
      email: `${id}@example.invalid`,
      phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '1 Synthetic Lane',
      city: 'Test City',
      zip: '00000',
      active: true,
      pipeline_stage: 'active_customer',
    });
  }

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a local disposable database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    estimateId = randomUUID();
    await addCustomer(trx, customerId, 'Renewal');
    await trx('estimates').insert({
      id: estimateId, customer_id: customerId, status: 'sent', service_interest: 'Quarterly Pest Control',
    });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => {
    await database?.destroy();
    await appDb?.destroy?.();
  });

  async function visit(overrides = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      source_estimate_id: estimateId,
      scheduled_date: '2098-02-10',
      service_type: 'Quarterly Pest Control Service',
      status: 'confirmed',
      window_start: '09:00',
      window_end: '10:00',
      ...overrides,
    });
    return id;
  }
  const resolve = () => paidEstimateVisitsQuery(trx, { estimateId, customerId });

  test('skips an assessment and a callback and anchors on the paid visit', async () => {
    await visit({ scheduled_date: '2098-01-05', service_type: 'Waves Assessment', window_start: '08:00', window_end: '09:00' });
    await visit({ scheduled_date: '2098-01-15', is_callback: true });
    const paid = await visit({ scheduled_date: '2098-02-10' });

    const rows = await resolve();

    expect(rows.map((row) => row.id)).toEqual([paid]);
    expect(dateOnlyString(rows[0].scheduled_date)).toBe('2098-02-10');
  });

  test('an unflagged completed re-service never anchors the term; the next paid visit does', async () => {
    await visit({ scheduled_date: '2098-01-20', status: 'completed', is_callback: false, service_type: 'Pest Control Re-Service' });
    const paid = await visit({ scheduled_date: '2098-02-10' });

    expect((await resolve()).map((row) => row.id)).toEqual([paid]);
  });

  test('excludes another customer, holds, catalog assessments and retained history; same-day visits order by start time', async () => {
    const assessment = await trx('services').where({ service_key: 'lawn_inspection' }).first('id');
    const paidService = await trx('services').whereNot({ service_key: 'lawn_inspection' }).whereNotNull('service_key').first('id');
    expect(assessment).toBeTruthy();
    expect(paidService).toBeTruthy();
    const otherCustomerId = randomUUID();
    await addCustomer(trx, otherCustomerId, 'Other');

    // Catalog assessment despite a paid-looking service_type.
    await visit({ scheduled_date: '2098-01-05', service_type: 'Lawn Care Visit', service_id: assessment.id });
    // An unclaimed estimate hold is not a booked visit.
    await visit({ scheduled_date: '2098-01-10', customer_id: null, service_id: paidService.id, reservation_expires_at: trx.raw("NOW() + INTERVAL '15 minutes'") });
    // A source stamp cannot transfer another customer's booking into this plan.
    await visit({ scheduled_date: '2098-01-15', customer_id: otherCustomerId, service_id: paidService.id });
    for (const status of ['cancelled', 'skipped', 'no_show', 'rescheduled']) {
      await visit({ scheduled_date: '2098-01-20', service_id: paidService.id, status });
    }
    const afternoon = await visit({ scheduled_date: '2098-02-10', service_id: paidService.id, window_start: '14:00', window_end: '15:00' });
    const morning = await visit({ scheduled_date: '2098-02-10', service_id: paidService.id, window_start: '08:00', window_end: '09:00' });
    const later = await visit({ scheduled_date: '2098-03-10', service_id: paidService.id });

    const rows = await resolve();

    expect(rows.map((row) => row.id)).toEqual([morning, afternoon, later]);
  });

  test('the overlap check starts at the paid visit, so an earlier assessment inside current coverage does not block', async () => {
    await trx('annual_prepay_terms').insert({
      id: randomUUID(),
      customer_id: customerId,
      status: 'active',
      term_start: '2097-02-01',
      term_end: '2098-01-31',
      prepay_amount: 600,
      plan_label: 'Synthetic Existing Coverage',
    });
    const assessmentDate = '2098-01-05';
    await visit({ scheduled_date: assessmentDate, service_type: 'Waves Assessment' });
    await visit({ scheduled_date: '2098-02-10' });
    const message = 'Customer already has an annual prepay term through';

    const paidStart = dateOnlyString((await resolve().first('scheduled_services.scheduled_date')).scheduled_date);
    expect(paidStart).toBe('2098-02-10');
    await expect(lockAndAssertNoAnnualPrepayOverlap(trx, customerId, paidStart, false, message, estimateId))
      .resolves.toBeUndefined();
    // The date the old read would have used (the earliest linked row) lands inside the existing term.
    await expect(lockAndAssertNoAnnualPrepayOverlap(trx, customerId, assessmentDate, false, message, estimateId))
      .rejects.toMatchObject({ annualPrepayOverlap: expect.anything() });
  });
});
