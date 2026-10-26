/**
 * get_revenue_snapshot's recurringPlans — every WaveGuard plan member whatever
 * the billing type, reported beside MRR (the monthly-dues lane only). Before
 * this, the Monday briefing described the recurring base from MRR alone ("MRR
 * $381.66 across 7 recurring customers") while ~233 plan members paid per
 * application or by annual prepay. Everything else the tool returns is
 * exercised elsewhere; this file only pins the recurringPlans addition.
 */

function makeChain(resolveValue) {
  const chain = {
    where: () => chain,
    whereNull: () => chain,
    whereIn: () => chain,
    sum: () => chain,
    first: () => Promise.resolve(resolveValue),
    then: (resolve, reject) => Promise.resolve(resolveValue).then(resolve, reject),
  };
  return chain;
}

const mockDb = jest.fn(() => makeChain({ total: '0' }));
mockDb.raw = (sql) => sql;

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/forecast-analyzer', () => ({ analyzeTomorrow: async () => ({ needsReschedule: [] }) }));
jest.mock('../routes/admin-dashboard', () => ({ computeCoreKpis: jest.fn() }));
jest.mock('../services/collections/collection-hold', () => ({ excludeNeverAttemptedHoldDeferrals: (q) => q }));
jest.mock('../services/mrr-snapshot', () => ({
  tierBreakdown: async () => [{ tier: 'Gold', count: 3, mrr: 224 }],
  pendingPrepayIds: async () => [],
}));
const mockComputeRecurringPlans = jest.fn();
jest.mock('../services/mrr-breakdown', () => ({
  computeMrrBreakdown: async () => ({ total: 454, totalCount: 9 }),
  computeRecurringPlans: (...args) => mockComputeRecurringPlans(...args),
}));

const { executeBITool } = require('../services/bi-agent-tools');

test('reports recurring plans beside MRR, each under its own name', async () => {
  mockComputeRecurringPlans.mockResolvedValue({ customers: 233, monthly: 12482.5 });
  const out = await executeBITool('get_revenue_snapshot', {});
  expect(out.mrr).toBe(454);
  expect(out.recurringCustomers).toBe(9);
  expect(out.recurringPlans).toEqual({ customers: 233, monthly: 12482.5 });
  expect(mockComputeRecurringPlans).toHaveBeenCalledWith(mockDb);
});
