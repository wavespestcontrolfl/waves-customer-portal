/**
 * GATE_IRRIGATION_OWNER_RATES freeze rule (Codex round 1 on #6236): the live gate is read only when a NEW week-plan
 * decision is made. The snapshot records the table in decisionInputs.rateTable (key written ONLY for the owner table, so a
 * gate-off snapshot keeps today's exact shape), and replay plus every renderer of a stored plan read that key. A row
 * without the key is the package table, whatever the gate reads now.
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
const gateOn = () => { process.env.GATE_IRRIGATION_OWNER_RATES = 'true'; };
const gateOff = () => { delete process.env.GATE_IRRIGATION_OWNER_RATES; };

// A customer with a spray head and no typed inches: the plan runs on the default rate table, so its minutes depend on it.
const KNOWN_HEAD = {};
// No head type on file (typed weekly inches only): events-only plan, so the generic "about N minutes on spray zones" sentence.
const NO_HEAD = { irrigation_run_minutes: null, watering_days: null, irrigation_system_type: null, irrigation_inches_per_week: 1 };

function decide({ customerInputs = KNOWN_HEAD, forecast = 0.3, rain = 0.6, snapshotExtra = {} } = {}) {
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
      weekPlanEnabled: true, planWeekEnd: '2026-09-13', now,
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
  gateOff();
  process.env.GATE_IRRIGATION_APP_PLAN = 'true';
  process.env.GATE_IRRIGATION_WEEK_PLAN = 'true';
  process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all' });
});
afterEach(() => {
  gateOff();
  delete process.env.GATE_IRRIGATION_APP_PLAN;
  delete process.env.GATE_IRRIGATION_WEEK_PLAN;
  delete process.env.IRRIGATION_RESTRICTION_POLICY;
});

describe('the rate table keys', () => {
  test('a stored row is the package table unless it says owner; the live gate decides only an unpinned (new) decision', () => {
    expect(storedRateTable({})).toBe('package');
    expect(storedRateTable(null)).toBe('package');
    expect(storedRateTable({ rateTable: 'owner' })).toBe('owner');
    expect(storedRateTable({ rateTable: 'bogus' })).toBe('package');
    gateOn();
    expect(storedRateTable({})).toBe('package');
    expect(resolveRateTable()).toBe('owner');
    expect(resolveRateTable('package')).toBe('package');
    gateOff();
    expect(resolveRateTable()).toBe('package');
    expect(resolveRateTable('owner')).toBe('owner');
  });
  test('the snapshot key exists only for the owner table', () => {
    expect(rateTableInputs('package')).toEqual({});
    expect(rateTableInputs('owner')).toEqual({ rateTable: 'owner' });
  });
});

describe('a NEW decision reads the live gate and freezes it', () => {
  test('gate off: package minutes and NO rateTable key (snapshot shape identical to main)', () => {
    const { decision, snapshot } = decide();
    expect(decision.weekPlan).toMatchObject({ rateSource: 'system_type_default', rateInPerHr: 1.5 });
    expect(Object.keys(snapshot.decisionInputs)).not.toContain('rateTable');
    // The exact key list main writes, in order, so the claim hash of a gate-off snapshot cannot move.
    expect(Object.keys(snapshot.decisionInputs)).toEqual([
      'targetInches', 'lastWeekTargetInches', 'appliedInches', 'priorWeekEvents', 'priorWeekPrescribedInches',
      'priorWeekCreditedInches', 'priorWeekRainOverride', 'priorWeekSkippedRunInches', 'rainOnlyCarryover',
      'lastWeekRainInches', 'rainKnown', 'forecastRainInches', 'planMonth', 'grassType', 'forecastEt0Inches',
      'targetBasis', 'runMinutes', 'wateringDays', 'headTypes', 'explicitInchesPerWeek', 'rainSensor', 'county',
      'planWeekEnd', 'home', 'rainfallInches7d', 'et0Inches', 'rainSource', 'scheduleSource', 'scheduleUnconfirmed',
    ]);
    expect(JSON.stringify(snapshot.decisionInputs)).not.toMatch(/rateTable/);
  });

  test('gate on: owner minutes and rateTable "owner" frozen in decisionInputs', () => {
    const off = decide().decision;
    gateOn();
    const { decision, snapshot } = decide();
    expect(decision.weekPlan).toMatchObject({ rateSource: 'system_type_default', rateInPerHr: 1 });
    expect(decision.weekPlan.minutesPerEvent).toBeGreaterThan(off.weekPlan.minutesPerEvent);
    expect(snapshot.decisionInputs.rateTable).toBe('owner');
    // Everything but the key and the table's own consequences matches the gate-off decision's inputs.
    expect(Object.keys(snapshot.decisionInputs).filter((k) => k !== 'rateTable')).toEqual(Object.keys(off.decisionInputs));
  });

  test('the claim hash covers the frozen table: an owner snapshot hashes differently from a package one', () => {
    const pkg = decide().snapshot;
    gateOn();
    const owner = decide().snapshot;
    expect(_private.decisionHash(owner.plan, owner.decisionInputs, owner.restriction))
      .not.toBe(_private.decisionHash(pkg.plan, pkg.decisionInputs, pkg.restriction));
  });
});

describe('gate flips ON after a package-table snapshot (legacy row, no key)', () => {
  test('known head: replay equal, app plan still loads, minutes and sentences unchanged', async () => {
    const { customer, snapshot, decision } = decide();
    const before = await loadCustomerWateringPlan('fixture-customer', { now });
    gateOn();
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const after = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(after).not.toBeNull();
    expect(after).toEqual(before);
    expect(after.instruction).toBe(decision.payload.week_plan);
    expect(after.note).toBe(decision.payload.plan_note || '');
    expect(after.note).toContain('from University of Florida turf guidance');
    expect(snapshot.plan.rateInPerHr).toBe(1.5);
  });

  test('no head: the generic sentence stays 20 / 60 in the app plan and the report card', async () => {
    const { customer, snapshot } = decide({ customerInputs: NO_HEAD });
    gateOn();
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const plan = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(plan).not.toBeNull();
    expect(plan.instruction).toMatch(/about 20 minutes on spray zones and 60 on rotor zones|about 20 minutes on spray zones, 60 on rotor zones/);
    expect(JSON.stringify(plan)).not.toMatch(/30 minutes on spray/);
  });

  test('a hold or conditional plan keeps its "20 / 60" fallback sentence in the report card (buildReportWeekPlan)', () => {
    const { snapshot } = decide({ customerInputs: NO_HEAD, forecast: 1.4 }); // conditional on forecast, no head
    gateOn();
    const card = buildReportWeekPlan(snapshot, '2026-09-08');
    expect(card).not.toBeNull();
    expect(card.detail).toMatch(/about 20 minutes on spray zones, 60 on rotor zones/);
    expect(JSON.stringify(card)).not.toMatch(/30 minutes on spray/);
  });

  test('a changed customer input still withholds the plan (the freeze does not loosen the validity check)', async () => {
    const { customer } = decide();
    gateOn();
    findEligibleCustomers.mockResolvedValue([{ ...customer, irrigation_run_minutes: 35 }]);
    expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
  });
});

describe('gate flips OFF after an owner-table snapshot', () => {
  test('known head: replay equal, app plan still loads with the owner minutes and no UF attribution', async () => {
    gateOn();
    const { customer, snapshot, decision } = decide();
    expect(snapshot.decisionInputs.rateTable).toBe('owner');
    const before = await loadCustomerWateringPlan('fixture-customer', { now });
    gateOff();
    expect(replayWeekPlanForCustomer(snapshot, customer)).not.toBeNull();
    const after = await loadCustomerWateringPlan('fixture-customer', { now });
    expect(after).not.toBeNull();
    expect(after).toEqual(before);
    expect(after.instruction).toBe(decision.payload.week_plan);
    expect(after.note).not.toMatch(/University of Florida/);
    expect(snapshot.plan.rateInPerHr).toBe(1);
  });

  test('no head: the generic sentence stays 30 / 80 in the app plan and the report card', async () => {
    gateOn();
    const { customer, snapshot } = decide({ customerInputs: NO_HEAD, forecast: 1.4 });
    gateOff();
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
  test('a gate-on snapshot whose key is stripped (treated as the old table) no longer replays equal', () => {
    gateOn();
    const { customer, snapshot } = decide();
    const stripped = JSON.parse(JSON.stringify(snapshot));
    delete stripped.decisionInputs.rateTable;
    expect(replayWeekPlanForCustomer(stripped, customer)).toBeNull();
  });

  test('the weekly inputs carry a pinned table only when one is given', () => {
    const { customer } = decide();
    const args = { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 }, weekPlanEnabled: true, planWeekEnd: '2026-09-13', now };
    expect(weeklyInputsForCustomer(customer, args)).not.toHaveProperty('rateTable');
    expect(weeklyInputsForCustomer(customer, { ...args, rateTable: 'package' }).rateTable).toBe('package');
  });

  test('a decision pinned to the package table ignores a live gate that is on, and the reverse', () => {
    const base = (rateTable) => buildWeeklyEmailDecision({
      ...weeklyInputsForCustomer(decide().customer, { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 }, weekPlanEnabled: true, planWeekEnd: '2026-09-13', now, rateTable }),
      forecastRainInches: 0.3, forecastEt0Inches: 1.6,
    });
    gateOn();
    expect(base('package').weekPlan.rateInPerHr).toBe(1.5);
    expect(base('package').decisionInputs).not.toHaveProperty('rateTable');
    gateOff();
    expect(base('owner').weekPlan.rateInPerHr).toBe(1);
    expect(base('owner').decisionInputs.rateTable).toBe('owner');
  });
});
