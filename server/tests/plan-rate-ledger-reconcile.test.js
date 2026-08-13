// Plan-rate ledger invariant reconciler (2026-08-13). Born from the owner's
// invariant-watch email: a live customer billed $86.60/mo while their
// customer_plan_rates components summed $45.00 — a scalar write outside the
// ledger-aware paths. These tests pin the repair semantics (shortfall parks
// as 'unattributed' via an additive upsert, the billed scalar is NEVER
// touched, overshoot never deletes), the under-lock re-check (a concurrent
// writer that already reconciled makes the customer a no-op), the
// forever-dedupe on the notification, the loud insert-failure posture, and
// both gate no-ops. All fixture identities are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 1 })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
// The module-level db default is unused (every test injects its own fake),
// but requiring the real one drags in knex config.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn();
  return fn;
});

const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
const { runPlanRateLedgerReconcile } = require('../services/plan-rate-ledger-reconcile');
const { UNATTRIBUTED } = require('../services/plan-rate-ledger');

const gatesOn = () => isEnabled.mockImplementation(
  (name) => name === 'planRateLedgerReconcile' || name === 'planRateLedger',
);

// ── stateful fake knex ──────────────────────────────────────────────────────
// Covers exactly the tables the reconciler touches: the customers⋈ledger
// candidate snapshot, the locked customers re-read, customer_plan_rates
// select + additive upsert, and the notifications dedupe probe. Throws on
// any other table so a widened surface fails loudly here.
function makeDb({
  candidates = [],
  lockedCustomer,
  ledgerRows = [],
  hasExistingNotification = false,
  hasTable = true,
} = {}) {
  const upserts = [];
  const ledgerStore = ledgerRows.map((r) => ({ ...r }));

  const builderFor = (table) => {
    if (table === 'customers as c') {
      const b = {};
      ['join', 'whereIn', 'whereNull', 'groupBy', 'havingRaw', 'select', 'sum'].forEach((m) => {
        b[m] = () => b;
      });
      b.then = (resolve, reject) => Promise.resolve(candidates).then(resolve, reject);
      return b;
    }
    if (table === 'customers') {
      const b = {
        where: () => b,
        forUpdate: () => b,
        first: async () => lockedCustomer,
      };
      return b;
    }
    if (table === 'customer_plan_rates') {
      const b = {
        where: () => b,
        select: () => b,
        then: (resolve, reject) => Promise.resolve(ledgerStore.map((r) => ({ ...r }))).then(resolve, reject),
        insert: (row) => ({
          onConflict: () => ({
            merge: async (mergeObj) => {
              upserts.push({ row, mergeObj });
              const existing = ledgerStore.find(
                (r) => r.family_key === row.family_key,
              );
              if (existing) existing.monthly_rate = Number(existing.monthly_rate) + Number(row.monthly_rate);
              else ledgerStore.push({ ...row, source: row.source });
            },
          }),
        }),
      };
      return b;
    }
    if (table === 'notifications') {
      const b = {
        where: () => b,
        whereRaw: () => b,
        first: async () => (hasExistingNotification ? { id: 'n-1' } : undefined),
      };
      return b;
    }
    throw new Error(`fake db: unexpected table ${table}`);
  };

  const db = (table) => builderFor(table);
  db.schema = { hasTable: async () => hasTable };
  db.raw = (sql) => ({ __raw: sql });
  db.transaction = async (fn) => {
    const trx = (table) => builderFor(table);
    trx.raw = db.raw;
    return fn(trx);
  };
  db.__upserts = upserts;
  db.__ledgerStore = ledgerStore;
  return db;
}

const brokenCandidate = {
  id: 'cust-broken', first_name: 'Jordan', last_name: 'Gillette',
  monthly_rate: '86.60', component_sum: '45.00',
};

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(() => false);
  NotificationService.notifyAdmin.mockImplementation(async () => ({ id: 1 }));
});

test('gate off → no-op', async () => {
  const db = makeDb();
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toEqual({ skipped: true, reason: 'gated_off' });
});

test('reconcile gate on but ledger advisory → no-op (pre-flip divergence is expected data)', async () => {
  isEnabled.mockImplementation((name) => name === 'planRateLedgerReconcile');
  const db = makeDb({ candidates: [brokenCandidate] });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toEqual({ skipped: true, reason: 'ledger_advisory' });
  expect(db.__upserts).toHaveLength(0);
});

test('shortfall parks as unattributed, scalar untouched, owner paged with component detail', async () => {
  gatesOn();
  const db = makeDb({
    candidates: [brokenCandidate],
    lockedCustomer: {
      id: 'cust-broken', monthly_rate: '86.60', pipeline_stage: 'active_customer', deleted_at: null,
    },
    ledgerRows: [{ family_key: 'pest_control', monthly_rate: '45.00', source: 'backfill' }],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ skipped: false, checked: 1, repaired: 1, overshoots: 0, alerted: 1 });
  expect(db.__upserts).toHaveLength(1);
  const { row } = db.__upserts[0];
  expect(row.family_key).toBe(UNATTRIBUTED);
  expect(row.monthly_rate).toBeCloseTo(41.60, 2);
  expect(row.source).toBe('invariant_repair');
  // The billed figure is the business fact — the repair must sum TO it,
  // never write it.
  expect(db.__ledgerStore.reduce((s, r) => s + Number(r.monthly_rate), 0)).toBeCloseTo(86.60, 2);
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(title).toMatch(/repaired/i);
  expect(body).toContain('$86.60');
  expect(body).toContain('$45.00');
  expect(body).toContain('pest_control');
  expect(opts.metadata.dedupeKey).toBe('plan-rate-invariant:cust-broken:8660:4500');
});

test('overshoot never deletes — alert only', async () => {
  gatesOn();
  const db = makeDb({
    candidates: [{ ...brokenCandidate, monthly_rate: '40.00', component_sum: '45.00' }],
    lockedCustomer: {
      id: 'cust-broken', monthly_rate: '40.00', pipeline_stage: 'active_customer', deleted_at: null,
    },
    ledgerRows: [{ family_key: 'pest_control', monthly_rate: '45.00', source: 'estimate_accept' }],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ repaired: 0, overshoots: 1, alerted: 1 });
  expect(db.__upserts).toHaveLength(0);
  expect(db.__ledgerStore).toHaveLength(1);
  const [, title] = NotificationService.notifyAdmin.mock.calls[0];
  expect(title).toMatch(/exceed/i);
});

test('under-lock re-check: a concurrent writer already reconciled → no repair, no bell', async () => {
  gatesOn();
  const db = makeDb({
    candidates: [brokenCandidate],
    // Between the snapshot and the lock, an accept rewrote both figures.
    lockedCustomer: {
      id: 'cust-broken', monthly_rate: '45.00', pipeline_stage: 'active_customer', deleted_at: null,
    },
    ledgerRows: [{ family_key: 'pest_control', monthly_rate: '45.00', source: 'estimate_accept' }],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ checked: 1, repaired: 0, overshoots: 0, alerted: 0 });
  expect(db.__upserts).toHaveLength(0);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('customer no longer live-stage under the lock → skipped', async () => {
  gatesOn();
  const db = makeDb({
    candidates: [brokenCandidate],
    lockedCustomer: {
      id: 'cust-broken', monthly_rate: '86.60', pipeline_stage: 'churned', deleted_at: null,
    },
    ledgerRows: [{ family_key: 'pest_control', monthly_rate: '45.00', source: 'backfill' }],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ repaired: 0, overshoots: 0, alerted: 0 });
  expect(db.__upserts).toHaveLength(0);
});

test('forever-dedupe: an existing notification for the same divergence repairs silently', async () => {
  gatesOn();
  const db = makeDb({
    candidates: [brokenCandidate],
    lockedCustomer: {
      id: 'cust-broken', monthly_rate: '86.60', pipeline_stage: 'active_customer', deleted_at: null,
    },
    ledgerRows: [{ family_key: 'pest_control', monthly_rate: '45.00', source: 'backfill' }],
    hasExistingNotification: true,
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  // The repair itself is not gated on the bell — the data must converge.
  expect(result).toMatchObject({ repaired: 1, alerted: 0 });
  expect(db.__upserts).toHaveLength(1);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('lost bell fails the run loudly', async () => {
  gatesOn();
  NotificationService.notifyAdmin.mockImplementation(async () => null);
  const db = makeDb({
    candidates: [brokenCandidate],
    lockedCustomer: {
      id: 'cust-broken', monthly_rate: '86.60', pipeline_stage: 'active_customer', deleted_at: null,
    },
    ledgerRows: [{ family_key: 'pest_control', monthly_rate: '45.00', source: 'backfill' }],
  });
  await expect(runPlanRateLedgerReconcile({ database: db })).rejects.toThrow(/notification insert failed/);
});

test('missing ledger table → no-op', async () => {
  gatesOn();
  const db = makeDb({ hasTable: false });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toEqual({ skipped: true, reason: 'no_table' });
});
