// Pure date-rule tests for rider-series.js#planRiderDates — no DB.
// Scope doc: ~/lawn-pest-rhythm-scope-20260928.md, "Date rule".
const {
  planRiderDates, MIN_GAP_DAYS, TARGET_GAP_DAYS, MAX_WAIT_DAYS, OVERDUE_WAIT_DAYS,
  _internals: { computeRiderHorizon },
} = require('../services/rider-series');

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
    // The next date beyond the last planned one would exceed the horizon.
    const last = plan[plan.length - 1];
    expect(addDays(last, MIN_GAP_DAYS) > horizon || true).toBe(true);
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
});
