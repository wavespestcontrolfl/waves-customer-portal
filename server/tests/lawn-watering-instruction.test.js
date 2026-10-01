// Watering instruction writer (lawn report rebuild P2). Pure module: per-product
// rules + completion time + the customer's runtime facts in, one instruction out.
// Synthetic data only.

const { buildWateringInstruction, composeBannerLines, _private } = require('../services/service-report/lawn-watering-instruction');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../services/content/content-guardrails');

// 2026-09-30 14:40 ET (EDT, UTC-4).
const COMPLETED = '2026-09-30T18:40:00Z';

const HOLD = (hours = 24, source = 'label') => ({ mode: 'hold', hold_hours: hours, source });
const WATER_IN = (over = {}) => ({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default', ...over });
const NONE = (source = 'label') => ({ mode: 'none', source });
// A water-in window long enough to sit after a 24 h hold (rule C: the deadline is always completion + the window).
const LATE = (over = {}) => WATER_IN({ water_in_by_hours: 72, ...over });

const build = (rules, extra = {}) => buildWateringInstruction({ rules, completedAt: COMPLETED, ...extra });

const WITH_PLAN = { hasWeekPlan: true, planRunInches: 0.5 };

function expectCleanCopy(instruction) {
  // The frozen lines, and the same lines as composed on a render that has a plan.
  for (const line of [...instruction.lines, ...composeBannerLines(instruction, WITH_PLAN)]) {
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(reentrySafetyClaimFinding(line)).toBeFalsy();
    // No probabilities, no county language, no drying / keep-off phrasing.
    expect(line).not.toMatch(/%|percent|chance|ordinance|county|blackout|hose|\bdry\b|\bwait\b|keep\b.*\boff\b|stay off/i);
  }
  expect(instruction.lines.length).toBeLessThanOrEqual(3);
}

describe('mixed-visit matrix', () => {
  test('hold alone', () => {
    const r = build([HOLD(24)]);
    expect(r.state).toBe('hold');
    // Frozen lines are treatment-only; the plan sentence is composed per render.
    expect(r.lines).toEqual([
      'Skip your turf watering until Thu 3 PM.',
      'That gives today’s treatment time to work.',
    ]);
    expect(composeBannerLines(r, WITH_PLAN)).toEqual([...r.lines, 'Then follow this week’s plan below.']);
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.waterInBy).toBeNull();
    expect(r.ruleSource).toBe('label');
    expectCleanCopy(r);
  });

  test('hold without a weekly plan on THIS render has no plan sentence', () => {
    expect(composeBannerLines(build([HOLD(24)]), { hasWeekPlan: false })).toHaveLength(2);
    expect(composeBannerLines(build([HOLD(24)]))).toHaveLength(2);
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

  test('hold + water-in (rule C): the deadline is completion + the rule window, never re-anchored to the hold end', () => {
    const r = build([HOLD(6), WATER_IN()], { runtime: { headTypes: ['spray'] } });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.holdUntil).toBe('2026-10-01T01:00:00.000Z'); // 8:40 PM rounded up: 9 PM ET
    expect(r.waterInBy).toBe('2026-10-01T18:00:00.000Z'); // completion + 24 h, floored: Thu 2 PM
    expect(r.lines).toEqual([
      'Skip your turf watering until 9 PM tonight.',
      'After that, water in today’s treatment by Thu 2 PM: run each zone about 15 minutes.',
      'Run it even if it is not your usual day.',
    ]);
    expect(r.expiresAt).toBe(r.waterInBy);
    // Weakest provenance among the rules that drive the instruction.
    expect(r.ruleSource).toBe('default');
    expectCleanCopy(r);
  });

  test('hold + water-in (rule C): a hold that reaches the deadline cannot be satisfied with it -> no claim', () => {
    for (const rules of [[HOLD(48), WATER_IN()], [HOLD(24), WATER_IN()], [HOLD(24), WATER_IN({ water_in_by_hours: 1 })], [HOLD(72), LATE()]]) {
      const r = build(rules);
      expect(r.state).toBeNull();
      expect(r.lines).toEqual([]);
      expect(r.waterInBy).toBeNull();
    }
    // Just inside the window is still a claim.
    expect(build([HOLD(22), WATER_IN()]).state).toBe('hold_then_water_in');
  });

  test('a 24 h hold with a 72 h window keeps the completion-anchored deadline', () => {
    const r = build([HOLD(24), LATE()]);
    expect(r.state).toBe('hold_then_water_in');
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.waterInBy).toBe('2026-10-03T18:00:00.000Z'); // completion + 72 h, floored
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

  test('rule A: any product with no rule -> no claim; no other product may force a direction', () => {
    for (const rules of [[null, HOLD(24)], [null, WATER_IN()], [HOLD(24), null], [{ name: 'Talak', rule: null }, { name: 'Fertilizer', rule: WATER_IN() }], [{ mode: 'sometimes' }, HOLD(24)], [null, HOLD(6), WATER_IN()]]) {
      const r = build(rules);
      expect(r.state).toBeNull();
      expect(r.lines).toEqual([]);
    }
    // The products are still reported, so the unresolved one is visible.
    expect(build([{ name: 'Talak', rule: null }, { name: 'Fertilizer', rule: WATER_IN() }]).products).toEqual([
      { name: 'Talak', mode: null, source: null }, { name: 'Fertilizer', mode: 'water_in', source: 'default' },
    ]);
  });

  test('no claim (state null) when nothing forces hold or water-in and any product is unresolved', () => {
    for (const rules of [[null], [null, NONE()], [], undefined]) {
      const r = build(rules);
      expect(r.state).toBeNull();
      expect(r.lines).toEqual([]);
    }
  });

  test('none is a positive claim: every product resolved AND at least one label/owner sourced', () => {
    const r = build([NONE('label'), NONE('default')]);
    expect(r.state).toBe('none');
    expect(r.lines).toEqual(['No watering change from today’s treatment.']);
    expect(composeBannerLines(r, WITH_PLAN)).toEqual(['No watering change from today’s treatment.', 'Follow this week’s plan below.']);
    expectCleanCopy(r);
    expect(build([NONE('owner')]).state).toBe('none');
    // Defaults alone never assert "no change".
    expect(build([NONE('default'), NONE('default')]).state).toBeNull();
    // An unresolved product blocks it.
    expect(build([NONE('label'), null]).state).toBeNull();
  });

  test('records the completion instant the lines are anchored to (the watering text checks freshness against it)', () => {
    expect(build([HOLD(24)]).completedAt).toBe(new Date(COMPLETED).toISOString());
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
    expect(r.state).toBeNull(); // rule A: K-Flow has no rule
    const ok = build([{ name: 'Celsius WG', rule: HOLD(24) }, { name: 'K-Flow', rule: NONE() }]);
    expect(ok.state).toBe('hold');
    expect(ok.products).toEqual([
      { name: 'Celsius WG', mode: 'hold', source: 'label' },
      { name: 'K-Flow', mode: 'none', source: 'label' },
    ]);
    expect(r.products).toEqual([
      { name: 'Celsius WG', mode: 'hold', source: 'label' },
      { name: 'K-Flow', mode: null, source: null },
    ]);
  });

  test('ruleSource: label, owner, default (weakest driving rule wins)', () => {
    expect(build([HOLD(24, 'label')]).ruleSource).toBe('label');
    expect(build([HOLD(24, 'owner')]).ruleSource).toBe('owner');
    expect(build([HOLD(24, 'label'), HOLD(24, 'owner')]).ruleSource).toBe('owner');
    expect(build([HOLD(6, 'label'), WATER_IN({ source: 'default' })]).ruleSource).toBe('default');
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

  test('a head type on file but unusable (drip only, unrecognized): one full cycle', () => {
    for (const runtime of [{ headTypes: ['drip'] }, { headTypes: ['mystery'] }, { headTypes: ['spray', 'mystery'] }]) {
      const r = waterIn(runtime);
      expect(r.minutes).toEqual({ spray: null, rotor: null, unknown: true, measured: null });
      expect(r.lines[1]).toBe('Run one full cycle on each turf zone.');
    }
  });

  test('no flag ever means "no system": irrigation_system false / true / null never change the copy', () => {
    // A pre-toggle row (the column used to default to false) with a head type on file: the head ladder.
    for (const systemOn of [false, true, null, undefined]) {
      const withRotor = waterIn({ systemOn, headTypes: ['rotor'] });
      expect(withRotor.lines[1]).toBe('Run each zone about 40 minutes.');
      expect(withRotor.minutes).toEqual({ spray: null, rotor: 40, unknown: false, measured: null });
      // No head type on file: the generic both-figures line, whatever the flag says.
      const bare = waterIn({ systemOn });
      expect(bare.lines[1]).toBe('Run spray heads about 15 minutes a zone and rotors about 40 minutes.');
      expect(bare.minutes).toEqual({ spray: 15, rotor: 40, unknown: false, measured: null });
    }
    // Run minutes with no head type are not a head type either.
    expect(waterIn({ runMinutes: 20 }).lines[1]).toBe('Run spray heads about 15 minutes a zone and rotors about 40 minutes.');
  });

  test('other depths scale linearly, rounded to 5', () => {
    expect(waterIn({ headTypes: ['spray'] }, { water_in_inches: 0.5 }).minutes.spray).toBe(30);
    expect(waterIn({ headTypes: ['rotor'] }, { water_in_inches: 0.5 }).minutes.rotor).toBe(80);
    expect(waterIn({ headTypes: ['spray'] }, { water_in_inches: 0.75 }).minutes.spray).toBe(45);
  });

  test('hold then water-in prints the same ladder', () => {
    const r = build([HOLD(6), WATER_IN()], { runtime: { headTypes: ['spray', 'rotor'] } });
    expect(r.lines[1]).toBe('After that, water in today’s treatment by Thu 2 PM: run spray zones about 15 minutes and rotor zones about 40 minutes.');
    expectCleanCopy(r);
    const flagOff = build([HOLD(6), WATER_IN()], { runtime: { systemOn: false, headTypes: ['rotor'] } });
    expect(flagOff.lines[1]).toBe('After that, water in today’s treatment by Thu 2 PM: run each zone about 40 minutes.');
    expectCleanCopy(flagOff);
  });
});

describe('every rendered line passes the customer-copy guards', () => {
  const rulesets = [
    [HOLD(24)], [HOLD(4)], [HOLD(72)], [WATER_IN()], [WATER_IN({ water_in_by_hours: 1 })],
    [HOLD(1), WATER_IN({ water_in_by_hours: 2.5 })], [HOLD(24), LATE()], [NONE('label')],
  ];
  const runtimes = [
    null, { headTypes: ['spray'] }, { headTypes: ['rotor'] }, { headTypes: ['spray', 'rotor'] },
    { headTypes: ['drip'] }, { systemOn: false }, { systemOn: false, headTypes: ['rotor'] },
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

describe('water-in deadlines never round to or before completion', () => {
  const byHours = (hours, rules = [WATER_IN({ water_in_by_hours: hours })]) => build(rules, { runtime: { headTypes: ['rotor'] } });

  test.each([
    [0.25, '2026-09-30T18:55:00.000Z', 'Water in today’s treatment by 2:55 PM today.'],
    [1, '2026-09-30T19:40:00.000Z', 'Water in today’s treatment by 3:40 PM today.'],
    [1.5, '2026-09-30T20:10:00.000Z', 'Water in today’s treatment by 4:10 PM today.'],
    [2, '2026-09-30T20:00:00.000Z', 'Water in today’s treatment by 4 PM today.'],
    [24, '2026-10-01T18:00:00.000Z', 'Water in today’s treatment by Thu 2 PM.'],
  ])('%s h rule completed 2:40 PM ET', (hours, expectedBy, line) => {
    const r = byHours(hours);
    expect(r.waterInBy).toBe(expectedBy);
    expect(new Date(r.waterInBy).getTime()).toBeGreaterThan(new Date(COMPLETED).getTime());
    expect(r.lines[0]).toBe(line);
    expect(r.expiresAt).toBe(expectedBy);
    expectCleanCopy(r);
  });

  test('a rule so short that even the minute rounds to completion uses the exact instant', () => {
    const r = byHours(0.0001);
    expect(new Date(r.waterInBy).getTime()).toBeGreaterThan(new Date(COMPLETED).getTime());
  });

  test('hold then water-in: the completion-anchored deadline keeps the minute precision of a short window', () => {
    // Hold ends 4 PM (3:40 PM rounded up); the 1.5 h window ends 4:10 PM.
    const r = build([HOLD(1), WATER_IN({ water_in_by_hours: 1.5 })], { runtime: { headTypes: ['rotor'] } });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.waterInBy).toBe('2026-09-30T20:10:00.000Z');
    expect(r.waterInByLabel).toBe('4:10 PM today');
    expect(r.lines[1]).toBe('After that, water in today’s treatment by 4:10 PM today: run each zone about 40 minutes.');
    expectCleanCopy(r);
    // A window that ends before the hold does is no claim.
    expect(build([HOLD(1), WATER_IN({ water_in_by_hours: 0.25 })]).state).toBeNull();
  });

  test('deadlineAfter helper', () => {
    const base = new Date(COMPLETED);
    expect(_private.deadlineAfter(base, 24).toISOString()).toBe('2026-10-01T18:00:00.000Z');
    expect(_private.deadlineAfter(base, 0.25).toISOString()).toBe('2026-09-30T18:55:00.000Z');
  });
});

describe('hold until the treatment has dried (no invented duration)', () => {
  const DRY = { mode: 'hold', hold_hours: null, hold_until: 'dry', source: 'label' };
  const noDryFigure = (r) => {
    // No hours / minutes / days figure in the same sentence as dry / dried. (A
    // clock time such as "Thu 3 PM" beside "and not before ... dried" is the
    // specified rule-B copy: it states when, not how long a treatment takes to dry.)
    const DURATION = '\\d+(?:\\.\\d+)?\\s*(?:-\\s*)?(?:hours?|hrs?|h|minutes?|mins?|days?)\\b';
    for (const line of r.lines) {
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        if (!/\b(dry|dried|drying)\b/i.test(sentence)) continue;
        expect(sentence).not.toMatch(new RegExp(DURATION, 'i'));
        expect(sentence).not.toMatch(/\b(one|two|three|four|five|six|twelve|twenty[- ]four)\s+(?:hours?|minutes?)/i);
      }
    }
  };

  test('alone: hold, no clock time, no clock expiry (dryness is a condition, not a time)', () => {
    const r = build([DRY]);
    expect(r.state).toBe('hold');
    expect(r.holdUntil).toBeNull();
    expect(r.holdUntilLabel).toBe('today’s treatment has dried');
    expect(r.holdUntilPlanLabel).toBe('the spray has dried');
    expect(r.lines).toEqual([
      'Skip your turf watering until today’s treatment has dried.',
      'That gives today’s treatment time to work.',
    ]);
    expect(composeBannerLines(r, WITH_PLAN)[2]).toBe('Then follow this week’s plan below.');
    expect(r.expiresAt).toBeNull();
    expect(r.waterInBy).toBeNull();
    expect(r.ruleSource).toBe('label');
    expectCleanCopy(r);
    noDryFigure(r);
  });

  test('an until-dry rule with a recorded minimum keeps both: the clock time and the drying', () => {
    const r = build([{ ...DRY, hold_hours: 24 }]);
    expect(r.state).toBe('hold');
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 3 PM, and not before today’s treatment has dried.');
    expect(r.holdUntilPlanLabel).toBe('Thu 3 PM and the spray has dried');
    expect(r.expiresAt).toBeNull();
    expectCleanCopy(r);
    noDryFigure(r);
    // With no recorded minimum, no clock time is invented.
    expect(build([DRY]).holdUntil).toBeNull();
  });

  test('a late-evening until-dry visit gets no clock expiry', () => {
    const r = buildWateringInstruction({ rules: [DRY], completedAt: '2026-10-01T03:50:00Z' }); // 11:50 PM ET
    expect(r.expiresAt).toBeNull();
  });

  test('a timed hold on the same visit outranks it: the concrete clock time is printed', () => {
    const r = build([DRY, HOLD(24)]);
    expect(r.state).toBe('hold');
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.holdUntilLabel).toBe('Thu 3 PM');
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 3 PM, and not before today’s treatment has dried.');
    // The clock time alone never releases a hold that also waits for drying.
    expect(r.expiresAt).toBeNull();
  });

  test('until-dry + water-in (no floor): the deadline is completion + 24 h; the 6 h default floor is only a conflict check, never printed', () => {
    const r = build([DRY, WATER_IN()], { runtime: { headTypes: ['rotor'] } });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.holdUntil).toBeNull();
    expect(r.lines).toEqual([
      'Skip your turf watering until today’s treatment has dried.',
      'After that, water in today’s treatment by Thu 2 PM: run each zone about 40 minutes.',
      'Run it even if it is not your usual day.',
    ]);
    expect(r.waterInBy).toBe('2026-10-01T18:00:00.000Z');
    // The drying condition keeps the note live past the water-in deadline.
    expect(r.expiresAt).toBeNull();

    expect(r.lines.join(' ')).not.toMatch(/\b6\b|six/i);
    expectCleanCopy(r);
    noDryFigure(r);
  });

  test('rule B: until-dry + timed hold is ONE hold keeping both conditions', () => {
    const r = build([DRY, HOLD(24)]);
    expect(r.state).toBe('hold');
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.holdUntilLabel).toBe('Thu 3 PM');
    // The plan overlay keeps both conditions (the clock time and the drying).
    expect(r.holdUntilPlanLabel).toBe('Thu 3 PM and the spray has dried');
    expect(build([HOLD(24)]).holdUntilPlanLabel).toBe('Thu 3 PM');
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 3 PM, and not before today’s treatment has dried.');
    // The clock time alone never releases a hold that also waits for drying.
    expect(r.expiresAt).toBeNull();
    expectCleanCopy(r);
    noDryFigure(r);
    // The dry condition is never dropped, in either order.
    expect(build([HOLD(24), DRY]).lines[0]).toBe(r.lines[0]);
  });

  test('rule B + C: until-dry + timed hold + a later water-in keeps both conditions, deadline from completion', () => {
    const r = build([DRY, HOLD(24), LATE()], { runtime: { headTypes: ['rotor'] } });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.holdUntil).toBe('2026-10-01T19:00:00.000Z');
    expect(r.lines[0]).toBe('Skip your turf watering until Thu 3 PM, and not before today’s treatment has dried.');
    expect(r.waterInBy).toBe('2026-10-03T18:00:00.000Z');
    expect(build([DRY, HOLD(24), WATER_IN()]).state).toBeNull(); // 24 h hold vs 24 h window
  });

  test('rule C with a dry hold: its configured hours (else the 6 h floor) are the hidden hold end for the conflict check', () => {
    const dry = (hours) => ({ mode: 'hold', hold_hours: hours, hold_until: 'dry', source: 'label' });
    expect(build([dry(24), WATER_IN()]).state).toBeNull(); // 24 h >= the 24 h deadline
    expect(build([dry(12), WATER_IN()]).waterInBy).toBe('2026-10-01T18:00:00.000Z');
    expect(build([dry(12), dry(30), WATER_IN()]).state).toBeNull(); // the largest configured floor counts
    const r = build([dry(30), LATE()]);
    expect(r.waterInBy).toBe('2026-10-03T18:00:00.000Z'); // still completion + 72 h
    expect(build([{ mode: 'hold', hold_hours: null, hold_until: 'dry', source: 'label' }, WATER_IN()]).waterInBy).toBe('2026-10-01T18:00:00.000Z');
    // A water-in window shorter than the 6 h floor cannot follow an until-dry hold.
    expect(build([DRY, WATER_IN({ water_in_by_hours: 5 })]).state).toBeNull();
  });

  test('every ruleset x runtime x plan stays clean and never prints a figure beside dry/dried', () => {
    for (const rules of [[DRY], [DRY, WATER_IN()], [DRY, LATE()], [DRY, HOLD(24)], [DRY, HOLD(24), LATE()]]) {
      for (const runtime of [null, { headTypes: ['spray', 'rotor'] }, { systemOn: false }]) {
        for (const hasWeekPlan of [true, false]) {
          const r = build(rules, { runtime, hasWeekPlan });
          expectCleanCopy(r);
          noDryFigure(r);
        }
      }
    }
  });
});

describe('a hold far enough out names its date', () => {
  test('144 h or more prints weekday, month and day; nearer targets keep the short form', () => {
    expect(build([HOLD(168)]).lines[0]).toBe('Skip your turf watering until Wed, Oct 7 at 3 PM.');
    expect(build([HOLD(144)]).lines[0]).toBe('Skip your turf watering until Tue, Oct 6 at 3 PM.');
    expect(build([HOLD(120)]).lines[0]).toBe('Skip your turf watering until Mon 3 PM.');
    expect(build([HOLD(48)]).lines[0]).toBe('Skip your turf watering until Fri 3 PM.');
    const mixed = build([HOLD(168), WATER_IN({ water_in_by_hours: 300 })]);
    expect(mixed.lines[0]).toBe('Skip your turf watering until Wed, Oct 7 at 3 PM.');
    expectCleanCopy(mixed);
    expectCleanCopy(build([HOLD(168)]));
  });

  test('the date follows the ET calendar across month and year ends', () => {
    const r = buildWateringInstruction({ rules: [HOLD(168)], completedAt: '2026-12-29T18:40:00Z' });
    expect(r.lines[0]).toBe('Skip your turf watering until Tue, Jan 5 at 2 PM.');
  });
});

describe('plan-dependent copy is composed per render, never frozen', () => {
  const water = () => build([WATER_IN()], { runtime: { headTypes: ['rotor'] } });
  const PLAN_SENTENCE = /this week’s plan|this week’s watering/;
  test('the frozen lines carry no plan sentence for any state', () => {
    for (const rules of [[HOLD(24)], [NONE('label')], [WATER_IN()], [HOLD(24), LATE()], [{ mode: 'hold', hold_until: 'dry', source: 'label' }]]) {
      expect(build(rules).lines.join(' ')).not.toMatch(PLAN_SENTENCE);
    }
  });
  test('none: a plan at completion but none at render -> no plan sentence; none at completion, a plan at render -> the sentence', () => {
    const frozen = build([NONE('label')]); // built with no knowledge of any plan
    expect(composeBannerLines(frozen, { hasWeekPlan: false })).toEqual(['No watering change from today’s treatment.']);
    expect(composeBannerLines(frozen, { hasWeekPlan: true })).toEqual(['No watering change from today’s treatment.', 'Follow this week’s plan below.']);
    // ...and composing never mutates the frozen instruction.
    expect(frozen.lines).toEqual(['No watering change from today’s treatment.']);
  });
  test('hold: the same, for line 3', () => {
    const frozen = build([HOLD(24)]);
    expect(composeBannerLines(frozen, { hasWeekPlan: false })).toHaveLength(2);
    expect(composeBannerLines(frozen, { hasWeekPlan: true })[2]).toBe('Then follow this week’s plan below.');
  });
  test('water-in shallower than the plan run: the any-day sentence gains "counts toward"', () => {
    const r = water();
    expect(r.waterInInches).toBe(0.25);
    expect(r.lines[2]).toBe('Run it even if it is not your usual day.');
    const lines = composeBannerLines(r, { hasWeekPlan: true, planRunInches: 0.5 });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('Run it even if it is not your usual day. That counts toward this week’s watering.');
    expectCleanCopy(r);
  });
  test('as deep, no plan, or a plan with no run depth: the plain any-day line', () => {
    for (const plan of [{ hasWeekPlan: true, planRunInches: 0.25 }, { hasWeekPlan: true, planRunInches: 0.1 }, { hasWeekPlan: true, planRunInches: null }, { hasWeekPlan: false, planRunInches: 0.5 }]) {
      expect(composeBannerLines(water(), plan)[2]).toBe('Run it even if it is not your usual day.');
    }
  });
  test('the depth rides the instruction for every water-in state, and a deeper rule wins', () => {
    expect(build([WATER_IN({ water_in_inches: 0.5 })]).waterInInches).toBe(0.5);
    expect(build([HOLD(24), LATE()]).waterInInches).toBe(0.25);
    expect(build([HOLD(24)]).waterInInches).toBeNull();
  });
});

// ── Label mow hold (P2b) ─────────────────────────────────────────────────
// A SEPARATE result beside the watering lines: it never enters `lines` (the
// watering text sends those verbatim) and never depends on the watering state.
describe('mow hold', () => {
  const entry = (rule, mowHoldDays) => ({ name: 'Product', rule, mowHoldDays });
  const mow = (rules, completedAt = COMPLETED) => buildWateringInstruction({ rules, completedAt }).mowHold;

  test('a label day is 24 elapsed hours from completion, rounded UP to the hour, with the exact line', () => {
    // 2026-09-30 14:40 ET (a Wednesday) + 48 h = Fri 2:40 PM -> 3 PM.
    expect(mow([entry(HOLD(24), 2)])).toEqual({
      days: 2,
      untilAt: '2026-10-02T19:00:00.000Z',
      untilDate: '2026-10-02',
      untilLabel: 'Fri 3 PM',
      line: 'Mowing: hold off until Fri 3 PM, 2 days after today\'s treatment.',
    });
  });

  test('one day reads "1 day", and a late-afternoon visit never reads as "any time tomorrow"', () => {
    expect(mow([entry(HOLD(24), 1)])).toMatchObject({ untilLabel: 'Thu 3 PM', line: 'Mowing: hold off until Thu 3 PM, 1 day after today\'s treatment.' });
    // Thu 4 PM ET visit, 24 h label: never before Fri 4 PM.
    expect(mow([entry(HOLD(24), 1)], '2026-10-01T20:00:00Z')).toMatchObject({ untilAt: '2026-10-02T20:00:00.000Z', untilLabel: 'Fri 4 PM' });
  });

  test('ET clock and date, not UTC (late evening ET is already the next UTC day)', () => {
    // 2026-09-30 21:30 ET = 2026-10-01T01:30Z; +24 h = Thu 9:30 PM -> 10 PM.
    expect(mow([entry(HOLD(24), 1)], '2026-10-01T01:30:00Z')).toMatchObject({ untilDate: '2026-10-01', untilLabel: 'Thu 10 PM' });
  });

  test('crosses the early-November fall-back on elapsed hours', () => {
    // Sat Oct 31 4:30 PM EDT + 24 h = Sun Nov 1 3:30 PM EST -> 4 PM.
    expect(mow([entry(HOLD(24), 1)], '2026-10-31T20:30:00Z')).toMatchObject({ untilAt: '2026-11-01T21:00:00.000Z', untilDate: '2026-11-01', untilLabel: 'Sun 4 PM' });
  });

  test('crosses the March spring-forward on elapsed hours', () => {
    // Fri Mar 6 2026 12:00 EST + 72 h = Mon Mar 9 1:00 PM EDT.
    expect(mow([entry(HOLD(24), 3)], '2026-03-06T17:00:00Z')).toMatchObject({ untilDate: '2026-03-09', untilLabel: 'Mon 1 PM' });
  });

  test('month, year and leap-day ends; six or more days out names the date', () => {
    expect(mow([entry(HOLD(24), 3)], '2026-12-30T17:00:00Z')).toMatchObject({ untilDate: '2027-01-02', untilLabel: 'Sat 12 PM' });
    expect(mow([entry(HOLD(24), 7)], '2026-12-30T17:00:00Z')).toMatchObject({
      untilDate: '2027-01-06',
      untilLabel: 'Wed, Jan 6 at 12 PM',
      line: 'Mowing: hold off until Wed, Jan 6 at 12 PM, 7 days after today\'s treatment.',
    });
    expect(mow([entry(HOLD(24), 3)], '2028-02-27T17:00:00Z')).toMatchObject({ untilDate: '2028-03-01', untilLabel: 'Wed 12 PM' });
    expect(mow([entry(HOLD(24), 14)], '2026-12-30T17:00:00Z')).toMatchObject({ untilDate: '2027-01-13' });
  });

  test('the longest label hold across the applied products wins', () => {
    expect(mow([entry(HOLD(24), 2), entry(NONE(), 5), entry(WATER_IN(), 3)])).toMatchObject({ days: 5, untilDate: '2026-10-05', untilLabel: 'Mon 3 PM' });
  });

  test('null, absent and invalid values are ignored; no valid value means no mow hold at all', () => {
    for (const bad of [null, undefined, 0, -1, 15, 1.5, '2', '', NaN, Infinity, true, [2], {}]) {
      expect(mow([entry(HOLD(24), bad)])).toBeNull();
    }
    // An invalid value beside a valid one never lengthens or breaks it.
    expect(mow([entry(HOLD(24), 15), entry(HOLD(24), 2), entry(HOLD(24), '9')])).toMatchObject({ days: 2 });
    // Bare rules (no wrapper) and entries without the key carry no claim.
    expect(mow([HOLD(24)])).toBeNull();
    expect(mow([{ name: 'x', rule: HOLD(24) }])).toBeNull();
  });

  test('independent of the watering state: unknown or no-claim watering still gets the line', () => {
    const unknown = buildWateringInstruction({ rules: [entry(null, 2), entry(HOLD(24), null)], completedAt: COMPLETED });
    expect(unknown.state).toBeNull();
    expect(unknown.lines).toEqual([]);
    expect(unknown.mowHold).toMatchObject({ days: 2, untilLabel: 'Fri 3 PM' });
    // A hold-vs-water-in conflict (no claim) too.
    const conflict = buildWateringInstruction({ rules: [entry(HOLD(48), 4), entry(WATER_IN({ water_in_by_hours: 24 }), null)], completedAt: COMPLETED });
    expect(conflict.state).toBeNull();
    expect(conflict.mowHold).toMatchObject({ days: 4 });
  });

  test('never touches the watering lines or the rest of the instruction', () => {
    for (const rules of [[HOLD(24)], [WATER_IN()], [HOLD(24), LATE()], [NONE()]]) {
      const plain = buildWateringInstruction({ rules, completedAt: COMPLETED });
      const withMow = buildWateringInstruction({ rules: rules.map((rule) => entry(rule, 3)), completedAt: COMPLETED });
      const { mowHold: _a, products: _p1, ...plainRest } = plain;
      const { mowHold, products: _p2, ...withRest } = withMow;
      expect(withRest).toEqual(plainRest);
      expect(mowHold).toMatchObject({ days: 3 });
      expect(withMow.lines.join(' ')).not.toMatch(/mow/i);
      expect(composeBannerLines(withMow, WITH_PLAN).join(' ')).not.toMatch(/mow/i);
      expect(plain.mowHold).toBeNull();
    }
  });

  test('no products or no completion time: no mow hold', () => {
    expect(buildWateringInstruction({ rules: [], completedAt: COMPLETED }).mowHold).toBeNull();
    expect(buildWateringInstruction({ rules: [entry(HOLD(24), 2)], completedAt: null }).mowHold).toBeNull();
  });

  test('the copy is plain ASCII, with no drying or re-entry claim', () => {
    const { line } = mow([entry(HOLD(24), 2)]);
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(line).not.toMatch(/dry|dried|wait|safe/i);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(reentrySafetyClaimFinding(line)).toBeFalsy();
  });

  test('isValidMowHold accepts only a complete frozen shape', () => {
    const { isValidMowHold } = require('../services/service-report/lawn-watering-instruction');
    const good = mow([entry(HOLD(24), 2)]);
    expect(isValidMowHold(good)).toBe(true);
    for (const bad of [null, undefined, 'x', [], {}, { ...good, days: 0 }, { ...good, days: 15 }, { ...good, days: '2' }, { ...good, untilDate: 'Friday' }, { ...good, untilAt: 'later' }, { ...good, untilLabel: '' }, { ...good, line: '' }]) {
      expect(isValidMowHold(bad)).toBe(false);
    }
  });
});
