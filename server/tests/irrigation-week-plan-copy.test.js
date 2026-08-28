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
    expect(copy.week_plan).toContain('About 1.4" of rain is in this week\'s forecast');
    expect(copy.week_plan).toContain('leave the turf irrigation off for now. When your permitted watering day comes around: if ½" or more has fallen so far this week, skip that run; if less than ½" has, run one cycle of about 30 minutes per turf zone');
    // A 7-day total can't establish that rain comes BEFORE the assigned day.
    expect(copy.week_plan).not.toMatch(/before your watering day/);
  });

  test('conditional copy under a 2-day policy names every planned run', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 1.4, season: 'peak', restriction: { maxDaysPerWeek: 2 }, ...SPRAY });
    expect(plan.events).toBe(2);
    const copy = renderWeekPlanEmail(plan, { ...CTX, restriction: { ...ONE_DAY, maxDaysPerWeek: 2 } });
    // Each run judged on rain since the previous run — one early soaking
    // cancels one run, not the whole week's water.
    expect(copy.week_plan).toContain('On each of your 2 permitted watering days: if ½" or more has fallen since your previous run (or since the start of the week, for the first), skip that run; if less than ½" has, run one cycle of about 25 minutes per turf zone');
    const report = renderWeekPlanReport(plan);
    expect(report.detail).toContain('on each of your 2 permitted watering days, run one cycle of about 25 minutes per turf zone only if less than ½" has fallen since your previous run');
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

  test('watering prohibited (0-day policy) → skip, no override cycle, no "permitted day"', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: { maxDaysPerWeek: 0 }, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, { ...CTX, restriction: { ...ONE_DAY, maxDaysPerWeek: 0 } });
    expect(copy.week_plan).toContain("Lawn irrigation isn't permitted in your area right now");
    expect(copy.week_plan).not.toMatch(/permitted watering day|run one cycle|blue-gray/);
    expect(copy.restriction_note).toBe('SWFWMD Modified Phase III water shortage order: lawn irrigation is not permitted, through 2026-10-01.');
    expect(copy.restriction_note).not.toMatch(/assigned day/);
    const report = renderWeekPlanReport(plan);
    expect(report.title).toBe('This week: no lawn watering');
    expect(report.detail).not.toMatch(/permitted watering day|run one cycle/);
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
    expect(cond.detail).toContain('only if less than ½" has fallen so far this week');
    for (const c of [run, hold, cond]) expect(`${c.title} ${c.detail}`).not.toMatch(WEEKDAY);
  });
});

describe('decideWeekPlan (server glue)', () => {
  test('feeds the advice engine\'s target/applied into the runtime and pins the policy by `now`', () => {
    const advice = buildIrrigationAdvice({ grassType: 'st_augustine', month: 8, irrigationInchesPerWeek: 2, rainfallInches7d: 0.6, referenceEt0InchesWeek: 1.6 });
    const { plan, restriction, decisionInputs } = decideWeekPlan({ advice, grassType: 'st_augustine', et0Inches: 1.6, forecastRainInches: 0.3, ...SPRAY, county: 'Manatee', now: new Date('2026-08-28T12:00:00Z') });
    expect(restriction.maxDaysPerWeek).toBe(1);
    expect(plan.targetInches).toBe(advice.recommendedInchesPerWeek); // same month → same target
    expect(decisionInputs.planMonth).toBe(8);
    expect(plan.carryoverInches).toBe(0.5);
    expect(plan.action).toBe('run');
    expect(decisionInputs.county).toBe('Manatee');
  });

  test('county unknown → no policy → unavailable (fail closed)', () => {
    const advice = buildIrrigationAdvice({ grassType: 'st_augustine', month: 8, irrigationInchesPerWeek: 2, rainfallInches7d: 0.6 });
    const { plan } = decideWeekPlan({ advice, grassType: 'st_augustine', ...SPRAY, county: null, now: new Date('2026-08-28T12:00:00Z') });
    expect(plan.action).toBe('unavailable');
  });

  test('after the order expires with nothing configured → unavailable', () => {
    const advice = buildIrrigationAdvice({ grassType: 'st_augustine', month: 10, irrigationInchesPerWeek: 1, rainfallInches7d: 0.2 });
    const { plan, restriction } = decideWeekPlan({ advice, grassType: 'st_augustine', ...SPRAY, county: 'Manatee', now: new Date('2026-10-05T12:00:00Z') });
    expect(restriction).toBeNull();
    expect(plan.action).toBe('unavailable');
  });

  test('the plan\'s season and target come from the ET month of NOW, not the completed week', () => {
    // Completed week ended in March (cool); the plan is for early April (shoulder).
    const lastWeek = buildIrrigationAdvice({ grassType: 'st_augustine', month: 3, irrigationInchesPerWeek: 0.5, rainfallInches7d: 0.1, referenceEt0InchesWeek: 1.0 });
    const { plan, decisionInputs } = decideWeekPlan({ advice: lastWeek, grassType: 'st_augustine', et0Inches: 1.0, ...SPRAY, county: 'Manatee', now: new Date('2026-04-02T12:00:00Z') });
    expect(decisionInputs.planMonth).toBe(4);
    expect(plan.season).toBe('shoulder');
    expect(plan.reasons).not.toContain('cool_season');
    expect(plan.targetInches).toBe(0.75); // 1.0 × 0.8 × 0.9 shoulder Kc, quarter-rounded
    expect(decisionInputs.lastWeekTargetInches).toBe(lastWeek.recommendedInchesPerWeek);
    // Late March NOW → cool season, "every 10–14 days" copy allowed.
    expect(decideWeekPlan({ advice: lastWeek, grassType: 'st_augustine', ...SPRAY, county: 'Manatee', now: new Date('2026-03-30T12:00:00Z') }).plan.season).toBe('cool');
  });

  test('fmtInches renders the UF fractions', () => {
    expect(_private.fmtInches(0.5)).toBe('½"');
    expect(_private.fmtInches(0.75)).toBe('¾"');
    expect(_private.fmtInches(1.4)).toBe('1.4"');
  });
});

describe('snapshot lifecycle — exactness contract', () => {
  const db = require('../models/db');
  const { loadCurrentWeekPlan, persistWeekPlan, markWeekPlanSent, markAnyUnsentWeekPlanSent, discardUnsentWeekPlan, weekPlanDeliveryState } = require('../services/irrigation-week-plan');
  const NOW = new Date('2026-08-27T16:00:00Z'); // Thursday → week ending Sunday 2026-08-23
  const POLICY = { maxDaysPerWeek: 1, expiresOn: '2026-10-01', label: 'SWFWMD Modified Phase III water shortage order', county: 'Manatee' };
  const row = (restriction, extra = {}) => ({ week_ending: '2026-08-23', plan_as_of: NOW, sent_at: NOW, weather_inputs: JSON.stringify({ runMinutes: 20, county: 'Manatee' }), restriction_policy: JSON.stringify(restriction), week_plan: JSON.stringify({ action: 'run', reasons: [] }), ...extra });

  function stubSelect(returned, capture = {}) {
    db.mockImplementation(() => ({
      where(w) { capture.where = w; return this; },
      whereNotNull(c) { capture.notNull = c; return this; },
      first: async () => returned,
    }));
    return capture;
  }

  test('load: current week, SENT rows only, policy must still be in force; exposes the decision inputs', async () => {
    const cap = stubSelect(row(POLICY));
    const hit = await loadCurrentWeekPlan('c1', { now: NOW });
    expect(cap.where).toEqual({ customer_id: 'c1', week_ending: '2026-08-23' });
    expect(cap.notNull).toBe('sent_at');
    expect(hit.plan.action).toBe('run');
    expect(hit.decisionInputs.runMinutes).toBe(20);
    stubSelect(row({ ...POLICY, maxDaysPerWeek: 2 }));
    expect(await loadCurrentWeekPlan('c1', { now: NOW })).toBeNull();
    stubSelect(row(POLICY));
    expect(await loadCurrentWeekPlan('c1', { now: new Date('2026-10-05T12:00:00Z') })).toBeNull(); // policy expired since Monday
  });

  test('persist replaces only an UNSENT row and returns the decision hash; mark-sent binds to that hash; discard deletes only unsent', async () => {
    const calls = {};
    db.mockImplementation(() => ({
      insert(r) { calls.insert = r; return this; },
      onConflict(cols) { calls.conflict = cols; return this; },
      merge(r) { calls.merged = r; return this; },
      ignore: async () => { calls.ignored = true; },
      whereNull(c) { calls.whereNull = c; return this; },
      then(resolve) { return Promise.resolve(1).then(resolve); },
      where(w) { calls.where = w; return this; },
      update: async (patch) => { calls.update = patch; return 1; },
      del: async () => { calls.deleted = true; return 1; },
    }));
    const plan = { action: 'hold', reasons: [] };
    const hash = await persistWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23', plan, restriction: POLICY, decisionInputs: { runMinutes: 20 } });
    expect(hash).toBe(require('crypto').createHash('sha1').update(JSON.stringify(plan)).digest('hex'));
    expect(calls.conflict).toEqual(['customer_id', 'week_ending']);
    expect(calls.merged.decision_hash).toBe(hash);
    expect(calls.whereNull).toBe('irrigation_week_plans.sent_at'); // a SENT row is never replaced
    expect(calls.ignored).toBeUndefined();
    expect(calls.insert.sent_at).toBeNull();
    expect(JSON.parse(calls.insert.weather_inputs)).toEqual({ runMinutes: 20 });
    // mark-sent: keyed on the hash, unsent rows only; no hash → no-op.
    expect(await markWeekPlanSent({ customerId: 'c1', weekEnding: '2026-08-23' })).toBe(false);
    expect(await markWeekPlanSent({ customerId: 'c1', weekEnding: '2026-08-23', decisionHash: hash })).toBe(true);
    expect(calls.where).toEqual({ customer_id: 'c1', week_ending: '2026-08-23', decision_hash: hash });
    expect(calls.whereNull).toBe('sent_at');
    expect(calls.update.sent_at).toBeInstanceOf(Date);
    await discardUnsentWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23' });
    expect(calls.deleted).toBe(true);
    expect(calls.whereNull).toBe('sent_at');
  });
});

describe('weekPlanDeliveryState — the durable record decides', () => {
  const db = require('../models/db');
  const { weekPlanDeliveryState, markAnyUnsentWeekPlanSent } = require('../services/irrigation-week-plan');
  const withStatus = (status) => db.mockImplementation(() => ({ where() { return this; }, first: async () => (status === undefined ? undefined : { status }) }));

  test.each([
    ['sent', 'sent'], ['delivered', 'sent'], ['opened', 'sent'], ['clicked', 'sent'],
    ['blocked', 'blocked'], ['failed', 'failed'], ['queued', 'pending'], [undefined, null],
  ])('status %s → %s', async (status, expected) => {
    withStatus(status);
    expect(await weekPlanDeliveryState('k')).toBe(expected);
  });

  test('lookup failure → pending (never replace, never delete); no key → null', async () => {
    db.mockImplementation(() => ({ where() { return this; }, first: async () => { throw new Error('db down'); } }));
    expect(await weekPlanDeliveryState('k')).toBe('pending');
    expect(await weekPlanDeliveryState(null)).toBeNull();
  });

  test('markAnyUnsentWeekPlanSent stamps only the unsent row for the week', async () => {
    const calls = {};
    db.mockImplementation(() => ({ where(w) { calls.where = w; return this; }, whereNull(c) { calls.whereNull = c; return this; }, update: async (p) => { calls.update = p; return 1; } }));
    expect(await markAnyUnsentWeekPlanSent({ customerId: 'c1', weekEnding: '2026-08-23' })).toBe(true);
    expect(calls.where).toEqual({ customer_id: 'c1', week_ending: '2026-08-23' });
    expect(calls.whereNull).toBe('sent_at');
  });
});
