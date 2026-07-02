// getKpiHistory (services/kpi-snapshot.js) — the /admin/dashboard/kpi-history
// payload builder. Service-level test with an injected fake knex: mounting the
// full admin-dashboard router isn't hermetic (it pulls the whole dashboard
// service graph), and the route is a one-line delegation to this function.

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const { getKpiHistory } = require('../services/kpi-snapshot');

function makeFakeDb(rows) {
  const calls = { where: [], raw: [] };
  const builder = {
    where: (...args) => { calls.where.push(args); return builder; },
    select: () => builder,
    orderBy: (...args) => { calls.orderBy = args; return builder; },
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  const db = () => builder;
  db.raw = (sql, bindings) => { calls.raw.push({ sql, bindings }); return { sql, bindings }; };
  db._calls = calls;
  return db;
}

describe('getKpiHistory', () => {
  test('groups rows into per-metric ascending series, nulls preserved, values numeric', async () => {
    const db = makeFakeDb([
      { date: '2026-06-30', metric: 'completion_rate', value: '82.5000' },
      { date: '2026-06-30', metric: 'ar_days', value: null },
      { date: '2026-07-01', metric: 'completion_rate', value: '90.0000' },
      { date: '2026-07-01', metric: 'ar_days', value: '28.4000' },
    ]);
    const out = await getKpiHistory(90, db);

    expect(out.days).toBe(90);
    expect(out.series.completion_rate).toEqual([
      { date: '2026-06-30', value: 82.5 },
      { date: '2026-07-01', value: 90 },
    ]);
    // A day the metric was unavailable stays null — a gap, not a fake zero.
    expect(out.series.ar_days).toEqual([
      { date: '2026-06-30', value: null },
      { date: '2026-07-01', value: 28.4 },
    ]);
    expect(db._calls.orderBy).toEqual(['snapshot_date', 'asc']);
  });

  test('clamps the window to [7, 365] and defaults junk to 90', async () => {
    for (const [input, expected] of [[3, 7], [1000, 365], ['junk', 90], [undefined, 90], ['30', 30]]) {
      const db = makeFakeDb([]);
      const out = await getKpiHistory(input, db);
      expect(out.days).toBe(expected);
      // days-1 binds into the INCLUSIVE date floor, so the window is exactly
      // `days` calendar days counting today (not days+1).
      const floor = db._calls.raw.find((c) => String(c.sql).includes('::date - ?::int'));
      expect(floor.bindings).toEqual([expected - 1]);
    }
  });

  test('empty table yields an empty series map', async () => {
    const out = await getKpiHistory(90, makeFakeDb([]));
    expect(out.series).toEqual({});
  });
});
