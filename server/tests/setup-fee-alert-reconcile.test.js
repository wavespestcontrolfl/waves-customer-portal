// Unit tests for setup-fee-alert-reconcile — the transactional,
// dedupe-locked reconciliation of the estimate-wide unminted-setup-fee
// manual-billing alert. The load-bearing pin (Codex P0, final round): a
// REFUNDED fee-carrying invoice is fee-RESOLUTION evidence, never a
// reopened debt — a resolved alert must NOT be rewritten to demand the
// fee again when its fee invoice is refunded.

let mockTables = {};
let updates = [];

jest.mock('../models/db', () => {
  const makeTrx = () => {
    const counters = {};
    const trx = (table) => {
      counters[table] = (counters[table] || 0) + 1;
      const spec = mockTables[table];
      const val = typeof spec === 'function' ? spec(counters[table]) : spec;
      const chain = {};
      const self = () => chain;
      ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNull', 'orWhere', 'orderBy', 'forUpdate'].forEach((m) => {
        chain[m] = jest.fn(self);
      });
      chain.first = jest.fn(async () => (Array.isArray(val) ? (val[0] ?? null) : (val ?? null)));
      chain.select = jest.fn(async () => (Array.isArray(val) ? val : (val ? [val] : [])));
      chain.update = jest.fn(async (payload) => { updates.push({ table, payload }); return 1; });
      return chain;
    };
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = { now: jest.fn(() => 'NOW') };
    return trx;
  };
  const mock = jest.fn();
  mock.transaction = jest.fn(async (fn) => fn(makeTrx()));
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});

const { reconcileSetupFeeAlert } = require('../services/setup-fee-alert-reconcile');

const CUST = 'c1000000-0000-0000-0000-000000000001';
const EST = 'e1000000-0000-0000-0000-000000000001';
const FEE_LINE = JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]);
const APP_LINE = JSON.stringify([{ client_id: 'scheduled_ss-1_primary', description: 'Quarterly Pest Control', amount: 88 }]);

function alertRow(metaOverrides = {}) {
  return {
    id: 'alert-1',
    metadata: {
      dedupeKey: `unminted_setup_fee_manual_billing:${EST}`,
      customerId: CUST,
      scheduledServiceId: 'ss-1',
      ...metaOverrides,
    },
  };
}

beforeEach(() => {
  updates = [];
  mockTables = {};
});

test('a RESOLVED alert whose fee invoice becomes REFUNDED stays settled — never rewritten to demand the fee again', async () => {
  mockTables = {
    notifications: alertRow({ resolvedCovered: true }),
    // Call 1 = stamped scan, call 2 = on-visit scan.
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'refunded', line_items: FEE_LINE, notes: `accepted estimate #${EST} — $99 setup fee` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(updates).toEqual([]); // idempotent — no rewrite, no reopened debt
});

test('a VOID (not refunded) fee invoice beside a live application DOES rewrite to a fee-only instruction', async () => {
  mockTables = {
    notifications: alertRow({ resolvedCovered: true }),
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'void', line_items: FEE_LINE, notes: `accepted estimate #${EST}` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(updates).toHaveLength(1);
  expect(updates[0].payload.body).toContain('do NOT bill an application again');
  expect(updates[0].payload.body).toContain('one-time setup fee');
  expect(updates[0].payload.read_at).toBe(null); // newly actionable — rings
});

test('a foreign re-linked visit never reconciles another customer\'s alert', async () => {
  mockTables = {
    notifications: alertRow({ resolvedCovered: false }),
    invoices: () => [],
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: 'c2000000-0000-0000-0000-000000000002', sourceEstimateId: EST });
  expect(updates).toEqual([]);
});
