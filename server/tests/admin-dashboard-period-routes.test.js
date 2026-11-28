/**
 * Period-driven dashboard panels (/funnel, /service-mix, /sales-capture,
 * /revenue-by-city) + gross_margin 55% target alignment migration.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: () => {} }));

const mockExecuteDashboardTool = jest.fn();
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({
  executeDashboardTool: (...args) => mockExecuteDashboardTool(...args),
  INTERNAL_TEST_CUSTOMERS: [],
}));

const dbCalls = [];
jest.mock('../models/db', () => {
  const chainMethods = [
    'join', 'leftJoin', 'where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn',
    'whereRaw', 'orWhereRaw', 'select', 'sum', 'count', 'groupByRaw', 'orderBy', 'modify',
  ];
  const makeBuilder = (table) => {
    const b = {};
    for (const m of chainMethods) {
      b[m] = (...args) => {
        dbCalls.push({ table, method: m, args });
        if (typeof args[0] === 'function') args[0].call(b, b);
        return b;
      };
    }
    b.first = async () => (table === 'estimates as e' ? { total: '1200', cnt: '2' } : { count: '0' });
    b.then = (res, rej) => Promise.resolve(table === 'service_records as sr' ? [{ city: 'Bradenton', revenue: '500', jobs: '2' }] : []).then(res, rej);
    return b;
  };
  const dbFn = jest.fn((table) => {
    if (table === 'technicians') {
      return {
        where: () => ({
          first: async () => ({ id: 'admin-1', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false }),
        }),
      };
    }
    return makeBuilder(table);
  });
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-dashboard');
const { errorHandler } = require('../middleware/errors');
const { DEFAULT_KPI_TARGETS } = require('../../shared/kpi-targets.cjs');
const grossMarginMigration = require('../models/migrations/20261127180000_kpi_targets_gross_margin_55');
const recurringAutopayMigration = require('../models/migrations/20261127190000_kpi_targets_recurring_autopay');

const adminToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: 'admin-1', scope: 'staff' }, process.env.JWT_SECRET);

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dashboard', router);
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  dbCalls.length = 0;
  mockExecuteDashboardTool.mockReset();
  mockExecuteDashboardTool.mockImplementation(async (name, input) => (
    name === 'get_estimate_funnel'
      ? { period: { from: input.date_from, to: input.date_to }, funnel: { sent: 4 }, rates: {} }
      : { period: { from: input.date_from, to: input.date_to }, total_services: 10, mix: [] }
  ));
});

async function get(path) {
  const res = await fetch(`${base}/api/admin/dashboard${path}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('Period-driven dashboard endpoints', () => {
  test('/funnel forwards resolved custom range dates and returns the window label', async () => {
    const res = await get('/funnel?period=custom&from=2026-08-01');
    expect(res.status).toBe(200);
    expect(mockExecuteDashboardTool).toHaveBeenCalledWith('get_estimate_funnel', expect.objectContaining({
      date_from: '2026-08-01',
    }));
    expect(res.body.period.label).toBe('Since 2026-08-01');
  });

  test('/service-mix forwards resolved named period dates and returns the window label', async () => {
    const res = await get('/service-mix?period=last_90');
    expect(res.status).toBe(200);
    expect(mockExecuteDashboardTool).toHaveBeenCalledWith('get_service_mix', expect.objectContaining({
      date_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      date_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }));
    expect(res.body.period.label).toBe('Last 90 days');
  });

  test('/sales-capture bounds resolution timestamps on both start and end of the requested window', async () => {
    const res = await get('/sales-capture?period=custom&from=2026-07-15');
    expect(res.status).toBe(200);
    expect(res.body.period).toMatchObject({ from: '2026-07-15', label: 'Since 2026-07-15' });
    const rawClauses = dbCalls.filter(
      (c) => c.table === 'estimates as e' && (c.method === 'whereRaw' || c.method === 'orWhereRaw') && Array.isArray(c.args[1]),
    );
    expect(rawClauses.length).toBeGreaterThanOrEqual(3);
    for (const c of rawClauses) {
      expect(c.args[0]).toContain("INTERVAL '1 day'");
      expect(c.args[1]).toEqual(['2026-07-15T00:00:00', `${res.body.period.to}T00:00:00`]);
    }
  });

  test('/revenue-by-city filters service_date by the requested custom start date and returns period label', async () => {
    const res = await get('/revenue-by-city?period=custom&from=2026-06-01');
    expect(res.status).toBe(200);
    expect(res.body.period).toMatchObject({ from: '2026-06-01', label: 'Since 2026-06-01' });
    expect(dbCalls.some((c) => c.table === 'service_records as sr' && c.method === 'where' && c.args[0] === 'sr.service_date' && c.args[1] === '>=' && c.args[2] === '2026-06-01')).toBe(true);
  });
});

describe('Gross margin target 55% alignment', () => {
  test('DEFAULT_KPI_TARGETS sets gross_margin target to 55%', () => {
    expect(DEFAULT_KPI_TARGETS.gross_margin).toEqual({
      target: 55,
      lowerIsBetter: false,
      amberBandPct: 10,
    });
  });

  test('migration updates only untouched default 40% rows, copies saved autopay_pct target, and rolls back safely', async () => {
    const rows = [
      { metric: 'gross_margin', target: 40, updated_by: null, updated_at: '2026-07-02T00:00:00Z' },
      { metric: 'gross_margin', target: 40, updated_by: 'Adam', updated_at: '2026-08-01T00:00:00Z' },
      { metric: 'autopay_pct', target: 75, amber_band_pct: 10, lower_is_better: false, updated_by: 'Adam', updated_at: '2026-09-01T00:00:00Z' },
    ];
    const makeKnex = () => {
      const knex = () => {
        let filter = {};
        let nullCols = [];
        const matches = (row) => (
          Object.entries(filter).every(([k, v]) => row[k] === v)
          && nullCols.every((c) => row[c] == null)
        );
        return {
          where(obj) { filter = { ...filter, ...obj }; return this; },
          whereNull(col) { nullCols.push(col); return this; },
          async first() { return rows.find(matches); },
          async insert(row) { rows.push({ ...row }); },
          async del() {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (matches(rows[i])) rows.splice(i, 1);
            }
          },
          async update(patch) {
            for (const row of rows) {
              if (matches(row)) Object.assign(row, patch);
            }
          },
        };
      };
      knex.schema = { hasTable: async () => true };
      knex.fn = { now: () => 'NOW' };
      return knex;
    };

    const knex = makeKnex();
    await grossMarginMigration.up(knex);
    await recurringAutopayMigration.up(knex);
    expect(rows[0].target).toBe(55);
    expect(rows[1].target).toBe(40); // owner-edited row untouched
    expect(rows.find((r) => r.metric === 'recurring_autopay_pct')).toMatchObject({
      metric: 'recurring_autopay_pct',
      target: 75,
      updated_by: 'Adam',
      updated_at: '2026-09-01T00:00:00Z',
    });

    await recurringAutopayMigration.down(knex);
    await grossMarginMigration.down(knex);
    expect(rows[0].target).toBe(40);
    expect(rows[1].target).toBe(40);
    expect(rows.find((r) => r.metric === 'recurring_autopay_pct')).toBeUndefined();
  });
});
