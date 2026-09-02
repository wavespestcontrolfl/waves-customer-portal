// adminCoverageBoundaryInForce — the portal replay guard (codex pre-push
// P0 on C3 r25): the shared cancel lock serializes portal and admin runs but
// cannot reconcile a portal cancellation row parked behind (or accepted just
// before) an admin END-OF-COVERAGE commit. That commit churns the account
// while deliberately keeping its prepaid covered visits; a later portal
// replay (60s dedupe / inactive-account retry) runs the processor with NO
// boundary and would sweep them. The guard answers "does an admin
// end-of-coverage decision govern this account right now?"

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { adminCoverageBoundaryInForce } = require('../services/admin-cancellation');

let tables;
function builderFor(table) {
  const conds = [];
  const b = {};
  const rows = () => (tables[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = jest.fn((criteria) => { Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; });
  for (const m of ['orderBy', 'limit']) b[m] = jest.fn(() => b);
  b.select = jest.fn(async () => rows());
  b.first = jest.fn(async () => rows()[0] || null);
  return b;
}

const T0 = new Date('2026-08-31T15:00:00Z').getTime();
const adminRow = (id, { effectiveDate, status = 'resolved', createdAt = T0 }) => ({
  id, customer_id: 'cust-1', category: 'cancellation', source: 'admin', status,
  created_at: new Date(createdAt), metadata: JSON.stringify({ cancel_plan: { scope: [], effectiveDate } }),
});

beforeEach(() => {
  tables = { service_requests: [], customers: [{ id: 'cust-1', pipeline_stage: 'churned', pipeline_stage_changed_at: new Date(T0 + 30 * 1000) }] };
  db.mockImplementation((table) => builderFor(table));
});

test('no admin end-of-coverage acceptance → not in force (an end-now admin cancel keeps nothing)', async () => {
  tables.service_requests = [adminRow('a1', { effectiveDate: 'now' })];
  expect(await adminCoverageBoundaryInForce('cust-1')).toBe(false);
});

test('an OPEN end-of-coverage acceptance (in flight or repairing) is in force regardless of the churn anchor', async () => {
  tables.service_requests = [adminRow('a1', { effectiveDate: 'end_of_coverage', status: 'new' })];
  tables.customers[0].pipeline_stage = 'active_customer';
  expect(await adminCoverageBoundaryInForce('cust-1')).toBe(true);
});

test('a resolved acceptance accepted moments before the CURRENT churn transition is in force', async () => {
  tables.service_requests = [adminRow('a1', { effectiveDate: 'end_of_coverage' })];
  expect(await adminCoverageBoundaryInForce('cust-1')).toBe(true);
});

test('a decision from BEFORE a win-back is history — a re-churned account can be cancelled from the portal again', async () => {
  // Accepted two days before the current churn transition.
  tables.service_requests = [adminRow('a1', { effectiveDate: 'end_of_coverage', createdAt: T0 - 2 * 24 * 60 * 60 * 1000 })];
  expect(await adminCoverageBoundaryInForce('cust-1')).toBe(false);
});

test('an active (won-back) customer is never governed by a resolved decision', async () => {
  tables.service_requests = [adminRow('a1', { effectiveDate: 'end_of_coverage' })];
  tables.customers[0].pipeline_stage = 'active_customer';
  expect(await adminCoverageBoundaryInForce('cust-1')).toBe(false);
});

test('an unanchored churn (no pipeline_stage_changed_at) fails SAFE — the paid visits stay', async () => {
  tables.service_requests = [adminRow('a1', { effectiveDate: 'end_of_coverage' })];
  tables.customers[0].pipeline_stage_changed_at = null;
  expect(await adminCoverageBoundaryInForce('cust-1')).toBe(true);
});
