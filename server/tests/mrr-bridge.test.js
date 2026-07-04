const { buildBridgeMonths, prevMonthKey, periodKeyOf, monthLabelOf } = require('../services/mrr-bridge');

const snap = (entries) => new Map(Object.entries(entries)); // { customerId: rate }

describe('prevMonthKey / periodKeyOf / monthLabelOf', () => {
  test('prevMonthKey handles year boundaries with pure string math', () => {
    expect(prevMonthKey('2026-07-01')).toBe('2026-06-01');
    expect(prevMonthKey('2026-01-01')).toBe('2025-12-01');
  });

  test('periodKeyOf reads a DATE cell via local getters (no UTC drift)', () => {
    expect(periodKeyOf('2026-07-01')).toBe('2026-07-01');
    // node-postgres yields local-midnight Dates for DATE columns; the ET/UTC
    // offset must not shift the calendar day.
    expect(periodKeyOf(new Date(2026, 6, 1))).toBe('2026-07-01');
  });

  test('monthLabelOf renders the strip label', () => {
    expect(monthLabelOf('2026-07-01')).toBe('Jul ’26');
  });
});

describe('buildBridgeMonths — exact snapshot diffs', () => {
  test('splits entrants into new (converted in-month) vs reactivated', () => {
    const [m] = buildBridgeMonths({
      monthKeys: ['2026-07-01'],
      snapshotsByMonth: new Map([
        ['2026-06-01', snap({ a: 100 })],
        ['2026-07-01', snap({ a: 100, b: 80, c: 60 })],
      ]),
      conversionMonthById: new Map([
        ['b', '2026-07'], // converted this month → NEW
        ['c', '2025-11'], // long-ago customer returning → REACTIVATED
      ]),
    });
    expect(m.degraded).toBe(false);
    expect(m.new).toEqual({ mrr: 80, count: 1 });
    expect(m.reactivated).toEqual({ mrr: 60, count: 1 });
    expect(m.churned).toEqual({ mrr: 0, count: 0 });
  });

  test('expansion/contraction from per-customer rate deltas; bridge is additive to the cent', () => {
    const [m] = buildBridgeMonths({
      monthKeys: ['2026-07-01'],
      snapshotsByMonth: new Map([
        ['2026-06-01', snap({ a: 100, b: 50.25, c: 89, d: 40 })],
        ['2026-07-01', snap({ a: 120.5, b: 45.25, c: 89 })], // a +20.50, b −5.00, c flat, d gone
      ]),
      conversionMonthById: new Map(),
    });
    expect(m.startMrr).toBe(279.25);
    expect(m.endMrr).toBe(254.75);
    expect(m.expansion).toEqual({ mrr: 20.5, count: 1 });
    expect(m.contraction).toEqual({ mrr: 5, count: 1 });
    expect(m.churned).toEqual({ mrr: 40, count: 1 });
    // start + new + reactivated + expansion − contraction − churned = end
    const reconstructed =
      m.startMrr + m.new.mrr + m.reactivated.mrr + m.expansion.mrr - m.contraction.mrr - m.churned.mrr;
    expect(reconstructed).toBeCloseTo(m.endMrr, 2);
    expect(m.net).toBe(-24.5);
  });

  test('flat customers land in no movement bucket', () => {
    const [m] = buildBridgeMonths({
      monthKeys: ['2026-07-01'],
      snapshotsByMonth: new Map([
        ['2026-06-01', snap({ a: 100 })],
        ['2026-07-01', snap({ a: 100 })],
      ]),
      conversionMonthById: new Map(),
    });
    expect(m.net).toBe(0);
    expect(m.expansion.count + m.contraction.count + m.churned.count + m.new.count + m.reactivated.count).toBe(0);
  });

  test('consecutive months chain: each diffs against its own predecessor', () => {
    const out = buildBridgeMonths({
      monthKeys: ['2026-06-01', '2026-07-01'],
      snapshotsByMonth: new Map([
        ['2026-05-01', snap({ a: 100 })],
        ['2026-06-01', snap({ a: 100, b: 50 })],
        ['2026-07-01', snap({ b: 55 })],
      ]),
      conversionMonthById: new Map([['b', '2026-06']]),
    });
    expect(out[0].new).toEqual({ mrr: 50, count: 1 }); // b arrives in June
    expect(out[1].churned).toEqual({ mrr: 100, count: 1 }); // a leaves in July
    expect(out[1].expansion).toEqual({ mrr: 5, count: 1 }); // b grows in July
    expect(out[1].startMrr).toBe(out[0].endMrr); // months chain exactly
  });

  test('flags the in-progress current month', () => {
    const out = buildBridgeMonths({
      monthKeys: ['2026-06-01', '2026-07-01'],
      snapshotsByMonth: new Map([
        ['2026-05-01', snap({ a: 1 })],
        ['2026-06-01', snap({ a: 1 })],
        ['2026-07-01', snap({ a: 1 })],
      ]),
      conversionMonthById: new Map(),
      currentMonthKey: '2026-07-01',
    });
    expect(out[0].inProgress).toBe(false);
    expect(out[1].inProgress).toBe(true);
  });
});

describe('buildBridgeMonths — degraded months (pre-snapshot)', () => {
  test('degrades when either month lacks a snapshot, using the customers-table fallback', () => {
    const out = buildBridgeMonths({
      monthKeys: ['2026-05-01', '2026-06-01', '2026-07-01'],
      snapshotsByMonth: new Map([
        ['2026-06-01', snap({ a: 100 })], // first snapshot month
        ['2026-07-01', snap({ a: 100 })],
      ]),
      conversionMonthById: new Map(),
      degradedByMonth: new Map([
        ['2026-05-01', { newMrr: 120, newCount: 2, churnedMrr: 45, churnedCount: 1 }],
        // June has a snapshot but May 2026 predates snapshots → June ALSO
        // degrades (no prior month to diff against).
        ['2026-06-01', { newMrr: 60, newCount: 1, churnedMrr: 0, churnedCount: 0 }],
      ]),
    });
    expect(out[0].degraded).toBe(true);
    expect(out[0].net).toBe(75); // 120 − 45
    expect(out[0].startMrr).toBeNull(); // no exact anchors for a degraded month
    expect(out[1].degraded).toBe(true); // snapshot exists but predecessor doesn't
    expect(out[1].net).toBe(60);
    expect(out[2].degraded).toBe(false); // first exact month: Jun→Jul diff
  });

  test('degraded month with no fallback data renders zeros, never throws', () => {
    const [m] = buildBridgeMonths({
      monthKeys: ['2026-03-01'],
      snapshotsByMonth: new Map(),
      conversionMonthById: new Map(),
    });
    expect(m.degraded).toBe(true);
    expect(m.net).toBe(0);
    expect(m.new).toEqual({ mrr: 0, count: 0 });
  });
});
