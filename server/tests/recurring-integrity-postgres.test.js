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
const { stampSeriesPrepaid } = require('../services/prepaid-series');
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'synthetic-notification' })) }));
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []), findUnstampedRecurringLawnMembers: jest.fn(async () => []),
}));

postgres('recurring integrity against migrated PostgreSQL', () => {
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

  test('does not use another customer\'s source-estimate stamp as coverage', async () => {
    const otherCustomer = randomUUID();
    await trx('customers').insert({ id: otherCustomer, first_name: 'Synthetic', last_name: 'Other',
      phone: `fixture-${otherCustomer.slice(0, 8)}`, address_line1: '200 Test Lane', city: 'Test City', zip: '00000' });
    await visit({ customer_id: otherCustomer });
    expect((await findings())[0].issues).toEqual(['missing_schedule']);
  });

  test('recent acceptances receive the full 24-hour conversion grace period', async () => {
    await trx('estimates').where({ id: estimateId }).update({ accepted_at: new Date(now.getTime() - 23 * 3600000) });
    expect(await findings()).toEqual([]);
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

  test('the watchdog distinguishes single-visit payments from incomplete manual series coverage', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const paidAt = new Date('2040-01-05T16:00:00Z');
    const root = await visit({ prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    const child = await visit({ recurring_parent_id: root.id, created_at: new Date('2040-01-04T16:00:00Z'), estimated_price: 100 });
    expect((await runInner({ now })).prepayCoverageGaps).toBe(0);
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15', prepaid_method: 'check',
      prepaid_amount: 100, prepaid_at: paidAt });
    const result = await runInner({ now });
    expect(result).toMatchObject({ acceptedScheduleCheckFailed: false, prepayCoverageGaps: 1 });
    const notifications = require('../services/notification-service');
    expect(notifications.notifyAdmin).toHaveBeenCalledWith('alert', expect.any(String), expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ scheduled_service_id: child.id, issue: 'manual_series_stamp_missing' }) }));
  });

  test('manual allocation preserves exact cents across the locked series', async () => {
    const root = await visit();
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15' });
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-03-15' });
    const result = await stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 100, method: 'check', useExistingTransaction: true });
    expect(result.updatedRows.map((row) => Number(row.prepaid_amount))).toEqual([33.33, 33.33, 33.34]);
  });

  test('an annual stamp on a later sibling prevents every manual write', async () => {
    const root = await visit();
    const child = await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15',
      prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100 });
    await expect(stampSeriesPrepaid(trx, { anchorServiceId: root.id, totalAmount: 200, method: 'cash', useExistingTransaction: true }))
      .rejects.toMatchObject({ status: 409 });
    const rows = await trx('scheduled_services').whereIn('id', [root.id, child.id]).orderBy('scheduled_date');
    expect(rows[0].prepaid_amount).toBeNull();
    expect(rows[1].prepaid_method).toBe('annual_prepay_invoice');
    expect(Number(rows[1].prepaid_amount)).toBe(100);
  });
});
