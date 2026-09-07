// Real PostgreSQL round trip; the module DB is bound to a rollback-only
// fixture transaction so the production reader executes its actual queries.
let mockTransaction;
let mockFailedPlanReads = 0;
jest.mock('../models/db', () => {
  const query = (...args) => {
    const builder = mockTransaction(...args);
    const first = builder.first;
    builder.first = function (...fields) {
      if (args[0] === 'irrigation_week_plans' && fields[0] === 'id' && mockFailedPlanReads > 0) {
        mockFailedPlanReads -= 1;
        return Promise.reject(new Error('Synthetic transport failure before query'));
      }
      return first.apply(this, fields);
    };
    return builder;
  };
  query.raw = (...args) => mockTransaction.raw(...args);
  query.transaction = (...args) => mockTransaction.transaction(...args);
  query.fn = { now: () => mockTransaction.fn.now() };
  return query;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/apns', () => ({ send: jest.fn(async () => ({ ok: true })), status: () => ({ configured: true }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(async () => ({ ok: true })), status: () => ({ configured: true }) }));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(), activeSuppressionsFor: jest.fn(async () => []),
}));
jest.mock('../services/service-report/application-conditions', () => ({
  ...jest.requireActual('../services/service-report/application-conditions'),
  fetchServiceWeekWeather: jest.fn(),
}));
const { randomUUID } = require('crypto');
const { findEligibleCustomers, buildWeeklyEmailDecision, weeklyInputsForCustomer, runWeeklyIrrigationEmailSweep } = require('../services/irrigation-weekly-email');
const { persistWeekPlan, loadCurrentWeekPlan, loadPriorWeekPlan, discardUnsentWeekPlan } = require('../services/irrigation-week-plan');
const { gates } = require('../config/feature-gates');
const EmailTemplateLibrary = require('../services/email-template-library');
const { fetchServiceWeekWeather } = require('../services/service-report/application-conditions');
const { loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('app watering plans against PostgreSQL', () => {
  let database;
  let customerId;
  let decision;
  const originalFetch = global.fetch;
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
    jest.clearAllMocks();
    mockFailedPlanReads = 0;
    delete process.env.GATE_PROPERTY_ALERTS;
    gates.irrigationWeekPlan = true;
    gates.irrigationWeeklyEmail = true;
    process.env.GATE_IRRIGATION_APP_PLAN = 'true';
    process.env.GATE_IRRIGATION_WEEK_PLAN = 'true';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({
      daily: { precipitation_sum: Array(7).fill(0.2), et0_fao_evapotranspiration: Array(7).fill(1.6 / 7) },
      daily_units: { et0_fao_evapotranspiration: 'inch' },
    }) }));
    fetchServiceWeekWeather.mockResolvedValue({ rainInches: 0.6, et0Inches: 1.6 });
    EmailTemplateLibrary.sendTemplate.mockImplementation(async (options) => {
      if (options.onQueued && !await options.onQueued()) return { aborted: true, providerAttempted: false };
      return { sent: true, providerAttempted: true, message: { sent_at: now, provider_message_id: 'synthetic-mail' } };
    });
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
    expect(require('../services/logger').warn).not.toHaveBeenCalled();
    expect(saved.claimed).toBe(true);
  }, 30000);
  afterEach(async () => { jest.useRealTimers(); await mockTransaction?.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_IRRIGATION_APP_PLAN;
    delete process.env.GATE_IRRIGATION_WEEK_PLAN;
    delete process.env.GATE_PROPERTY_ALERTS;
    delete process.env.IRRIGATION_RESTRICTION_POLICY;
    global.fetch = originalFetch;
    gates.irrigationWeekPlan = false;
    gates.irrigationWeeklyEmail = false;
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

  async function resetDraft() {
    await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).delete();
  }

  test.each([false, true])('publishes without an email when the email gate is %s and the customer opted out', async (emailGate) => {
    await resetDraft();
    gates.irrigationWeeklyEmail = emailGate;
    await mockTransaction('notification_prefs').insert({ customer_id: customerId, email_enabled: false });
    await mockTransaction('customers').where({ id: customerId }).update({ email: null });
    expect(await findEligibleCustomers({ now, customerId })).toHaveLength(0);
    expect(await findEligibleCustomers({ now, customerId, includeApp: true })).toHaveLength(1);
    const result = await runWeeklyIrrigationEmailSweep({ now });
    expect(result).toMatchObject({ published: 1, sent: 0, failed: 0 });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    const row = await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first();
    expect(row.published_at).toEqual(now);
    expect(row.sent_at).toBeNull();
    const plan = await loadCustomerWateringPlan(customerId, { now });
    expect(plan).toMatchObject({ availableAt: now.toISOString(), sentAt: null, conditionalOnForecast: true });
    expect(plan.instruction).toBe(decision.payload.week_plan);
    if (process.env.DUMP_DIR) {
      require('fs').writeFileSync(require('path').join(process.env.DUMP_DIR, 'published-plan.json'), JSON.stringify({ available: true, plan }));
    }
  }, 30000);

  test('a failed email cannot erase or replace the published app plan, and retry consumes the same decision', async () => {
    await resetDraft();
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'synthetic-rejection' });
    const first = await runWeeklyIrrigationEmailSweep({ now });
    expect(first).toMatchObject({ published: 1, sent: 0, failed: 1 });
    const original = await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first();
    expect(original.sent_at).toBeNull();
    const firstCall = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    await discardUnsentWeekPlan({ customerId, weekEnding: '2026-09-06', claimToken: original.claim_token });
    expect(await loadCustomerWateringPlan(customerId, { now })).not.toBeNull();
    // Simulate the existing email claim lease expiring; no new lease exists.
    await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).update({ claimed_at: new Date(Date.now() - 180000) });
    fetchServiceWeekWeather.mockRejectedValue(new Error('A retry must use frozen weather'));
    const retry = await runWeeklyIrrigationEmailSweep({ now: new Date('2026-09-07T15:00:00Z') });
    expect(retry).toMatchObject({ published: 0, sent: 1, failed: 0 });
    const secondCall = EmailTemplateLibrary.sendTemplate.mock.calls[1][0];
    expect(secondCall.payload).toEqual(firstCall.payload);
    expect(secondCall.categories).toEqual(firstCall.categories);
    const final = await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first();
    expect(final.decision_hash).toBe(original.decision_hash);
    expect(final.published_at).toEqual(original.published_at);
    expect(final.sent_at).not.toBeNull();
    expect((await loadCurrentWeekPlan(customerId, { now, pinnedAvailableAt: now.toISOString(), strict: true })).availableAt).toEqual(now);
    expect((await runWeeklyIrrigationEmailSweep({ now })).deduped).toBe(1);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(2);
  }, 30000);

  test('an email-disabled customer gets the published plan advisory once through the real bell and alert ledgers', async () => {
    // The final provider fence reads the live clock; freeze Date only while
    // leaving PostgreSQL's sockets and timers real.
    jest.useFakeTimers({ doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    jest.setSystemTime(now);
    await resetDraft();
    process.env.GATE_PROPERTY_ALERTS = 'true';
    await mockTransaction('notification_prefs').insert({ customer_id: customerId, email_enabled: false, weather_alerts: true });
    await mockTransaction('push_subscriptions').insert({ customer_id: customerId, role: 'customer', platform: 'ios',
      device_token: `qa-${randomUUID()}`, subscription_data: '{}', active: true });
    expect((await runWeeklyIrrigationEmailSweep({ now })).published).toBe(1);
    const { runPropertyAlertsSweep } = require('../services/property-alerts');
    expect((await runPropertyAlertsSweep({ now, knex: mockTransaction })).delivered).toBe(1);
    expect((await runPropertyAlertsSweep({ now, knex: mockTransaction })).delivered).toBe(0);
    expect(require('../services/apns').send).toHaveBeenCalledTimes(1);
    expect(require('../services/apns').send.mock.calls[0][1]).toMatchObject({ ephemeral: true });
    expect((await mockTransaction('notifications').where({ recipient_id: customerId })).length).toBe(1);
    const alerts = await mockTransaction('customer_alerts').where({ customer_id: customerId });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload).toMatchObject({ availableAt: now.toISOString(), delivery: { push: { accepted: 1 } } });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect((await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first()).sent_at).toBeNull();
    delete process.env.GATE_PROPERTY_ALERTS;
  }, 30000);

  test("a published decision refuses a different claimant decision and still supplies next week's rain accounting", async () => {
    const original = await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first();
    await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).update({ published_at: now, claimed_at: null });
    const changed = await persistWeekPlan({ customerId, weekEnding: '2026-09-06', planAsOf: now,
      decisionInputs: decision.decisionInputs, restriction: decision.restriction, plan: { ...decision.weekPlan, action: 'hold' } });
    expect(changed).toMatchObject({ claimed: false });
    expect((await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first()).decision_hash).toBe(original.decision_hash);
    expect(await loadPriorWeekPlan({ customerId, weekEnding: '2026-09-13' })).toMatchObject({ events: decision.weekPlan.events });
  }, 30000);

  test.each(['muted', 'gate_off', 'after_cutoff'])('%s never publishes an app-only plan', async (mode) => {
    await resetDraft();
    await mockTransaction('notification_prefs').insert({ customer_id: customerId, email_enabled: false, seasonal_tips: mode !== 'muted' });
    if (mode === 'gate_off') delete process.env.GATE_IRRIGATION_APP_PLAN;
    const at = mode === 'after_cutoff' ? new Date('2026-09-07T16:01:00Z') : now;
    await runWeeklyIrrigationEmailSweep({ now: at });
    expect(await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).whereNotNull('published_at').first()).toBeUndefined();
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  }, 30000);

  test('a late or gate-off retry never sends a contradictory legacy email after publication', async () => {
    await resetDraft();
    gates.irrigationWeeklyEmail = false;
    expect((await runWeeklyIrrigationEmailSweep({ now })).published).toBe(1);
    gates.irrigationWeeklyEmail = true;
    await runWeeklyIrrigationEmailSweep({ now: new Date('2026-09-07T17:00:00Z') });
    delete process.env.GATE_IRRIGATION_APP_PLAN;
    gates.irrigationWeekPlan = false;
    await runWeeklyIrrigationEmailSweep({ now });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  }, 30000);

  test('a moved home or edited schedule during weather fetch cannot be published', async () => {
    await resetDraft();
    fetchServiceWeekWeather.mockImplementationOnce(async () => {
      await mockTransaction('property_preferences').where({ customer_id: customerId }).update({ irrigation_run_minutes: 40 });
      return { rainInches: 0.6, et0Inches: 1.6 };
    });
    const result = await runWeeklyIrrigationEmailSweep({ now });
    expect(result.published).toBe(0);
    expect(await loadCustomerWateringPlan(customerId, { now })).toBeNull();
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  }, 30000);

  test.each(['cutoff', 'app_gate'])('a %s crossed during calculation retains the independent pre-plan email', async (cause) => {
    await resetDraft();
    let time = now;
    fetchServiceWeekWeather.mockImplementationOnce(async () => {
      if (cause === 'cutoff') time = new Date('2026-09-07T16:01:00Z');
      else delete process.env.GATE_IRRIGATION_APP_PLAN;
      return { rainInches: 0.6, et0Inches: 1.6 };
    });
    const result = await runWeeklyIrrigationEmailSweep({ now, clock: () => time });
    expect(result).toMatchObject({ published: 0, sent: 1, failed: 0 });
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.payload.week_plan).toBeUndefined();
    expect(call.categories.some(category => category.startsWith('plan:'))).toBe(false);
    expect(await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).whereNotNull('published_at').first()).toBeUndefined();
  }, 30000);

  test('closing the email window after publication retains the plan and sends no legacy fallback', async () => {
    await resetDraft();
    let time = now;
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async (options) => {
      time = new Date('2026-09-07T16:01:00Z');
      expect(await options.onQueued()).toBe(false);
      return { aborted: true, providerAttempted: false };
    });
    const result = await runWeeklyIrrigationEmailSweep({ now, clock: () => time });
    expect(result).toMatchObject({ published: 1, sent: 0, plan: { window_closed: 1 } });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(await loadCustomerWateringPlan(customerId, { now: time })).not.toBeNull();
  }, 30000);

  test.each([1, 2])('an unreadable sent check never authorizes a fallback over a published plan (%s failed reads)', async (failedReads) => {
    await resetDraft();
    gates.irrigationWeeklyEmail = false;
    expect((await runWeeklyIrrigationEmailSweep({ now })).published).toBe(1);
    gates.irrigationWeeklyEmail = true;
    mockFailedPlanReads = failedReads;
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async (options) => {
      expect(await options.onQueued()).toBe(false);
      return { aborted: true, providerAttempted: false };
    });
    const result = await runWeeklyIrrigationEmailSweep({ now });
    expect(result.sent).toBe(0);
    expect(result.plan.claim_error).toBeGreaterThan(0);
    expect(await loadCustomerWateringPlan(customerId, { now })).not.toBeNull();
  }, 30000);

  test('a gate-off retry crossing the cutoff cannot fall back over an app publication', async () => {
    await resetDraft();
    gates.irrigationWeeklyEmail = false;
    expect((await runWeeklyIrrigationEmailSweep({ now })).published).toBe(1);
    await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).update({ claimed_at: null });
    gates.irrigationWeeklyEmail = true;
    delete process.env.GATE_IRRIGATION_APP_PLAN;
    let time = now;
    EmailTemplateLibrary.sendTemplate.mockImplementation(async (options) => {
      time = new Date('2026-09-07T16:01:00Z');
      expect(await options.onQueued()).toBe(false);
      return { aborted: true, providerAttempted: false };
    });
    const result = await runWeeklyIrrigationEmailSweep({ now, clock: () => time });
    expect(result.sent).toBe(0);
    expect(result.plan.window_closed).toBe(1);
    expect((await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first()).published_at).toEqual(now);
  }, 30000);

  test('a customer merge retains the published plan over a draft without recording an email send', async () => {
    const loser = randomUUID();
    await mockTransaction('customers').insert({ id: loser, first_name: 'Sample', phone: '9415550101', active: true });
    const draft = await mockTransaction('irrigation_week_plans').where({ customer_id: customerId }).first();
    const [published] = await mockTransaction('irrigation_week_plans').insert({ ...draft, id: randomUUID(), customer_id: loser, published_at: now }).returning('*');
    const { repointWeekPlansKeepAvailable } = require('../services/customer-dedupe')._test;
    await repointWeekPlansKeepAvailable(mockTransaction, 'irrigation_week_plans', 'customer_id', customerId, loser);
    expect(await mockTransaction('irrigation_week_plans').where({ customer_id: customerId })).toEqual([
      expect.objectContaining({ id: published.id, published_at: now, sent_at: null }),
    ]);
    expect(await mockTransaction('irrigation_week_plans').where({ customer_id: loser })).toHaveLength(0);
    expect((await loadCustomerWateringPlan(customerId, { now })).sentAt).toBeNull();
  }, 30000);

});
