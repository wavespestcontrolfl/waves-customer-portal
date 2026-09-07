// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
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
const { randomUUID } = require('node:crypto');
const { findAcceptedRecurringScheduleGaps } = require('../services/recurring-schedule-audit');
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'synthetic-notification' })) }));
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []), findUnstampedRecurringLawnMembers: jest.fn(async () => []),
}));

postgres('accepted recurring schedules against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let estimateId;
  const now = new Date('2040-01-10T16:00:00Z');

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    // The app loads acceptance's route module at startup. Load its shared
    // pure reader here so Jest's cold transforms are outside a DB test's timer.
    require('../services/plan-rate-ledger').acceptedRecurringBillingLines({});
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    estimateId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted',
      accepted_at: new Date('2040-01-01T16:00:00Z'), accepted_service_mode: 'recurring',
      monthly_total: 100, annual_total: 1200,
      estimate_data: { customerSelection: { frequency: 'monthly' }, result: { recurring: {
        services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'quarterly', visitsPerYear: 4 }],
      } } } });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function visit(overrides = {}) {
    const [row] = await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
      service_type: 'Monthly Pest Control Service', service_key_snapshot: 'pest_general_monthly',
      status: 'pending', scheduled_date: '2040-01-15', source_estimate_id: estimateId,
      is_recurring: true, recurring_pattern: 'monthly', ...overrides }).returning('*');
    return row;
  }
  async function findings() {
    return (await findAcceptedRecurringScheduleGaps({ now }, trx)).filter((gap) => gap.customerId === customerId);
  }

  test('finds an accepted plan without recurring-marked appointments and honours latest stop decisions', async () => {
    expect((await findings())[0].issues).toEqual(['missing_schedule']);
    const root = await visit({ is_recurring: false, recurring_pattern: null, status: 'completed' });
    expect((await findings())[0].issues).toContain('missing_recurrence');
    await trx('recurring_plan_alerts').insert({ customer_id: customerId, recurring_parent_id: root.id,
      alert_type: 'plan_lapsed', resolved_action: 'cancel_series', resolved_at: now });
    expect(await findings()).toEqual([]);
  });

  test('uses parent linkage for unstamped-source children and retained-series evidence', async () => {
    const root = await visit({ source_estimate_id: null });
    await trx('activity_log').insert({ customer_id: customerId, action: 'recurring_series_skipped',
      metadata: { estimateId, existingParentId: root.id } });
    for (let month = 2; month <= 12; month += 1) {
      await visit({ source_estimate_id: null, recurring_parent_id: root.id,
        scheduled_date: `2040-${String(month).padStart(2, '0')}-15` });
    }
    expect(await findings()).toEqual([]);
  });

  test('an explicitly retained series excludes its standalone reservation but still needs every application', async () => {
    const root = await visit({ source_estimate_id: null });
    for (let month = 2; month <= 12; month += 1) {
      await visit({ source_estimate_id: null, recurring_parent_id: root.id,
        scheduled_date: `2040-${String(month).padStart(2, '0')}-15` });
    }
    const reservation = await visit({ is_recurring: false, recurring_pattern: null, scheduled_date: '2040-01-18' });
    expect((await findings())[0].issues).toContain('missing_recurrence');
    const [event] = await trx('activity_log').insert({ customer_id: customerId, action: 'recurring_series_skipped',
      metadata: { estimateId, existingParentId: root.id, reservedServiceId: reservation.id,
        skippedService: reservation.service_type } }).returning('*');
    expect(await findings()).toEqual([]);
    await trx('scheduled_services').where({ recurring_parent_id: root.id, scheduled_date: '2040-12-15' }).update({ status: 'cancelled' });
    expect((await findings())[0].issues).toEqual(['missing_applications']);
    await trx('activity_log').where({ id: event.id }).update({ metadata: { estimateId, existingParentId: root.id } });
    expect((await findings())[0].issues).toContain('missing_recurrence');
  });

  test('retained-series metadata cannot exempt a reservation using another customer\'s series', async () => {
    const otherCustomer = randomUUID();
    await trx('customers').insert({ id: otherCustomer, first_name: 'Synthetic', last_name: 'Other',
      phone: `fixture-${otherCustomer.slice(0, 8)}`, address_line1: '200 Test Lane', city: 'Test City', zip: '00000' });
    const unrelated = await visit({ customer_id: otherCustomer, source_estimate_id: null });
    const reservation = await visit({ is_recurring: false, recurring_pattern: null });
    await trx('activity_log').insert({ customer_id: customerId, action: 'recurring_series_skipped',
      metadata: { estimateId, existingParentId: unrelated.id, reservedServiceId: reservation.id } });
    expect((await findings())[0].issues).toContain('missing_recurrence');
  });

  test('does not use another customer\'s source-estimate stamp as coverage', async () => {
    const otherCustomer = randomUUID();
    await trx('customers').insert({ id: otherCustomer, first_name: 'Synthetic', last_name: 'Other',
      phone: `fixture-${otherCustomer.slice(0, 8)}`, address_line1: '200 Test Lane', city: 'Test City', zip: '00000' });
    await visit({ customer_id: otherCustomer });
    expect((await findings())[0].issues).toEqual(['missing_schedule']);
  });

  test('a second acceptance cannot borrow another estimate\'s completed series', async () => {
    const root = await visit();
    for (let month = 2; month <= 12; month += 1) {
      await visit({ recurring_parent_id: root.id, scheduled_date: `2040-${String(month).padStart(2, '0')}-15` });
    }
    const original = await trx('estimates').where({ id: estimateId }).first();
    const secondEstimateId = randomUUID();
    await trx('estimates').insert({ id: secondEstimateId, customer_id: customerId, status: 'accepted',
      accepted_at: original.accepted_at, estimate_data: original.estimate_data,
      accepted_service_mode: 'recurring', monthly_total: 100, annual_total: 1200 });
    expect(await findings()).toEqual([expect.objectContaining({ estimateId: secondEstimateId, issues: ['missing_schedule'] })]);
  });

  test('scalar rodent acceptance is uncovered until its own quarterly series exists', async () => {
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { results: { rodBaitMo: 25 } } } });
    expect(await findings()).toEqual([expect.objectContaining({ serviceFamily: 'rodent_bait', issues: ['missing_schedule'] })]);
    const rodent = { service_type: 'Quarterly Rodent Bait Station Service', service_key_snapshot: 'rodent_bait_quarterly', recurring_pattern: 'quarterly' };
    const root = await visit(rodent);
    for (const month of ['04', '07', '10']) {
      await visit({ ...rodent, recurring_parent_id: root.id, scheduled_date: `2040-${month}-15` });
    }
    expect(await findings()).toEqual([]);
  });

  test('recent acceptances receive the full 24-hour conversion grace period', async () => {
    await trx('estimates').where({ id: estimateId }).update({ accepted_at: new Date(now.getTime() - 23 * 3600000) });
    expect(await findings()).toEqual([]);
  });

  test('a scalar palm acceptance requires its own semiannual appointments', async () => {
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: {
      recurring: { palmInjectionMo: 25, palmInjectionAnn: 300 }, results: { injection: { appsPerYear: 2 } },
    } } });
    expect(await findings()).toEqual([expect.objectContaining({ serviceFamily: 'palm_injection', issues: ['missing_schedule'] })]);
    const palm = { service_type: 'Semiannual Palm Injection', service_key_snapshot: 'palm_injection_semiannual', recurring_pattern: 'semiannual' };
    const root = await visit(palm);
    await visit({ ...palm, recurring_parent_id: root.id, scheduled_date: '2040-07-15' });
    expect(await findings()).toEqual([]);
  });

  test('legacy acceptances require explicit lineage before asserting schedule gaps', async () => {
    await trx('estimates').where({ id: estimateId }).update({ accepted_service_mode: null });
    const existing = await visit({ source_estimate_id: null });
    expect(await findings()).toEqual([]);
    await trx('scheduled_services').where({ id: existing.id }).update({ source_estimate_id: estimateId });
    expect((await findings())[0].issues).toContain('missing_applications');
  });

  test('stored exception cadence dates preserve the series position in the real reader', async () => {
    const root = await visit();
    for (let month = 2; month <= 12; month += 1) {
      await visit({ recurring_parent_id: root.id, scheduled_date: `2040-${String(month).padStart(2, '0')}-15` });
    }
    await trx('scheduled_services').where({ id: root.id }).update({ scheduled_date: '2040-06-20',
      date_exception: true, date_exception_cadence_date: '2040-01-15' });
    expect(await findings()).toEqual([]);
  });

  test('cadence changes without updated_at writes still get a new incident revision', async () => {
    const root = await visit({ recurring_pattern: 'quarterly' });
    for (let month = 2; month <= 12; month += 1) {
      await visit({ recurring_parent_id: root.id, scheduled_date: `2040-${String(month).padStart(2, '0')}-15` });
    }
    const original = (await findings())[0];
    expect(original.issues).toContain('cadence_differs_from_acceptance');
    // Separate savepoints create distinct tuple transaction versions while
    // the enclosing synthetic fixture is still rolled back after the test.
    await trx.transaction((sp) => sp('scheduled_services').where({ id: root.id }).update({ recurring_pattern: 'monthly' }));
    expect(await findings()).toEqual([]);
    await trx.transaction((sp) => sp('scheduled_services').where({ id: root.id }).update({ recurring_pattern: 'quarterly' }));
    expect((await findings())[0].evidenceKey).not.toBe(original.evidenceKey);
    expect((await trx('scheduled_services').where({ id: root.id }).first()).updated_at).toEqual(root.updated_at);
  });

  test('active holds suppress only their own accepted family until resume', async () => {
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { recurring: {
      services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6 }],
    } } } });
    const [hold] = await trx('plan_holds').insert({ customer_id: customerId, family_key: 'lawn_care',
      starts_on: '2040-01-01', resume_on: '2040-02-01', status: 'active' }).returning('*');
    expect(await findings()).toEqual([]);
    await trx('plan_holds').where({ id: hold.id }).update({ status: 'resumed' });
    expect((await findings())[0].issues).toEqual(['missing_schedule']);
  });

});
