/**
 * GATE_IRRIGATION_OWNER_RATES (owner 2026-10-09, "build it"): ONE sprinkler head rate table for every reader.
 * Off = the package table (spray 1.5, rotor 0.5 in/hr) exactly as before; on = the owner table (spray 15, rotor 40
 * minutes per quarter inch). A customer's MEASURED rate outranks either table.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.fn = { now: () => 'now()' }; m.raw = jest.fn((e) => e); return m; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const pkg = require('../../packages/irrigation-runtime');
const { irrigationRates, irrigationRateOptions } = require('../services/irrigation-rates');
const { decideWeekPlan, renderWeekPlanEmail, renderWeekPlanReport } = require('../services/irrigation-week-plan');
const { buildIrrigationAdvice } = require('../services/service-report/irrigation-advice');
const weeklyEmail = require('../services/irrigation-weekly-email');
const { portalIrrigationInches } = require('../services/service-report/report-data');
const { sizingFieldsUnconfirmed } = require('../services/irrigation-schedule-confirmation');

const { buildWeekPlan, resolveApplicationRate, deriveIrrigationInchesPerWeek, defaultEventMinutes, HEAD_PRECIP_RATE_IN_PER_HR, OWNER_HEAD_RATE_IN_PER_HR } = pkg;

const ONE_DAY = { maxDaysPerWeek: 1, label: 'Test order', expiresOn: '2026-12-31', hoursNote: 'on your assigned day' };
const SPRAY = { runMinutes: 20, wateringDays: ['Mon', 'Wed'], systemType: ['spray'] };
const ROTOR = { runMinutes: 60, wateringDays: ['Mon', 'Wed'], systemType: ['rotor'] };

let saved;
beforeEach(() => { saved = process.env.GATE_IRRIGATION_OWNER_RATES; delete process.env.GATE_IRRIGATION_OWNER_RATES; });
afterEach(() => { if (saved === undefined) delete process.env.GATE_IRRIGATION_OWNER_RATES; else process.env.GATE_IRRIGATION_OWNER_RATES = saved; });
const gateOn = () => { process.env.GATE_IRRIGATION_OWNER_RATES = 'true'; };

describe('rate table chooser', () => {
  test('off or anything but exactly "true" = the package table', () => {
    expect(irrigationRates()).toBe(HEAD_PRECIP_RATE_IN_PER_HR);
    for (const v of ['1', 'TRUE', 'yes', '']) {
      process.env.GATE_IRRIGATION_OWNER_RATES = v;
      expect(irrigationRates()).toBe(HEAD_PRECIP_RATE_IN_PER_HR);
    }
  });
  test('on = the owner table (15 / 40 minutes per quarter inch)', () => {
    gateOn();
    expect(irrigationRates()).toBe(OWNER_HEAD_RATE_IN_PER_HR);
    expect(irrigationRateOptions()).toEqual({ rates: { spray: 1, rotor: 0.375 } });
  });
});

describe('package: rates option', () => {
  test('defaultEventMinutes: 20 / 60 on the package table, 30 / 80 on the owner table', () => {
    expect(defaultEventMinutes()).toEqual({ spray: 20, rotor: 60 });
    expect(defaultEventMinutes(HEAD_PRECIP_RATE_IN_PER_HR)).toEqual({ spray: 20, rotor: 60 });
    expect(defaultEventMinutes(OWNER_HEAD_RATE_IN_PER_HR)).toEqual({ spray: 30, rotor: 80 });
  });

  test('resolveApplicationRate: no option = package rate; owner option = owner rate', () => {
    expect(resolveApplicationRate(SPRAY)).toEqual({ rateInPerHr: 1.5, rateSource: 'system_type_default', headType: 'spray' });
    expect(resolveApplicationRate(SPRAY, { rates: OWNER_HEAD_RATE_IN_PER_HR })).toEqual({ rateInPerHr: 1, rateSource: 'system_type_default', headType: 'spray' });
    expect(resolveApplicationRate(ROTOR, { rates: OWNER_HEAD_RATE_IN_PER_HR }).rateInPerHr).toBe(0.375);
  });

  test('a MEASURED rate outranks either table', () => {
    const measured = { ...SPRAY, explicitInchesPerWeek: 1.2 }; // 1.2 / (20/60 x 2) = 1.8 in/hr
    expect(resolveApplicationRate(measured)).toMatchObject({ rateInPerHr: 1.8, rateSource: 'measured' });
    expect(resolveApplicationRate(measured, { rates: OWNER_HEAD_RATE_IN_PER_HR })).toMatchObject({ rateInPerHr: 1.8, rateSource: 'measured' });
  });

  test('buildWeekPlan: default-rate minutes follow the table; measured minutes do not', () => {
    const base = { targetInchesPerWeek: 0.5, season: 'peak', restriction: ONE_DAY, ...SPRAY };
    expect(buildWeekPlan(base)).toMatchObject({ action: 'run', minutesPerEvent: 20, rateInPerHr: 1.5 });
    expect(buildWeekPlan({ ...base, rates: OWNER_HEAD_RATE_IN_PER_HR })).toMatchObject({ action: 'run', minutesPerEvent: 30, rateInPerHr: 1 });
    const rotor = { ...base, ...ROTOR };
    expect(buildWeekPlan(rotor).minutesPerEvent).toBe(60);
    expect(buildWeekPlan({ ...rotor, rates: OWNER_HEAD_RATE_IN_PER_HR }).minutesPerEvent).toBe(80);
    const measured = { ...base, explicitInchesPerWeek: 1.2 };
    expect(buildWeekPlan(measured).minutesPerEvent).toBe(buildWeekPlan({ ...measured, rates: OWNER_HEAD_RATE_IN_PER_HR }).minutesPerEvent);
    expect(buildWeekPlan(measured).rateSource).toBe('measured');
  });

  test('deriveIrrigationInchesPerWeek with the owner table matches the lawn report card (45 min, rotor, 1 day = 0.28)', () => {
    const input = { runMinutes: 45, wateringDays: ['Mon'], systemType: ['rotor'] };
    expect(deriveIrrigationInchesPerWeek(input).inchesPerWeek).toBe(0.38);
    expect(deriveIrrigationInchesPerWeek(input, { rates: OWNER_HEAD_RATE_IN_PER_HR }).inchesPerWeek).toBe(0.28);
  });
});

describe('Monday plan (decideWeekPlan) and its generic sentences', () => {
  const advice = () => buildIrrigationAdvice({ grassType: 'st_augustine', month: 8, irrigationInchesPerWeek: 2, rainfallInches7d: 0.6 });
  const decide = (extra = {}) => decideWeekPlan({ advice: advice(), grassType: 'st_augustine', forecastEt0Inches: 1.6, forecastRainInches: 0.3, ...SPRAY, county: 'Manatee', now: new Date('2026-08-28T12:00:00Z'), ...extra }).plan;

  test('gate off: default-rate plan unchanged; gate on: owner minutes', () => {
    const off = decide();
    expect(off).toMatchObject({ action: 'run', rateSource: 'system_type_default', rateInPerHr: 1.5 });
    gateOn();
    const on = decide();
    expect(on).toMatchObject({ action: 'run', rateSource: 'system_type_default', rateInPerHr: 1 });
    expect(on.minutesPerEvent).toBeGreaterThan(off.minutesPerEvent);
    expect(on.minutesPerEvent).toBe(Math.max(5, Math.round((on.depthInches / 1) * 60 / 5) * 5));
  });

  test('gate on: a measured rate still wins', () => {
    gateOn();
    expect(decide({ explicitInchesPerWeek: 1.2 })).toMatchObject({ rateSource: 'measured', rateInPerHr: 1.8 });
  });

  const EVENTS_ONLY = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY }); // no head type on file
  const CTX = { firstName: 'Jordan', grassLabel: 'St. Augustine', restriction: ONE_DAY };
  const HOLD = buildWeekPlan({ targetInchesPerWeek: 0.2, season: 'peak', restriction: ONE_DAY });
  const CONDITIONAL = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, forecastRainInches: 1 });

  test('gate off: the generic sentences read exactly as they always did (20 and 60)', () => {
    const email = renderWeekPlanEmail(EVENTS_ONLY, CTX);
    expect(email.week_plan).toContain('run one full cycle on each turf zone — ½ to ¾ inch of water, which is about 20 minutes on spray zones and 60 on rotor zones');
    expect(renderWeekPlanEmail(HOLD, CTX).week_plan).toContain('one full cycle on each turf zone (½ to ¾ inch — about 20 minutes on spray zones, 60 on rotor zones)');
    expect(renderWeekPlanReport(HOLD, { restriction: ONE_DAY }).detail).toContain('(½ to ¾ inch — about 20 minutes on spray zones, 60 on rotor zones)');
    expect(renderWeekPlanReport(CONDITIONAL, { restriction: ONE_DAY }).detail).toContain('(½ to ¾ inch — about 20 minutes on spray zones, 60 on rotor zones)');
  });

  test('gate on: the same sentences, computed from the owner table (30 and 80)', () => {
    const OWNER = { ...CTX, rateTable: 'owner' };
    const email = renderWeekPlanEmail(EVENTS_ONLY, OWNER);
    expect(email.week_plan).toContain('run one full cycle on each turf zone — ½ to ¾ inch of water, which is about 30 minutes on spray zones and 80 on rotor zones');
    expect(renderWeekPlanEmail(HOLD, OWNER).week_plan).toContain('one full cycle on each turf zone (½ to ¾ inch — about 30 minutes on spray zones, 80 on rotor zones)');
    expect(renderWeekPlanReport(HOLD, { restriction: ONE_DAY, rateTable: 'owner' }).detail).toContain('(½ to ¾ inch — about 30 minutes on spray zones, 80 on rotor zones)');
    expect(renderWeekPlanReport(CONDITIONAL, { restriction: ONE_DAY, rateTable: 'owner' }).detail).toContain('(½ to ¾ inch — about 30 minutes on spray zones, 80 on rotor zones)');
    const all = JSON.stringify([email, renderWeekPlanReport(HOLD, { restriction: ONE_DAY, rateTable: 'owner' }), renderWeekPlanReport(CONDITIONAL, { restriction: ONE_DAY, rateTable: 'owner' })]);
    expect(all).not.toMatch(/about 20 minutes on spray/);
  });

  test('the "typical rates" note drops the University of Florida attribution only with the gate on', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(renderWeekPlanEmail(plan, CTX).plan_note).toContain('Minutes assume typical spray heads rates from University of Florida turf guidance.');
    const note = renderWeekPlanEmail(plan, { ...CTX, rateTable: 'owner' }).plan_note;
    expect(note).toContain('Minutes assume typical spray heads rates. If you know');
    expect(note).not.toMatch(/University of Florida/);
  });
});

describe('weekly email, report figure and schedule guard', () => {
  const derivedFor = (rates) => deriveIrrigationInchesPerWeek({ runMinutes: 30, wateringDays: ['Mon', 'Thu'], systemType: ['spray'] }, rates ? { rates } : undefined);

  test('the schedule provenance sentence: UF attribution off; plain "typical rate" on, with the owner rate per hour', () => {
    const args = (derived, rateTable) => ({ scheduleSource: 'portal_derived', derived, scheduleFmt: String(derived.inchesPerWeek), rateTable });
    const off = weeklyEmail._private.buildScheduleNote(args(derivedFor()));
    expect(off).toContain('using the typical spray heads rate from University of Florida turf guidance (about 1.5" per hour).');
    gateOn();
    const on = weeklyEmail._private.buildScheduleNote(args(derivedFor(OWNER_HEAD_RATE_IN_PER_HR), 'owner'));
    expect(on).toContain('using the typical spray heads rate (about 1" per hour).');
    expect(on).not.toMatch(/University of Florida/);
  });

  test('the report\'s portal figure (portalIrrigationInches): 1.5 in/hr off, 1.0 in/hr on', () => {
    const prefs = { irrigation_run_minutes: 30, watering_days: ['Mon', 'Thu'], irrigation_system_type: ['spray'] };
    expect(portalIrrigationInches(prefs)).toBe(1.5);
    gateOn();
    expect(portalIrrigationInches(prefs)).toBe(1);
  });

  test('the report\'s portal figure: a typed weekly-inches entry outranks the table', () => {
    const prefs = { irrigation_inches_per_week: 0.8, irrigation_run_minutes: 30, watering_days: ['Mon', 'Thu'], irrigation_system_type: ['spray'] };
    expect(portalIrrigationInches(prefs)).toBe(0.8);
    gateOn();
    expect(portalIrrigationInches(prefs)).toBe(0.8);
  });

  test('schedule guard: 60 min x 4 days on spray is 6 in on the package table (declined, so the stale tech reading wins) and 4 in on the owner table (derives, so the confirmed schedule replaces it)', () => {
    const row = {
      irrigation_home_changed_at: '2026-10-01T00:00:00Z',
      turf_irrigation_inches_per_week: 1,
      irrigation_run_minutes: 60,
      watering_days: ['Mon', 'Tue', 'Thu', 'Fri'],
      irrigation_system_type: ['spray'],
      irrigation_confirmed_fields: ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type'],
    };
    expect(sizingFieldsUnconfirmed(row)).toBe(true);
    gateOn();
    expect(sizingFieldsUnconfirmed(row)).toBe(false);
  });
});

describe('portal carries the choice', () => {
  test('GET /api/property/preferences adds irrigationOwnerRates only through the gate-checked spread', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/property.js'), 'utf8');
    expect(src).toMatch(/function irrigationRatesPayload\(\) \{\s*return irrigationOwnerRatesLive\(\) \? \{ irrigationOwnerRates: true \} : \{\};\s*\}/);
    expect(src.match(/\.\.\.irrigationRatesPayload\(\)/g)).toHaveLength(2);
  });
  test('the payload helper: absent off, true on', () => {
    const { irrigationOwnerRatesLive } = require('../services/irrigation-rates');
    expect(irrigationOwnerRatesLive()).toBe(false);
    gateOn();
    expect(irrigationOwnerRatesLive()).toBe(true);
  });
});
