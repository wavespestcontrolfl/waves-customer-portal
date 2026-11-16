/**
 * Freeze rule (Codex round 1 on #6236): a NEW week-plan decision uses the owner table. The snapshot records the table in
 * decisionInputs.rateTable (key written ONLY for the owner table), and replay plus every renderer of a stored plan read
 * that key. A stored row without the key was decided on the package table and keeps its minutes, so a plan decided
 * and sent before the owner table went live never changes. A legacy row is built here by pinning rateTable: 'package'.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/irrigation-week-plan', () => ({
  ...jest.requireActual('../services/irrigation-week-plan'),
  loadCurrentWeekPlan: jest.fn(),
}));
jest.mock('../services/irrigation-weekly-email', () => ({
  ...jest.requireActual('../services/irrigation-weekly-email'),
  findEligibleCustomers: jest.fn(),
}));

const { loadCurrentWeekPlan, _private } = require('../services/irrigation-week-plan');
const { buildWeeklyEmailDecision, weeklyInputsForCustomer, findEligibleCustomers, replayWeekPlanForCustomer } = require('../services/irrigation-weekly-email');
const { loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const { buildReportWeekPlan } = require('../services/service-report/report-data');
const { storedRateTable, resolveRateTable, rateTableInputs } = require('../services/irrigation-rates');

const now = new Date('2026-09-07T14:05:00Z');

// A customer with a spray head and no typed inches: the plan runs on the default rate table, so its minutes depend on it.
const KNOWN_HEAD = {};
// No head type on file (typed weekly inches only): events-only plan, so the generic "about N minutes on spray zones" sentence.
const NO_HEAD = { irrigation_run_minutes: null, watering_days: null, irrigation_system_type: null, irrigation_inches_per_week: 1 };

function decide({ customerInputs = KNOWN_HEAD, forecast = 0.3, rain = 0.6, snapshotExtra = {}, rateTable = undefined } = {}) {
  const customer = {
    id: 'fixture-customer', first_name: 'Sample', email: 'sample@example.invalid',
    address_line1: '100 Fixture Lane', address_line2: 'Unit 1', city: 'Sarasota', zip: '34236',
    latitude: 27.3, longitude: -82.5, grass_type: 'st_augustine', turf_county: 'Sarasota',
    irrigation_run_minutes: 20, watering_days: ['Mon', 'Wed', 'Fri', 'Sun'],
    irrigation_system_type: ['spray'], irrigation_system: true,
    irrigation_inches_per_week: null, rain_sensor: false,
    ...customerInputs,
  };
  const decision = buildWeeklyEmailDecision({
    ...weeklyInputsForCustomer(customer, {
      weekEnding: '2026-09-06', weekWeather: { rainInches: rain, et0Inches: 1.6 },
      weekPlanEnabled: true, planWeekEnd: '2026-09-13', now, rateTable,
    }),
    forecastRainInches: forecast, forecastEt0Inches: 1.6,
  });
  if (!decision.weekPlan) throw new Error(`Fixture produced no plan: ${decision.reason}`);
  const snapshot = JSON.parse(JSON.stringify({
    weekEnding: '2026-09-06', planAsOf: now, sentAt: now, availableAt: now,
    decisionInputs: decision.decisionInputs, plan: decision.weekPlan, restriction: decision.restriction,
    ...snapshotExtra,
  }));
  findEligibleCustomers.mockResolvedValue([customer]);
  loadCurrentWeekPlan.mockResolvedValue(snapshot);
  return { customer, snapshot, decision };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IRRIGATION_APP_PLAN = 'true';
  process.env.GATE_IRRIGATION_WEEK_PLAN = 'true';
  process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all' });
});
afterEach(() => {
  delete process.env.GATE_IRRIGATION_APP_PLAN;
  delete process.env.GATE_IRRIGATION_WEEK_PLAN;
  delete process.env.IRRIGATION_RESTRICTION_POLICY;
});

describe('the rate table keys', () => {
  test('a stored row is the package table unless it says owner; only an unpinned (new) decision is the owner table', () => {
    expect(storedRateTable({})).toBe('package');
    expect(storedRateTable(null)).toBe('package');
    expect(storedRateTable({ rateTable: 'owner' })).toBe('owner');
    expect(storedRateTable({ rateTable: 'bogus' })).toBe('package');
    expect(resolveRateTable()).toBe('owner');
    expect(resolveRateTable('package')).toBe('package');
    expect(resolveRateTable('owner')).toBe('owner');
  });
  test('the snapshot key exists only for the owner table', () => {
    expect(rateTableInputs('package')).toEqual({});
    expect(rateTableInputs('owner')).toEqual({ rateTable: 'owner' });
  });
});

describe('a NEW decision uses the owner table and freezes it', () => {
  test('owner minutes and rateTable "owner" frozen in decisionInputs', () => {
    const { decision, snapshot } = decide();
    expect(decision.weekPlan).toMatchObject({ rateSource: 'system_type_default', rateInPerHr: 1 });
    expect(snapshot.decisionInputs.rateTable).toBe('owner');
  });

  test('a pinned package-table decision (legacy shape): package minutes and NO rateTable key', () => {
    const owner = decide();
    const { decision, snapshot } = decide({ rateTable: 'package' });
    expect(decision.weekPlan).toMatchObject({ rateSource: 'system_type_default', rateInPerHr: 1.5 });
    expect(decision.weekPlan.minutesPerEvent).toBeLessThan(owner.decision.weekPlan.minutesPerEvent);
    expect(Object.keys(snapshot.decisionInputs)).not.toContain('rateTable');
    // The exact key list a legacy row carries, in order, so the claim hash of a stored legacy snapshot cannot move.
    expect(Object.keys(snapshot.decisionInputs)).toEqual([
      'targetInches', 'lastWeekTargetInches', 'appliedInches', 'priorWeekEvents', 'priorWeekPrescribedInches',
      'priorWeekCreditedInches', 'priorWeekRainOverride', 'priorWeekSkippedRunInches', 'rainOnlyCarryover',
      'lastWeekRainInches', 'rainKnown', 'forecastRainInches', 'planMonth', 'grassType', 'forecastEt0Inches',
      'targetBasis', 'runMinutes', 'wateringDays', 'headTypes', 'explicitInchesPerWeek', 'rainSensor', 'county',
      'planWeekEnd', 'home', 'rainfallInches7d', 'et0Inches', 'rainSource', 'scheduleSource', 'scheduleUnconfirmed',
    ]);
    expect(JSON.stringify(snapshot.decisionInputs)).not.toMatch(/rateTable/);
    // Everything but the key matches the owner decision's inputs.
    expect(Object.keys(owner.snapshot.decisionInputs).filter((k) => k !== 'rateTable')).toEqual(Object.keys(snapshot.decisionInputs));
  });

  test('the claim hash covers the frozen table: an owner snapshot hashes differently from a package one', () => {
    const pkg = decide({ rateTable: 'package' }).snapshot;
    const owner = decide().snapshot;
    expect(_private.decisionHash(owner.plan, owner.decisionInputs, owner.restriction))
      .not.toBe(_private.decisionHash(pkg.plan, pkg.decisionInputs, pkg.restriction));
  });
});

describe('a stored package-table snapshot (legacy row, no key) keeps its minutes', () => {
  test('known head: replay equal, app plan still loads, minutes and sentences unchanged', async () => {
    const { customer, snapshot, decision } = decide({ rateTable: 'package' });
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const after = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(after).not.toBeNull();
    expect(after.instruction).toBe(decision.payload.week_plan);
    expect(after.note).toBe(decision.payload.plan_note || '');
    expect(after.note).toContain('from University of Florida turf guidance');
    expect(snapshot.plan.rateInPerHr).toBe(1.5);
  });

  test('no head: the generic sentence stays 20 / 60 in the app plan and the report card', async () => {
    const { customer, snapshot } = decide({ customerInputs: NO_HEAD, rateTable: 'package' });
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const plan = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(plan).not.toBeNull();
    expect(plan.instruction).toMatch(/about 20 minutes on spray zones and 60 on rotor zones|about 20 minutes on spray zones, 60 on rotor zones/);
    expect(JSON.stringify(plan)).not.toMatch(/30 minutes on spray/);
  });

  test('a hold or conditional plan keeps its "20 / 60" fallback sentence in the report card (buildReportWeekPlan)', () => {
    const { snapshot } = decide({ customerInputs: NO_HEAD, forecast: 1.4, rateTable: 'package' }); // conditional on forecast, no head
    const card = buildReportWeekPlan(snapshot, '2026-09-08');
    expect(card).not.toBeNull();
    expect(card.detail).toMatch(/about 20 minutes on spray zones, 60 on rotor zones/);
    expect(JSON.stringify(card)).not.toMatch(/30 minutes on spray/);
  });

  test('a changed customer input still withholds the plan (the freeze does not loosen the validity check)', async () => {
    const { customer } = decide({ rateTable: 'package' });
    findEligibleCustomers.mockResolvedValue([{ ...customer, irrigation_run_minutes: 35 }]);
    expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
  });
});

describe('an owner-table snapshot', () => {
  test('known head: replay equal, app plan loads with the owner minutes and no UF attribution', async () => {
    const { customer, snapshot, decision } = decide();
    expect(snapshot.decisionInputs.rateTable).toBe('owner');
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const after = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(after).not.toBeNull();
    expect(after.instruction).toBe(decision.payload.week_plan);
    expect(after.note).not.toMatch(/University of Florida/);
    expect(snapshot.plan.rateInPerHr).toBe(1);
  });

  test('no head: the generic sentence is 30 / 80 in the app plan and the report card', async () => {
    const { customer, snapshot } = decide({ customerInputs: NO_HEAD, forecast: 1.4 });
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const plan = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(plan).not.toBeNull();
    expect(plan.notificationBody).toMatch(/about 30 minutes on spray zones, 80 on rotor zones/);
    expect(plan.instruction).toMatch(/about 30 minutes on spray zones, 80 on rotor zones/);
    const card = buildReportWeekPlan(snapshot, '2026-09-08');
    expect(card.detail).toMatch(/about 30 minutes on spray zones, 80 on rotor zones/);
    expect(JSON.stringify([plan, card])).not.toMatch(/about 20 minutes on spray/);
  });
});

describe('replay is pinned to the stored table', () => {
  test('an owner snapshot whose key is stripped (treated as the old table) no longer replays equal', () => {
    const { customer, snapshot } = decide();
    const stripped = JSON.parse(JSON.stringify(snapshot));
    delete stripped.decisionInputs.rateTable;
    expect(replayWeekPlanForCustomer(stripped, customer)).toBeNull();
  });

  test('the weekly inputs always carry the table the decision is pinned to: the given one, else the owner table', () => {
    const { customer } = decide();
    const args = { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 }, weekPlanEnabled: true, planWeekEnd: '2026-09-13', now };
    expect(weeklyInputsForCustomer(customer, args).rateTable).toBe('owner');
    expect(weeklyInputsForCustomer(customer, { ...args, rateTable: 'package' }).rateTable).toBe('package');
  });

  test('a decision pinned to a table keeps it', () => {
    const base = (rateTable) => buildWeeklyEmailDecision({
      ...weeklyInputsForCustomer(decide().customer, { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 }, weekPlanEnabled: true, planWeekEnd: '2026-09-13', now, rateTable }),
      forecastRainInches: 0.3, forecastEt0Inches: 1.6,
    });
    expect(base('package').weekPlan.rateInPerHr).toBe(1.5);
    expect(base('package').decisionInputs).not.toHaveProperty('rateTable');
    expect(base('owner').weekPlan.rateInPerHr).toBe(1);
    expect(base('owner').decisionInputs.rateTable).toBe('owner');
  });
});

// Codex round 2 on #6236: the move guard (does a confirmed runtime YIELD a figure?) derives inches, and the 5-inch
// plausibility ceiling is crossed at different minutes under the two tables. It must use the decision's own table.
// Spray 60 min x 4 days is 6.0 in on the package table (declined, so the stale tech reading wins and the plan is
// events-only) and 4.0 in on the owner table (derives, so the confirmed schedule sizes the plan).
describe('the move guard follows the decision\'s table (stale fallback, 60 min x 4 days on spray)', () => {
  const MOVED_STALE = {
    irrigation_run_minutes: 60,
    watering_days: ['Mon', 'Tue', 'Thu', 'Fri'],
    irrigation_system_type: ['spray'],
    irrigation_home_changed_at: '2026-08-20T00:00:00Z',
    irrigation_confirmed_fields: ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type', 'turf_county', 'turf_grass', 'rain_sensor'],
    turf_irrigation_inches_per_week: 1,
  };
  const inputsArgs = { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 }, weekPlanEnabled: true, planWeekEnd: '2026-09-13', now };

  test('a new decision pins ONE table for the guard and the decision', () => {
    const { customer } = decide({ customerInputs: MOVED_STALE });
    expect(weeklyInputsForCustomer(customer, inputsArgs)).toMatchObject({ scheduleUnconfirmed: false, rateTable: 'owner' });
    // An explicit table wins for the guard as well as the decision.
    expect(weeklyInputsForCustomer(customer, { ...inputsArgs, rateTable: 'package' })).toMatchObject({ scheduleUnconfirmed: true, rateTable: 'package' });
    expect(weeklyInputsForCustomer(customer, { ...inputsArgs, rateTable: 'owner' })).toMatchObject({ scheduleUnconfirmed: false, rateTable: 'owner' });
  });

  test.each([
    { table: 'package', unconfirmed: true },
    { table: 'owner', unconfirmed: false },
  ])('a published $table-table plan: replay equal, plan loads, pending email payload identical', async ({ table, unconfirmed }) => {
    const { customer, snapshot, decision } = decide({ customerInputs: MOVED_STALE, rateTable: table });
    expect(snapshot.decisionInputs.scheduleUnconfirmed).toBe(unconfirmed);
    expect(snapshot.decisionInputs.rateTable).toBe(table === 'owner' ? 'owner' : undefined);
    const before = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(before).not.toBeNull();
    const replay = replayWeekPlanForCustomer(snapshot, customer);
    expect(replay).not.toBeNull();
    expect(replay.payload).toEqual(decision.payload);
    expect(replay.weekPlan).toEqual(snapshot.plan);
    const after = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(after).not.toBeNull();
    expect(after).toEqual(before);
  });
});
