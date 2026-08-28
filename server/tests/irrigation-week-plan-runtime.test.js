/**
 * @waves/irrigation-runtime buildWeekPlan — the weekly watering DECISION.
 * Pins the owner rulings of 2026-08-28: legal cap above the model, ½" hold
 * threshold = ½" default dose (never top off a small deficit), carryover
 * capped at root-zone storage (not banked 1:1), forecast rain makes the plan
 * CONDITIONAL (never credited up front), and no plan without a current policy.
 */
const { buildWeekPlan, resolveApplicationRate, WEEK_PLAN_CONSTANTS } = require('../../packages/irrigation-runtime');

const ONE_DAY = { maxDaysPerWeek: 1 };
const TWO_DAYS = { maxDaysPerWeek: 2 };
const SPRAY = { runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], systemType: ['spray'] };

describe('buildWeekPlan — precedence and guards', () => {
  test('no current restriction policy → unavailable, never a silent 2-day fallback', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: null, ...SPRAY });
    expect(p.action).toBe('unavailable');
    expect(p.reasons).toContain('restriction_policy_missing');
    expect(p.legalMaxEvents).toBeNull();
  });

  test('no target → unavailable', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: null, season: 'peak', restriction: ONE_DAY });
    expect(p.action).toBe('unavailable');
    expect(p.reasons).toContain('target_missing');
  });

  test('never names the customer\'s saved days as permitted days', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: TWO_DAYS, ...SPRAY });
    expect(p.permittedDays).toBeNull();
  });
});

describe('buildWeekPlan — sizing', () => {
  test('1.25" need under a 1-day cap → one ¾" run, 30 min on spray, restriction_limited', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(p.action).toBe('run');
    expect(p.events).toBe(1);
    expect(p.depthInches).toBe(0.75);
    expect(p.minutesPerEvent).toBe(30);
    expect(p.rateSource).toBe('system_type_default');
    expect(p.reasons).toContain('restriction_limited');
    expect(p.conditionalOnForecast).toBe(false);
  });

  test('1.25" need under a 2-day cap → two runs; default dose ½" is the floor (spray ≈ 20 min)', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: TWO_DAYS, ...SPRAY });
    expect(p.events).toBe(2);
    expect(p.depthInches).toBe(0.63);
    expect(p.minutesPerEvent).toBe(25);
    expect(p.reasons).not.toContain('restriction_limited');
  });

  test('0.5" need → exactly one ½" run: spray 20 min, rotor 60 min', () => {
    const spray = buildWeekPlan({ targetInchesPerWeek: 0.5, season: 'shoulder', restriction: TWO_DAYS, ...SPRAY });
    expect(spray.events).toBe(1);
    expect(spray.depthInches).toBe(0.5);
    expect(spray.minutesPerEvent).toBe(20);
    const rotor = buildWeekPlan({ targetInchesPerWeek: 0.5, season: 'shoulder', restriction: TWO_DAYS, ...SPRAY, systemType: ['rotor'] });
    expect(rotor.minutesPerEvent).toBe(60);
  });

  test('cool season caps at one event and flags cool_season even under a 2-day policy', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 0.75, season: 'cool', restriction: TWO_DAYS, ...SPRAY });
    expect(p.seasonalMaxEvents).toBe(1);
    expect(p.events).toBe(1);
    expect(p.reasons).toContain('cool_season');
  });

  test('no head type → events-only plan (minutes null), still a run', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: ONE_DAY, runMinutes: 20, wateringDays: ['Mon'], systemType: [] });
    expect(p.action).toBe('run');
    expect(p.minutesPerEvent).toBeNull();
    expect(p.rateSource).toBeNull();
  });

  test('a 0-day policy → hold with restriction_prohibits, even when the need is below the event minimum', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: { maxDaysPerWeek: 0 }, ...SPRAY });
    expect(p.action).toBe('hold');
    expect(p.reasons).toContain('restriction_prohibits');
    expect(p.fallbackMinutesPerEvent).toBeNull();
    const lowNeed = buildWeekPlan({ targetInchesPerWeek: 0.3, season: 'cool', restriction: { maxDaysPerWeek: 0 }, ...SPRAY });
    expect(lowNeed.reasons).toContain('restriction_prohibits');
    expect(lowNeed.reasons).not.toContain('need_below_event_minimum');
    expect(lowNeed.fallbackMinutesPerEvent).toBeNull();
  });
});

describe('buildWeekPlan — hold threshold and carryover', () => {
  test('a 0.3" deficit is NOT topped off with a ½" run — it holds', () => {
    // target 1.25, last week applied 2.2 → carryover capped at 0.5 → need 0.75;
    // make the need small instead via a low target.
    const p = buildWeekPlan({ targetInchesPerWeek: 0.3, season: 'cool', restriction: ONE_DAY, ...SPRAY });
    expect(p.action).toBe('hold');
    expect(p.reasons).toContain('need_below_event_minimum');
    expect(p.fallbackMinutesPerEvent).toBe(20); // the wilt-override cycle is one ½" dose
    expect(WEEK_PLAN_CONSTANTS.HOLD_BELOW_INCHES).toBe(WEEK_PLAN_CONSTANTS.EVENT_DEPTH_MIN_INCHES);
  });

  test('last week\'s surplus carries over only up to root-zone storage (½"), never 1:1', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1.25, lastWeekAppliedInches: 2.6, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(p.carryoverInches).toBe(0.5); // 1.35" surplus → capped
    expect(p.needInches).toBe(0.75);
    expect(p.reasons).toContain('prior_week_overwatered');
    expect(p.action).toBe('run');
  });

  test('a big surplus against a small cool-season target → hold', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 2, season: 'cool', restriction: ONE_DAY, ...SPRAY });
    expect(p.needInches).toBe(0.25);
    expect(p.action).toBe('hold');
  });

  test('with a rain sensor, carryover comes from observed RAIN only — assumed irrigation never earns a skip', () => {
    // 0.75" schedule + 0.5" rain vs a 0.75" target: without a sensor that is a
    // 0.5" surplus (hold-worthy); with a sensor the schedule may have been
    // skipped, so only the rain counts — no surplus, a run is required.
    const noSensor = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 1.25, lastWeekRainInches: 0.5, season: 'shoulder', restriction: ONE_DAY, ...SPRAY });
    expect(noSensor.carryoverInches).toBe(0.5);
    expect(noSensor.action).toBe('hold');
    const sensor = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 1.25, lastWeekRainInches: 0.5, season: 'shoulder', restriction: ONE_DAY, rainSensor: true, ...SPRAY });
    expect(sensor.carryoverInches).toBe(0);
    expect(sensor.action).toBe('run');
    // A real rain surplus still carries for a sensor customer, under its own reason.
    const wet = buildWeekPlan({ targetInchesPerWeek: 0.75, lastWeekAppliedInches: 2.5, lastWeekRainInches: 1.75, season: 'shoulder', restriction: ONE_DAY, rainSensor: true, ...SPRAY });
    expect(wet.carryoverInches).toBe(0.5);
    expect(wet.reasons).toContain('prior_week_rain_surplus');
    expect(wet.reasons).not.toContain('prior_week_overwatered');
  });

  test('a deficit last week never carries (carryover is surplus-only)', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1, lastWeekAppliedInches: 0.2, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(p.carryoverInches).toBe(0);
    expect(p.needInches).toBe(1);
  });
});

describe('buildWeekPlan — forecast is conditional, never credited', () => {
  test('≥ ½" forecast → run stays sized for the need but conditionalOnForecast', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 1.4, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(p.action).toBe('run');
    expect(p.conditionalOnForecast).toBe(true);
    expect(p.needInches).toBe(1.25); // forecast not subtracted
    expect(p.reasons).toContain('forecast_rain');
  });

  test('< ½" forecast → unconditional; missing forecast → flagged, confidence medium at best', () => {
    const small = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: 0.3, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(small.conditionalOnForecast).toBe(false);
    const none = buildWeekPlan({ targetInchesPerWeek: 1.25, forecastRainInches: null, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(none.reasons).toContain('forecast_unavailable');
    expect(none.confidence).toBe('medium');
  });

  test('rain unknown last week → confidence low', () => {
    const p = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: ONE_DAY, rainKnown: false, ...SPRAY });
    expect(p.confidence).toBe('low');
    expect(p.reasons).toContain('rain_unknown');
  });
});

describe('resolveApplicationRate', () => {
  test('typed inches + runtime → MEASURED rate; measured rate yields exact minutes', () => {
    // 2"/wk over 20 min × 4 days = 1.5 in/hr (spray-like)
    const r = resolveApplicationRate({ explicitInchesPerWeek: 2, runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], systemType: ['spray'] });
    expect(r.rateSource).toBe('measured');
    expect(r.rateInPerHr).toBe(1.5);
    const p = buildWeekPlan({ targetInchesPerWeek: 0.5, season: 'peak', restriction: ONE_DAY, explicitInchesPerWeek: 2, ...SPRAY });
    expect(p.rateSource).toBe('measured');
    expect(p.confidence).toBe('medium'); // no forecast supplied
  });

  test('implausible measured rate falls back to the head-type default', () => {
    const r = resolveApplicationRate({ explicitInchesPerWeek: 5, runMinutes: 5, wateringDays: ['Mon'], systemType: ['spray'] });
    expect(r.rateSource).toBe('system_type_default');
    expect(r.rateInPerHr).toBe(1.5);
  });

  test('drip alongside one turf head type uses the turf head; mixed turf heads → no rate', () => {
    expect(resolveApplicationRate({ systemType: ['drip', 'rotor'] }).headType).toBe('rotor');
    expect(resolveApplicationRate({ systemType: ['spray', 'rotor'] }).rateInPerHr).toBeNull();
  });

  test('typed inches never produce per-zone minutes for mixed / drip-only / missing head types (events-only)', () => {
    const typed = { explicitInchesPerWeek: 2, runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'] };
    for (const systemType of [['spray', 'rotor'], ['drip'], [], null]) {
      const r = resolveApplicationRate({ ...typed, systemType });
      expect(r.rateSource).toBeNull();
      expect(r.rateInPerHr).toBeNull();
      const p = buildWeekPlan({ targetInchesPerWeek: 1, season: 'peak', restriction: ONE_DAY, ...typed, systemType });
      expect(p.action).toBe('run');
      expect(p.minutesPerEvent).toBeNull();
    }
  });

  test('a measured rate yields whole minutes; a default rate rounds to 5', () => {
    // 1.8"/wk over 20 min × 4 days = 1.35 in/hr measured → ¾" in 33 min (not 35)
    const measured = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, explicitInchesPerWeek: 1.8, ...SPRAY });
    expect(measured.rateSource).toBe('measured');
    expect(measured.minutesPerEvent).toBe(33);
    const assumed = buildWeekPlan({ targetInchesPerWeek: 1.25, season: 'peak', restriction: ONE_DAY, ...SPRAY });
    expect(assumed.rateSource).toBe('system_type_default');
    expect(assumed.minutesPerEvent).toBe(30);
  });
});
