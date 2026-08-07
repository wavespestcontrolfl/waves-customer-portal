// UNSLICED authoritative accepts — the #3245 r16 ledger reset path, and the
// r22 scalar:null sentinel trap that nearly dead-coded it.
//
// The path under test (estimate-converter, post-customer-update):
//   a recurring accept whose estimate yields EMPTY family slices (no priced
//   recurring rows) makes applyAcceptToLedger return the no-slices sentinel
//   `{ scalar: null }`. The legacy scalar commits, and — under
//   GATE_PLAN_RATE_LEDGER — the converter must then reset the ledger to
//   match the committed scalar via syncScalarWriteToLedger(source:
//   'unsliced_accept'), or Σ(components) diverges from the scalar the
//   customer is actually billed.
//
// The r22 trap: `Number(null)` is 0. A guard that coerces the sentinel
// before null-checking it reads "no slices" as an AUTHORITATIVE ZERO —
// clearing monthly_rate over stale components AND skipping the
// unsliced_accept reset (its `ledgerAdvisoryScalar == null` arm goes dead).
// The discriminator in these tests is the ledger STORE: with the bug the
// stale components survive beside the new scalar; correct behavior
// reconciles the store to the committed figure. This suite runs the REAL
// converter + REAL plan-rate-ledger against a stateful fake knex (gate-on
// accept harness — this path previously had no direct test).

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(async () => {}),
  isNewRecurringSignupCandidate: jest.fn(async () => false),
}));

const featureGates = require('../config/feature-gates');
const EstimateConverter = require('../services/estimate-converter');
const { UNATTRIBUTED } = require('../services/plan-rate-ledger');

// Gate helper: ONLY the plan-rate-ledger gate flips; every other gate a
// loaded module consults stays off.
const gateOn = () => featureGates.isEnabled.mockImplementation((name) => name === 'planRateLedger');
const gateOff = () => featureGates.isEnabled.mockImplementation(() => false);

// ── stateful fake knex ──────────────────────────────────────────────────────
// Covers exactly the tables a skipAutoSchedule/skipSetupInvoice recurring
// accept touches: estimates, customers (first + update-returning),
// scheduled_services (classifier rows + reservation count), activity_log,
// and customer_plan_rates (the ledger store). Throws on anything else so a
// converter change that widens the surface fails loudly here.
function makeAcceptDb({
  estimate,
  customer,
  planRows = [],
  ledgerRows = [],
  updateReturnedRate = null,
  ledgerDelError = null,
}) {
  const ledgerStore = ledgerRows.map((r) => ({ ...r }));
  const customerUpdates = [];

  const nestedBuilder = () => {
    const b = {};
    ['where', 'orWhere', 'whereNull', 'whereNot', 'orWhereNot', 'whereIn', 'whereNotIn'].forEach((m) => {
      b[m] = (...args) => { if (typeof args[0] === 'function') args[0](nestedBuilder()); return b; };
    });
    return b;
  };

  const db = (table) => {
    if (table === 'estimates') {
      return { where: () => ({ first: async () => estimate }) };
    }
    if (table === 'customers') {
      const q = {
        where() { return q; },
        forUpdate() { return q; },
        async first() { return customer; },
        update(updates, returning) {
          customerUpdates.push(updates);
          if (Array.isArray(returning)) {
            return Promise.resolve([{ monthly_rate: updateReturnedRate }]);
          }
          return Promise.resolve(1);
        },
      };
      return q;
    }
    if (table === 'scheduled_services') {
      // Hybrid chain: the add-on classifier consumes it as a thenable
      // (leftJoin/select/where… → rows); the reservation probe ends in
      // .count().first() → { count: 0 }.
      const q = {};
      ['leftJoin', 'select', 'whereNotIn', 'whereNull', 'whereNotNull', 'count', 'orderBy'].forEach((m) => {
        q[m] = () => q;
      });
      q.where = (...args) => { if (typeof args[0] === 'function') args[0](nestedBuilder()); return q; };
      q.first = async () => ({ count: 0 });
      q.then = (resolve, reject) => Promise.resolve(planRows.map((r) => ({ ...r }))).then(resolve, reject);
      return q;
    }
    if (table === 'activity_log') {
      return { insert: async () => [1] };
    }
    if (table === 'customer_plan_rates') {
      const ctx = { filter: null };
      const q = {
        where(filter) { ctx.filter = filter; return q; },
        select() {
          return Promise.resolve(ledgerStore
            .filter((r) => r.customer_id === ctx.filter.customer_id)
            .map((r) => ({ family_key: r.family_key, monthly_rate: r.monthly_rate })));
        },
        insert(row) {
          return {
            onConflict() {
              return {
                merge(mergeFields) {
                  const existing = ledgerStore.find((r) => r.customer_id === row.customer_id
                    && r.family_key === row.family_key);
                  if (existing) Object.assign(existing, mergeFields);
                  else ledgerStore.push({ ...row });
                  return Promise.resolve();
                },
              };
            },
            then(resolve, reject) {
              ledgerStore.push({ ...row });
              return Promise.resolve().then(resolve, reject);
            },
          };
        },
        del() {
          if (ledgerDelError) return Promise.reject(ledgerDelError);
          const before = ledgerStore.length;
          for (let i = ledgerStore.length - 1; i >= 0; i -= 1) {
            const matches = ledgerStore[i].customer_id === ctx.filter.customer_id
              && (ctx.filter.family_key === undefined || ledgerStore[i].family_key === ctx.filter.family_key);
            if (matches) ledgerStore.splice(i, 1);
          }
          return Promise.resolve(before - ledgerStore.length);
        },
      };
      return q;
    }
    throw new Error(`unsliced-accept fake db: unexpected table ${table}`);
  };

  db.schema = {
    hasTable: async (name) => name === 'customer_plan_rates',
    hasColumn: async () => false, // pre-billing_mode update shape — simplest legacy path
  };
  db.transaction = async (fn) => fn(db);
  db.raw = (sql, bindings) => ({ __raw: sql, bindings });
  db.ledgerStore = ledgerStore;
  db.customerUpdates = customerUpdates;
  return db;
}

// ── fixtures ────────────────────────────────────────────────────────────────
// An accepted recurring estimate whose lines carry NO price provenance and
// whose monthly_total is empty: estimateFamilySlices yields {} (no families,
// no zero-comps — unpriced ≠ comped), which is exactly the unsliced_accept
// precondition. One-time totals stay empty so the accept is NOT suppressed
// (suppression requires one-time dollar evidence).
const unpricedEstimate = (services) => ({
  id: 'est-unsliced',
  status: 'accepted',
  customer_id: 'cust-1',
  monthly_total: null,
  annual_total: null,
  onetime_total: null,
  estimate_data: {
    // Frozen snapshot: no prior qualifying keys — keeps the tier lookup off
    // the live loadExistingQualifyingServiceKeys query surface.
    membershipSnapshot: { existingServiceKeys: [] },
    result: { recurring: { services } },
  },
});

const UNPRICED_PEST_LINE = {
  name: 'Quarterly Pest Control Service',
  service: 'pest_control',
  frequency: 'quarterly',
  selected: true,
  isSelected: true,
};
const UNPRICED_TS_LINE = {
  name: 'Bi-Monthly Tree & Shrub Care Service',
  service: 'tree_shrub',
  frequency: 'bi_monthly',
  selected: true,
  isSelected: true,
};
const LIVE_PEST_ROW = {
  service_type: 'Quarterly Pest Control Service',
  is_callback: false,
  catalog_service_key: null,
  catalog_service_name: null,
  source_estimate_id: null,
};

const CONVERT_OPTS_BASE = {
  skipAutoSchedule: true,
  skipSetupInvoice: true,
  skipMembershipEmail: true,
  skipWelcomeSms: true,
  autoSendInvoice: false,
  deferCommercialScheduleNotification: true,
};

afterEach(() => gateOff());

describe('unsliced authoritative accepts (codex #3245 r16 + r22)', () => {
  test('gate ON, same-family unpriced re-quote: null sentinel is NOT an authoritative zero — the unsliced_accept reset reconciles stale components to the committed scalar', async () => {
    gateOn();
    const db = makeAcceptDb({
      estimate: unpricedEstimate([UNPRICED_PEST_LINE]),
      customer: {
        id: 'cust-1', first_name: 'Pat', last_name: 'Customer',
        pipeline_stage: 'active_customer', monthly_rate: '95',
        member_since: '2025-01-01', waveguard_tier: 'Bronze',
      },
      planRows: [LIVE_PEST_ROW], // same family → replace classification, addOnBase 0
      ledgerRows: [
        { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
        { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 55 },
      ],
    });

    const result = await EstimateConverter.convertEstimate('est-unsliced', {
      ...CONVERT_OPTS_BASE, database: db,
    });

    // Legacy replace semantics committed the estimate's (empty) monthly — a
    // plain value, never a ledger-authority figure minted from Number(null).
    expect(result.monthlyRate).toBe(0);
    const rateUpdate = db.customerUpdates.find((u) => 'monthly_rate' in u);
    expect(rateUpdate.monthly_rate).toBe(0);

    // THE TRAP PIN: with the r22 bug (Number(null) → authoritative 0) the
    // unsliced_accept branch is dead-coded and the stale 40+55 components
    // survive beside a 0 scalar (Σ ≠ scalar). Correct behavior resets the
    // ledger to the committed scalar — zero clears it entirely.
    expect(db.ledgerStore).toHaveLength(0);
  });

  test('gate ON, disjoint unpriced add-on: the committed scalar (atomic increment RETURNING) is synced to a single unattributed component with source unsliced_accept', async () => {
    gateOn();
    const db = makeAcceptDb({
      estimate: unpricedEstimate([UNPRICED_TS_LINE]),
      customer: {
        id: 'cust-1', first_name: 'Pat', last_name: 'Customer',
        pipeline_stage: 'active_customer', monthly_rate: '60',
        member_since: '2025-01-01', waveguard_tier: 'Bronze',
      },
      planRows: [LIVE_PEST_ROW], // disjoint family → proven add-on, addOnBase 60
      ledgerRows: [
        { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
        { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 20 },
      ],
      updateReturnedRate: 60, // what the atomic COALESCE increment actually wrote
    });

    const result = await EstimateConverter.convertEstimate('est-unsliced', {
      ...CONVERT_OPTS_BASE, database: db,
    });

    // Add-on path: monthly_rate wrote via the atomic in-database increment
    // (raw COALESCE), and the RETURNING figure is the customer rate.
    const rateUpdate = db.customerUpdates.find((u) => 'monthly_rate' in u);
    expect(rateUpdate.monthly_rate.__raw).toContain('COALESCE(monthly_rate, 0) + ?');
    expect(result.monthlyRate).toBe(60);

    // The unsliced reset reconciled the ledger to that committed scalar:
    // one unattributed component, stamped with the unsliced_accept source.
    expect(db.ledgerStore).toHaveLength(1);
    expect(db.ledgerStore[0]).toMatchObject({
      customer_id: 'cust-1',
      family_key: UNATTRIBUTED,
      monthly_rate: 60,
      source: 'unsliced_accept',
    });
  });

  test('gate ON, ledger reset failure ABORTS the accept (syncScalarWriteToLedger throws under authority — no silent Σ≠scalar commit)', async () => {
    gateOn();
    const db = makeAcceptDb({
      estimate: unpricedEstimate([UNPRICED_PEST_LINE]),
      customer: {
        id: 'cust-1', first_name: 'Pat', last_name: 'Customer',
        pipeline_stage: 'active_customer', monthly_rate: '95',
        member_since: '2025-01-01', waveguard_tier: 'Bronze',
      },
      planRows: [LIVE_PEST_ROW],
      ledgerRows: [
        { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      ],
      ledgerDelError: new Error('ledger down'),
    });

    await expect(EstimateConverter.convertEstimate('est-unsliced', {
      ...CONVERT_OPTS_BASE, database: db,
    })).rejects.toThrow('ledger down');
  });

  test('gate OFF (dark): no unsliced reset fires — legacy scalar commits and the advisory ledger is left untouched', async () => {
    gateOff();
    const staleRows = [
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 55 },
    ];
    const db = makeAcceptDb({
      estimate: unpricedEstimate([UNPRICED_PEST_LINE]),
      customer: {
        id: 'cust-1', first_name: 'Pat', last_name: 'Customer',
        pipeline_stage: 'active_customer', monthly_rate: '95',
        member_since: '2025-01-01', waveguard_tier: 'Bronze',
      },
      planRows: [LIVE_PEST_ROW],
      ledgerRows: staleRows,
    });

    const result = await EstimateConverter.convertEstimate('est-unsliced', {
      ...CONVERT_OPTS_BASE, database: db,
    });

    expect(result.monthlyRate).toBe(0);
    // Kill-switch semantics: with the gate off nothing reads the components
    // and the empty-slices accept must not touch them.
    expect(db.ledgerStore).toEqual(staleRows);
  });
});
