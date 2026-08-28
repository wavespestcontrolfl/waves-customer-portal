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
    expect(copy.restriction_note).toContain('Water on your assigned day only.');
    expect(_private.restrictionNote({ ...ONE_DAY, maxDaysPerWeek: 2 })).toContain('2 days a week');
    expect(_private.restrictionNote({ ...ONE_DAY, maxDaysPerWeek: 2 })).toContain('Water on your assigned days only.');
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

  test('hold from a rain-only surplus (sensor customer) says rain alone did it', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 2.5, lastWeekRainInches: 1.75, season: 'cool', restriction: ONE_DAY, rainSensor: true, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.week_plan).toContain("Last week's rain alone left more in the soil");
    expect(copy.plan_note).toContain('rain sensor');
  });

  test('conditional: leave the turf irrigation off, run only if < ½" falls', () => {
    const plan = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 1.4, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    const copy = renderWeekPlanEmail(plan, CTX);
    expect(copy.plan_subject).toBe('Check the rain before you water this week, Jordan');
    expect(copy.plan_subject).not.toMatch(/rain first/i);
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
    expect(copy.week_plan).toContain('On each of your 2 permitted watering days: if ½" or more has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first), skip that run; if less than ½" has, run one cycle of about 25 minutes per turf zone');
    const report = renderWeekPlanReport(plan);
    expect(report.detail).toContain('on each of your 2 permitted watering days, run one cycle of about 25 minutes per turf zone only if less than ½" has fallen since your previous permitted watering day (skipped or not');
  });

  test('a single run under a multi-day policy says "one of your permitted watering days" everywhere', () => {
    const two = { maxDaysPerWeek: 2 };
    const run = buildWeekPlan({ targetInchesPerWeek: 0.6, season: 'peak', restriction: two, ...SPRAY });
    expect(run.events).toBe(1);
    expect(renderWeekPlanEmail(run, { ...CTX, restriction: { ...ONE_DAY, maxDaysPerWeek: 2 } }).week_plan).toContain('on one of your permitted watering days');
    expect(renderWeekPlanReport(run).detail).toContain('On one of your permitted watering days');
    const hold = buildWeekPlan({ targetInchesPerWeek: 0.3, season: 'cool', restriction: two, ...SPRAY });
    expect(renderWeekPlanEmail(hold, CTX).week_plan).toContain('on one of your permitted watering days');
    expect(renderWeekPlanReport(hold).detail).toContain('on one of your permitted watering days');
    const cond = buildWeekPlan({ targetInchesPerWeek: 0.6, forecastRainInches: 0.9, season: 'peak', restriction: two, ...SPRAY });
    expect(renderWeekPlanEmail(cond, CTX).week_plan).toContain('When one of your permitted watering days comes around');
    expect(renderWeekPlanReport(cond).detail).toContain('on one of your permitted watering days');
    // One-day policy keeps the singular.
    expect(_private.permittedDayPhrase({ legalMaxEvents: 1, events: 1 })).toBe('your permitted watering day');
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
    expect(copy.plan_note).toContain('if we get ½" or more of rain before your run, skip it');
    const twoNoForecast = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: { maxDaysPerWeek: 2 }, forecastRainInches: null, ...SPRAY });
    expect(renderWeekPlanEmail(twoNoForecast, CTX).plan_note).toContain('since your previous permitted watering day (skipped or not — since the start of the week, for the first), skip that run');
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

  test('report carries the no-forecast rain safeguard the email has', () => {
    const one = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: ONE_DAY, forecastRainInches: null, ...SPRAY });
    expect(renderWeekPlanReport(one).detail).toContain('No rain forecast was available for this plan — if ½" or more of rain falls before your run, skip it.');
    const two = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: { maxDaysPerWeek: 2 }, forecastRainInches: null, ...SPRAY });
    expect(renderWeekPlanReport(two).detail).toContain('since your previous permitted watering day (skipped or not), skip that run');
    const withForecast = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: ONE_DAY, forecastRainInches: 0.1, ...SPRAY });
    expect(renderWeekPlanReport(withForecast).detail).not.toContain('No rain forecast');
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
    // The report's override cycle carries the same fallback minutes the email names.
    expect(hold.detail).toContain('run one cycle of about 20 minutes per turf zone on your permitted watering day');
    const cond = renderWeekPlanReport(buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 0.9, season: 'peak', restriction: ONE_DAY, ...SPRAY }));
    expect(cond.title).toBe('This week: check the rain before you water');
    expect(`${cond.title} ${cond.detail}`).not.toMatch(/rain (go|comes) first/i);
    expect(cond.detail).toContain('only if less than ½" has fallen so far this week');
    for (const c of [run, hold, cond]) expect(`${c.title} ${c.detail}`).not.toMatch(WEEKDAY);
  });
});

describe('decideWeekPlan (server glue)', () => {
  test('feeds the advice engine\'s target/applied into the runtime and pins the policy by `now`', () => {
    const advice = buildIrrigationAdvice({ grassType: 'st_augustine', month: 8, irrigationInchesPerWeek: 2, rainfallInches7d: 0.6, referenceEt0InchesWeek: 1.6 });
    const { plan, restriction, decisionInputs } = decideWeekPlan({ advice, grassType: 'st_augustine', forecastEt0Inches: 1.6, forecastRainInches: 0.3, ...SPRAY, county: 'Manatee', now: new Date('2026-08-28T12:00:00Z') });
    expect(restriction.maxDaysPerWeek).toBe(1);
    expect(plan.targetInches).toBe(advice.recommendedInchesPerWeek); // same month, same ET₀ → same target
    expect(decisionInputs.targetBasis).toBe('forecast_et0');
    const withHome = decideWeekPlan({ advice, grassType: 'st_augustine', forecastEt0Inches: 1.6, ...SPRAY, county: 'Manatee', home: { addressLine1: '123 Sample Ln', addressLine2: 'Unit 4', city: 'Bradenton', zip: '34205', latitude: 27.5, longitude: -82.5 }, now: new Date('2026-08-28T12:00:00Z') });
    expect(withHome.decisionInputs.home).toEqual({ addressLine1: '123 Sample Ln', addressLine2: 'Unit 4', city: 'Bradenton', zip: '34205', latitude: 27.5, longitude: -82.5 });
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
    const { plan, decisionInputs } = decideWeekPlan({ advice: lastWeek, grassType: 'st_augustine', forecastEt0Inches: 1.0, ...SPRAY, county: 'Manatee', now: new Date('2026-04-02T12:00:00Z') });
    expect(decisionInputs.planMonth).toBe(4);
    expect(plan.season).toBe('shoulder');
    expect(plan.reasons).not.toContain('cool_season');
    expect(plan.targetInches).toBe(0.75); // 1.0 × 0.8 × 0.9 shoulder Kc, quarter-rounded
    expect(decisionInputs.lastWeekTargetInches).toBe(lastWeek.recommendedInchesPerWeek);
    // No forecast ET₀ → the seasonal target for the plan month, never last week's ET₀.
    const seasonal = decideWeekPlan({ advice: lastWeek, grassType: 'st_augustine', ...SPRAY, county: 'Manatee', now: new Date('2026-04-02T12:00:00Z') });
    expect(seasonal.decisionInputs.targetBasis).toBe('seasonal');
    expect(seasonal.plan.targetInches).toBe(1); // 1.25 × 0.75 shoulder multiplier
    // A hot week ahead after a cool completed week sizes from the hot week.
    const hot = decideWeekPlan({ advice: lastWeek, grassType: 'st_augustine', forecastEt0Inches: 1.8, ...SPRAY, county: 'Manatee', now: new Date('2026-04-02T12:00:00Z') });
    expect(hot.plan.targetInches).toBe(1.25);
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
  const { loadCurrentWeekPlan, persistWeekPlan, markWeekPlanSent, discardUnsentWeekPlan, _private } = require('../services/irrigation-week-plan');
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

  test('a render pinned to the signature\'s snapshot accepts only that sent_at; pinned-none renders no plan', async () => {
    stubSelect(row(POLICY));
    expect((await loadCurrentWeekPlan('c1', { now: NOW, pinnedSentAt: NOW.toISOString() })).plan.action).toBe('run');
    expect(await loadCurrentWeekPlan('c1', { now: NOW, pinnedSentAt: new Date('2026-08-24T12:00:00Z').toISOString() })).toBeNull();
    expect(await loadCurrentWeekPlan('c1', { now: NOW, pinnedSentAt: null })).toBeNull();
    expect((await loadCurrentWeekPlan('c1', { now: NOW })).plan.action).toBe('run'); // unpinned = live
    // Strict (pinned render): a failed lookup refuses instead of rendering plan-less.
    db.mockImplementation(() => ({ where() { return this; }, whereNotNull() { return this; }, first: async () => { throw new Error('db down'); } }));
    await expect(loadCurrentWeekPlan('c1', { now: NOW, pinnedSentAt: NOW.toISOString(), strict: true })).rejects.toThrow('db down');
    expect(await loadCurrentWeekPlan('c1', { now: NOW })).toBeNull();
  });

  test('persist is an atomic claim: replaces only an UNSENT, unleased row; returns claimed + hash; mark-sent binds to the hash; discard deletes only unsent', async () => {
    const calls = {};
    let returned = [{ decision_hash: 'x' }];
    db.mockImplementation(() => ({
      insert(r) { calls.insert = r; return this; },
      onConflict(cols) { calls.conflict = cols; return this; },
      merge(r) { calls.merged = r; return this; },
      whereRaw(sql, b) { calls.whereRaw = sql; calls.bindings = b; return this; },
      returning: async () => returned,
      where(w) { calls.where = w; return this; },
      whereNull(c) { calls.whereNull = c; return this; },
      update: async (patch) => { calls.update = patch; return 1; },
      del: async () => { calls.deleted = true; return 1; },
    }));
    const plan = { action: 'hold', reasons: [] };
    const claim = await persistWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23', plan, restriction: POLICY, decisionInputs: { runMinutes: 20 }, claimToken: 'tok-1' });
    expect(claim.claimed).toBe(true);
    // Hash covers plan + ALL decision inputs + restriction.
    expect(claim.hash).toBe(require('crypto').createHash('sha1').update(JSON.stringify({ plan, decisionInputs: { runMinutes: 20 }, restriction: POLICY })).digest('hex'));
    expect(_private.decisionHash(plan, { runMinutes: 20, home: { addressLine1: 'elsewhere' } }, POLICY)).not.toBe(claim.hash);
    expect(_private.decisionHash(plan, { runMinutes: 20 }, { ...POLICY, maxDaysPerWeek: 2 })).not.toBe(claim.hash);
    expect(_private.decisionHash(plan, { runMinutes: 25 }, POLICY)).not.toBe(claim.hash);
    expect(calls.conflict).toEqual(['customer_id', 'week_ending']);
    expect(calls.merged.decision_hash).toBe(claim.hash);
    expect(calls.merged.claim_token).toBe('tok-1');
    expect(calls.whereRaw).toMatch(/sent_at IS NULL/);
    expect(calls.whereRaw).toMatch(/claim_token = \?/);
    // Lease = the email library's queued-row lease (2 minutes), never a longer private clock.
    expect(_private.CLAIM_LEASE_SECONDS).toBe(120);
    expect(calls.whereRaw).toMatch(/claimed_at < now\(\) - interval '120 seconds'/);
    expect(calls.bindings).toEqual(['tok-1']);
    expect(calls.insert.sent_at).toBeNull();
    // Another worker's live lease → nothing returned → not claimed, no hash.
    returned = [];
    const lost = await persistWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23', plan, decisionInputs: { runMinutes: 20 }, claimToken: 'tok-2' });
    expect(lost.claimed).toBe(false);
    expect(lost.hash).toBeNull();
    expect(lost.error).toBeUndefined(); // contention, not an error
    // mark-sent: keyed on the hash, unsent rows only; no hash → no-op.
    expect(await markWeekPlanSent({ customerId: 'c1', weekEnding: '2026-08-23' })).toBe(false);
    expect(await markWeekPlanSent({ customerId: 'c1', weekEnding: '2026-08-23', decisionHash: claim.hash })).toBe(true);
    expect(calls.where).toEqual({ customer_id: 'c1', week_ending: '2026-08-23', decision_hash: claim.hash });
    // With a claim token the stamp is scoped to the claimant's own row too.
    expect(await markWeekPlanSent({ customerId: 'c1', weekEnding: '2026-08-23', decisionHash: claim.hash, claimToken: 'tok-1' })).toBe(true);
    expect(calls.where).toEqual({ customer_id: 'c1', week_ending: '2026-08-23', decision_hash: claim.hash, claim_token: 'tok-1' });
    expect(calls.whereNull).toBe('sent_at');
    expect(calls.update.sent_at).toBeInstanceOf(Date);
    // Discard is scoped to the claimant's own lease — no token, no delete.
    calls.deleted = undefined;
    await discardUnsentWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23' });
    expect(calls.deleted).toBeUndefined();
    await discardUnsentWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23', claimToken: 'tok-1' });
    expect(calls.deleted).toBe(true);
    expect(calls.where).toEqual({ customer_id: 'c1', week_ending: '2026-08-23', claim_token: 'tok-1' });
    expect(calls.whereNull).toBe('sent_at');
    // A DB error is reported distinctly so the sweep can fall back to the pre-plan email.
    db.mockImplementation(() => ({ insert() { throw new Error('db down'); } }));
    const errored = await persistWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23', plan, decisionInputs: { runMinutes: 20 }, claimToken: 'tok-3' });
    expect(errored).toMatchObject({ claimed: false, hash: null, error: true });
  });
});

describe('hasSentWeekPlan', () => {
  const db = require('../models/db');
  const { hasSentWeekPlan } = require('../services/irrigation-week-plan');
  test('true / false / null(unknown) — an unreadable table is never proof of a sent row', async () => {
    db.mockImplementation(() => ({ where() { return this; }, whereNotNull() { return this; }, first: async () => ({ id: 'x' }) }));
    expect(await hasSentWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23' })).toBe(true);
    db.mockImplementation(() => ({ where() { return this; }, whereNotNull() { return this; }, first: async () => undefined }));
    expect(await hasSentWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23' })).toBe(false);
    db.mockImplementation(() => ({ where() { return this; }, whereNotNull() { return this; }, first: async () => { throw new Error('relation missing'); } }));
    expect(await hasSentWeekPlan({ customerId: 'c1', weekEnding: '2026-08-23' })).toBeNull();
  });
});

describe('weekPlanDeliveryState — the durable record decides, at customer/week scope, and names the snapshot', () => {
  const db = require('../models/db');
  const { weekPlanDeliveryState, planCategory, _private } = require('../services/irrigation-week-plan');
  const cap = {};
  const withRows = (rows) => db.mockImplementation(() => ({ where(w) { cap.where = w; return this; }, select: async () => rows }));

  test.each([
    ['sent', 'sent'], ['delivered', 'sent'], ['opened', 'sent'], ['clicked', 'sent'],
    ['blocked', 'blocked'], ['failed', 'failed'], ['queued', 'pending'],
  ])('status %s → %s', async (status, expected) => {
    withRows([{ status, categories: JSON.stringify(['irrigation', 'plan:abc123']), provider_message_id: null, queued_at: new Date().toISOString(), updated_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }]);
    const r = await weekPlanDeliveryState({ triggerEventId: 'irrigation.weekly:c1:2026-08-23' });
    expect(r.state).toBe(expected);
    expect(r.decisionHash).toBe('abc123');
    expect(cap.where).toEqual({ trigger_event_id: 'irrigation.weekly:c1:2026-08-23' });
  });

  test('no record → null; a delivered record wins across recipient keys (email changed mid-week)', async () => {
    withRows([]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: null, decisionHash: null });
    withRows([{ status: 'sent', categories: JSON.stringify(['plan:first']) }, { status: 'queued', categories: JSON.stringify(['plan:second']) }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'sent', decisionHash: 'first' });
  });

  test('a queued row is pending only inside the library\'s 2-minute lease; past it, stale (claimable)', async () => {
    withRows([{ status: 'queued', categories: JSON.stringify(['plan:h']), queued_at: new Date(Date.now() - 30 * 1000).toISOString() }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'pending', decisionHash: 'h' });
    withRows([{ status: 'queued', categories: JSON.stringify(['plan:h']), queued_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'stale', decisionHash: 'h' });
  });

  test('a failed row is ambiguous (pending) when the provider may have accepted it — an id, or recent enough that bookkeeping may have failed after acceptance; an OLD id-less failure is retryable', async () => {
    withRows([{ status: 'failed', categories: JSON.stringify(['plan:h']), provider_message_id: 'sg-123', updated_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'pending', decisionHash: 'h' });
    withRows([{ status: 'failed', categories: JSON.stringify(['plan:h']), provider_message_id: null, updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'pending', decisionHash: 'h' }); // inside the webhook-repair window
    withRows([{ status: 'failed', categories: JSON.stringify(['plan:h']), provider_message_id: null, updated_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'failed', decisionHash: 'h' });
  });

  test('a record without a plan category names no snapshot (report stays absent)', async () => {
    withRows([{ status: 'sent', categories: JSON.stringify(['irrigation', 'irrigation_weekly', 'cut_back']) }]);
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'sent', decisionHash: null });
    withRows([{ status: 'sent', categories: ['irrigation', planCategory('deadbeef')] }]); // array form
    expect((await weekPlanDeliveryState({ triggerEventId: 't' })).decisionHash).toBe('deadbeef');
    expect(_private.hashFromCategories('not json')).toBeNull();
  });

  test('lookup failure → pending (never replace, never delete); no key → null', async () => {
    db.mockImplementation(() => ({ where() { return this; }, select: async () => { throw new Error('db down'); } }));
    expect(await weekPlanDeliveryState({ triggerEventId: 't' })).toEqual({ state: 'pending', decisionHash: null });
    expect(await weekPlanDeliveryState({})).toEqual({ state: null, decisionHash: null });
  });
});
