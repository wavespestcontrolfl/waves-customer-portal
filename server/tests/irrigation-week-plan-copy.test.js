/**
 * irrigation-week-plan renderers — the WORDING rules (owner 2026-08-28):
 * "each turf zone" never "each zone"; "skip your turf watering" / "leave the
 * turf irrigation off" never "turn your controller off"; "your permitted
 * watering day" never a weekday; measured rate → exact minutes, assumed
 * rate → "about"; conditional forecast copy; restriction note.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildWeekPlan } = require('../../packages/irrigation-runtime');
const { renderWeekPlanEmail, renderWeekPlanReport, decideWeekPlan, _private } = require('../services/irrigation-week-plan');
const { buildIrrigationAdvice } = require('../services/service-report/irrigation-advice');

const ONE_DAY = { maxDaysPerWeek: 1, label: 'SWFWMD Modified Phase III water shortage order', expiresOn: '2026-10-01', hoursNote: 'on your assigned day, during your area\'s allowed hours' };
const SPRAY = { runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], systemType: ['spray'] };
const CTX = { firstName: 'Jordan', grassLabel: 'St. Augustine', runMinutes: 20, restriction: ONE_DAY };
const WEEKDAY = /\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;

function allText(copy) { return Object.values(copy).join(' '); }

describe('renderWeekPlanEmail', () => {
  test('run: minutes per TURF zone on the permitted day, comparison to what they run, UF/IFAS depth', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.plan_subject).toBe('This week: about 30 minutes per turf zone, Jordan');
    expect(copy.week_plan).toContain('run each turf zone about 30 minutes on your permitted watering day — 10 minutes more than you run now');
    expect(copy.week_plan).toContain('about ¾" of water per run');
    expect(copy.plan_note).toContain('limited to one watering day a week');
    expect(copy.plan_note).toContain('Minutes assume typical spray heads rates');
    expect(copy.restriction_note).toContain('one day a week');
    expect(copy.restriction_note).toContain('through 2026-10-01');
    const text = allText(copy);
    expect(text).not.toMatch(/each zone\b/);
    expect(text).not.toMatch(/controller/i);
    expect(text).not.toMatch(WEEKDAY);
  });

  test('measured rate → exact minutes, no "about", no assumed-rate note', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 0.5, season: 'peak', restriction: ONE_DAY, explicitInchesPerWeek: 2, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.plan_subject).toBe('This week: 20 minutes per turf zone, Jordan');
    expect(copy.week_plan).toMatch(/run each turf zone 20 minutes on your permitted watering day — about what you run now/);
    expect(copy.plan_note).not.toContain('Minutes assume');
  });

  test('hold: skip your turf watering + wilt cues + a fallback cycle; overwatered reason named', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 2, season: 'cool', restriction: ONE_DAY, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.plan_subject).toBe('Skip your turf watering this week, Jordan');
    expect(copy.week_plan).toMatch(/^This week: skip your turf watering\. Last week's rain and irrigation left more in the soil/);
    expect(copy.week_plan).toContain('dull blue-gray tint, or footprints that stay pressed in');
    expect(copy.week_plan).toContain('run one cycle of about 20 minutes per turf zone on your permitted watering day');
    expect(allText(copy)).not.toMatch(/turn .*off|controller/i);
  });

  test('conditional: leave the turf irrigation off, run only if < ½" falls', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 1.4, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.plan_subject).toMatch(/^Rain first, then decide/);
    expect(copy.week_plan).toContain('about 1.4" in the forecast');
    expect(copy.week_plan).toContain('leave the turf irrigation off for now. If less than ½" actually falls, run one cycle of about 30 minutes per turf zone on your permitted watering day');
  });

  test('cool-season run adds the every-10–14-days-if-needed guidance', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 0.6, season: 'cool', restriction: ONE_DAY, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.week_plan).toContain('every 10–14 days if needed is plenty');
  });

  test('no head type → events-only cycle + ask for the head type; rain sensor line; forecast-unavailable caveat', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: ONE_DAY, runMinutes: 20, wateringDays: ['Mon'], systemType: [], rainSensor: true, forecastRainInches: null });
    const copy = renderWeekPlanEmail(plan, { ...CTX, runMinutes: 20 });
    expect(copy.week_plan).toContain('run one full cycle on each turf zone — ½ to ¾ inch of water, which is about 20 minutes on spray zones and 60 on rotor zones on your permitted watering day');
    expect(copy.plan_note).toContain('Add your sprinkler head type');
    expect(copy.plan_note).toContain('rain sensor will skip a run');
    expect(copy.plan_note).toContain("couldn't get a rain forecast");
  });

  test('unavailable plan → null (the sender keeps its pre-plan template)', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: null, ...SPRAY });
    expect(renderWeekPlanEmail(plan, CTX)).toBeNull();
    expect(renderWeekPlanReport(plan)).toBeNull();
  });
});

describe('renderWeekPlanReport', () => {
  test('run / hold / conditional each render a title + detail with the same wording rules', () => {
    const run = renderWeekPlanReport(buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, ...SPRAY }), { runMinutes: 20 });
    expect(run.title).toBe('This week: about 30 minutes per turf zone');
    expect(run.detail).toContain('On your permitted watering day, about ¾" of water per run — 10 minutes more than you run now');
    const hold = renderWeekPlanReport(buildWeekPlan({ targetInchesPerWeek: 0.3, season: 'cool', restriction: ONE_DAY, ...SPRAY }));
    expect(hold.title).toBe('This week: skip your turf watering');
    const cond = renderWeekPlanReport(buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 0.9, season: 'peak', restriction: ONE_DAY, ...SPRAY }));
    expect(cond.title).toBe('This week: let the rain go first');
    expect(cond.detail).toContain('if less than ½" falls');
    for (const c of [run, hold, cond]) expect(`${c.title} ${c.detail}`).not.toMatch(WEEKDAY);
  });
});

describe('decideWeekPlan (server glue)', () => {
  test('feeds the advice engine\'s target/applied into the runtime and pins the policy by `now`', () => {
    const advice = buildIrrigationAdvice({ grassType: 'st_augustine', month: 8, irrigationInchesPerWeek: 2, rainfallInches7d: 0.6, referenceEt0InchesWeek: 1.6 });
    const { plan, restriction } = decideWeekPlan({ advice, month: 8, forecastRainInches: 0.3, ...SPRAY, now: new Date('2026-08-28T12:00:00Z') });
    expect(restriction.maxDaysPerWeek).toBe(1);
    expect(plan.targetInches).toBe(advice.recommendedInchesPerWeek);
    expect(plan.carryoverInches).toBe(0.5);
    expect(plan.action).toBe('run');
  });

  test('after the order expires with nothing configured → unavailable', () => {
    const advice = buildIrrigationAdvice({ grassType: 'st_augustine', month: 10, irrigationInchesPerWeek: 1, rainfallInches7d: 0.2 });
    const { plan, restriction } = decideWeekPlan({ advice, month: 10, ...SPRAY, now: new Date('2026-10-05T12:00:00Z') });
    expect(restriction).toBeNull();
    expect(plan.action).toBe('unavailable');
  });

  test('fmtInches renders the UF fractions', () => {
    expect(_private.fmtInches(0.5)).toBe('½"');
    expect(_private.fmtInches(0.75)).toBe('¾"');
    expect(_private.fmtInches(1.4)).toBe('1.4"');
  });
});
