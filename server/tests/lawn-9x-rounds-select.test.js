/**
 * GATE_LAWN_9X_ROUNDS (owner 2026-10-28): a NEW residential lawn 9x series is
 * written as recurring_pattern 'lawn_rounds_9' with no interval. One shared
 * helper (lawnRoundsSeriesPattern) decides; every writer that stores a
 * series' pattern calls it, and the parent and every child of one series
 * carry the same value. Off, every series is written exactly as before.
 *
 * This file covers the helper, the seeder's own follow-up rows (which the
 * online booking wizard and the estimate converter write through), the
 * converter's series write, and the converter's quote-prepay decision. The
 * office create has its own harness: lawn-9x-rounds-admin-create.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  withCustomerCommsLock: jest.fn(async (conn, id, fn) => fn(conn)),
}));

const seeder = require('../services/recurring-appointment-seeder');
const converter = require('../services/estimate-converter');
const { resolveWizardSeriesPlan } = require('../services/booking-pay-at-visit');
const { parseETDateTime } = require('../utils/datetime-et');

const { lawnRoundsSeriesPattern, seedFollowUpsForParent, planFollowUpSeedDates, LAWN_ROUNDS_9 } = seeder;

afterEach(() => { delete process.env.GATE_LAWN_9X_ROUNDS; });
const gateOn = () => { process.env.GATE_LAWN_9X_ROUNDS = 'true'; };

describe('lawnRoundsSeriesPattern', () => {
  const cases = [
    ['residential lawn every_6_weeks', { pattern: 'every_6_weeks', intervalDays: null, service_type: 'Lawn Care' }, true],
    ['residential lawn custom/42', { pattern: 'custom', intervalDays: 42, service_type: 'Lawn Care' }, true],
    ['residential lawn custom/"42" (string)', { pattern: 'custom', intervalDays: '42', service_type: 'Lawn Care' }, true],
    ['lawn identified by catalog key lawn_care_6week', { pattern: 'custom', intervalDays: 42, service_key: 'lawn_care_6week', service_type: 'Enhanced Program' }, true],
    ['lawn identified by serviceType (camel) only', { pattern: 'every_6_weeks', serviceType: 'Lawn Care' }, true],
    ['tree and shrub custom/42', { pattern: 'custom', intervalDays: 42, service_type: 'Tree & Shrub Care' }, false],
    ['tree and shrub every_6_weeks', { pattern: 'every_6_weeks', service_type: 'Tree & Shrub Care' }, false],
    ['mosquito every_6_weeks (seasonal row vocabulary)', { pattern: 'every_6_weeks', service_type: 'Mosquito Control' }, false],
    ['mosquito custom/42', { pattern: 'custom', intervalDays: 42, service_type: 'Mosquito Control' }, false],
    ['pest custom/42', { pattern: 'custom', intervalDays: 42, service_type: 'Pest Control' }, false],
    ['palm injection every_6_weeks', { pattern: 'every_6_weeks', service_type: 'Palm Injections' }, false],
    ['commercial lawn every_6_weeks', { pattern: 'every_6_weeks', service_type: 'Commercial Lawn Care' }, false],
    ['commercial lawn by key', { pattern: 'custom', intervalDays: 42, service_key: 'commercial_lawn', service_type: 'Lawn Care' }, false],
    ['commercial lawn by flag', { pattern: 'every_6_weeks', service_type: 'Lawn Care', isCommercial: true }, false],
    ['lawn monthly', { pattern: 'monthly', service_type: 'Lawn Care' }, false],
    ['lawn bimonthly', { pattern: 'bimonthly', service_type: 'Lawn Care' }, false],
    ['lawn custom with another interval', { pattern: 'custom', intervalDays: 30, service_type: 'Lawn Care' }, false],
    ['lawn custom with no interval', { pattern: 'custom', service_type: 'Lawn Care' }, false],
    ['lawn_rounds_9 already', { pattern: LAWN_ROUNDS_9, service_type: 'Lawn Care' }, false],
    ['no identity at all', { pattern: 'every_6_weeks' }, false],
  ];

  test.each(cases)('gate off returns the input unchanged: %s', (_name, input) => {
    expect(lawnRoundsSeriesPattern(input)).toEqual({ pattern: input.pattern, intervalDays: input.intervalDays ?? null });
  });

  test.each(cases)('gate on: %s', (_name, input, translates) => {
    gateOn();
    const out = lawnRoundsSeriesPattern(input);
    if (translates) {
      expect(out).toEqual({ pattern: LAWN_ROUNDS_9, intervalDays: null });
    } else {
      expect(out).toEqual({ pattern: input.pattern, intervalDays: input.intervalDays ?? null });
    }
  });

  test('the gate is read live, not at load', () => {
    const input = { pattern: 'every_6_weeks', service_type: 'Lawn Care' };
    expect(lawnRoundsSeriesPattern(input).pattern).toBe('every_6_weeks');
    gateOn();
    expect(lawnRoundsSeriesPattern(input).pattern).toBe(LAWN_ROUNDS_9);
    delete process.env.GATE_LAWN_9X_ROUNDS;
    expect(lawnRoundsSeriesPattern(input).pattern).toBe('every_6_weeks');
  });
});

// A scripted connection: every insert and every parent update is recorded.
const COLS = Object.fromEntries([
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'service_type', 'service_id', 'service_key_snapshot', 'status', 'notes', 'time_window', 'zone',
  'estimated_duration_minutes', 'estimated_price', 'payment_method_preference', 'source_estimate_id',
  'source', 'is_recurring', 'recurring_pattern', 'recurring_parent_id', 'recurring_ongoing',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days', 'customer_confirmed',
  'confirmed_at', 'skip_weekends', 'weekend_shift', 'appointment_type', 'updated_at',
].map((c) => [c, {}]));

function makeConn() {
  const inserted = [];
  const parentUpdates = [];
  const conn = (table) => {
    if (table === 'scheduled_services') {
      const q = {};
      ['where', 'orWhere', 'whereNotIn', 'select', 'orderBy'].forEach((m) => {
        q[m] = (arg) => { if (typeof arg === 'function') arg.call(q); return q; };
      });
      q.columnInfo = async () => COLS;
      q.update = async (u) => { parentUpdates.push(u); return 1; };
      q.insert = (rows) => ({ returning: async () => { inserted.push(...rows); return rows; } });
      q.first = async () => null;
      q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      q.catch = () => Promise.resolve([]);
      return q;
    }
    if (table === 'services') {
      const q = {
        forShare() { return q; },
        where() { return q; },
        whereRaw() { return q; },
        async select() { return []; },
        async first() { return null; },
      };
      return q;
    }
    if (table === 'property_preferences') return { where: () => ({ first: async () => null }) };
    throw new Error(`unexpected table ${table}`);
  };
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  conn.executionPromise = { then: () => {} };
  conn.raw = async () => ({});
  return { conn, inserted, parentUpdates };
}

const lawnParent = (extra = {}) => ({
  id: 'parent-1',
  customer_id: 'customer-1',
  scheduled_date: '2099-03-17', // a Tuesday, round 3
  service_type: 'Lawn Care',
  service_id: null,
  service_key_snapshot: null,
  status: 'pending',
  ...extra,
});

const gapDays = (a, b) => Math.round((parseETDateTime(`${b}T12:00`) - parseETDateTime(`${a}T12:00`)) / 86400000);

describe('seedFollowUpsForParent — the seeder\'s own follow-up rows (booking wizard, accept, office hand-off)', () => {
  test('gate off: the parent mark and every child keep every_6_weeks, 42 days apart', async () => {
    const { conn, inserted, parentUpdates } = makeConn();
    await seedFollowUpsForParent(conn, lawnParent(), { pattern: 'every_6_weeks', plannedCount: 9, skipWeekends: true });
    expect(parentUpdates[0]).toMatchObject({ is_recurring: true, recurring_pattern: 'every_6_weeks' });
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((r) => r.recurring_pattern === 'every_6_weeks')).toBe(true);
    expect(gapDays('2099-03-17', inserted[0].scheduled_date)).toBeGreaterThanOrEqual(42);
  });

  test('gate on: the parent mark and every child carry lawn_rounds_9 and no interval', async () => {
    gateOn();
    const { conn, inserted, parentUpdates } = makeConn();
    const res = await seedFollowUpsForParent(conn, lawnParent(), { pattern: 'every_6_weeks', plannedCount: 9, skipWeekends: true });
    expect(res.pattern).toBe(LAWN_ROUNDS_9);
    expect(res.insertedCount).toBe(8);
    expect(parentUpdates[0]).toMatchObject({ is_recurring: true, recurring_pattern: LAWN_ROUNDS_9, recurring_interval_days: null });
    expect(inserted).toHaveLength(8);
    for (const row of inserted) {
      expect(row.recurring_pattern).toBe(LAWN_ROUNDS_9);
      expect(row.recurring_interval_days).toBeUndefined();
    }
    // One visit a round: round 3 is taken by the parent, so the next is round 4 (Apr 24 on).
    expect(inserted[0].scheduled_date >= '2099-04-24').toBe(true);
  });

  test('gate on, a parent that already carries custom/42: the interval is dropped on the parent and the children', async () => {
    gateOn();
    const { conn, inserted, parentUpdates } = makeConn();
    await seedFollowUpsForParent(
      conn,
      lawnParent({ recurring_pattern: 'custom', recurring_interval_days: 42 }),
      { pattern: 'custom', plannedCount: 9, skipWeekends: true },
    );
    expect(parentUpdates[0]).toMatchObject({ recurring_pattern: LAWN_ROUNDS_9, recurring_interval_days: null });
    expect(inserted.every((r) => r.recurring_pattern === LAWN_ROUNDS_9 && r.recurring_interval_days === undefined)).toBe(true);
  });

  test('the wizard plans its occupancy locks with the same dates the seed writes', async () => {
    gateOn();
    const { conn, inserted } = makeConn();
    const parent = lawnParent();
    const planned = await planFollowUpSeedDates(conn, parent, { pattern: 'every_6_weeks', plannedCount: 9, skipWeekends: true, weekendShift: 'forward' });
    await seedFollowUpsForParent(conn, parent, { pattern: 'every_6_weeks', plannedCount: 9, skipWeekends: true, weekendShift: 'forward' });
    expect(planned).toEqual(inserted.map((r) => r.scheduled_date));
  });

  test.each([
    ['tree and shrub', 'Tree & Shrub Care', 'every_6_weeks'],
    ['mosquito', 'Mosquito Control', 'every_6_weeks'],
    ['commercial lawn', 'Commercial Lawn Care', 'every_6_weeks'],
  ])('gate on, %s keeps its pattern', async (_name, serviceType, pattern) => {
    gateOn();
    const { conn, inserted, parentUpdates } = makeConn();
    await seedFollowUpsForParent(conn, lawnParent({ service_type: serviceType }), { pattern, plannedCount: 4, skipWeekends: true });
    expect(parentUpdates[0].recurring_pattern).toBe(pattern);
    expect(inserted.every((r) => r.recurring_pattern === pattern)).toBe(true);
  });

  test('gate on, lawn monthly and bimonthly keep their patterns', async () => {
    gateOn();
    for (const pattern of ['monthly', 'bimonthly']) {
      const { conn, inserted, parentUpdates } = makeConn();
      await seedFollowUpsForParent(conn, lawnParent(), { pattern, plannedCount: 3, skipWeekends: true });
      expect(parentUpdates[0].recurring_pattern).toBe(pattern);
      expect(inserted.every((r) => r.recurring_pattern === pattern)).toBe(true);
    }
  });
});

describe('estimate converter series write (seedRecurringFollowUpsForParent)', () => {
  const lawnLine = () => ({
    service: 'lawn_care', name: 'Lawn Care', serviceName: 'Lawn Care', frequency: 'every_6_weeks', visitsPerYear: 9,
  });

  test('the cadence vocabulary stays every_6_weeks on both sides of the gate (quote line, seeding gate, catalog link)', () => {
    for (const on of [false, true]) {
      if (on) gateOn();
      expect(converter.converterFollowUpSeedingPattern(lawnLine(), { service_type: 'Lawn Care' }, 'every_6_weeks')).toBe('every_6_weeks');
      expect(converter.supportsConverterFollowUpSeeding(lawnLine(), { service_type: 'Lawn Care' }, 'every_6_weeks')).toBe(true);
    }
  });

  test('gate off: parent and children are written every_6_weeks', async () => {
    const { conn, inserted, parentUpdates } = makeConn();
    await converter.seedRecurringFollowUpsForParent(conn, lawnParent(), lawnLine(), { registerReminders: false });
    expect(parentUpdates[0].recurring_pattern).toBe('every_6_weeks');
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((r) => r.recurring_pattern === 'every_6_weeks')).toBe(true);
  });

  test('gate on: parent and children are written lawn_rounds_9 with no interval', async () => {
    gateOn();
    const { conn, inserted, parentUpdates } = makeConn();
    await converter.seedRecurringFollowUpsForParent(conn, lawnParent(), lawnLine(), { registerReminders: false });
    expect(parentUpdates[0].recurring_pattern).toBe(LAWN_ROUNDS_9);
    // The accept's parent carries no interval, so none is written to the parent or a child.
    expect(parentUpdates[0].recurring_interval_days ?? null).toBeNull();
    expect(inserted).toHaveLength(8);
    expect(inserted.every((r) => r.recurring_pattern === LAWN_ROUNDS_9 && r.recurring_interval_days === undefined)).toBe(true);
  });

  test('gate on: a tree and shrub 9x line still writes every_6_weeks', async () => {
    gateOn();
    const { conn, inserted, parentUpdates } = makeConn();
    const ts = { service: 'tree_shrub', name: 'Tree & Shrub Care', frequency: 'every_6_weeks', visitsPerYear: 9 };
    await converter.seedRecurringFollowUpsForParent(conn, lawnParent({ service_type: 'Tree & Shrub Care' }), ts, { registerReminders: false });
    expect(parentUpdates[0].recurring_pattern).toBe('every_6_weeks');
    expect(inserted.every((r) => r.recurring_pattern === 'every_6_weeks')).toBe(true);
  });

  test('gate on: a commercial lawn line is never seeded, so never translated', async () => {
    gateOn();
    const { conn, inserted } = makeConn();
    const commercial = { ...lawnLine(), name: 'Commercial Lawn Care', serviceName: 'Commercial Lawn Care' };
    const res = await converter.seedRecurringFollowUpsForParent(conn, lawnParent({ service_type: 'Commercial Lawn Care' }), commercial, { registerReminders: false });
    expect(res.pattern).toBeNull();
    expect(inserted).toHaveLength(0);
  });
});

describe('estimate converter quote prepay decision', () => {
  const lawnLine = () => ({ service: 'lawn_care', name: 'Lawn Care', frequency: 'every_6_weeks', visitsPerYear: 9 });

  test('gate off: the prepay term records every_6_weeks, as before', () => {
    expect(converter.annualPrepayCoverageCadence(lawnLine(), 'every_6_weeks')).toBe('every_6_weeks');
  });

  test('gate on: the prepay term would record lawn_rounds_9, which the decision refuses like seasonal_feb_oct', () => {
    gateOn();
    expect(converter.annualPrepayCoverageCadence(lawnLine(), 'every_6_weeks')).toBe(LAWN_ROUNDS_9);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/estimate-converter.js'), 'utf8');
    expect(src).toMatch(/cadence === RecurringAppointmentSeeder\.SEASONAL_FEB_OCT\s*\|\|\s*cadence === RecurringAppointmentSeeder\.LAWN_ROUNDS_9/);
  });

  test('gate on: 6x and 12x lawn and 9x tree and shrub keep their prepay cadences', () => {
    gateOn();
    expect(converter.annualPrepayCoverageCadence({ service: 'lawn_care', name: 'Lawn Care', frequency: 'bimonthly', visitsPerYear: 6 }, 'bimonthly')).toBe('bimonthly');
    expect(converter.annualPrepayCoverageCadence({ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly', visitsPerYear: 12 }, 'monthly')).toBe('monthly');
    expect(converter.annualPrepayCoverageCadence({ service: 'tree_shrub', name: 'Tree & Shrub Care', frequency: 'every_6_weeks', visitsPerYear: 9 }, 'every_6_weeks')).toBe('every_6_weeks');
  });
});

describe('online booking wizard series', () => {
  const lawnEstimate = () => ({
    id: 'est-lawn-9', annual_total: 900, monthly_total: 75,
    estimate_data: { engineResult: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', monthly: 75, annual: 900, perApp: 100, visitsPerYear: 9, frequency: 'every_6_weeks' }] } },
  });

  test('the wizard plan keeps the quote vocabulary on both sides of the gate (the quote authorizes 9 visits)', () => {
    expect(resolveWizardSeriesPlan(lawnEstimate(), 'lawn_care')).toEqual({ pattern: 'every_6_weeks', visits: 9 });
    gateOn();
    expect(resolveWizardSeriesPlan(lawnEstimate(), 'lawn_care')).toEqual({ pattern: 'every_6_weeks', visits: 9 });
  });

  test('gate on: the wizard\'s seeder call writes rounds on the parent and the 8 children it seeds', async () => {
    gateOn();
    const plan = resolveWizardSeriesPlan(lawnEstimate(), 'lawn_care');
    const { conn, inserted, parentUpdates } = makeConn();
    // The wizard inserts the parent with no recurring_pattern and hands the seeder the plan's pattern.
    const bare = lawnParent({ recurring_pattern: undefined });
    await seedFollowUpsForParent(conn, bare, { pattern: plan.pattern, plannedCount: plan.visits, skipWeekends: true, weekendShift: 'forward', recurringOngoing: false });
    expect(parentUpdates[0]).toMatchObject({ recurring_pattern: LAWN_ROUNDS_9, recurring_interval_days: null });
    expect(inserted).toHaveLength(plan.visits - 1);
    expect(inserted.every((r) => r.recurring_pattern === LAWN_ROUNDS_9)).toBe(true);
  });
});
