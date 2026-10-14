'use strict';

// The texting AI's next-of-series identity (sms-shadow-drafter nextVisitOfSeries)
// trusts two facts the aggregator stamps on each upcoming visit: seriesKey (the
// schedule's own series link) and series_exclusive (that series is ALL of the
// customer's upcoming work, beyond the three listed rows). Regression: a
// matching service label, or three listed rows of one series, proved neither.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { seriesKeyOfRow, stampSeriesExclusive } = require('../services/context-aggregator');

// A chainable stand-in for upcomingServicesBase(customer): records the filters
// and resolves .first() with `other`.
function baseReturning(other, calls = []) {
  return () => {
    const q = {
      whereNot: (...a) => { calls.push(['whereNot', ...a]); return q; },
      where: (fn) => {
        const inner = { whereNull: (c) => { calls.push(['whereNull', c]); return inner; }, orWhereNot: (...a) => { calls.push(['orWhereNot', ...a]); return inner; } };
        fn(inner);
        return q;
      },
      first: async () => other,
    };
    return q;
  };
}

describe('seriesKeyOfRow', () => {
  test('a child visit keys on its parent, the recurring parent on itself, a one-time job on nothing', () => {
    expect(seriesKeyOfRow({ id: 'child', recurring_parent_id: 'parent', is_recurring: true })).toBe('parent');
    expect(seriesKeyOfRow({ id: 'parent', recurring_parent_id: null, is_recurring: true })).toBe('parent');
    expect(seriesKeyOfRow({ id: 'one-time', recurring_parent_id: null, is_recurring: false })).toBeNull();
    expect(seriesKeyOfRow(null)).toBeNull();
  });
});

describe('stampSeriesExclusive', () => {
  const series = () => [
    { id: 'parent', recurring_parent_id: null, is_recurring: true },
    { id: 'c1', recurring_parent_id: 'parent', is_recurring: true },
    { id: 'c2', recurring_parent_id: 'parent', is_recurring: true },
  ];

  test('one series and no other upcoming work: exclusive, asked with the series excluded', async () => {
    const calls = [];
    const rows = await stampSeriesExclusive({ id: 'cust' }, series(), baseReturning(undefined, calls));
    expect(rows.map((r) => r.series_exclusive)).toEqual([true, true, true]);
    expect(calls).toEqual([['whereNot', 'ss.id', 'parent'], ['whereNull', 'ss.recurring_parent_id'], ['orWhereNot', 'ss.recurring_parent_id', 'parent']]);
  });

  test('one series in the listed rows but another upcoming visit exists beyond them: not exclusive', async () => {
    const rows = await stampSeriesExclusive({ id: 'cust' }, series(), baseReturning({ id: 'a-fourth-visit' }));
    expect(rows.map((r) => r.series_exclusive)).toEqual([false, false, false]);
  });

  test('a failed read is not exclusive (fail closed)', async () => {
    const failing = () => { throw new Error('db down'); };
    const rows = await stampSeriesExclusive({ id: 'cust' }, series(), failing);
    expect(rows.map((r) => r.series_exclusive)).toEqual([false, false, false]);
  });

  test('mixed rows, one-time jobs, or a single row: nothing is asked and nothing is stamped', async () => {
    const neverAsked = () => { throw new Error('must not query'); };
    for (const rows of [
      [{ id: 'a', is_recurring: false }, { id: 'b', is_recurring: false }],
      [{ id: 'p1', is_recurring: true }, { id: 'p2', is_recurring: true }],
      [{ id: 'p1', is_recurring: true }, { id: 'x', is_recurring: false }],
      [{ id: 'p1', is_recurring: true }],
      [],
    ]) {
      const out = await stampSeriesExclusive({ id: 'cust' }, rows, neverAsked);
      expect(out.every((r) => r.series_exclusive === undefined)).toBe(true);
    }
  });
});
