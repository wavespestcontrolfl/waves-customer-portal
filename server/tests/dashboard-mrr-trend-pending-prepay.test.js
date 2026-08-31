'use strict';
/**
 * get_mrr_trend current-month recompute must union the payment-pending
 * annual-prepay ids past the monthly-lane predicate (Codex #3669 r3 P1):
 * those customers sit on billing_mode 'per_application' until the prepay
 * invoice is PAID, while the completed-month snapshots and the live
 * headline (computeMrrBreakdown) both count them — without the union the
 * chart's current point sits below both sources whenever an annual
 * invoice awaits payment.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Recording knex fake: every chained call is logged; grouped-where callbacks
// run against the same recorder so laneOrPendingPrepay's whereRaw/orWhereIn
// land in the log. Thenable so `await chain` and `.first()` both resolve.
const recorded = [];
function makeChain(table) {
  const chain = {
    table,
    calls: [],
    log(method, args) { this.calls.push({ method, args }); recorded.push({ table: this.table, method, args }); return this; },
  };
  const methods = ['where', 'andWhere', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereIn', 'orWhereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNull', 'orWhereNotNull', 'whereBetween', 'select', 'groupBy', 'orderBy', 'limit', 'sum', 'count', 'modify'];
  for (const m of methods) {
    chain[m] = (...args) => {
      chain.log(m, args);
      if (m === 'where' && typeof args[0] === 'function') args[0].call(chain);
      if (m === 'modify' && typeof args[0] === 'function') args[0](chain);
      return chain;
    };
  }
  chain.first = (...args) => { chain.log('first', args); return Promise.resolve({ mrr: 0, customer_count: 0 }); };
  chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return chain;
}
const mockDb = (table) => makeChain(typeof table === 'object' ? JSON.stringify(table) : table);
mockDb.raw = (...args) => ({ __raw: args });
jest.mock('../models/db', () => mockDb);

// Two payment-pending prepay customers, per the billing cron's own helper.
jest.mock('../services/annual-prepay-renewals', () => ({
  getPaymentPendingCustomerIds: jest.fn().mockResolvedValue(new Set(['pp-1', 'pp-2'])),
}));

const { MONTHLY_LANE_SQL } = require('../services/billing-lane');
const { executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');

describe('get_mrr_trend pending-prepay union (Codex #3669 r3 P1, r4 P2)', () => {
  test('the CURRENT-month recompute ORs the pending ids beside MONTHLY_LANE_SQL; historical fallback months do not', async () => {
    recorded.length = 0;
    await executeDashboardTool('get_mrr_trend', { months: 2 });

    // 2 windows × 2 queries (sum + by-tier), every one lane-scoped…
    const customerCalls = recorded.filter((r) => String(r.table).includes('customers'));
    const laneRaws = customerCalls.filter((r) => r.method === 'whereRaw' && r.args[0] === MONTHLY_LANE_SQL);
    expect(laneRaws.length).toBe(4);
    // …but the union is TODAY's transient set: current window only (r4 —
    // today's pending customers must not inflate months they weren't
    // pending in).
    const unions = customerCalls.filter((r) => r.method === 'orWhereIn' && r.args[0] === 'c.id');
    expect(unions.length).toBe(2);
    for (const u of unions) expect(u.args[1]).toEqual(['pp-1', 'pp-2']);
  });

  test('an empty pending set adds no union arm (no widening)', async () => {
    const { getPaymentPendingCustomerIds } = require('../services/annual-prepay-renewals');
    getPaymentPendingCustomerIds.mockResolvedValueOnce(new Set());
    recorded.length = 0;
    await executeDashboardTool('get_mrr_trend', { months: 2 });
    const unions = recorded.filter((r) => r.method === 'orWhereIn' && r.args[0] === 'c.id');
    expect(unions).toHaveLength(0);
    const laneRaws = recorded.filter((r) => r.method === 'whereRaw' && r.args[0] === MONTHLY_LANE_SQL);
    expect(laneRaws.length).toBeGreaterThan(0);
  });
});
