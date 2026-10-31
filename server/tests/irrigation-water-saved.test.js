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
const { waterSavedForDecision, waterSavedSentence, waterSavedSetupSentence, WATER_SAVED_CONSTANTS, WATER_RATES_PER_1000_GAL } = require('../services/irrigation-water-saved');
const { renderWeekPlanEmail, decideWeekPlan, loadCurrentWeekPlan } = require('../services/irrigation-week-plan');
const { buildWeeklyEmailDecision, weeklyInputsForCustomer, findEligibleCustomers, replayWeekPlanForCustomer } = require('../services/irrigation-weekly-email');
const { loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const { buildIrrigationAdvice } = require('../services/service-report/irrigation-advice');

const now = new Date('2026-09-07T14:05:00Z');
const ONE_DAY = { maxDaysPerWeek: 1, label: 'Synthetic test policy', expiresOn: '2099-12-31', hoursNote: 'on your assigned day' };
const TWO_DAY = { ...ONE_DAY, maxDaysPerWeek: 2 };
const gateOn = () => { process.env.GATE_IRRIGATION_WATER_SAVINGS = 'true'; };
const gateOff = () => { delete process.env.GATE_IRRIGATION_WATER_SAVINGS; delete process.env.GATE_IRRIGATION_WATER_DOLLARS; };
const dollarsOn = () => { process.env.GATE_IRRIGATION_WATER_DOLLARS = 'true'; };

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

  test('drip beside one turf head is still one head (codex #6498 r7): rotor + drip, 40 min on the owner table → 0.25" per run', () => {
    const block = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 40, wateringDays: ['Mon', 'Thu'], systemType: ['rotor', 'drip'], rates: OWNER_HEAD_RATE_IN_PER_HR });
    expect(block).toMatchObject({ basis: 'schedule', depthInches: 0.25, gallonsPerRun: 800, gallonsPerWeek: 1600 });
  });

  test('a run plan\'s prescribed depth outranks the schedule (codex #6498 r7): the sentence sits beside that run', () => {
    const block = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 40, wateringDays: ['Mon', 'Thu'], systemType: ['rotor'], rates: OWNER_HEAD_RATE_IN_PER_HR, planDepthInches: 0.75, planEvents: 1 });
    expect(block).toMatchObject({ basis: 'plan', depthInches: 0.75, runsPerWeek: 1, gallonsPerRun: 2350, gallonsPerWeek: 2350 });
    expect(waterSavedSentence(block, { action: 'run', reasons: [] })).toBe("Each run you skip is about 2,350 gallons on your lawn, from this week's plan and your lawn's size on file.");
    // null / 0 plan depth (a hold) leaves the schedule or default basis alone.
    expect(waterSavedForDecision({ lawnSqft: 5000, rates: OWNER_HEAD_RATE_IN_PER_HR, planDepthInches: null }).basis).toBe('default');
  });

  test('a schedule that derives nothing (mixed turf heads, drip only, no days) falls back to the owner default', () => {
    expect(waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon'], systemType: ['spray', 'rotor'], rates: HEAD_PRECIP_RATE_IN_PER_HR })).toMatchObject({ basis: 'default', gallonsPerRun: 1550 });
    expect(waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon'], systemType: ['drip'], rates: HEAD_PRECIP_RATE_IN_PER_HR })).toMatchObject({ basis: 'default' });
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

describe('phase 2 — the dollar range for county water (GATE_IRRIGATION_WATER_DOLLARS)', () => {
  const rates = HEAD_PRECIP_RATE_IN_PER_HR;
  const hold = { action: 'hold', reasons: [] };

  test('gate off, or not county water, or no county rate: the block is exactly phase 1 (no dollars key)', () => {
    expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'Manatee' })).not.toHaveProperty('dollars');
    dollarsOn();
    for (const waterSource of ['well', 'reclaimed', null, '']) {
      expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource, county: 'Manatee' })).not.toHaveProperty('dollars');
    }
    expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'Hillsborough' })).not.toHaveProperty('dollars');
    expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: null })).not.toHaveProperty('dollars');
  });

  test('county water in a rated county: whole dollars from the DISPLAYED gallons, irrigation-meter low to house-meter high', () => {
    dollarsOn();
    const block = waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'Manatee' });
    // 1,550 gal × $3.11 = $4.82 → $5; × $10.78 = $16.71 → $17; week 3,100 gal → $10 / $33.
    expect(block.dollars).toEqual({ county: 'Manatee', perThousandLow: 3.11, perThousandHigh: 10.78, runLow: 5, runHigh: 17, weekLow: 10, weekHigh: 33 });
    expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'Manatee County' }).dollars.county).toBe('Manatee');
    expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'sarasota' }).dollars).toMatchObject({ county: 'Sarasota', runLow: 6, runHigh: 20 });
    expect(waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'Charlotte' }).dollars).toMatchObject({ county: 'Charlotte', runLow: 11, runHigh: 26 });
    expect(Object.keys(WATER_RATES_PER_1000_GAL).sort()).toEqual(['Charlotte', 'Manatee', 'Sarasota']);
  });

  test('the sentence: the week\'s money on a whole-week hold, a run\'s money otherwise and on the asks; nothing without the key', () => {
    dollarsOn();
    const block = waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'county', county: 'Manatee' });
    expect(waterSavedSentence(block, hold)).toBe("Each 20-minute run you skip is about 1,550 gallons on your lawn, so skipping both of this week's runs saves about 3,100 gallons. On Manatee County water that is roughly $10 to $33 for the week. That assumes a typical half-inch run over your lawn's size on file; enter your zone minutes and watering days under Irrigation in your portal and we'll use those instead.");
    expect(waterSavedSentence(block, { action: 'run', reasons: [] })).toMatch(/gallons on your lawn\. On Manatee County water that is roughly \$5 to \$17 a run\. That assumes/);
    expect(waterSavedSentence(block, { action: 'hold', reasons: ['cool_season_cadence'] })).toMatch(/\$5 to \$17 a run\./);
    expect(waterSavedSetupSentence(block)).toMatch(/real water saved\. On Manatee County water that is roughly \$5 to \$17 a run\. Once your schedule/);
    expect(waterSavedSetupSentence(block, { scheduleDetailsOnFile: true })).toMatch(/a run\. Once that's in your portal, we'll use your own schedule for that figure\.$/);
    // The closer option never touches a schedule-basis sentence.
    const sched = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'], rates });
    expect(waterSavedSetupSentence(sched, { scheduleDetailsOnFile: true })).toBe(waterSavedSetupSentence(sched));
    const schedule = waterSavedForDecision({ lawnSqft: 5000, runMinutes: 20, wateringDays: ['Mon', 'Thu'], systemType: ['spray'], rates, waterSource: 'county', county: 'Sarasota' });
    expect(waterSavedSentence(schedule, hold)).toMatch(/saves about 3,100 gallons\. On Sarasota County water that is roughly \$12 to \$40 for the week\.$/);
    const phase1 = waterSavedForDecision({ lawnSqft: 5000, rates, waterSource: 'well', county: 'Manatee' });
    expect(waterSavedSentence(phase1, hold)).not.toMatch(/\$/);
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
    // A one-day policy makes this a RUN plan of one 0.75" event: the frozen block follows the prescribed run (r7),
    // not the customer's two 20-minute spray runs (0.5" each).
    expect(on.plan).toMatchObject({ action: 'run', events: 1, depthInches: 0.75 });
    expect(on.decisionInputs.waterSaved).toEqual({ v: 1, basis: 'plan', lawnSqft: 5000, depthInches: 0.75, runsPerWeek: 1, gallonsPerRun: 2350, gallonsPerWeek: 2350 });
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

  test('phase 2 plumbing: the sweep reads pp.irrigation_water_source, withholds it after a move until re-saved, and the frozen block carries the dollars', () => {
    expect(inputsFor({ ...customer, irrigation_water_source: 'county' }).waterSource).toBe('county');
    expect(inputsFor({ ...customer, irrigation_water_source: null }).waterSource).toBeNull();
    const moved = { ...customer, irrigation_water_source: 'county', irrigation_home_changed_at: '2026-09-01T00:00:00Z' };
    expect(inputsFor({ ...moved, irrigation_confirmed_fields: '[]' }).waterSource).toBeNull();
    expect(inputsFor({ ...moved, irrigation_confirmed_fields: JSON.stringify(['irrigation_water_source']) }).waterSource).toBe('county');
    const sweep = require('fs').readFileSync(require.resolve('../services/irrigation-weekly-email'), 'utf8');
    expect(sweep).toMatch(/'pp\.irrigation_water_source',/);
    gateOn(); dollarsOn();
    const on = decideFor({ ...customer, irrigation_water_source: 'county' });
    expect(on.weekPlan.action).toBe('hold');
    expect(on.decisionInputs.waterSaved.dollars).toMatchObject({ county: 'Sarasota', weekLow: 12, weekHigh: 40 });
    expect(on.payload.plan_note).toContain('On Sarasota County water that is roughly $12 to $40 for the week.');
    // Well water, or the dollars gate off: phase 1 exactly.
    expect(decideFor({ ...customer, irrigation_water_source: 'well' }).decisionInputs.waterSaved).not.toHaveProperty('dollars');
    delete process.env.GATE_IRRIGATION_WATER_DOLLARS;
    expect(decideFor({ ...customer, irrigation_water_source: 'county' }).payload.plan_note).not.toMatch(/\$/);
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
    // One turf head beside drip zones: the ask says the heads are mixed, so the sentence keeps the default basis
    // (never "from the sprinkler schedule in your portal") — codex r8 P2.
    const rotorDrip = decideFor({ ...noSchedule, irrigation_run_minutes: 40, watering_days: ['Mon', 'Thu'], irrigation_system_type: ['rotor', 'drip'] });
    expect(rotorDrip.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(rotorDrip.payload.schedule_ask).toMatch(/very different rates/);
    expect(rotorDrip.payload.schedule_ask).toContain('a typical 20-minute run is about 1,550 gallons');
    expect(rotorDrip.payload.schedule_ask).not.toMatch(/From the sprinkler schedule in your portal/);
    // Its minutes and days ARE on file, so the closer points at the ask instead of "once your schedule is on file"
    // (owner 2026-10-26); nothing on file keeps the original closer (asserted above).
    expect(rotorDrip.payload.schedule_ask.endsWith("Once that's in your portal, we'll use your own schedule for that figure.")).toBe(true);
    expect(rotorDrip.payload.schedule_ask).not.toContain('Once your schedule is on file');
    // A system marked off routes the customer to reply to us, never to the portal: the original closer stays.
    const markedOff = decideFor({ ...noSchedule, irrigation_system: false, turf_irrigation_type: 'in_ground', irrigation_run_minutes: 40, watering_days: ['Mon', 'Thu'], irrigation_system_type: ['rotor'] });
    expect(markedOff.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(markedOff.payload.schedule_ask).toContain('reply to this email');
    expect(markedOff.payload.schedule_ask).not.toContain("Once that's in your portal");
    // No sprinkler system known: nothing to skip, no sentence (setup_system carries no ask at all).
    const noSystem = decideFor({ ...noSchedule, irrigation_system: false, turf_irrigation_type: 'none' });
    expect(noSystem.templateKey).toBe(TEMPLATE_SETUP_SYSTEM);
    expect(noSystem.payload.schedule_ask).toBe('');
    // A passed block (a replay) is used verbatim; null means none.
    expect(decideFor(noSchedule, { waterSaved: null }).payload.schedule_ask).toBe(off.payload.schedule_ask);
    gateOff();
    expect(decideFor(noSchedule, { waterSaved: { v: 1, basis: 'default', lawnSqft: 3000, depthInches: 0.5, runsPerWeek: 2, gallonsPerRun: 950, gallonsPerWeek: 1900 } }).payload.schedule_ask).toContain('about 950 gallons');
  });

  test('confirm-schedule email (tech-recorded weekly total, no portal schedule): the owner default rides the schedule note (codex #6498 r6)', () => {
    const { TEMPLATE_CONFIRM_SCHEDULE } = require('../services/irrigation-weekly-email');
    const tech = { ...customer, irrigation_inches_per_week: null, turf_irrigation_inches_per_week: 1 };
    const off = decideFor(tech);
    expect(off.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
    expect(off.payload.schedule_note).not.toMatch(/gallons/);
    gateOn();
    const on = decideFor(tech);
    expect(on.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
    expect(on.payload.schedule_note.startsWith(off.payload.schedule_note)).toBe(true);
    expect(on.payload.schedule_note).toContain('For a lawn your size, a typical 20-minute run is about 1,550 gallons');
    // No area (or withheld after a move): the note is exactly as before.
    expect(decideFor({ ...tech, turf_lawn_sqft: null }).payload.schedule_note).toBe(off.payload.schedule_note);
    // (A moved home in plan mode routes to the plan branch instead; whichever variant, no gallons anywhere in the payload.)
    expect(JSON.stringify(decideFor({ ...tech, irrigation_home_changed_at: '2026-09-01T00:00:00Z', irrigation_confirmed_fields: '[]' }).payload)).not.toMatch(/gallons/);
    // A replay passes its block verbatim; null means none.
    expect(decideFor(tech, { waterSaved: null }).payload.schedule_note).toBe(off.payload.schedule_note);
    // Hand watering on record (tech irrigation_type manual / none): no sprinkler-run sentence (codex r7 P2).
    for (const type of ['manual', 'none']) {
      expect(JSON.stringify(decideFor({ ...tech, turf_irrigation_type: type }).payload)).not.toMatch(/gallons/);
    }
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
