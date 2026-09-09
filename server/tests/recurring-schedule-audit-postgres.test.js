// recurring-schedule-audit against migrated PostgreSQL: the too-close checks
// use a per-pattern minimum gap in DAYS, so day-gap cadences the month-only
// map used to drop silently (`every_6_weeks`, `custom` with its own
// recurring_interval_days) are audited, a plausible gap is not flagged, and
// a pattern with no known minimum is still excluded rather than guessed.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const { auditRecurringScheduleAnomalies, auditRecurringScheduleCoverage } = require('../services/recurring-schedule-audit');

postgres('recurring schedule anomaly audit against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;

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
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Cadence',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function series({ pattern, intervalDays = null, dates }) {
    const [parent] = await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
      service_type: 'Every 6 Weeks Lawn Care Service', status: 'pending', scheduled_date: dates[0],
      is_recurring: true, recurring_pattern: pattern, recurring_interval_days: intervalDays }).returning('*');
    for (const d of dates.slice(1)) {
      await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
        service_type: 'Every 6 Weeks Lawn Care Service', status: 'pending', scheduled_date: d,
        is_recurring: true, recurring_pattern: pattern, recurring_interval_days: intervalDays, recurring_parent_id: parent.id });
    }
    return parent;
  }
  async function findings() {
    const { anomalies } = await auditRecurringScheduleAnomalies({ limit: 500 }, trx);
    return anomalies.filter((a) => a.customerId === customerId).map((a) => `${a.checkType}:${a.issue}:${a.diffDays}`).sort();
  }

  test('custom series with a 42-day interval: a 20-day gap is too close, a 35-day gap is not', async () => {
    await series({ pattern: 'custom', intervalDays: 42, dates: ['2040-03-01', '2040-03-21', '2040-04-25'] });
    expect(await findings()).toEqual(['child_anchor:child_too_close_to_parent:20', 'consecutive:consecutive_too_close:20']);
  });

  test('every_6_weeks: a 20-day gap is too close, a 30-day gap is not', async () => {
    await series({ pattern: 'every_6_weeks', dates: ['2040-03-01', '2040-03-21', '2040-04-20'] });
    expect(await findings()).toEqual(['child_anchor:child_too_close_to_parent:20', 'consecutive:consecutive_too_close:20']);
  });

  test('quarterly keeps its month-derived minimum (63 days): a 60-day gap is too close', async () => {
    await series({ pattern: 'quarterly', dates: ['2040-03-01', '2040-04-30'] });
    expect(await findings()).toEqual(['child_anchor:child_too_close_to_parent:60', 'consecutive:consecutive_too_close:60']);
  });

  test('a pattern with no known minimum (custom without interval days, unknown label) is excluded, not guessed', async () => {
    await series({ pattern: 'custom', intervalDays: null, dates: ['2040-03-01', '2040-03-02'] });
    await series({ pattern: 'every_fortnight_ish', dates: ['2040-05-01', '2040-05-02'] });
    expect(await findings()).toEqual([]);
  });

  test('coverage measures every series separately and reports pagination instead of claiming a complete book', async () => {
    await series({ pattern: 'quarterly', dates: ['2040-03-01', '2040-05-15'] });
    await series({ pattern: 'custom', intervalDays: 42, dates: ['2040-03-01', '2040-04-12'] });
    const options = { customerId, now: new Date('2040-02-01T12:00:00Z'), limit: 1 };
    const first = await auditRecurringScheduleCoverage(options, trx);
    const second = await auditRecurringScheduleCoverage({ ...options, offset: 1 }, trx);
    expect(first).toMatchObject({ measuredSeries: 1, hasMore: true });
    expect(second).toMatchObject({ measuredSeries: 1, hasMore: false });
    expect(first.series[0].parentId).not.toBe(second.series[0].parentId);
    expect([first, second].map(page => page.series[0].intervals[0].intervalDays).sort((a, b) => a - b)).toEqual([42, 75]);
  });

  test('coverage reads plan holds and the latest same-customer series decision before classifying continuation', async () => {
    const parent = await series({ pattern: 'quarterly', dates: ['2040-03-01'] });
    await trx('scheduled_services').where('id', parent.id).update({ status: 'completed', recurring_ongoing: true });
    const options = { customerId, now: new Date('2040-09-09T12:00:00Z') };
    expect((await auditRecurringScheduleCoverage(options, trx)).series[0].issues).toContain('ongoing_plan_has_no_future_visit');
    await trx('recurring_plan_alerts').insert({ recurring_parent_id: parent.id, customer_id: customerId,
      alert_type: 'plan_lapsed', resolved_action: 'cancel_series', resolved_at: new Date('2040-09-01T12:00:00Z') });
    expect((await auditRecurringScheduleCoverage(options, trx)).series[0]).toMatchObject({ stopped: true, issues: [] });
  });

  test('inactive customers are outside the active-book coverage scan', async () => {
    await series({ pattern: 'quarterly', dates: ['2040-03-01'] });
    await trx('customers').where('id', customerId).update({ active: false });
    expect(await auditRecurringScheduleCoverage({ customerId }, trx)).toMatchObject({ measuredSeries: 0, series: [] });
  });

  test('an active hold pauses the matching service family without concealing other recurring plans', async () => {
    const parent = await series({ pattern: 'every_6_weeks', dates: ['2040-03-01'] });
    await trx('scheduled_services').where('id', parent.id).update({ status: 'completed', recurring_ongoing: true });
    await trx('plan_holds').insert({ customer_id: customerId, family_key: 'lawn_care', starts_on: '2040-09-01', resume_on: '2040-10-01' });
    const result = await auditRecurringScheduleCoverage({ customerId, now: new Date('2040-09-09T12:00:00Z') }, trx);
    expect(result.series[0]).toMatchObject({ paused: true, issues: [] });
  });

  test('coverage follows the current template catalog identity while preserving the completed first visit', async () => {
    const oneTime = await trx('services').where('billing_type', 'one_time').first('id');
    const recurring = await trx('services').where('billing_type', 'recurring').first('id');
    expect(oneTime).toBeDefined(); expect(recurring).toBeDefined();
    const parent = await series({ pattern: 'quarterly', dates: ['2040-03-01', '2040-06-07'] });
    await trx('scheduled_services').where('id', parent.id).update({ status: 'completed', service_id: oneTime.id,
      recurring_template_overrides: { service_id: recurring.id, service_type: 'Current recurring service' } });
    const previous = process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE;
    process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';
    try {
      await jest.isolateModulesAsync(async () => {
        const audit = require('../services/recurring-schedule-audit').auditRecurringScheduleCoverage;
        const result = await audit({ customerId, now: new Date('2040-04-01T12:00:00Z') }, trx);
        expect(result).toMatchObject({ measuredSeries: 1, excludedOneTimeSeries: 0 });
        expect(result.series[0].serviceType).toBe('Current recurring service');
      });
      expect((await trx('scheduled_services').where('id', parent.id).first('service_id')).service_id).toBe(oneTime.id);
    } finally {
      if (previous === undefined) delete process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE;
      else process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = previous;
    }
  });
});
