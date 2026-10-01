/**
 * Cancel-reseed in-term placement (owner ruling 2026-09-30,
 * GATE_CANCEL_RESEED_IN_TERM).
 *
 * The post-cancel reseed appended the replacement at the series END. On an
 * ongoing quarterly plan that is 15 months out, so the plan year that lost
 * the visit stayed short. With the gate on, the replacement goes into the
 * widest gap left in that plan year; no gap that fits → series end, as before.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { pickInTermReseedDate, termWindowAtIndex } = require('../services/recurring-series-cancel-reseed');
const { buildRecurringScheduleAnomalySql } = require('../services/recurring-schedule-audit');

const row = (id, date, status = 'pending') => ({
  id, scheduled_date: date, status, is_recurring: true, recurring_parent_id: id === 'root' ? null : 'root',
});

describe('pickInTermReseedDate', () => {
  // The live case behind the ruling: quarterly root 2026-06-08, the Oct 1
  // visit cancelled on Sep 30, term 0 = [2026-06-08, 2027-06-08).
  const quarterly = [
    row('root', '2026-06-08', 'completed'),
    row('c1', '2026-10-01', 'cancelled'),
    row('c2', '2026-12-30'),
    row('c3', '2027-03-31'),
    row('c4', '2027-06-30'),
    row('c5', '2027-09-29'),
  ];
  const window = termWindowAtIndex('2026-06-08', 0);

  test('puts the replacement inside the term, near the slot the cancel freed', () => {
    // Jun 8 → Dec 30 midpoint (Sep 18) is past; a week out (Oct 7) leaves
    // 84 days to Dec 30 — more room than any other gap (Dec 30 → Mar 31
    // leaves 45). Never the series end (Dec 2027).
    expect(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30' })).toBe('2026-10-07');
  });

  test('is the midpoint of the gap when the midpoint is still ahead', () => {
    // Jun 8 → Dec 30: 205 days, midpoint Sep 18.
    expect(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-07-01' })).toBe('2026-09-18');
  });

  test('never books sooner than the lead time', () => {
    expect(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30', leadDays: 1 })).toBe('2026-10-01');
    expect(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30' }) >= '2026-10-07').toBe(true);
  });

  test('a plan whose first visits were all cancelled (no visit yet) still fills the term', () => {
    const rows = [
      row('root', '2026-06-30', 'cancelled'), row('c1', '2026-09-29', 'cancelled'),
      row('c2', '2026-12-29'), row('c3', '2027-03-30'), row('c4', '2027-06-29'), row('c5', '2027-09-28'),
    ];
    const date = pickInTermReseedDate({ rows, window: termWindowAtIndex('2026-06-30', 0), todayStr: '2026-09-28' });
    // Nothing visited yet: the soonest bookable day (a week out).
    expect(date).toBe('2026-10-05');
  });

  test('keeps the minimum spacing from every live visit', () => {
    const date = pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30', minSpacingDays: 14 });
    const dist = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
    for (const d of ['2026-06-08', '2026-12-30', '2027-03-31']) expect(dist(date, d)).toBeGreaterThanOrEqual(14);
  });

  test('cancelled rows do not block a gap (the cancelled date is free again)', () => {
    const date = pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30' });
    expect(date).not.toBeNull();
  });

  test('applies the series shift and skips a gap the shift pushes out of range', () => {
    // A shift that always lands on a taken date → falls through every gap.
    expect(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30', shift: () => null })).toBeNull();
    // A one-day forward nudge (weekend rule) is kept.
    const plain = pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30' });
    const nudged = pickInTermReseedDate({
      rows: quarterly, window, todayStr: '2026-09-30',
      shift: (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
    });
    expect(nudged > plain).toBe(true);
  });

  test('never returns a date the series already occupies', () => {
    const plain = pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30' });
    const other = pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30', takenDates: new Set([plain]) });
    expect(other).not.toBe(plain);
  });

  test('null when the term is already over (caller appends at the series end)', () => {
    expect(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2027-06-08' })).toBeNull();
  });

  test('null when no gap is wide enough', () => {
    const tight = [row('root', '2026-01-01', 'completed'), row('a', '2026-01-20'), row('b', '2026-02-10')];
    const w = { start: '2026-01-01', end: '2026-02-20' };
    expect(pickInTermReseedDate({ rows: tight, window: w, todayStr: '2026-01-02', minSpacingDays: 14 })).toBeNull();
  });

  test('ignores boosters and callbacks when measuring gaps', () => {
    const rows = [
      ...quarterly,
      { id: 'boost', scheduled_date: '2026-11-15', status: 'pending', is_recurring: false, recurring_parent_id: 'root' },
      { ...row('cb', '2026-11-10'), is_callback: true },
    ];
    expect(pickInTermReseedDate({ rows, window, todayStr: '2026-09-30' }))
      .toBe(pickInTermReseedDate({ rows: quarterly, window, todayStr: '2026-09-30' }));
  });

  test('null without a term window', () => {
    expect(pickInTermReseedDate({ rows: quarterly, window: null, todayStr: '2026-09-30' })).toBeNull();
  });
});

describe('wiring (source guards)', () => {
  const schedule = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const gatesSrc = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');

  test('gate is strict and read live', () => {
    expect(gatesSrc).toMatch(/function cancelReseedInTermLive\(\) \{\n {2}return process\.env\.GATE_CANCEL_RESEED_IN_TERM === 'true';/);
  });

  test('the reseed builds a picker only when the gate is on', () => {
    expect(schedule).toMatch(/const placementPicker = cancelReseedInTermLive\(\)\n\s+\? /);
    expect(schedule).toMatch(/: null;\n\s+const add = await addOneReseedVisit\(trx, \{/);
  });

  test('the reconciler honours the picker only for the one-visit reseed extend', () => {
    expect(schedule).toMatch(/const pickedDate = \(extendByOne && need === 1 && placementPicker\)/);
    expect(schedule).toMatch(/const extendDates = pickedDate \? \[pickedDate\] : planSeriesExtendDates\(/);
  });

  test('the stamp records where the visit went', () => {
    expect(schedule).toMatch(/overlap_dates: overlapDates, placement,/);
  });
});

describe('spacing audit skips in-term replacements', () => {
  test('series rows exclude visits an in-term reseed added', () => {
    const { sql } = buildRecurringScheduleAnomalySql();
    expect(sql).toMatch(/al\.action = 'recurring_cancel_reseed'/);
    expect(sql).toMatch(/al\.metadata->>'placement' = 'in_term'/);
    expect(sql).toMatch(/al\.metadata->'added_service_ids' @> to_jsonb\(s\.id::text\)/);
    // No bare `?` in the new clause (knex.raw would read it as a binding).
    const clause = sql.slice(sql.indexOf('AND NOT EXISTS'), sql.indexOf('active_series AS'));
    expect(clause).not.toMatch(/\?/);
  });
});
