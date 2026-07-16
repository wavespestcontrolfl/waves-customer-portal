// Live-report pressure trend must be bounded to visits BEFORE this report's
// service date. Report tokens are permanent and dynamicContext is computed at
// render time, so an unbounded trend makes an old link present LATER visits'
// data as this report's "current" reading (and contradicts sinceLastVisit,
// which has always been bounded). Two layers pinned here:
//   1. the builder honors beforeDate (excludes later visits from the series)
//   2. dynamic-context actually PASSES beforeDate — the 2026-07-16 audit bug
//      was the caller omitting it, not the builder lacking support.

jest.mock('../services/service-report/pressure-trend', () => {
  const actual = jest.requireActual('../services/service-report/pressure-trend');
  return {
    ...actual,
    buildPressureTrendContext: jest.fn().mockResolvedValue(undefined),
  };
});

const { buildPressureTrendContext } = require('../services/service-report/pressure-trend');
const { buildServiceReportDynamicContext } = require('../services/service-report/dynamic-context');

const actualPressureTrend = jest.requireActual('../services/service-report/pressure-trend');

const RECORD = {
  id: 'rec-report',
  customer_id: 'cust-1',
  status: 'completed',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-03-10',
  started_at: '2026-03-10T15:00:00Z',
  pressure_index: 2,
};

// prior visit (belongs in the trend) + a visit completed AFTER this report
// (must never appear when the render-time bound is applied)
const PRIOR = { id: 'rec-prior', customer_id: 'cust-1', status: 'completed', service_line: 'pest', service_type: 'Quarterly Pest Control Service', service_date: '2026-02-10', started_at: '2026-02-10T15:00:00Z', pressure_index: 1 };
const LATER = { id: 'rec-later', customer_id: 'cust-1', status: 'completed', service_line: 'pest', service_type: 'Quarterly Pest Control Service', service_date: '2026-06-10', started_at: '2026-06-10T15:00:00Z', pressure_index: 4 };

function makeTrendKnex(fixtures) {
  return (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {
      select: () => q,
      where(a, b, c) {
        if (typeof a === 'function') return q; // service-line scope — fixtures are pre-scoped
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 3 && b === '<') {
          rows = rows.filter((r) => String(r[a]) < String(c));
        }
        return q;
      },
      whereNot(criteria) {
        rows = rows.filter((r) => !Object.entries(criteria).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      modify(fn) { fn(q); return q; },
      orderBy: () => q,
      limit(n) { rows = rows.slice(0, n); return q; },
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  };
}

describe('pressure trend render-time bound', () => {
  test('builder with beforeDate excludes later visits — current point is THIS visit', async () => {
    const knex = makeTrendKnex({ service_records: [LATER, PRIOR], service_findings: [] });
    const context = await actualPressureTrend.buildPressureTrendContext({
      record: RECORD,
      beforeDate: RECORD.service_date,
      knex,
    });
    expect(context.points.map((p) => p.pressureIndex)).toEqual([1, 2]);
    expect(context.current.pressureIndex).toBe(2);
  });

  test('unbounded builder folds the later visit in as "current" (why the caller must bound)', async () => {
    const knex = makeTrendKnex({ service_records: [LATER, PRIOR], service_findings: [] });
    const context = await actualPressureTrend.buildPressureTrendContext({ record: RECORD, knex });
    expect(context.current.pressureIndex).toBe(4); // the July visit, not this report's
  });

  test('dynamic-context passes beforeDate = the record service_date to the trend builder', async () => {
    buildPressureTrendContext.mockClear();
    const record = { ...RECORD };
    const dynKnex = (table) => {
      const q = {
        where: () => q,
        leftJoin: () => q,
        select: () => q,
        orderBy: () => q,
        limit: () => q,
        modify: (fn) => { fn(q); return q; },
        whereIn: () => q,
        whereNot: () => q,
        whereNotNull: () => q,
        columnInfo: () => Promise.resolve({}),
        first: () => Promise.resolve(table === 'service_records' ? record : null),
        catch: () => Promise.resolve([]),
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return q;
    };
    dynKnex.raw = (sql) => sql;

    await buildServiceReportDynamicContext({
      recordId: record.id,
      omitPestPressureContext: false,
      knex: dynKnex,
    });

    expect(buildPressureTrendContext).toHaveBeenCalledTimes(1);
    expect(buildPressureTrendContext.mock.calls[0][0]).toEqual(expect.objectContaining({
      beforeDate: record.service_date,
    }));
  });
});
