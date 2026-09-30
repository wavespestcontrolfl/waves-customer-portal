// Watering instruction writer (lawn report rebuild P2). Pure module: per-product
// rules + completion time + the customer's runtime facts in, one instruction out.
// Synthetic data only.

const { buildWateringInstruction, _private } = require('../services/service-report/lawn-watering-instruction');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../services/content/content-guardrails');

// 2026-09-30 14:40 ET (EDT, UTC-4).
const COMPLETED = '2026-09-30T18:40:00Z';

const HOLD = (hours = 24, source = 'label') => ({ mode: 'hold', hold_hours: hours, source });
const WATER_IN = (over = {}) => ({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default', ...over });
const NONE = (source = 'label') => ({ mode: 'none', source });

const build = (rules, extra = {}) => buildWateringInstruction({ rules, completedAt: COMPLETED, ...extra });

function expectCleanCopy(instruction) {
  for (const line of instruction.lines) {
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(reentrySafetyClaimFinding(line)).toBeFalsy();
    // No probabilities, no county language, no drying / keep-off phrasing.
    expect(line).not.toMatch(/%|percent|chance|ordinance|county|blackout|\bdry\b|\bwait\b|keep\b.*\boff\b|stay off/i);
  }
  expect(instruction.lines.length).toBeLessThanOrEqual(3);
}

describe('mixed-visit matrix', () => {
  test('hold alone', () => {
    const r = build([HOLD(24)], { hasWeekPlan: true });
    expect(r.state).toBe('hold');
    expect(r.lines).toEqual([
      'Skip your turf watering until Thu 3 PM.',
      'That gives today’s treatment time to work.',
      'Then follow this week’s plan below.',
    ]);
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.waterInBy).toBeNull();
    expect(r.ruleSource).toBe('label');
    expectCleanCopy(r);
  });

  test('hold without a weekly plan drops the plan line', () => {
    expect(build([HOLD(24)]).lines).toHaveLength(2);
  });

  test('water-in alone: deadline rounds DOWN, runs on a non-permitted day, no rain talk', () => {
    const r = build([WATER_IN()], { runtime: { headTypes: ['rotor'] } });
    expect(r.state).toBe('water_in');
    expect(r.waterInBy).toBe('2026-10-01T18:00:00.000Z'); // 2 PM, not 3 PM
    expect(r.lines).toEqual([
      'Water in today’s treatment by Thu 2 PM.',
      'Run each zone about 40 minutes.',
      'Run it even if it is not your usual day.',
    ]);
    expect(r.ruleSource).toBe('default');
    expectCleanCopy(r);
  });

  test('hold + water-in: hold wins, then water in after the hold ends', () => {
    const r = build([HOLD(24), WATER_IN()], { runtime: { headTypes: ['spray'] } });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.waterInBy).toBe('2026-10-02T19:00:00.000Z'); // hold end + 24 h
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 3 PM, then water in.');
    expect(r.lines[1]).toBe('After that, run each zone about 15 minutes within 24 hours.');
    expect(r.lines[2]).toBe('Run it even if it is not your usual day.');
    // Weakest provenance among the rules that drive the instruction.
    expect(r.ruleSource).toBe('default');
    expectCleanCopy(r);
  });

  test('hold + none is a plain hold; the none product contributes nothing', () => {
    const r = build([HOLD(24), NONE()]);
    expect(r.state).toBe('hold');
    expect(r.ruleSource).toBe('label');
  });

  test('two holds take the longer; two water-ins take the deeper depth and the earlier deadline', () => {
    expect(build([HOLD(24), HOLD(48)]).holdUntil).toBe('2026-10-02T19:00:00.000Z');
    const r = build([WATER_IN({ water_in_inches: 0.25, water_in_by_hours: 48 }), WATER_IN({ water_in_inches: 0.5, water_in_by_hours: 12 })], { runtime: { headTypes: ['spray'] } });
    expect(r.waterInBy).toBe('2026-10-01T06:00:00.000Z'); // 2:40 PM + 12 h = 2:40 AM, floored: Thu 2 AM ET
    expect(r.minutes.spray).toBe(30); // 0.5 in scales 15 -> 30
    expect(r.lines[0]).toBe('Water in today’s treatment by Thu 2 AM.');
  });

  test('an unresolved product never blocks a hold or water-in another product forces', () => {
    expect(build([null, HOLD(24)]).state).toBe('hold');
    expect(build([null, WATER_IN()]).state).toBe('water_in');
  });

  test('no claim (state null) when nothing forces hold or water-in and any product is unresolved', () => {
    for (const rules of [[null], [null, NONE()], [], undefined]) {
      const r = build(rules);
      expect(r.state).toBeNull();
      expect(r.lines).toEqual([]);
    }
  });

  test('none is a positive claim: every product resolved AND at least one label/owner sourced', () => {
    const r = build([NONE('label'), NONE('default')], { hasWeekPlan: true });
    expect(r.state).toBe('none');
    expect(r.lines).toEqual(['No watering change from today’s treatment.', 'Follow this week’s plan below.']);
    expectCleanCopy(r);
    expect(build([NONE('owner')]).state).toBe('none');
    // Defaults alone never assert "no change".
    expect(build([NONE('default'), NONE('default')]).state).toBeNull();
    // An unresolved product blocks it.
    expect(build([NONE('label'), null]).state).toBeNull();
    expect(build([NONE('label')]).lines).toEqual(['No watering change from today’s treatment.']);
  });

  test('completedAt missing or invalid -> no claim at all', () => {
    for (const completedAt of [null, undefined, '', 'not a date']) {
      const r = buildWateringInstruction({ rules: [HOLD(24)], completedAt });
      expect(r.state).toBeNull();
      expect(r.lines).toEqual([]);
      expect(r.holdUntil).toBeNull();
    }
  });

  test('accepts { name, rule } entries and reports each product', () => {
    const r = build([{ name: 'Celsius WG', rule: HOLD(24) }, { name: 'K-Flow', rule: null }]);
    expect(r.state).toBe('hold');
    expect(r.products).toEqual([
      { name: 'Celsius WG', mode: 'hold', source: 'label' },
      { name: 'K-Flow', mode: null, source: null },
    ]);
  });

  test('ruleSource: label, owner, default (weakest driving rule wins)', () => {
    expect(build([HOLD(24, 'label')]).ruleSource).toBe('label');
    expect(build([HOLD(24, 'owner')]).ruleSource).toBe('owner');
    expect(build([HOLD(24, 'label'), HOLD(24, 'owner')]).ruleSource).toBe('owner');
    expect(build([HOLD(24, 'label'), WATER_IN({ source: 'default' })]).ruleSource).toBe('default');
    // A none product never lowers the provenance of the rules that drive the state.
    expect(build([HOLD(24, 'label'), NONE('default')]).ruleSource).toBe('label');
  });
});

describe('hold end: rounded UP to the next clock hour in ET, worded from the visit day', () => {
  test('rounds up, never down', () => {
    const r = buildWateringInstruction({ rules: [HOLD(24)], completedAt: '2026-09-30T18:00:00Z' });
    expect(r.holdUntil).toBe('2026-10-01T18:00:00.000Z'); // already on the hour: kept
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 2 PM.');
    const r2 = buildWateringInstruction({ rules: [HOLD(24)], completedAt: '2026-09-30T18:00:01Z' });
    expect(r2.lines[0]).toBe('Skip your turf watering until Thu 3 PM.');
  });

  test('same ET day reads "tonight" (evening) or "today"; a later day names the weekday', () => {
    const evening = buildWateringInstruction({ rules: [HOLD(4)], completedAt: '2026-09-30T20:10:00Z' }); // 4:10 PM ET + 4 h
    expect(evening.lines[0]).toBe('Skip your turf watering until 9 PM tonight.');
    const afternoon = buildWateringInstruction({ rules: [HOLD(2)], completedAt: '2026-09-30T14:10:00Z' }); // 10:10 AM ET + 2 h
    expect(afternoon.lines[0]).toBe('Skip your turf watering until 1 PM today.');
    const nextDay = buildWateringInstruction({ rules: [HOLD(48)], completedAt: COMPLETED });
    expect(nextDay.lines[0]).toBe('Skip your turf watering until Fri 3 PM.');
  });

  test('the ET date, not the UTC date, decides "today" (visit after 8 PM ET is already the next UTC day)', () => {
    // 9:30 PM ET Sep 30 = 01:30 UTC Oct 1; +1 h = 11 PM ET, same ET day.
    const r = buildWateringInstruction({ rules: [HOLD(1)], completedAt: '2026-10-01T01:30:00Z' });
    expect(r.lines[0]).toBe('Skip your turf watering until 11 PM tonight.');
  });

  test('a midnight-ET end reads as 12 AM on the next weekday', () => {
    const r = buildWateringInstruction({ rules: [HOLD(3)], completedAt: '2026-10-01T01:30:00Z' }); // 9:30 PM ET + 3 h = 12:30 AM -> 1 AM Thu
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 1 AM.');
  });

  test('DST: 24 elapsed hours across fall-back lands on the same wall clock minus one hour, still on the hour', () => {
    // Sat 2026-10-31 3 PM EDT + 24 h crosses the 2026-11-01 fall-back: 2 PM EST Sun.
    const r = buildWateringInstruction({ rules: [HOLD(24)], completedAt: '2026-10-31T19:00:00Z' });
    expect(r.holdUntil).toBe('2026-11-01T19:00:00.000Z');
    expect(r.lines[0]).toBe('Skip your turf watering until Sun 2 PM.');
    // Spring forward 2027-03-14: Sat 3 PM EST + 24 h = Sun 4 PM EDT.
    const s = buildWateringInstruction({ rules: [HOLD(24)], completedAt: '2027-03-13T20:00:00Z' });
    expect(s.holdUntil).toBe('2027-03-14T20:00:00.000Z');
    expect(s.lines[0]).toBe('Skip your turf watering until Sun 4 PM.');
  });

  test('helpers round on the absolute hour', () => {
    const d = new Date('2026-09-30T18:40:00Z');
    expect(_private.ceilToHour(d).toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(_private.floorToHour(d).toISOString()).toBe('2026-09-30T18:00:00.000Z');
  });
});

describe('minutes ladder (a sprinkler system is never assumed absent)', () => {
  const waterIn = (runtime, over = {}) => build([WATER_IN(over)], { runtime });

  test('measured: typed weekly inches + run minutes + days + one head type', () => {
    // 1.5 in/week over 30 min x 2 days = 1.5 in/hr; 0.25 in -> 10 minutes.
    const r = waterIn({ explicitInchesPerWeek: 1.5, runMinutes: 30, wateringDays: ['Mon', 'Thu'], headTypes: ['spray'] });
    expect(r.minutes).toEqual({ spray: null, rotor: null, unknown: false, measured: 10 });
    expect(r.lines[1]).toBe('Run each zone about 10 minutes.');
    expectCleanCopy(r);
  });

  test('measured wins over the head-type table', () => {
    // rate 0.9 in/hr (0.9 in over 30 min x 2 days x ... = 0.9/(0.5*2)=0.9): 0.25 -> 17 minutes, not 40 (rotor table).
    const r = waterIn({ explicitInchesPerWeek: 0.9, runMinutes: 30, wateringDays: ['Mon', 'Thu'], headTypes: ['rotor'] });
    expect(r.minutes.measured).toBe(17);
    expect(r.minutes.rotor).toBeNull();
  });

  test('typed inches without run minutes fall through to the head-type table', () => {
    const r = waterIn({ explicitInchesPerWeek: 1.5, headTypes: ['rotor'] });
    expect(r.minutes).toEqual({ spray: null, rotor: 40, unknown: false, measured: null });
  });

  test('spray heads on file: 15 minutes; run minutes alone do not change the table', () => {
    const r = waterIn({ runMinutes: 20, wateringDays: ['Mon'], headTypes: ['spray'] });
    expect(r.minutes).toEqual({ spray: 15, rotor: null, unknown: false, measured: null });
    expect(r.lines[1]).toBe('Run each zone about 15 minutes.');
  });

  test('rotor heads on file: 40 minutes', () => {
    const r = waterIn({ headTypes: ['rotor'] });
    expect(r.minutes).toEqual({ spray: null, rotor: 40, unknown: false, measured: null });
    expect(r.lines[1]).toBe('Run each zone about 40 minutes.');
  });

  test('drip alongside one turf head type still uses that head type', () => {
    expect(waterIn({ headTypes: ['spray', 'drip'] }).minutes.spray).toBe(15);
  });

  test('mixed spray and rotor: both figures, by zone type', () => {
    const r = waterIn({ headTypes: ['spray', 'rotor'] });
    expect(r.minutes).toEqual({ spray: 15, rotor: 40, unknown: false, measured: null });
    expect(r.lines[1]).toBe('Run spray zones about 15 minutes and rotor zones about 40 minutes.');
    expectCleanCopy(r);
  });

  test('nothing on file: both generic figures (never "no system")', () => {
    for (const runtime of [null, undefined, {}, { runMinutes: null, headTypes: [], systemOn: null }]) {
      const r = waterIn(runtime);
      expect(r.minutes).toEqual({ spray: 15, rotor: 40, unknown: false, measured: null });
      expect(r.lines[1]).toBe('Run spray heads about 15 minutes a zone and rotors about 40 minutes.');
      expect(r.lines.join(' ')).not.toMatch(/no sprinkler|don.t have a sprinkler|no system/i);
    }
  });

  test('a moved home (runtime unconfirmed) is treated as nothing on file, even with data', () => {
    const r = waterIn({ unconfirmed: true, explicitInchesPerWeek: 1.5, runMinutes: 30, wateringDays: ['Mon', 'Thu'], headTypes: ['rotor'] });
    expect(r.minutes).toEqual({ spray: 15, rotor: 40, unknown: false, measured: null });
  });

  test('heads on file but unknown (drip only, unrecognized, or a system with no head type): one full cycle', () => {
    for (const runtime of [{ headTypes: ['drip'] }, { headTypes: ['mystery'] }, { systemOn: true }, { runMinutes: 20 }]) {
      const r = waterIn(runtime);
      expect(r.minutes).toEqual({ spray: null, rotor: null, unknown: true, measured: null });
      expect(r.lines[1]).toBe('Run one full cycle on each turf zone.');
    }
  });

  test('a customer who explicitly says there is no system gets inches, never an inference', () => {
    const r = waterIn({ systemOn: false });
    expect(r.lines[1]).toBe('Apply about ¼ inch of water with a hose-end sprinkler.');
    expect(r.minutes).toEqual({ spray: null, rotor: null, unknown: false, measured: null });
    expectCleanCopy(r);
    // Only an explicit false: null / undefined never mean "no system".
    expect(waterIn({ systemOn: null }).minutes.spray).toBe(15);
  });

  test('other depths scale linearly, rounded to 5', () => {
    expect(waterIn({ headTypes: ['spray'] }, { water_in_inches: 0.5 }).minutes.spray).toBe(30);
    expect(waterIn({ headTypes: ['rotor'] }, { water_in_inches: 0.5 }).minutes.rotor).toBe(80);
    expect(waterIn({ headTypes: ['spray'] }, { water_in_inches: 0.75 }).minutes.spray).toBe(45);
  });

  test('hold then water-in prints the same ladder', () => {
    const r = build([HOLD(24), WATER_IN()], { runtime: { headTypes: ['spray', 'rotor'] } });
    expect(r.lines[1]).toBe('After that, run spray zones about 15 minutes and rotor zones about 40 minutes within 24 hours.');
    expectCleanCopy(r);
    const none = build([HOLD(24), WATER_IN()], { runtime: { systemOn: false } });
    expect(none.lines[1]).toBe('After that, apply about ¼ inch of water with a hose-end sprinkler within 24 hours.');
    expectCleanCopy(none);
  });
});

describe('every rendered line passes the customer-copy guards', () => {
  const rulesets = [
    [HOLD(24)], [HOLD(4)], [HOLD(72)], [WATER_IN()], [WATER_IN({ water_in_by_hours: 1 })],
    [HOLD(24), WATER_IN({ water_in_by_hours: 1 })], [HOLD(24), WATER_IN()], [NONE('label')],
  ];
  const runtimes = [
    null, { headTypes: ['spray'] }, { headTypes: ['rotor'] }, { headTypes: ['spray', 'rotor'] },
    { headTypes: ['drip'] }, { systemOn: false },
    { explicitInchesPerWeek: 1.5, runMinutes: 30, wateringDays: ['Mon', 'Thu'], headTypes: ['spray'] },
  ];
  test.each(rulesets.map((r, i) => [i, r]))('ruleset %i x every runtime x plan/no plan', (_i, rules) => {
    for (const runtime of runtimes) {
      for (const hasWeekPlan of [true, false]) {
        const r = build(rules, { runtime, hasWeekPlan });
        expect(r.state).not.toBeNull();
        expectCleanCopy(r);
        for (const line of r.lines) {
          expect(line).toMatch(/[.]$/);
          expect(line).not.toMatch(/\{|\}|undefined|null|NaN/);
        }
      }
    }
  });
});
