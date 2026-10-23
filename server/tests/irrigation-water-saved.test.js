/**
 * GATE_IRRIGATION_WATER_SAVINGS (owner 2026-10-22, phase 1: gallons only). The "water you saved" sentence on the
 * Monday plan: the gallons math on the owner default and on a schedule on file, where the sentence prints and where it
 * stays silent, and the freeze rule (a NEW decision reads the gate once and writes decisionInputs.waterSaved; replay
 * and the app card read the stored block, never the gate or today's lawn size).
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

const { buildWeekPlan, HEAD_PRECIP_RATE_IN_PER_HR, OWNER_HEAD_RATE_IN_PER_HR } = require('../../packages/irrigation-runtime');
const { waterSavedForDecision, waterSavedSentence, WATER_SAVED_CONSTANTS } = require('../services/irrigation-water-saved');
const { renderWeekPlanEmail, decideWeekPlan, loadCurrentWeekPlan } = require('../services/irrigation-week-plan');
const { buildWeeklyEmailDecision, weeklyInputsForCustomer, findEligibleCustomers, replayWeekPlanForCustomer } = require('../services/irrigation-weekly-email');
const { loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const { buildIrrigationAdvice } = require('../services/service-report/irrigation-advice');

const now = new Date('2026-09-07T14:05:00Z');
const ONE_DAY = { maxDaysPerWeek: 1, label: 'Synthetic test policy', expiresOn: '2099-12-31', hoursNote: 'on your assigned day' };
const TWO_DAY = { ...ONE_DAY, maxDaysPerWeek: 2 };
const gateOn = () => { process.env.GATE_IRRIGATION_WATER_SAVINGS = 'true'; };
const gateOff = () => { delete process.env.GATE_IRRIGATION_WATER_SAVINGS; };

afterEach(() => {
  gateOff();
  delete process.env.GATE_IRRIGATION_APP_PLAN;
  delete process.env.GATE_IRRIGATION_WEEK_PLAN;
  delete process.env.IRRIGATION_RESTRICTION_POLICY;
  jest.clearAllMocks();
});

describe('waterSavedForDecision — the gallons block', () => {
  test('owner default when no schedule is on file: 20 minutes, twice a week, half an inch (5,000 sq ft → 1,550 per run, 3,100 a week)', () => {
    const block = waterSavedForDecision({ lawnSqft: 5000, rates: OWNER_HEAD_RATE_IN_PER_HR });
    expect(block).toEqual({ v: 1, basis: 'default', lawnSqft: 5000, depthInches: 0.5, runsPerWeek: 2, gallonsPerRun: 1550, gallonsPerWeek: 3100 });
    expect(WATER_SAVED_CONSTANTS).toMatchObject({ DEFAULT_RUN_MINUTES: 20, DEFAULT_RUNS_PER_WEEK: 2, DEFAULT_DEPTH_PER_RUN_INCHES: 0.5, GALLONS_PER_INCH_PER_1000_SQFT: 623 });
  });

  test('a schedule on file outranks the default: zone minutes × the decision\'s head rate table, per run', () => {
    // 20 min on spray: 0.5" per run on the package table (1.5 in/hr), 0.33" on the owner table (1.0 in/hr).
    const pkg = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'], rates: HEAD_PRECIP_RATE_IN_PER_HR });
    expect(pkg).toMatchObject({ basis: 'schedule', depthInches: 0.5, runsPerWeek: 2, gallonsPerRun: 1550, gallonsPerWeek: 3100 });
    const owner = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'], rates: OWNER_HEAD_RATE_IN_PER_HR });
    expect(owner).toMatchObject({ basis: 'schedule', depthInches: 0.33, runsPerWeek: 2, gallonsPerRun: 1050, gallonsPerWeek: 2100 });
  });

  test('a positive typed weekly figure over the watering days outranks the table', () => {
    const block = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], systemType: ['spray'], explicitInchesPerWeek: 2, rates: HEAD_PRECIP_RATE_IN_PER_HR });
    expect(block).toMatchObject({ basis: 'schedule', depthInches: 0.5, runsPerWeek: 4, gallonsPerRun: 1550, gallonsPerWeek: 6200 });
  });

  test('a schedule that derives nothing (mixed heads, drip, no days) falls back to the owner default', () => {
    expect(waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon'], systemType: ['spray', 'rotor'], rates: HEAD_PRECIP_RATE_IN_PER_HR })).toMatchObject({ basis: 'default', gallonsPerRun: 1550 });
    expect(waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: [], systemType: ['spray'], explicitInchesPerWeek: 2, rates: HEAD_PRECIP_RATE_IN_PER_HR })).toMatchObject({ basis: 'default' });
  });

  test('no lawn area, an implausible area, or a figure under 50 gallons → null (never a guessed lawn)', () => {
    expect(waterSavedForDecision({ lawnSqft: null, rates: HEAD_PRECIP_RATE_IN_PER_HR })).toBeNull();
    expect(waterSavedForDecision({ lawnSqft: 0, rates: HEAD_PRECIP_RATE_IN_PER_HR })).toBeNull();
    expect(waterSavedForDecision({ lawnSqft: 250000, rates: HEAD_PRECIP_RATE_IN_PER_HR })).toBeNull();
    expect(waterSavedForDecision({ lawnSqft: 40, rates: HEAD_PRECIP_RATE_IN_PER_HR })).toBeNull();
    // Rounded to the nearest 50: 3,000 sq ft × 0.5" × 0.623 = 934.5 → 950.
    expect(waterSavedForDecision({ lawnSqft: 3000, rates: HEAD_PRECIP_RATE_IN_PER_HR }).gallonsPerRun).toBe(950);
  });

  test('the week total is the DISPLAYED per-run figure × runs, so the two printed numbers add up (codex #6498 r1 P2)', () => {
    // Raw: 934.5 × 2 = 1,869 → 1,850 on its own; the customer reads "950 a run" and must read "1,900 a week".
    expect(waterSavedForDecision({ lawnSqft: 3000, rates: HEAD_PRECIP_RATE_IN_PER_HR })).toMatchObject({ gallonsPerRun: 950, gallonsPerWeek: 1900 });
    const four = waterSavedForDecision({ lawnSqft: 3000, runMinutes: 20, wateringDays: ['Mon', 'Tue', 'Thu', 'Sat'], systemType: ['spray'], rates: HEAD_PRECIP_RATE_IN_PER_HR });
    expect(four.gallonsPerWeek).toBe(four.gallonsPerRun * 4);
  });
});

describe('the sentence — where it prints and where it stays silent', () => {
  const DEFAULT = waterSavedForDecision({ lawnSqft: 5000, rates: HEAD_PRECIP_RATE_IN_PER_HR });
  const SCHEDULE = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'], rates: HEAD_PRECIP_RATE_IN_PER_HR });
  const SPRAY = { runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'] };
  const hold = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 2.5, lastWeekRainInches: 1.75, season: 'peak', restriction: TWO_DAY, ...SPRAY });
  const run = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, ...SPRAY });
  const conditional = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 1.4, season: 'peak', restriction: ONE_DAY, ...SPRAY });
  const prohibited = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: { ...ONE_DAY, maxDaysPerWeek: 0 }, ...SPRAY });

  test('hold, default basis: per run, the whole week, and the typical-run disclaimer with the portal ask', () => {
    expect(hold.action).toBe('hold');
    expect(waterSavedSentence(DEFAULT, hold)).toBe("Each 20-minute run you skip is about 1,550 gallons on your lawn, so skipping both of this week's runs saves about 3,100 gallons. That assumes a typical half-inch run over your lawn's size on file; enter your zone minutes and watering days under Irrigation in your portal and we'll use those instead.");
  });

  test('hold, schedule basis: names the portal schedule, no typical-run disclaimer; 4 runs reads "all 4"', () => {
    expect(waterSavedSentence(SCHEDULE, hold)).toBe("Each run you skip is about 1,550 gallons on your lawn, from the sprinkler schedule in your portal and your lawn's size on file, so skipping both of this week's runs saves about 3,100 gallons.");
    expect(waterSavedSentence({ ...SCHEDULE, runsPerWeek: 4, gallonsPerWeek: 6250 }, hold)).toContain("skipping all 4 of this week's runs saves about 6,250 gallons");
    expect(waterSavedSentence({ ...SCHEDULE, runsPerWeek: 1 }, hold)).toBe("Each run you skip is about 1,550 gallons on your lawn, from the sprinkler schedule in your portal and your lawn's size on file.");
  });

  test('a cool-season cadence hold is conditional (run one cycle if you did not last week): per-run figure only (codex #6498 r5)', () => {
    const cadence = { ...hold, reasons: [...(hold.reasons || []), 'cool_season_cadence'] };
    expect(waterSavedSentence(SCHEDULE, cadence)).toBe("Each run you skip is about 1,550 gallons on your lawn, from the sprinkler schedule in your portal and your lawn's size on file.");
    expect(waterSavedSentence(DEFAULT, cadence)).not.toMatch(/this week's runs/);
  });

  test('run and conditional plans get the per-run figure only (the week may still run)', () => {
    expect(run.action).toBe('run');
    expect(waterSavedSentence(DEFAULT, run)).toBe("Each 20-minute run you skip is about 1,550 gallons on your lawn. That assumes a typical half-inch run over your lawn's size on file; enter your zone minutes and watering days under Irrigation in your portal and we'll use those instead.");
    expect(conditional.conditionalOnForecast).toBe(true);
    expect(waterSavedSentence(SCHEDULE, conditional)).not.toContain('this week\'s runs');
  });

  test('silent: no block, an unavailable plan, or a hold because irrigation is not permitted', () => {
    expect(waterSavedSentence(null, hold)).toBeNull();
    expect(waterSavedSentence(DEFAULT, { action: 'unavailable', reasons: [] })).toBeNull();
    expect(prohibited.reasons).toContain('restriction_prohibits');
    expect(waterSavedSentence(DEFAULT, prohibited)).toBeNull();
  });

  test('renderWeekPlanEmail prints it LAST in plan_note, after the rain rule, and prints nothing without a block', () => {
    const ctx = { firstName: 'Jordan', grassLabel: 'St. Augustine', runMinutes: 20, restriction: ONE_DAY };
    const withBlock = renderWeekPlanEmail(run, { ...ctx, waterSaved: DEFAULT }).plan_note;
    expect(withBlock.endsWith(waterSavedSentence(DEFAULT, run))).toBe(true);
    expect(withBlock.indexOf('if we get ½" or more of rain before your run, skip it.')).toBeLessThan(withBlock.indexOf('Each 20-minute run'));
    const without = renderWeekPlanEmail(run, ctx).plan_note;
    expect(without).not.toMatch(/gallons/);
    expect(renderWeekPlanEmail(run, { ...ctx, waterSaved: null }).plan_note).toBe(without);
  });
});

describe('freeze rule — a NEW decision reads the gate once; stored plans never recompute', () => {
  const advice = buildIrrigationAdvice({ rainfallInches7d: 0.6, et0Inches: 1.6, irrigationInchesPerWeek: 1, grassType: 'st_augustine', serviceDate: '2026-09-06' });
  const decide = (extra = {}) => decideWeekPlan({ advice, grassType: 'st_augustine', lastWeekRainInches: 0.6, forecastRainInches: 0.3, runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'], county: 'Sarasota', planWeekEnd: '2026-09-13', lawnSqft: 5000, now, ...extra });

  beforeEach(() => {
    process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all' });
  });

  test('gate off: no waterSaved key (snapshot shape byte-identical); gate on: the block is frozen in decisionInputs', () => {
    const off = decide();
    expect(Object.keys(off.decisionInputs)).not.toContain('waterSaved');
    expect(JSON.stringify(off.decisionInputs)).not.toMatch(/waterSaved|gallons/);
    gateOn();
    const on = decide();
    expect(on.decisionInputs.waterSaved).toEqual({ v: 1, basis: 'schedule', lawnSqft: 5000, depthInches: 0.5, runsPerWeek: 2, gallonsPerRun: 1550, gallonsPerWeek: 3100 });
    expect(Object.keys(on.decisionInputs).filter((k) => k !== 'waterSaved')).toEqual(Object.keys(off.decisionInputs));
    expect(on.plan).toEqual(off.plan); // the block never shapes the decision
  });

  test('gate on with no lawn area on file: no key, no sentence', () => {
    gateOn();
    expect(Object.keys(decide({ lawnSqft: null }).decisionInputs)).not.toContain('waterSaved');
  });

  test('a passed block is used verbatim, whatever the gate reads; null means a row without one', () => {
    const frozen = { v: 1, basis: 'default', lawnSqft: 4000, depthInches: 0.5, runsPerWeek: 2, gallonsPerRun: 1250, gallonsPerWeek: 2500 };
    expect(decide({ waterSaved: frozen }).decisionInputs.waterSaved).toEqual(frozen); // gate off
    gateOn();
    expect(decide({ waterSaved: frozen, lawnSqft: 9000 }).decisionInputs.waterSaved).toEqual(frozen);
    expect(Object.keys(decide({ waterSaved: null }).decisionInputs)).not.toContain('waterSaved');
  });
});

describe('end to end — sweep inputs, the email note, replay and the app card', () => {
  const customer = {
    id: 'fixture-customer', first_name: 'Sample', email: 'sample@example.invalid',
    address_line1: '100 Fixture Lane', address_line2: 'Unit 1', city: 'Sarasota', zip: '34236',
    latitude: 27.3, longitude: -82.5, grass_type: 'st_augustine', turf_county: 'Sarasota', turf_lawn_sqft: 5000,
    irrigation_run_minutes: null, watering_days: null, irrigation_system_type: null, irrigation_system: true,
    irrigation_inches_per_week: 1, rain_sensor: false,
  };
  // A January week with a soaking: a cool-season target the carryover covers, so the plan is a hold (the week clause prints).
  const JAN = new Date('2026-01-19T12:00:00Z');
  const inputsFor = (c, extra = {}) => weeklyInputsForCustomer(c, { weekEnding: '2026-01-18', weekWeather: { rainInches: 1.5, et0Inches: 0.8 }, weekPlanEnabled: true, planWeekEnd: '2026-01-25', now: JAN, ...extra });
  const decideFor = (c, extra = {}) => buildWeeklyEmailDecision({ ...inputsFor(c, extra), forecastRainInches: 0.1, forecastEt0Inches: 0.8 });

  beforeEach(() => {
    process.env.GATE_IRRIGATION_APP_PLAN = 'true';
    process.env.GATE_IRRIGATION_WEEK_PLAN = 'true';
    process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned days', coverage: 'all' });
  });

  test('the sweep reads tp.lawn_sqft and withholds it after a move until a LAWN-SIZE writer re-establishes it (codex #6498 r1 P2)', () => {
    expect(inputsFor(customer).lawnSqft).toBe(5000);
    expect(inputsFor({ ...customer, turf_lawn_sqft: null }).lawnSqft).toBeNull();
    const moved = { ...customer, irrigation_home_changed_at: '2026-09-01T00:00:00Z' };
    expect(inputsFor({ ...moved, irrigation_confirmed_fields: '[]' }).lawnSqft).toBeNull();
    // A grass-only review says nothing about the former home's size: still withheld.
    expect(inputsFor({ ...moved, irrigation_confirmed_fields: JSON.stringify(['turf_grass']) }).lawnSqft).toBeNull();
    // A measured lawn releases the area even while the grass is still the old profile's.
    expect(inputsFor({ ...moved, irrigation_confirmed_fields: JSON.stringify(['turf_lawn_sqft']) }).lawnSqft).toBe(5000);
    expect(inputsFor({ ...moved, irrigation_confirmed_fields: JSON.stringify(['turf_lawn_sqft']) }).grassType).toBeNull();
    const sweep = require('fs').readFileSync(require.resolve('../services/irrigation-weekly-email'), 'utf8');
    expect(sweep).toMatch(/'tp\.lawn_sqft as turf_lawn_sqft',/);
  });

  test('gate off: the plan email and snapshot are exactly as before; gate on: a typed-inches-only customer gets the default-basis sentence on a hold', () => {
    const off = decideFor(customer);
    expect(off.weekPlan.action).toBe('hold');
    expect(off.payload.plan_note).not.toMatch(/gallons/);
    expect(Object.keys(off.decisionInputs)).not.toContain('waterSaved');
    gateOn();
    const on = decideFor(customer);
    expect(on.weekPlan).toEqual(off.weekPlan);
    // Typed weekly inches with no watering days derive no per-run depth, so the owner default stands in.
    expect(on.decisionInputs.waterSaved).toMatchObject({ basis: 'default', lawnSqft: 5000, gallonsPerRun: 1550, gallonsPerWeek: 3100 });
    expect(on.payload.plan_note).toContain("Each 20-minute run you skip is about 1,550 gallons on your lawn, so skipping both of this week's runs saves about 3,100 gallons.");
    expect(on.payload.plan_note.endsWith("we'll use those instead.")).toBe(true);
  });

  test('setup-schedule email (system on file, no schedule): the owner default prints in the ask, so the line reaches the customers it was meant for (codex #6498 r1 P1)', () => {
    const { TEMPLATE_SETUP_SCHEDULE, TEMPLATE_SETUP_SYSTEM } = require('../services/irrigation-weekly-email');
    const noSchedule = { ...customer, irrigation_inches_per_week: null };
    const off = decideFor(noSchedule);
    expect(off.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(off.payload.schedule_ask).not.toMatch(/gallons/);
    gateOn();
    const on = decideFor(noSchedule);
    expect(on.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(on.payload.schedule_ask.startsWith(off.payload.schedule_ask)).toBe(true);
    expect(on.payload.schedule_ask).toContain(' For a lawn your size, a typical 20-minute run is about 1,550 gallons, so every run you skip after a good rain is real water saved.');
    expect(on.payload.schedule_ask.endsWith("we'll use your own minutes and days for that figure.")).toBe(true);
    // The same customer in the legacy (gate-off plan) path gets it too: the setup ask is shared.
    expect(decideFor(noSchedule, { weekPlanEnabled: false }).payload.schedule_ask).toContain('1,550 gallons');
    // No lawn area, or an area withheld after a move: the ask is exactly as before.
    expect(decideFor({ ...noSchedule, turf_lawn_sqft: null }).payload.schedule_ask).toBe(off.payload.schedule_ask);
    // (Nothing on file to be unconfirmed, so no moved preface; the former home's area is still withheld.)
    const movedAsk = decideFor({ ...noSchedule, irrigation_home_changed_at: '2026-09-01T00:00:00Z', irrigation_confirmed_fields: '[]' }).payload.schedule_ask;
    expect(movedAsk).toBe(off.payload.schedule_ask);
    // No sprinkler system known: nothing to skip, no sentence (setup_system carries no ask at all).
    const noSystem = decideFor({ ...noSchedule, irrigation_system: false, turf_irrigation_type: 'none' });
    expect(noSystem.templateKey).toBe(TEMPLATE_SETUP_SYSTEM);
    expect(noSystem.payload.schedule_ask).toBe('');
    // A passed block (a replay) is used verbatim; null means none.
    expect(decideFor(noSchedule, { waterSaved: null }).payload.schedule_ask).toBe(off.payload.schedule_ask);
    gateOff();
    expect(decideFor(noSchedule, { waterSaved: { v: 1, basis: 'default', lawnSqft: 3000, depthInches: 0.5, runsPerWeek: 2, gallonsPerRun: 950, gallonsPerWeek: 1900 } }).payload.schedule_ask).toContain('about 950 gallons');
  });

  test('replay and the app card read the frozen block: a gate flip or a lawn-size edit after publication changes nothing and withholds nothing', async () => {
    gateOn();
    const decision = decideFor(customer);
    const snapshot = JSON.parse(JSON.stringify({ weekEnding: '2026-01-18', planAsOf: JAN, sentAt: JAN, availableAt: JAN, decisionInputs: decision.decisionInputs, plan: decision.weekPlan, restriction: decision.restriction }));
    gateOff();
    const resized = { ...customer, turf_lawn_sqft: 9000 };
    const replay = replayWeekPlanForCustomer(snapshot, resized);
    expect(replay).not.toBeNull();
    expect(replay.decisionInputs.waterSaved).toEqual(snapshot.decisionInputs.waterSaved);
    expect(replay.payload.plan_note).toBe(decision.payload.plan_note);
    findEligibleCustomers.mockResolvedValue([resized]);
    loadCurrentWeekPlan.mockResolvedValue(snapshot);
    const card = await loadCustomerWateringPlan('fixture-customer', { now: JAN });
    expect(card.note).toBe(decision.payload.plan_note);
    expect(card.note).toContain('about 1,550 gallons');
  });

  test('a snapshot without the block replays silent even when the gate is now on and the lawn has an area', async () => {
    const decision = decideFor(customer);
    const snapshot = JSON.parse(JSON.stringify({ weekEnding: '2026-01-18', planAsOf: JAN, sentAt: JAN, availableAt: JAN, decisionInputs: decision.decisionInputs, plan: decision.weekPlan, restriction: decision.restriction }));
    gateOn();
    const replay = replayWeekPlanForCustomer(snapshot, customer);
    expect(replay).not.toBeNull();
    expect(Object.keys(replay.decisionInputs)).not.toContain('waterSaved');
    expect(replay.payload.plan_note).not.toMatch(/gallons/);
  });
});
