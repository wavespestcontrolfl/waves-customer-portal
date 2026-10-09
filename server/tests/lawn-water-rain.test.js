// GATE_LAWN_WATER_RAIN: the lawn report's rain card (owner 2026-10-09). The card is decided by the record's frozen
// permission (rainAdvice) plus the visit; with no permission every surface is exactly what it was. Synthetic data only.

jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn() };
});

const irrigation = require('@waves/irrigation-runtime');
const { buildLawnWaterContext } = require('../services/service-report/report-data');
const { buildLawnReportV2, mapWater } = require('../services/service-report/lawn-report-v2');
const rain = require('../services/service-report/lawn-water-rain');
const advice = require('../services/service-report/irrigation-advice');
const { buildReportAskFacts } = require('../services/service-report/report-ask-ai');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const COPY = require('../../shared/lawn-water-rain-copy.json');
const WATERING = require('../../shared/watering-copy.json');

const ON = Object.freeze({ rainCard: true, sensorLine: true });
const WILT = 'folded blades, a blue-gray tint, or footprints that stay pressed in';
const COVERED = `Rain alone covered your lawn this week. Leave the sprinklers off until the grass shows ${WILT}, then run one full cycle on an allowed watering day.`;
const DEFICIT = (t) => `Your weekly water is below ${t}. If the grass shows ${WILT}, run one full cycle on your next allowed watering day.`;
const SURPLUS = 'Rain and your sprinklers together put down more than your lawn can use this week. Skip a watering day rather than shortening your runs — longer runs reach the roots better than short ones.';
const SENSOR = 'Florida law requires a rain shutoff device on an automatic sprinkler system. If yours skipped a run this week, it is working.';

const days = (values) => values.map((inches, i) => ({ date: `2026-07-${String(9 + i).padStart(2, '0')}`, inches }));
const SCHEDULE = { irrigation_inches_per_week: 0.75, irrigation_system: true };

// The real water builders: the context (rain, schedule, target), then the report builder.
function weekOf(values, { prefs = SCHEDULE, rainAdvice = null, instruction = null, totalRain = null, daily = true, extra = {} } = {}) {
  const series = days(values);
  const total = totalRain != null ? totalRain : series.reduce((sum, day) => sum + day.inches, 0);
  const waterContext = {
    ...buildLawnWaterContext({
      turfProfile: { grass_type: 'st_augustine' }, propertyPrefs: prefs, serviceDate: '2026-07-15',
      completionRainfall7dInches: total, completionDailyRain: daily ? series : null,
    }),
    ...extra,
  };
  return buildLawnReportV2({ lawnAssessment: { scores: {}, waterContext }, applications: [], rainAdvice, wateringInstruction: instruction });
}
const cardOf = (report) => ({ status: report.water.status, explanation: report.water.explanation, rain: report.water.rainInches, total: report.water.totalInches });
const waterInsight = (report) => (report.insights || []).find((card) => card.category === 'water') || null;

describe('R1: the per-day cap', () => {
  test('the cap is the package constant, imported (not a copy of the number)', () => {
    expect(rain.MAX_INCHES_PER_DAY).toBe(irrigation.WEEK_PLAN_CONSTANTS.EVENT_DEPTH_MAX_INCHES);
    expect(rain.MAX_INCHES_PER_DAY).toBe(0.75);
  });

  test.each([
    [[0, 3, 3, 0, 0, 0, 0], 6, 1.5],
    [[2, 2, 0, 0, 0, 0, 0], 4, 1.5],
    [[0.75, 0.75, 0, 0, 0, 0, 0], 1.5, 1.5],
    [[1.0, 0, 0, 0, 0, 0, 0], 1, 0.75],
    [[0.2, 0.3, 0, 0.1, 0, 0, 0], 0.6, 0.6],
    [[0, 0, 0, 0, 0, 0, 0], 0, 0],
  ])('daily %j (total %s) counts %s for the status', (values, total, expected) => {
    expect(rain.effectiveRainInches(total, days(values))).toBe(expected);
  });

  test('with only a weekly total there is NO cap: a split of a total would be a guess', () => {
    expect(rain.effectiveRainInches(6, null)).toBe(6);
    expect(rain.effectiveRainInches(6, undefined)).toBe(6);
    expect(rain.effectiveRainInches(6, days([3, 3, 0, 0, 0, 0]))).toBe(6); // 6 days: not the complete window
    expect(rain.effectiveRainInches(6, [...days([3, 3, 0, 0, 0, 0]), { date: '2026-07-15', inches: null }])).toBe(6); // a day without a number
    expect(rain.effectiveRainInches(null, days([3, 3, 0, 0, 0, 0, 0]))).toBeNull();
  });

  test('the cap changes the STATUS of a borderline week, never the rain or the total the card shows', () => {
    // 1.0 inch in one day + a 0.5 schedule against a 1.25 target: counted whole 1.5 is "above target", capped 1.25 is balanced.
    const values = [1.0, 0, 0, 0, 0, 0, 0];
    const prefs = { irrigation_inches_per_week: 0.5, irrigation_system: true };
    const off = weekOf(values, { prefs });
    const on = weekOf(values, { prefs, rainAdvice: ON });
    expect(cardOf(off).status).toBe('high');
    expect(cardOf(on)).toMatchObject({ status: 'balanced', rain: 1, total: 1.5 });
    expect(on.water.rainInches).toBe(1); // the measured rain; the capped 0.75 is never shown
    expect(JSON.stringify(on)).not.toMatch(/"(?:rainInches|totalInches)":(?:0\.75|1\.25)\b/);
  });

  test('weekly total only (no daily series): the status is the old one even with the permission', () => {
    const prefs = { irrigation_inches_per_week: 0.5, irrigation_system: true };
    const on = weekOf([1.0, 0, 0, 0, 0, 0, 0], { prefs, rainAdvice: ON, daily: false });
    expect(cardOf(on).status).toBe('high');
  });

  test('the engine rule is shared: balanceOf gives what buildIrrigationAdvice gives', () => {
    const built = advice.buildIrrigationAdvice({ grassType: 'st_augustine', month: 7, irrigationInchesPerWeek: 0.75, rainfallInches7d: 0.2 });
    expect(advice.balanceOf({ recommended: built.recommendedInchesPerWeek, irrigation: 0.75, rain: 0.2, rainKnown: true }))
      .toEqual({ appliedInchesPerWeek: built.appliedInchesPerWeek, differentialInchesPerWeek: built.differentialInchesPerWeek, status: built.status });
    expect(advice.balanceOf({ recommended: 1.25, irrigation: 0.75, rain: 0, rainKnown: false })).toMatchObject({ status: 'rain_unknown', differentialInchesPerWeek: null });
  });
});

describe('the advisor\'s three scenarios, through the real builders (gate off, then on)', () => {
  const show = (label, off, on) => {
    if (process.env.PRINT_RAIN_SCENARIOS) console.log(`${label}\n  OFF ${JSON.stringify(cardOf(off))} insight=${waterInsight(off) && waterInsight(off).customerAction}\n  ON  ${JSON.stringify(cardOf(on))} insight=${waterInsight(on) && waterInsight(on).customerAction}`);
  };

  test('(i) 6 inches + a 0.75 schedule: "rain covered" instead of "ease back"; then a 0.2 inch week: the new deficit sentence', () => {
    const wet = [0, 3, 3, 0, 0, 0, 0];
    const off = weekOf(wet);
    const on = weekOf(wet, { rainAdvice: ON });
    show('(i) week 1', off, on);
    expect(cardOf(off)).toMatchObject({ status: 'high', rain: 6, total: 6.75 });
    expect(off.water.explanation).toBe('Your weekly water (rain + irrigation) is running above about 1.25"/wk. Easing back on irrigation should help reduce fungus, mushrooms, and weed pressure.');
    expect(waterInsight(off).customerAction).toMatch(/Ease back on irrigation by one cycle/);
    expect(cardOf(on)).toEqual({ status: 'rain_covered', explanation: COVERED, rain: 6, total: 6.75 });
    expect(on.water).toMatchObject({ rainCard: true, rainSensorLine: true });
    expect(waterInsight(on)).toBeNull(); // no "too much water" card beside "rain covered it"
    // the diagnosis (its water category feeds the insights and the root cause) reads the card's own status
    const { buildVisualDiagnosisCategories } = require('../services/service-report/lawn-visual-diagnosis');
    const category = (waterStatus) => buildVisualDiagnosisCategories({ scores: {}, waterStatus }).find((card) => card.key === 'water_moisture_stress');
    expect(category('surplus').score).toBeLessThan(category('rain_covered').score);
    expect(category('rain_covered').score).toBe(category('balanced').score);
    expect(JSON.stringify(category('rain_covered'))).not.toMatch(/above target|below target/);

    const dry = [0, 0, 0.2, 0, 0, 0, 0];
    const dryOff = weekOf(dry);
    const dryOn = weekOf(dry, { rainAdvice: ON });
    show('(i) week 2', dryOff, dryOn);
    expect(dryOff.water.explanation).toBe('Your weekly water is below about 1.25"/wk. A little more irrigation time will help the lawn handle the heat.');
    expect(cardOf(dryOn)).toMatchObject({ status: 'low', explanation: DEFICIT('about 1.25"/wk') });
    expect(dryOn.water.explanation).not.toMatch(/few minutes|more irrigation time|each run/i);
    expect(waterInsight(dryOn).customerAction).toBe(`If the grass shows ${WILT}, run one full cycle on your next allowed watering day.`);
    expect(dryOn.water.rainSensorLine).toBeUndefined(); // the sensor line is for a rain-covered week only
  });

  test('(ii) 4 inches on days 1-2, then five dry days: rain covered the week (the lawn is told to wait for the wilt signs)', () => {
    const week = [2, 2, 0, 0, 0, 0, 0];
    const off = weekOf(week);
    const on = weekOf(week, { rainAdvice: ON });
    show('(ii)', off, on);
    expect(cardOf(off).status).toBe('high');
    expect(cardOf(on)).toMatchObject({ status: 'rain_covered', explanation: COVERED, rain: 4, total: 4.75 });
  });

  test('(iii) 6 inches, no schedule on file: today the card is silent about the rain; now it says so, and the schedule call to action stays', () => {
    const week = [0, 3, 3, 0, 0, 0, 0];
    const off = weekOf(week, { prefs: null });
    const on = weekOf(week, { prefs: null, rainAdvice: ON });
    show('(iii)', off, on);
    expect(cardOf(off)).toMatchObject({ status: 'unknown' });
    expect(off.water.explanation).toMatch(/don’t have your irrigation schedule on file/);
    expect(cardOf(on)).toMatchObject({ status: 'rain_covered', explanation: COVERED, rain: 6 });
    expect(on.water.scheduleOnFile).toBe(false); // state C is untouched: the card still asks for the schedule
    expect(on.water.confidence).toBe('low');
  });

  test('a wet week the sprinklers pushed over (rain below the target): the new surplus sentence', () => {
    const values = [1.0, 0, 0, 0, 0, 0, 0];
    const prefs = { irrigation_inches_per_week: 1.5, irrigation_system: true };
    const on = weekOf(values, { prefs, rainAdvice: ON });
    expect(cardOf(on)).toMatchObject({ status: 'high', explanation: SURPLUS });
    expect(on.water.explanation).not.toMatch(/fungus|mushroom|weed pressure|should help/i);
  });
});

describe('R3 boundaries', () => {
  test('rain exactly at the target is covered; just under is not', () => {
    // st_augustine July target 1.25
    expect(cardOf(weekOf([1.25, 0, 0, 0, 0, 0, 0], { rainAdvice: ON })).status).toBe('rain_covered');
    expect(cardOf(weekOf([1.2, 0, 0, 0, 0, 0, 0], { rainAdvice: ON })).status).not.toBe('rain_covered');
  });

  test('the measured rain decides "covered", not the capped figure (a 2 inch single day is covered)', () => {
    expect(cardOf(weekOf([2, 0, 0, 0, 0, 0, 0], { rainAdvice: ON })).status).toBe('rain_covered');
  });

  test('no rain reading at all: nothing is claimed', () => {
    const report = weekOf([0, 0, 0, 0, 0, 0, 0], { rainAdvice: ON, totalRain: null, daily: false, extra: { rainfallInches7d: null } });
    expect(report.water.status).not.toBe('rain_covered');
  });
});

describe('suppression: today\'s card, byte for byte', () => {
  const wet = [0, 3, 3, 0, 0, 0, 0];
  const base = () => weekOf(wet);

  test.each([
    ['no frozen permission (a record from before the gate)', { rainAdvice: null }],
    ['a version 1 record', { rainAdvice: undefined }],
    ['the frozen decision said no (new sod, or a move left the schedule unconfirmed)', { rainAdvice: null }],
    ['a post-treatment hold', { rainAdvice: ON, instruction: { state: 'hold', lines: ['x'] } }],
    ['a hold then water-in', { rainAdvice: ON, instruction: { state: 'hold_then_water_in', lines: ['x'] } }],
    ['a water-in', { rainAdvice: ON, instruction: { state: 'water_in', lines: ['x'] } }],
    ['the schedule withheld after a move', { rainAdvice: ON, extra: { scheduleUnconfirmed: true } }],
  ])('%s', (_label, options) => {
    const off = base();
    const report = weekOf(wet, options);
    if (options.extra) {
      expect(report.water.status).not.toBe('rain_covered');
      expect(report.water).not.toHaveProperty('rainCard');
    } else {
      expect(report.water).toEqual(off.water);
      expect(JSON.stringify(report.insights)).toBe(JSON.stringify(off.insights));
      expect(JSON.stringify(report.diagnosis)).toBe(JSON.stringify(off.diagnosis));
    }
  });

  test('a "no watering change" instruction (state none) does not stand the card down', () => {
    expect(weekOf(wet, { rainAdvice: ON, instruction: { state: 'none', lines: ['No watering change from today’s treatment.'] } }).water.status).toBe('rain_covered');
  });

  test('the capped status also stands down with an instruction (the whole card is today\'s)', () => {
    const prefs = { irrigation_inches_per_week: 0.5, irrigation_system: true };
    const report = weekOf([1.0, 0, 0, 0, 0, 0, 0], { prefs, rainAdvice: ON, instruction: { state: 'water_in', lines: ['x'] } });
    expect(report.water.status).toBe('high');
  });

  test('a water week with a weekly plan keeps today\'s display rule: the status is rain covered, the plan prints', () => {
    const report = weekOf(wet, { rainAdvice: ON, extra: { weekPlan: { title: 'This week: skip', detail: 'x', action: 'hold' } } });
    expect(report.water.status).toBe('rain_covered');
    expect(report.water.weekPlan.title).toBe('This week: skip');
  });
});

describe('the rain sensor line', () => {
  test('only in a rain-covered week, and only when the frozen decision wants it', () => {
    expect(weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: ON }).water.rainSensorLine).toBe(true);
    expect(weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: { rainCard: true, sensorLine: false } }).water).not.toHaveProperty('rainSensorLine');
    expect(weekOf([0, 0, 0.2, 0, 0, 0, 0], { rainAdvice: ON }).water).not.toHaveProperty('rainSensorLine');
  });

  test('the field and its truthy values: property_preferences.rain_sensor, true or "t" (the weekly email\'s own test)', () => {
    const decide = (rain_sensor, extra = {}) => rain.rainCardDecision({ sod_laid_on: null, rain_sensor, ...extra }, '2026-07-15').rainSensorLine;
    expect(decide(true)).toBe(false);
    expect(decide('t')).toBe(false);
    [false, null, undefined, 'f', 0].forEach((value) => expect(decide(value)).toBe(true));
  });

  // The move guard needs a rate table since the one-rate-table change; the freeze is a live read, so it passes the live one.
  test('a customer who moved, with an unconfirmed schedule, gets no rain card (and the guard is given a rate table)', () => {
    const moved = { sod_laid_on: null, rain_sensor: false, irrigation_home_changed_at: '2026-06-01T00:00:00Z', irrigation_run_minutes: 30, irrigation_confirmed_fields: '[]' };
    expect(rain.rainCardDecision(moved, '2026-07-15')).toEqual({ rainCard: false, rainSensorLine: false });
    expect(rain.rainCardDecision({ ...moved, irrigation_confirmed_fields: '["irrigation_run_minutes"]' }, '2026-07-15').rainCard).toBe(true);
  });
});

describe('the snapshot path (no property rain, an area snapshot instead)', () => {
  const snapshot = (rainInches, status, interpretation) => ({
    status, interpretation, confidence: 'high', rain_7day_inches: rainInches, adjusted_rain_7day_inches: rainInches,
    irrigation_inches_per_week: 0.75, total_water_7day_inches: rainInches + 0.75, target_water_inches_per_week: 1.25,
  });
  const run = (snap, rainAdvice) => {
    const waterContext = buildLawnWaterContext({ turfProfile: { grass_type: 'st_augustine' }, propertyPrefs: SCHEDULE, serviceDate: '2026-07-15' });
    return buildLawnReportV2({ lawnAssessment: { scores: {}, waterContext }, applications: [], waterSnapshot: snap, rainAdvice });
  };

  test('rain covered, deficit and surplus on the snapshot, with its lead sentence and "~X" target format; no cap (no daily series)', () => {
    const covered = run(snapshot(3, 'high', 'wet_condition_watch'), ON);
    expect(covered.water).toMatchObject({ source: 'area_snapshot', status: 'rain_covered', explanation: COVERED });
    const deficit = run(snapshot(0.1, 'low', 'water_deficit_likely'), ON);
    expect(deficit.water.explanation).toMatch(/^Based on rainfall for your area and the irrigation schedule on file, your area received about 0\.1" of rain/);
    expect(deficit.water.explanation).toContain(DEFICIT('~1.3"/wk').replace('~1.3', '~1.3'));
    expect(run(snapshot(0.9, 'high', 'wet_condition_watch'), ON).water.explanation).toMatch(/this week\. Rain and your sprinklers together put down more than your lawn can use this week\./);
    expect(run(snapshot(3, 'high', 'wet_condition_watch'), null).water.explanation).toMatch(/Easing back on irrigation should help reduce/);
  });
});

describe('every surface agrees on a rain-covered week', () => {
  test('Ask Waves is told the status and the sentence; the narrative is not given a watering claim', () => {
    const on = weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: ON });
    const facts = buildReportAskFacts({ data: { serviceLine: 'lawn', applications: [], reportV2: on } }).lawn_report.water_this_week;
    expect(facts.status).toBe('rain_covered');
    expect(facts.explanation).toContain('Rain alone covered your lawn this week.');
    expect(facts.rain_last_7_days_inches).toBe(6);
    const { groundingFacts, mergeNarrative } = require('../services/service-report/lawn-report-narrative')._test;
    expect(groundingFacts(on, { grassLabel: 'lawn' }).water).toMatchObject({ status: 'unknown', rainCoveredWeek: true });
    // the model may not rewrite the fixed sentence (it may rewrite an ordinary explanation)
    const rewritten = mergeNarrative(on, { water: 'Over the past week the lawn got plenty of rain, so skip the sprinklers.' });
    expect(rewritten.water.explanation).toBe(COVERED);
  });

  test('the root cause and the insights name no watering fix beside it', () => {
    const on = weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: ON });
    expect(on.snapshot.rootCause || '').not.toMatch(/too much water|a little dry/);
    expect(waterInsight(on)).toBeNull();
  });
});

describe('round 1 review: one watering story across every surface', () => {
  const DRY = [0, 0, 0.2, 0, 0, 0, 0];
  const PLAN = { title: 'This week: run once', detail: 'x', action: 'run' };
  const narrative = require('../services/service-report/lawn-report-narrative');
  const MODEL = {
    statusHeadline: 'Your lawn is thirsty', customerAction: 'Add ten minutes to every run this week.', water: 'Over the past week the lawn needs more irrigation time.',
    insights: [{ headline: 'h', whatWeSaw: 'w', whyItMatters: 'y', wavesAction: 'a', customerAction: 'Add irrigation time to every zone.', nextVisitPlan: 'n' }],
  };

  test('narrative: a rain-card report is not rewritten by the model, in any action field (P1)', async () => {
    const on = weekOf(DRY, { rainAdvice: ON });
    expect(on.water.rainCard).toBe(true);
    const report = { ...on, water: { ...on.water, droughtSignal: true } };
    // the merge keeps the snapshot action, every insight action and the card sentence
    const merged = narrative._test.mergeNarrative(report, MODEL);
    expect(merged.snapshot.customerAction).toBe(report.snapshot.customerAction);
    expect(merged.water.explanation).toBe(report.water.explanation);
    merged.insights.forEach((card, i) => expect(card.customerAction).toBe(report.insights[i].customerAction));
    // and the whole overlay is skipped: the model is never called, the very same report comes back
    const callModel = jest.fn(async () => ({ ok: true, json: MODEL }));
    expect(await narrative.applyLawnReportNarrative(report, { grassLabel: 'lawn' }, { callModel })).toBe(report);
    expect(callModel).not.toHaveBeenCalled();
  });

  test('narrative: without the rain card the overlay still runs (gate off is untouched)', async () => {
    const off = weekOf(DRY);
    expect(off.water.rainCard).toBeUndefined();
    const report = { ...off, water: { ...off.water, droughtSignal: true } };
    const callModel = jest.fn(async () => ({ ok: true, json: MODEL }));
    await narrative.applyLawnReportNarrative(report, { grassLabel: 'lawn' }, { callModel });
    expect(callModel).toHaveBeenCalled();
  });

  test('root cause: a deficit with no plan says what the card says, wilt signs and one full cycle (P2)', () => {
    const on = weekOf(DRY, { rainAdvice: ON });
    const expected = `The lawn is simply running a little dry. If the grass shows ${WILT}, run one full cycle on your next allowed watering day.`;
    expect(on.snapshot.rootCause).toBe(expected);
    expect(on.water.explanation).toContain(`If the grass shows ${WILT}, run one full cycle on your next allowed watering day.`);
    expect(customerCopyViolations(on.snapshot.rootCause)).toEqual([]);
    expect(on.snapshot.rootCause).not.toMatch(/more even watering/);
    // the gate off, and a plan on the card, keep their own sentences
    expect(weekOf(DRY).snapshot.rootCause).toBe('The lawn is simply running a little dry — a bit more even watering is the highest-impact fix right now.');
    expect(weekOf(DRY, { rainAdvice: ON, extra: { weekPlan: PLAN } }).snapshot.rootCause).toMatch(/this week’s watering plan below sets the runs/);
  });

  test('insight twins: the deficit next-visit line adds no water, the surplus action is the card\'s (no plan)', () => {
    const dry = waterInsight(weekOf(DRY, { rainAdvice: ON }));
    expect(dry.nextVisitPlan).toBe('Recheck moisture and color next visit.');
    expect(waterInsight(weekOf(DRY)).nextVisitPlan).toMatch(/added water is landing/);
    const prefs = { irrigation_inches_per_week: 1.5, irrigation_system: true };
    const over = waterInsight(weekOf([1.0, 0, 0, 0, 0, 0, 0], { prefs, rainAdvice: ON }));
    expect(over.customerAction).toBe(WATERING.surplusAdvice);
    expect(waterInsight(weekOf([1.0, 0, 0, 0, 0, 0, 0], { prefs })).customerAction).toMatch(/Ease back on irrigation by one cycle/);
  });

  test('Ask Waves: a weekly plan on the card hides the rain-card sentence from the facts, the status stays (P1)', () => {
    const ask = (report) => buildReportAskFacts({ data: { serviceLine: 'lawn', applications: [], reportV2: report } }).lawn_report.water_this_week;
    const wet = [0, 3, 3, 0, 0, 0, 0];
    const withPlan = ask(weekOf(wet, { rainAdvice: ON, extra: { weekPlan: PLAN } }));
    expect(withPlan.status).toBe('rain_covered');
    expect(withPlan.explanation).toBeUndefined();
    expect(withPlan.week_plan).toContain('This week: run once');
    const dryPlan = ask(weekOf(DRY, { rainAdvice: ON, extra: { weekPlan: PLAN } }));
    expect(dryPlan.status).toBe('low');
    expect(dryPlan.explanation).toBeUndefined();
    // no plan: the sentence the page prints is the sentence Ask Waves gets
    expect(ask(weekOf(wet, { rainAdvice: ON })).explanation).toBe(COVERED);
    expect(ask(weekOf(DRY, { rainAdvice: ON })).explanation).toBe(DEFICIT('about 1.25"/wk'));
    // gate off (no rainCard): an ordinary explanation is sent as it always was, plan or not
    expect(ask(weekOf(DRY, { extra: { weekPlan: PLAN } })).explanation).toMatch(/below about 1\.25"\/wk/);
  });

  test('the page and Ask Waves share one predicate for "a weekly plan is on the card"', () => {
    const { weekPlanOnCard } = require('../../shared/lawn-water-card.cjs');
    expect(weekPlanOnCard({ weekPlan: { title: 'x' } })).toBe(true);
    expect(weekPlanOnCard({ weekPlan: { title: '' } })).toBe(false);
    expect(weekPlanOnCard({ weekPlan: null })).toBe(false);
    expect(weekPlanOnCard({})).toBe(false);
    expect(weekPlanOnCard(null)).toBe(false);
  });
});

describe('round 2 review: the snapshot wet flag, the sensor line in Ask facts, the damp card', () => {
  const snap = (rainInches, status, interpretation) => ({
    status, interpretation, confidence: 'high', rain_7day_inches: rainInches, adjusted_rain_7day_inches: rainInches,
    irrigation_inches_per_week: 0.75, total_water_7day_inches: rainInches + 0.75, target_water_inches_per_week: 1.25,
  });
  const runSnap = (snapshot, rainAdvice, assessment = {}) => {
    const waterContext = buildLawnWaterContext({ turfProfile: { grass_type: 'st_augustine' }, propertyPrefs: SCHEDULE, serviceDate: '2026-07-15' });
    return buildLawnReportV2({ lawnAssessment: { scores: {}, waterContext, ...assessment }, applications: [], waterSnapshot: snapshot, rainAdvice });
  };

  test('P1: a snapshot reclassified as rain covered no longer drives the overwatering story (insight, root cause)', () => {
    const wet = snap(3, 'high', 'wet_condition_watch');
    const on = runSnap(wet, ON);
    expect(on.water.status).toBe('rain_covered');
    expect(waterInsight(on)).toBeNull();
    expect(on.snapshot.rootCause || '').not.toMatch(/too much water|easing back/);
    // gate off: the same snapshot still tells today's overwatering story
    const off = runSnap(wet, null);
    expect(off.snapshot.rootCause).toMatch(/too much water/);
    expect(waterInsight(off).headline).toBe('The lawn is likely getting too much water');
    // a surplus that is NOT rain covered keeps the snapshot wet flag (rain below the target)
    const surplus = runSnap(snap(0.9, 'high', 'wet_condition_watch'), ON);
    expect(surplus.water.status).toBe('high');
    expect(surplus.snapshot.rootCause).toMatch(/too much water/);
  });

  test('P1: an independent photo overwatering signal still counts on a rain-covered snapshot', () => {
    const on = runSnap(snap(3, 'high', 'wet_condition_watch'), ON, { overwateringSignal: true });
    expect(on.water.status).toBe('rain_covered');
    expect(on.snapshot.rootCause).toMatch(/too much water/);
  });

  test('P2: the rain shutoff sentence is in the Ask facts exactly when the page prints it', () => {
    const ask = (report) => buildReportAskFacts({ data: { serviceLine: 'lawn', applications: [], reportV2: report } }).lawn_report.water_this_week;
    const wet = [0, 3, 3, 0, 0, 0, 0];
    const PLAN = { title: 'This week: run once', detail: 'x', action: 'run' };
    expect(ask(weekOf(wet, { rainAdvice: ON })).rain_sensor_note).toBe(SENSOR);
    // a weekly plan hides the explanation, never the sensor line
    const withPlan = ask(weekOf(wet, { rainAdvice: ON, extra: { weekPlan: PLAN } }));
    expect(withPlan.explanation).toBeUndefined();
    expect(withPlan.rain_sensor_note).toBe(SENSOR);
    // not printed = not in the facts: sensor field true, a deficit week, gate off
    expect(ask(weekOf(wet, { rainAdvice: { rainCard: true, sensorLine: false } })).rain_sensor_note).toBeUndefined();
    expect(ask(weekOf([0, 0, 0.2, 0, 0, 0, 0], { rainAdvice: ON })).rain_sensor_note).toBeUndefined();
    expect(ask(weekOf(wet)).rain_sensor_note).toBeUndefined();
  });

  test('P2: page and Ask Waves share one predicate for the sensor line', () => {
    const { rainSensorLineOnCard } = require('../../shared/lawn-water-card.cjs');
    expect(rainSensorLineOnCard({ rainSensorLine: true, status: 'rain_covered' })).toBe(true);
    expect(rainSensorLineOnCard({ rainSensorLine: true, status: 'low' })).toBe(false);
    expect(rainSensorLineOnCard({ rainSensorLine: false, status: 'rain_covered' })).toBe(false);
    expect(rainSensorLineOnCard({ status: 'rain_covered' })).toBe(false);
    expect(rainSensorLineOnCard(null)).toBe(false);
    const fs = require('fs');
    const page = fs.readFileSync(require('path').join(__dirname, '../../client/src/components/report/lawnV2/LawnReportV2.jsx'), 'utf8');
    expect(page).toMatch(/rainSensorLineOnCard/);
  });

  test('sweep: the moisture-balance card beside a rain-covered card says neither "keep your schedule" nor a cycle count', () => {
    const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
    const categories = [{ key: 'water_moisture_stress', status: 'watch', score: 60, customerExplanation: 'Mixed moisture read.' }];
    const card = (water) => buildLawnInsightCards({ categories, water: { rainCard: true, scheduleOnFile: true, ...water }, grassLabel: 'lawn' }).find((c) => c.category === 'water');
    expect(card({ status: 'rain_covered' }).customerAction).toBe('We’ll keep watching moisture balance at upcoming visits.');
    expect(card({ status: 'rain_covered', overwatering: true }).customerAction).toBe('Let the damp areas dry out between waterings.');
    // not rain covered (and gate off): today's sentences
    expect(card({ status: 'balanced', rainCard: false }).customerAction).toBe('Keep your current watering schedule unless we flag a change.');
    expect(card({ status: 'balanced', rainCard: false, overwatering: true }).customerAction).toMatch(/ease back an irrigation cycle/);
  });
});

describe('the customer copy', () => {
  test('the exact sentences, built from the shared wilt-signs constant', () => {
    expect(WATERING.wiltSigns).toBe(WILT);
    expect(COPY.pillLabel).toBe('Rain covered it');
    expect(COPY.surplus).toBe(SURPLUS);
    expect(COPY.sensorLine).toBe(SENSOR);
    expect(weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: ON }).water.explanation).toBe(COVERED);
  });

  test.each([COVERED, DEFICIT('about 1.25"/wk'), SURPLUS, SENSOR, 'Rain covered it'])('passes the customer-copy rules and promises nothing: %s', (text) => {
    expect(customerCopyViolations(text)).toEqual([]);
    expect(text).not.toMatch(/\b(?:safe|guarantee|will help|should help|prevent|a few minutes|each run\b.*add|add .*minutes)\b/i);
    expect(text).not.toMatch(/\b(?:fungus|dollarweed|leach\w*|stored|days? (?:to|until) wilt)\b/i); // R4: no leaching, no inches stored, no days to wilt
  });

  test('the sentences name no weekday, day count, minutes or restriction number', () => {
    [COVERED, DEFICIT('about 1.25"/wk'), SURPLUS].forEach((text) => {
      expect(text.replace(/about 1\.25"\/wk/, '')).not.toMatch(/\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|minute/i);
    });
  });
});

describe('the gate readers', () => {
  const gates = require('../config/feature-gates');
  const saved = { rain: process.env.GATE_LAWN_WATER_RAIN, facts: process.env.GATE_LAWN_REPORT_FACTS };
  afterEach(() => {
    if (saved.rain === undefined) delete process.env.GATE_LAWN_WATER_RAIN; else process.env.GATE_LAWN_WATER_RAIN = saved.rain;
    if (saved.facts === undefined) delete process.env.GATE_LAWN_REPORT_FACTS; else process.env.GATE_LAWN_REPORT_FACTS = saved.facts;
  });

  test('strict true, read at call time; the freeze needs the facts gate too (one named helper)', () => {
    const set = (r, f) => { if (r === null) delete process.env.GATE_LAWN_WATER_RAIN; else process.env.GATE_LAWN_WATER_RAIN = r; if (f === null) delete process.env.GATE_LAWN_REPORT_FACTS; else process.env.GATE_LAWN_REPORT_FACTS = f; };
    [[null, null, false, false], ['true', null, true, false], [null, 'true', false, false], ['true', 'true', true, true], ['1', 'true', false, false], ['TRUE', 'true', false, false]]
      .forEach(([r, f, live, freeze]) => { set(r, f); expect(gates.lawnWaterRainLive()).toBe(live); expect(gates.lawnWaterRainFreezeLive()).toBe(freeze); });
  });

  test('the gate does not change a render: a record frozen with the permission renders the card whatever the gate says', () => {
    delete process.env.GATE_LAWN_WATER_RAIN;
    expect(weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: ON }).water.status).toBe('rain_covered');
    process.env.GATE_LAWN_WATER_RAIN = 'true';
    expect(weekOf([0, 3, 3, 0, 0, 0, 0], { rainAdvice: null }).water.status).toBe('high');
  });
});

describe('mapWater alone is untouched', () => {
  test('without the rain card nothing in mapWater changes', () => {
    const context = buildLawnWaterContext({ turfProfile: { grass_type: 'st_augustine' }, propertyPrefs: SCHEDULE, serviceDate: '2026-07-15', completionRainfall7dInches: 6, completionDailyRain: days([0, 3, 3, 0, 0, 0, 0]) });
    const water = mapWater(context);
    expect(water.status).toBe('high');
    ['rainCard', 'rainSensorLine'].forEach((key) => expect(water).not.toHaveProperty(key));
  });
});
