/**
 * computeCoreKpis(period, range) — the optional range.to window-end override
 * (Codex P1, bi-agent-tools.js:121: the Weekly BI Briefing's Monday-morning
 * run must close its windows YESTERDAY so Monday's not-yet-done appointments
 * never count as an incomplete in completion_rate's denominator).
 *
 * This pins the completion-rate query (`scheduled_services`, the one
 * unwrapped/must-succeed query computeCoreKpis runs first) end bound:
 *  - no range.to            -> ends today (byte-identical to every existing
 *                              caller: the dashboard routes, kpi-snapshot.js)
 *  - range.to before today  -> ends at range.to
 *  - range.to after today   -> clamped to today
 *  - range.to before start  -> collapses to start..start
 *
 * Every other computeCoreKpis query is wrapped in its own try/catch (AR days,
 * collection rate, retention, momentum, leaderboard, memberships, deposits,
 * call-to-booking, autopay, CSAT, leads) and isn't exercised in depth here —
 * a generic fake chain resolves them to benign empty/zero values so the
 * function completes without throwing.
 */

const { etDateString, addETDays } = require('../utils/datetime-et');

// jest.mock factories can't close over ordinary top-level variables (only
// `mock`-prefixed ones survive hoisting), so the whole fake Knex builder
// lives inside the factory and publishes its capture array on the mock db
// function itself (`db.__mockScheduledServicesWhereCalls`).
jest.mock('../models/db', () => {
  const mockScheduledServicesWhereCalls = [];

  // One generic, chainable Knex-like stub for every table. `.first()` and a
  // direct `await` (no `.first()`, used by e.g. the leaderboard query) both
  // resolve to a benign, non-throwing value so every OTHER query in
  // computeCoreKpis (all wrapped in try/catch) degrades quietly. Only
  // 'scheduled_services' (>=/<= where calls) is recorded — it's the
  // completion-rate query this test pins, and the only query besides
  // 'service_records' that computeCoreKpis does NOT wrap in a try/catch, so
  // it must resolve.
  function makeChain(table) {
    const firstRowByTable = {
      scheduled_services: { total: '10', completed: '5', cancelled: '0' },
      service_records: {
        total: '10', completed: '2', callbacks: '1',
        rev_total: '1000', hours_total: '20', avg_rev: '100', avg_rpmh: '50',
        avg_margin: '40', weighted_margin: '42', jobs: '10',
      },
    };
    const chain = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'first') return () => Promise.resolve(firstRowByTable[table] || {});
        if (prop === 'then') return (resolve) => Promise.resolve([]).then(resolve);
        if (prop === 'where' && table === 'scheduled_services') {
          return (...args) => { mockScheduledServicesWhereCalls.push(args); return chain; };
        }
        // Every other chain method (where, whereNull, whereNotNull, whereIn,
        // whereNotIn, whereRaw, modify, select, leftJoin, groupBy, orderBy,
        // orderByRaw, count, ...) is chainable and otherwise a no-op.
        return (...args) => chain;
      },
    });
    return chain;
  }

  const db = jest.fn((table) => makeChain(table));
  db.raw = (sql) => sql;
  db.__mockScheduledServicesWhereCalls = mockScheduledServicesWhereCalls;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { computeCoreKpis } = require('../routes/admin-dashboard');
const fakeDb = require('../models/db');

describe('computeCoreKpis — range.to window-end override', () => {
  let scheduledServicesWhereCalls;

  beforeEach(() => {
    fakeDb.__mockScheduledServicesWhereCalls.length = 0;
    scheduledServicesWhereCalls = fakeDb.__mockScheduledServicesWhereCalls;
  });

  it('with no range, ends the completion-rate window today (byte-identical to every existing caller)', async () => {
    const today = etDateString();
    await computeCoreKpis('last_7');
    expect(scheduledServicesWhereCalls).toEqual([
      ['scheduled_date', '>=', expect.any(String)],
      ['scheduled_date', '<=', today],
    ]);
  });

  it('a range.from with no range.to still ends today (existing dashboard custom-range callers)', async () => {
    const today = etDateString();
    const from = etDateString(addETDays(new Date(), -3));
    await computeCoreKpis('last_7', { from });
    expect(scheduledServicesWhereCalls).toEqual([
      ['scheduled_date', '>=', from],
      ['scheduled_date', '<=', today],
    ]);
  });

  it('range.to before today ends the window at range.to, not today', async () => {
    const yesterday = etDateString(addETDays(new Date(), -1));
    const from = etDateString(addETDays(new Date(), -7));
    await computeCoreKpis('last_7', { from, to: yesterday });
    expect(scheduledServicesWhereCalls).toEqual([
      ['scheduled_date', '>=', from],
      ['scheduled_date', '<=', yesterday],
    ]);
  });

  it('range.to after today is clamped to today, never a future date', async () => {
    const today = etDateString();
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const from = etDateString(addETDays(new Date(), -7));
    await computeCoreKpis('last_7', { from, to: tomorrow });
    expect(scheduledServicesWhereCalls).toEqual([
      ['scheduled_date', '>=', from],
      ['scheduled_date', '<=', today],
    ]);
  });

  it('range.to before range.from collapses to a single-day start..start window', async () => {
    const from = etDateString(addETDays(new Date(), -7));
    const tooEarly = etDateString(addETDays(new Date(), -10));
    await computeCoreKpis('last_7', { from, to: tooEarly });
    expect(scheduledServicesWhereCalls).toEqual([
      ['scheduled_date', '>=', from],
      ['scheduled_date', '<=', from],
    ]);
  });
});
