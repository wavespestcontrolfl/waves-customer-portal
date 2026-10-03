// Pure date-rule tests for rider-series-preview.js#planRiderDates — no DB.
// Scope doc: ~/lawn-pest-rhythm-scope-20260928.md, "Date rule". Copied
// verbatim from the (unmerged) write engine's rider-series-plan.test.js
// (branch feat/pest-rides-lawn-core-20260928, PR #5268) — planRiderDates and
// computeRiderHorizon are byte-identical between the engine and this
// read-only preview, so every case here proves the SAME rule either way.
const {
  planRiderDates, MIN_GAP_DAYS, TARGET_GAP_DAYS, MAX_WAIT_DAYS, OVERDUE_WAIT_DAYS,
  _internals: { computeRiderHorizon },
} = require('../services/rider-series-preview');

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function datesEvery(startStr, gapDays, count) {
  const out = [];
  let cur = startStr;
  for (let i = 0; i < count; i++) {
    out.push(cur);
    cur = addDays(cur, gapDays);
  }
  return out;
}

describe('rider-series planRiderDates', () => {
  test('constants match the scope doc Date rule', () => {
    expect(MIN_GAP_DAYS).toBe(77);
    expect(TARGET_GAP_DAYS).toBe(84);
    expect(MAX_WAIT_DAYS).toBe(105);
  });

  test('host every 42 days -> rider lands on every 2nd host date (every 84)', () => {
    const anchor = '2026-01-01';
    const hostDates = datesEvery(anchor, 42, 20); // includes anchor itself
    const horizon = addDays(anchor, 400);
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    expect(plan.length).toBeGreaterThan(3);
    // Every planned date is itself a host date (rides the host, never a
    // standalone fallback, since the host never skips a beat).
    const hostSet = new Set(hostDates);
    for (const d of plan) expect(hostSet.has(d)).toBe(true);
    // Gaps from the anchor, and between consecutive rider dates, are all 84.
    let prev = anchor;
    for (const d of plan) {
      const gap = (new Date(d) - new Date(prev)) / 86400000;
      expect(gap).toBe(84);
      prev = d;
    }
  });

  test('host irregular 42/44 -> first host date >= anchor+77 is picked', () => {
    const anchor = '2026-01-01';
    // 42, 44, 42, 44, ... alternating gaps.
    const hostDates = [anchor];
    let cur = anchor;
    let gap = 42;
    for (let i = 0; i < 12; i++) {
      cur = addDays(cur, gap);
      hostDates.push(cur);
      gap = gap === 42 ? 44 : 42;
    }
    const horizon = addDays(anchor, 400);
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    expect(plan.length).toBeGreaterThan(0);
    const first = plan[0];
    const minDate = addDays(anchor, MIN_GAP_DAYS);
    const maxDate = addDays(anchor, MAX_WAIT_DAYS);
    expect(first >= minDate).toBe(true);
    expect(first <= maxDate).toBe(true);
    expect(hostDates.includes(first)).toBe(true);
  });

  test('a skipped host visit that pushes the gap past 105 falls back to +84', () => {
    const anchor = '2026-01-01';
    // Next host date is 130 days out (a skipped visit) — well past MAX_WAIT.
    const hostDates = [anchor, addDays(anchor, 130), addDays(anchor, 172)];
    const horizon = addDays(anchor, 200);
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    expect(plan[0]).toBe(addDays(anchor, 84));
    // The fallback date is not one of the host's own dates.
    expect(hostDates.includes(plan[0])).toBe(false);
  });

  test('host ends -> every subsequent date is an 84-day standalone fallback', () => {
    const anchor = '2026-01-01';
    const hostDates = [anchor, addDays(anchor, 42)]; // host stops after this
    const horizon = addDays(anchor, 400);
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    expect(plan.length).toBeGreaterThanOrEqual(3);
    let prev = anchor;
    for (const d of plan) {
      const gap = (new Date(d) - new Date(prev)) / 86400000;
      expect(gap).toBe(84);
      prev = d;
    }
  });

  test('min gap is never below 77 days for a host-derived date', () => {
    const anchor = '2026-01-01';
    // A host date only 10 days out must never be picked — too soon.
    const hostDates = [anchor, addDays(anchor, 10), addDays(anchor, 80)];
    const horizon = addDays(anchor, 200);
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    expect(plan[0]).toBe(addDays(anchor, 80));
    const gap = 80;
    expect(gap).toBeGreaterThanOrEqual(MIN_GAP_DAYS);
  });

  test('horizon is respected — no planned date exceeds it', () => {
    const anchor = '2026-01-01';
    const hostDates = datesEvery(anchor, 42, 30);
    const horizon = addDays(anchor, 200);
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    expect(plan.length).toBeGreaterThan(0);
    for (const d of plan) expect(d <= horizon).toBe(true);
    // Nothing the horizon allows is left out: the plan is exactly the
    // unbounded plan cut at the horizon.
    const unbounded = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: addDays(anchor, 2000) });
    expect(plan).toEqual(unbounded.filter((d) => d <= horizon));
  });

  test('empty host list plus an already-past horizon plans nothing', () => {
    const plan = planRiderDates({ hostDates: [], lastRiderDate: '2026-06-01', horizonDate: '2026-06-01' });
    expect(plan).toEqual([]);
  });

  test('weekend shift is applied to a standalone fallback date only', () => {
    // 2026-01-01 is a Thursday; +84 days = 2026-03-26 (Thursday) — pick an
    // anchor where +84 lands on a weekend to exercise the shift.
    // 2026-01-03 is a Saturday; +84 = 2026-03-28 (Saturday).
    const anchor = '2026-01-03';
    const horizon = addDays(anchor, 100);
    const withoutShift = planRiderDates({ hostDates: [], lastRiderDate: anchor, horizonDate: horizon });
    const withShift = planRiderDates({
      hostDates: [], lastRiderDate: anchor, horizonDate: horizon, skipWeekends: true, weekendShift: 'forward',
    });
    expect(withoutShift[0]).toBe(addDays(anchor, 84));
    expect(withShift[0]).not.toBe(addDays(anchor, 84));
    const shiftedDow = new Date(`${withShift[0]}T12:00:00Z`).getUTCDay();
    expect(shiftedDow).not.toBe(0);
    expect(shiftedDow).not.toBe(6);
  });

  test('missing anchor or horizon returns an empty plan rather than throwing', () => {
    expect(planRiderDates({ hostDates: ['2026-01-01'] })).toEqual([]);
    expect(planRiderDates({ hostDates: ['2026-01-01'], lastRiderDate: '2026-01-01' })).toEqual([]);
  });

  test('a stale anchor never plans before earliestDate: overdue rider takes the first host date in the overdue window', () => {
    const anchor = '2026-01-01';
    const floor = '2026-10-06';
    const hostDates = datesEvery('2026-10-20', 42, 8); // first host date 14 days after the floor
    const plan = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: hostDates[hostDates.length - 1], earliestDate: floor });
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((d) => d >= floor)).toBe(true);
    expect(plan[0]).toBe('2026-10-20');
    expect(plan[1]).toBe(hostDates[2]); // then back on every 2nd host date
  });

  test('without earliestDate the same stale anchor would walk through past dates (fail-without-fix evidence)', () => {
    const plan = planRiderDates({ hostDates: [], lastRiderDate: '2026-01-01', horizonDate: '2026-12-31' });
    expect(plan[0]).toBe(addDays('2026-01-01', TARGET_GAP_DAYS));
    expect(plan[0] < '2026-10-06').toBe(true);
  });

  test('an overdue rider with no host date in the overdue window takes a standalone date on the floor', () => {
    const floor = '2026-10-06'; // a Tuesday
    const hostDates = [addDays(floor, OVERDUE_WAIT_DAYS + 1)];
    const plan = planRiderDates({ hostDates, lastRiderDate: '2026-01-01', horizonDate: '2027-06-01', earliestDate: floor });
    expect(plan[0]).toBe(floor);
    expect(plan.every((d) => d >= floor)).toBe(true);
  });

  test('a backward weekend shift on an overdue standalone date never crosses the floor', () => {
    const floor = '2026-10-10'; // a Saturday
    const plan = planRiderDates({
      hostDates: [], lastRiderDate: '2026-01-01', horizonDate: '2027-06-01', earliestDate: floor, skipWeekends: true, weekendShift: 'back',
    });
    expect(plan[0] >= floor).toBe(true);
    expect(plan[0]).toBe('2026-10-12'); // Monday
  });

  // --- P1 fallback count (PR #5268 round 2): plannedVisitCountForPattern
  // is a TOTAL occurrence count that already includes the anchor visit
  // itself (e.g. quarterly = 4 visits/year, the first of which IS the
  // anchor) — computeRiderHorizon must plan count-1 FUTURE gaps past it,
  // never the raw count (which plans one extra TARGET_GAP_DAYS step past
  // the real one-year horizon).
  test('computeRiderHorizon: a quarterly rider whose host ends plans exactly 3 future standalone dates after the anchor (P1 fallback count, fail-without-fix evidence)', () => {
    const anchor = '2026-01-01';
    const horizon = computeRiderHorizon(anchor, [], 'quarterly');
    // fail-without-fix: the pre-fix formula (count * TARGET_GAP_DAYS) would
    // put the horizon a full extra 84-day step past this.
    expect(horizon).toBe(addDays(anchor, 3 * TARGET_GAP_DAYS));
    expect(horizon).not.toBe(addDays(anchor, 4 * TARGET_GAP_DAYS));
    const plan = planRiderDates({ hostDates: [], lastRiderDate: anchor, horizonDate: horizon });
    expect(plan).toEqual([
      addDays(anchor, TARGET_GAP_DAYS),
      addDays(anchor, 2 * TARGET_GAP_DAYS),
      addDays(anchor, 3 * TARGET_GAP_DAYS),
    ]);
  });

  test('earliestDate does not change a plan whose anchor is recent', () => {
    const anchor = '2026-10-01';
    const hostDates = datesEvery('2026-10-15', 42, 10);
    const horizon = hostDates[hostDates.length - 1];
    const base = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon });
    const floored = planRiderDates({ hostDates, lastRiderDate: anchor, horizonDate: horizon, earliestDate: '2026-10-09' });
    expect(floored).toEqual(base);
  });

  // --- P1 fix #7 (PR #5268 round 4): runaway horizon bound ---------------
  test('computeRiderHorizon bounds a host date sitting years out to the standalone horizon plus the sane maximum, never the raw host date (fail-without-fix evidence)', () => {
    const anchor = '2026-10-01';
    const tenYearsOut = addDays(anchor, 3653);
    const horizon = computeRiderHorizon(anchor, [tenYearsOut], 'quarterly');
    // fail-without-fix: the pre-fix formula returns hostLast verbatim
    // whenever it exceeds the standalone horizon, however far out that is.
    expect(horizon).not.toBe(tenYearsOut);
    const standaloneHorizon = addDays(anchor, 3 * TARGET_GAP_DAYS);
    expect(horizon).toBe(addDays(standaloneHorizon, 730));
  });

  test('computeRiderHorizon still takes a host date that is only modestly past the standalone horizon (unaffected by the cap)', () => {
    const anchor = '2026-10-01';
    const standaloneHorizon = addDays(anchor, 3 * TARGET_GAP_DAYS);
    const modestlyLater = addDays(standaloneHorizon, 30);
    const horizon = computeRiderHorizon(anchor, [modestlyLater], 'quarterly');
    expect(horizon).toBe(modestlyLater);
  });

  test('computeRiderHorizon is unaffected by the cap for an ordinary near-today anchor with no host dates', () => {
    const anchor = '2026-10-01';
    const horizon = computeRiderHorizon(anchor, [], 'quarterly');
    expect(horizon).toBe(addDays(anchor, 3 * TARGET_GAP_DAYS));
  });

  test('diffPlan pairs same-date movable rows by id, whatever order they arrive in', () => {
    const { diffPlan } = require('../services/rider-series-preview')._internals;
    const rows = [
      { id: 'b', scheduled_date: '2098-02-01' },
      { id: 'a', scheduled_date: '2098-02-01' },
      { id: 'c', scheduled_date: '2098-02-01' },
    ];
    const plan = ['2098-03-01', '2098-06-01'];
    const forward = diffPlan(plan, rows);
    const reversed = diffPlan(plan, [...rows].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.move.map((m) => m.id)).toEqual(['a', 'b']);
    expect(forward.cancel.map((c) => c.id)).toEqual(['c']);
  });
});

// Second batch of ride pairs (owner ruling 2026-10-01): each rider cadence has
// its own gaps, so on a MONTHLY lawn host a monthly rider takes every lawn
// date, a bi-monthly one every 2nd, a quarterly one every 3rd, a semiannual
// one every 6th, and a seasonal (Feb-Oct) one every in-season date. The lawn
// dates come from the seeder's own monthly walk, from 24 start dates across a
// year, so 28- and 35-day lawn gaps, weekend shifts and both sides of the
// winter are all covered.
describe('rider gaps per cadence on a monthly lawn host', () => {
  const Seeder = require('../services/recurring-appointment-seeder');
  const { riderGapsFor } = require('../services/rider-series-preview');
  const starts = datesEvery('2097-01-07', 15, 24);
  const lawnFollowUps = (start) => Seeder.buildRecurringFollowUpRows(
    { id: 'lawn', customer_id: 'c1', scheduled_date: start, service_type: 'Lawn Care' },
    { pattern: 'monthly', visitsPerYear: 12, skipWeekends: true },
  ).map((r) => r.scheduled_date);
  const ride = (start, pattern) => {
    const hosts = lawnFollowUps(start);
    const wanted = Seeder.plannedVisitCountForPattern(pattern, {}) - 1;
    const plan = planRiderDates({
      hostDates: [start, ...hosts], lastRiderDate: start, horizonDate: addDays(start, 730), skipWeekends: true, gaps: riderGapsFor(pattern),
    }).slice(0, wanted);
    return { hosts, wanted, plan };
  };

  test('the quarterly gaps are the rule every existing pair already uses', () => {
    expect(riderGapsFor('quarterly')).toEqual({ min: MIN_GAP_DAYS, target: TARGET_GAP_DAYS, max: MAX_WAIT_DAYS });
    expect(riderGapsFor('triannual')).toBe(riderGapsFor('quarterly'));
    const hostDates = datesEvery('2026-01-01', 42, 12);
    const args = { hostDates, lastRiderDate: '2026-01-01', horizonDate: '2027-02-01' };
    expect(planRiderDates({ ...args, gaps: riderGapsFor('quarterly') })).toEqual(planRiderDates(args));
  });

  test.each([
    ['monthly', 1], ['bimonthly', 2], ['quarterly', 3], ['semiannual', 6],
  ])('a %s rider takes every lawn date number %i, for its whole first year', (pattern, step) => {
    for (const start of starts) {
      const { hosts, wanted, plan } = ride(start, pattern);
      expect(hosts).toHaveLength(11);
      expect(plan).toEqual(Array.from({ length: wanted }, (_, k) => hosts[(k + 1) * step - 1]));
    }
  });

  test('a seasonal mosquito rider takes every Feb-Oct lawn date and none in Nov-Jan', () => {
    const month = (d) => Number(d.slice(5, 7));
    for (const start of starts) {
      const { hosts, wanted, plan } = ride(start, 'seasonal_feb_oct');
      expect(wanted).toBe(8);
      expect(plan).toEqual(hosts.filter((d) => month(d) >= 2 && month(d) <= 10).slice(0, 8));
      expect(plan).toHaveLength(8);
    }
  });

  test('a seasonal rider with no lawn date to take stands alone on its own in-season date, never in winter', () => {
    const plan = planRiderDates({
      hostDates: [], lastRiderDate: '2097-10-08', horizonDate: '2098-04-01', skipWeekends: true, gaps: riderGapsFor('seasonal_feb_oct'),
    });
    expect(plan[0]).toBe(Seeder.seasonalFebOctDate('2097-10-08', 1));
    expect(plan.every((d) => Number(d.slice(5, 7)) >= 2 && Number(d.slice(5, 7)) <= 10)).toBe(true);
    // An overdue one (the plan floor is in winter) waits for the season to open.
    const overdue = planRiderDates({
      hostDates: [], lastRiderDate: '2097-06-01', earliestDate: '2097-12-10', horizonDate: '2098-03-01', gaps: riderGapsFor('seasonal_feb_oct'),
    });
    expect(overdue[0]).toBe('2098-02-01');
  });
});
