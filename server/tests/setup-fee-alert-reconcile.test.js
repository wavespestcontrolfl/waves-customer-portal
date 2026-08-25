// Unit tests for setup-fee-alert-reconcile — the transactional,
// dedupe-locked reconciliation of the estimate-wide unminted-setup-fee
// manual-billing alert. The load-bearing pin (Codex P0, final round): a
// REFUNDED fee-carrying invoice is fee-RESOLUTION evidence, never a
// reopened debt — a resolved alert must NOT be rewritten to demand the
// fee again when its fee invoice is refunded.

let mockTables = {};
let mockUpdates = [];
let mockCounters = {};

jest.mock('../models/db', () => {
  // ONE shared per-test counter map: the pre-read (direct db) and the
  // transaction reads advance the same sequence.
  const handler = (table) => {
    mockCounters[table] = (mockCounters[table] || 0) + 1;
    const spec = mockTables[table];
    const val = typeof spec === 'function' ? spec(mockCounters[table]) : spec;
    const chain = {};
    const self = () => chain;
    ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNull', 'orWhere', 'orWhereRaw', 'orWhereIn', 'orderBy', 'forUpdate', 'leftJoin', 'andWhere', 'orWhereNotNull', 'whereNotIn'].forEach((m) => {
      chain[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(chain, chain);
        return chain;
      });
    });
    chain.first = jest.fn(async () => (Array.isArray(val) ? (val[0] ?? null) : (val ?? null)));
    chain.select = jest.fn(async () => (Array.isArray(val) ? val : (val ? [val] : [])));
    chain.pluck = jest.fn(async () => []);
    chain.update = jest.fn(async (payload) => { mockUpdates.push({ table, payload }); return 1; });
    return chain;
  };
  const mock = jest.fn((table) => handler(table));
  mock.transaction = jest.fn(async (fn) => {
    const trx = (table) => handler(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = { now: jest.fn(() => 'NOW') };
    return fn(trx);
  });
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

// notifications reads, in order: 1 = pre-lock scan (.select), 2 = in-trx
// lock recheck (.first), 3 = the estate alert (.first), 4 = the
// terminal-registration scan (.select — none in these tests).
function notificationsInOrder(primary) {
  return (n) => (n === 1 ? [primary] : (n === 2 || n === 3 ? primary : []));
}

beforeEach(() => {
  mockUpdates = [];
  mockTables = {};
  mockCounters = {};
});

test('a RESOLVED alert whose fee invoice becomes REFUNDED stays settled — never rewritten to demand the fee again', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: true })),
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
  expect(mockUpdates).toEqual([]); // idempotent — no rewrite, no reopened debt
});

test('a VOID (not refunded) fee invoice beside a live application DOES rewrite to a fee-only instruction', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: true })),
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'void', line_items: FEE_LINE, notes: `accepted estimate #${EST}` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].payload.body).toContain('do NOT bill an application again');
  expect(mockUpdates[0].payload.body).toContain('one-time setup fee');
  expect(mockUpdates[0].payload.read_at).toBe(null); // newly actionable — rings
});

test('a PARTIAL fee amount ($9.90 vs expected $99) never resolves the fee — cents-exact against persisted expectation', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: false, expectedSetupFeeCents: 9900 })),
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'paid', line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 9.90 }]), notes: `accepted estimate #${EST}` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  // Application covered, fee NOT (partial) → fee-only instruction, never resolved.
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].payload.body).toContain('one-time setup fee');
  expect(mockUpdates[0].payload.body).not.toContain('RESOLVED');
});

test('a foreign re-linked visit never reconciles another customer\'s alert', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: false })),
    invoices: () => [],
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: 'c2000000-0000-0000-0000-000000000002', sourceEstimateId: EST });
  expect(mockUpdates).toEqual([]);
});
