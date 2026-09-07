// Real PostgreSQL round trip; the module DB is bound to a rollback-only
// fixture transaction so the production reader executes its actual queries.
let mockTransaction;
jest.mock('../models/db', () => {
  const query = (...args) => mockTransaction(...args);
  query.raw = (...args) => mockTransaction.raw(...args);
  query.fn = { now: () => mockTransaction.fn.now() };
  return query;
});
jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {} }));
const { randomUUID } = require('crypto');
const { findEligibleCustomers, buildWeeklyEmailDecision, weeklyInputsForCustomer } = require('../services/irrigation-weekly-email');
const { persistWeekPlan } = require('../services/irrigation-week-plan');
const { loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('app watering plans against PostgreSQL', () => {
  let database;
  let customerId;
  let decision;
  const now = new Date('2026-09-07T14:05:00Z');
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    process.env.GATE_IRRIGATION_APP_PLAN = 'true';
    process.env.GATE_IRRIGATION_WEEK_PLAN = 'true';
    process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all' });
  });
  beforeEach(async () => {
    mockTransaction = await database.transaction();
    customerId = randomUUID();
    await mockTransaction('customers').insert({ id: customerId, first_name: 'Sample', phone: '9415550100',
      email: 'sample@example.invalid', active: true, pipeline_stage: 'active_customer',
      address_line1: '100 Fixture Lane', address_line2: 'Unit 1', city: 'Sarasota', zip: '34236', latitude: 27.3, longitude: -82.5 });
    await mockTransaction('property_preferences').insert({ customer_id: customerId, irrigation_system: true,
      irrigation_run_minutes: 20, watering_days: JSON.stringify(['Mon', 'Wed', 'Fri', 'Sun']), irrigation_system_type: JSON.stringify(['spray']), rain_sensor: false });
    await mockTransaction('customer_turf_profiles').insert({ customer_id: customerId, grass_type: 'st_augustine', county: 'Sarasota', active: true });
    await mockTransaction('scheduled_services').insert({ customer_id: customerId, scheduled_date: '2026-09-10',
      service_type: 'Lawn Care Program', status: 'confirmed', is_recurring: true });
    const customers = await findEligibleCustomers({ now, customerId });
    expect(customers).toHaveLength(1);
    decision = buildWeeklyEmailDecision({
      ...weeklyInputsForCustomer(customers[0], { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 },
        weekPlanEnabled: true, planWeekEnd: '2026-09-13', now }),
      forecastRainInches: 1.4, forecastEt0Inches: 1.6,
    });
    expect(decision.weekPlan).toBeTruthy();
    const saved = await persistWeekPlan({ customerId, weekEnding: '2026-09-06', planAsOf: now,
      decisionInputs: decision.decisionInputs, restriction: decision.restriction, plan: decision.weekPlan });
    expect(saved.claimed).toBe(true);
  }, 30000);
  afterEach(async () => { await mockTransaction?.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_IRRIGATION_APP_PLAN;
    delete process.env.GATE_IRRIGATION_WEEK_PLAN;
    delete process.env.IRRIGATION_RESTRICTION_POLICY;
    await database?.destroy();
  });

  test('a new recurring lawn customer qualifies automatically, but the app waits for a sent plan', async () => {
    expect(await loadCustomerWateringPlan(customerId, { now })).toBeNull();
    // Synthetic provider-success fixture; no real email or push is sent.
    await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).update({ sent_at: now });
    const plan = await loadCustomerWateringPlan(customerId, { now });
    expect(plan).not.toBeNull();
    expect(plan.instruction).toBe(decision.payload.week_plan);
    expect(plan.conditionalOnForecast).toBe(true);
    expect(plan).not.toHaveProperty('home');
    expect(await loadCustomerWateringPlan(customerId, { now: new Date('2026-09-14T14:05:00Z') })).toBeNull();
  }, 30000);

  test('current database settings and home identity invalidate the saved instructions', async () => {
    await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).update({ sent_at: now });
    expect(await loadCustomerWateringPlan(customerId, { now })).not.toBeNull();
    await mockTransaction('property_preferences').where({ customer_id: customerId }).update({ irrigation_run_minutes: 40 });
    expect(await loadCustomerWateringPlan(customerId, { now })).toBeNull();
    await mockTransaction('property_preferences').where({ customer_id: customerId }).update({ irrigation_run_minutes: 20 });
    await mockTransaction('customers').where({ id: customerId }).update({ address_line2: 'Unit 2' });
    expect(await loadCustomerWateringPlan(customerId, { now })).toBeNull();
  }, 30000);
  test('the historical dashboard feed cannot expose an old watering instruction', async () => {
    await mockTransaction('customer_alerts').insert([
      { customer_id: customerId, rule_key: 'irrigation_weekly_plan', dedupe_key: 'weekly-fixture', title: 'Old watering plan', body: 'Old instruction' },
      { customer_id: customerId, rule_key: 'lawn_inspection_reassurance', dedupe_key: 'inspection-fixture', title: 'Inspection update', body: 'Inspection detail' },
    ]);
    const { listCustomerAlerts } = require('../services/property-alerts');
    const alerts = await listCustomerAlerts(customerId);
    expect(alerts.map((alert) => alert.ruleKey)).toEqual(['lawn_inspection_reassurance']);
  }, 30000);

});
