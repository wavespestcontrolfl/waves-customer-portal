'use strict';

// PR E: the processor's churn wind-down clears waveguard_tier /
// waveguard_tier_source / monthly_rate and resets the plan-rate ledger —
// but ONLY under GATE_CANCEL_FLOW_V2. Gate off = byte-identical to H0
// (tier residue stays; that leak is what the 2026-08-30 audit measured).

jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn() }));
jest.mock('../services/track-transitions', () => ({ cancel: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ handleCancellation: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }) }));
jest.mock('../services/churn-classifier', () => ({
  classifyChurnReason: jest.fn().mockResolvedValue({ code: 'unclassified', source: 'none' }),
}));
jest.mock('../services/invoice', () => ({
  voidOpenInvoicesForCancelledService: jest.fn().mockResolvedValue([]),
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'],
}));
jest.mock('../services/estimate-card-holds', () => ({
  handleCardHoldCancellation: jest.fn().mockResolvedValue({ handled: false, reason: 'no_hold' }),
}));
jest.mock('../services/appointment-card-request', () => ({
  handleAppointmentCardCancellation: jest.fn().mockResolvedValue({ handled: false, released: true, reason: 'no_card_request' }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockResetLedgerToScalar = jest.fn().mockResolvedValue(undefined);
let mockLedgerAuthoritative = true;
jest.mock('../services/plan-rate-ledger', () => ({
  resetLedgerToScalar: (...args) => mockResetLedgerToScalar(...args),
  planRateLedgerEnabled: () => mockLedgerAuthoritative,
}));

// Minimal stateful knex fake: enough for the churn block (customers update,
// payment_methods, payments, scheduled_services sweeps come back empty).
jest.mock('../models/db', () => {
  const tables = {};
  const matches = (row, conds) => conds.every((c) => c(row));
  function makeQuery(table) {
    const rows = tables[table] || (tables[table] = []);
    const conds = [];
    const q = {
      where(criteria, op, val) {
        if (typeof criteria === 'function') { criteria.call(q); return q; }
        if (typeof criteria === 'string') {
          conds.push(op !== undefined && val === undefined ? (r) => r[criteria] === op : (r) => r[criteria] === val || r[criteria] === op);
          return q;
        }
        Object.entries(criteria || {}).forEach(([k, v]) => conds.push((r) => r[k] === v));
        return q;
      },
      orWhere() { return q; },
      whereIn(col, vals) { conds.push((r) => vals.includes(r[col])); return q; },
      whereNull(col) { conds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { conds.push((r) => r[col] != null); return q; },
      whereNot(col, val) { conds.push((r) => r[col] !== val); return q; },
      del() { const keep = rows.filter((r) => !matches(r, conds)); const n = rows.length - keep.length; tables[table] = keep; return Promise.resolve(n); },
      whereRaw() { return q; },
      forUpdate() { return q; },
      select() { return Promise.resolve(rows.filter((r) => matches(r, conds))); },
      first(...cols) {
        const row = rows.find((r) => matches(r, conds)) || null;
        if (!row || !cols.length) return Promise.resolve(row);
        const out = {};
        for (const c of cols) out[c] = row[c];
        return Promise.resolve(out);
      },
      update(patch) {
        const hit = rows.filter((r) => matches(r, conds));
        hit.forEach((r) => Object.assign(r, patch));
        return Promise.resolve(hit.length);
      },
      insert(row) { rows.push({ ...row }); return Promise.resolve([row]); },
    };
    return q;
  }
  const db = (table) => makeQuery(table);
  db.transaction = async (fn) => {
    // Real rollback semantics: snapshot every table, restore on throw —
    // without this a fail-closed test would pass against writes that a real
    // Postgres transaction would have rolled back.
    const snapshot = JSON.parse(JSON.stringify(tables));
    const trx = (table) => makeQuery(table);
    trx.isTransaction = true;
    // Every statement the transaction issues, in order, so a test can assert
    // the rung-6 customer-comms lock is the FIRST thing it does.
    trx.raw = async (sql, bindings) => { db.__statements.push({ raw: sql, bindings }); };
    db.__statements.push({ begin: true });
    try {
      return await fn(trx);
    } catch (err) {
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, snapshot);
      throw err;
    }
  };
  db.__tables = tables;
  db.__statements = [];
  return db;
});

const db = require('../models/db');
const { processCancellationRequest, applyScopedWindDown } = require('../services/cancellation-processor');
const { lockCustomerComms } = require('../utils/customer-comms-lock');

function seedCustomer() {
  db.__tables.customers = [{
    id: 'cust-1',
    pipeline_stage: 'active_customer',
    active: true,
    monthly_rate: 140,
    waveguard_tier: 'Gold',
    waveguard_tier_source: 'auto',
    autopay_enabled: true,
    next_charge_date: '2026-09-01',
  }];
  db.__tables.payment_methods = [];
  db.__tables.payments = [];
  db.__tables.scheduled_services = [];
  db.__tables.job_status_history = [];
  db.__tables.customer_interactions = [];
  db.__tables.termite_stations = [];
}

afterEach(() => {
  delete process.env.GATE_CANCEL_FLOW_V2;
  mockResetLedgerToScalar.mockClear();
  mockLedgerAuthoritative = true;
});

test('gate ON: churn clears tier, tier source, and rate, and resets the plan-rate ledger to zero', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'too pricey', requestId: 'req-1' });
  expect(result.churned).toBe(true);
  const customer = db.__tables.customers[0];
  expect(customer.waveguard_tier).toBeNull();
  expect(customer.waveguard_tier_source).toBeNull();
  expect(customer.monthly_rate).toBeNull();
  expect(customer.churn_mrr).toBe(140); // snapshotted BEFORE the clear
  expect(customer.active).toBe(false);
  expect(mockResetLedgerToScalar).toHaveBeenCalledWith(expect.anything(), 'cust-1', 0, { source: 'cancellation' });
});

test('gate OFF: byte-identical to H0 — tier and rate residue stays', async () => {
  seedCustomer();
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'too pricey', requestId: 'req-1' });
  expect(result.churned).toBe(true);
  const customer = db.__tables.customers[0];
  expect(customer.waveguard_tier).toBe('Gold');
  expect(customer.monthly_rate).toBe(140);
  expect(customer.active).toBe(false);
  expect(mockResetLedgerToScalar).not.toHaveBeenCalled();
});

test('gate ON + ledger AUTHORITATIVE: a ledger failure FAILS CLOSED — churn errors, review alert', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockLedgerAuthoritative = true;
  mockResetLedgerToScalar.mockRejectedValueOnce(new Error('ledger down'));
  seedCustomer();
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'x', requestId: 'req-1' });
  // A surviving positive component would resurrect the old rate on win-back
  // — the whole churn write reports as an error instead of leaving it stale.
  expect(result.churned).toBe(false);
  expect(result.errors).toContain('churn');
  // The transaction rolled back AND the processor ABORTED: account still
  // active/billable, so no visit or series may have been touched.
  expect(result.ok).toBe(false);
  expect(result.cancelledCount).toBe(0);
  expect(result.recurrenceStopped).toBe(0);
  expect(db.__tables.customers[0].active).toBe(true);
  expect(db.__tables.customers[0].waveguard_tier).toBe('Gold');
});

test('gate ON + ledger ADVISORY: a ledger failure still FAILS CLOSED and aborts (codex r48 — stale rows become authoritative on a later gate flip)', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockLedgerAuthoritative = false;
  mockResetLedgerToScalar.mockRejectedValueOnce(new Error('ledger down'));
  seedCustomer();
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'x', requestId: 'req-1' });
  // The ledger clear is atomic with the wind-down regardless of the read
  // gate: everything rolls back, the run aborts before any sweep, and the
  // request is flagged for review — no half-wound account, no stale
  // components waiting to resurrect the rate when the gate flips on.
  expect(result.churned).toBe(false);
  expect(result.errors).toContain('churn');
  expect(result.cancelledCount).toBe(0);
  expect(db.__tables.customers[0].waveguard_tier).toBe('Gold');
  expect(db.__tables.customers[0].active).toBe(true);
});

test('a monthly component repriced mid-run aborts the wind-down — stale planned rates never overwrite a concurrent pricing change', async () => {
  db.__tables.invoices = [];
  db.__tables.customer_plan_rates = [
    // The plan said pest_control was 60 → 66, but a concurrent write moved it.
    { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 75 },
  ];
  const plan = {
    monthlyLane: true, perApplicationLane: false, inScope: ['lawn_care'], remaining: ['pest_control'],
    remainingRates: [{ family: 'pest_control', before: 60, after: 66 }],
    tierBefore: 'Silver', tierAfter: 'Bronze', scalarBefore: 150, scalarAfter: 66,
  };
  const tierBeforeRun = db.__tables.customers[0].waveguard_tier;
  await expect(applyScopedWindDown('cust-1', plan, { requestId: 'req-1' })).rejects.toThrow(/zero rows/);
  expect(db.__tables.customers[0].waveguard_tier).toBe(tierBeforeRun);
  expect(Number(db.__tables.customer_plan_rates[0].monthly_rate)).toBe(75);
  // Matching rate → the CAS lands and the wind-down completes.
  db.__tables.customer_plan_rates[0].monthly_rate = 60;
  await applyScopedWindDown('cust-1', plan, { requestId: 'req-1' });
  expect(Number(db.__tables.customer_plan_rates[0].monthly_rate)).toBe(66);
  expect(db.__tables.customers[0].waveguard_tier).toBe('Bronze');
});

test('a committed wind-down stamps scopedWindDownCommitted on the REQUEST row in the same transaction — the repair retry\'s proof', async () => {
  db.__tables.invoices = [];
  db.__tables.service_requests = [{ id: 'req-1', metadata: JSON.stringify({ cancel_plan: { scope: ['lawn_care'], waiveLateFee: true } }) }];
  seedCustomer();
  await applyScopedWindDown('c1', {
    ok: true, inScope: ['lawn_care'], remaining: ['pest_control'], tierBefore: 'Silver', tierAfter: 'Bronze',
    monthlyLane: false, perApplicationLane: true, remainingRates: [], perAppRows: [],
  }, { requestId: 'req-1', actorLabel: 'Admin' });
  const meta = JSON.parse(db.__tables.service_requests[0].metadata);
  // Existing accepted choices survive; the proof is added.
  expect(meta.cancel_plan).toEqual(expect.objectContaining({ scope: ['lawn_care'], waiveLateFee: true, scopedWindDownCommitted: true }));
  // A portal request (no cancel_plan metadata) gets the proof too.
  db.__tables.service_requests = [{ id: 'req-portal', metadata: null }];
  await applyScopedWindDown('c1', {
    ok: true, inScope: ['lawn_care'], remaining: ['pest_control'], tierBefore: 'Silver', tierAfter: 'Bronze',
    monthlyLane: false, perApplicationLane: true, remainingRates: [], perAppRows: [],
  }, { requestId: 'req-portal', actorLabel: 'Portal' });
  expect(JSON.parse(db.__tables.service_requests[0].metadata).cancel_plan.scopedWindDownCommitted).toBe(true);
});

test('a per-application reprice whose CAS lands on zero rows aborts the wind-down — tier demote rolls back, never a silently kept old price', async () => {
  db.__tables.invoices = [];
  // The live price drifted after the preview (plan said 90 → 96).
  db.__tables.scheduled_services = [{ id: 'v1', customer_id: 'cust-1', estimated_price: 95 }];
  const plan = {
    monthlyLane: false, perApplicationLane: true, inScope: ['lawn_care'], remaining: ['pest_control'],
    remainingRates: [], tierBefore: 'Silver', tierAfter: 'Bronze',
    perAppRows: [{ id: 'v1', family: 'pest_control', before: 90, after: 96 }],
  };
  const tierBeforeRun = db.__tables.customers[0].waveguard_tier;
  await expect(applyScopedWindDown('cust-1', plan, { requestId: 'req-1' })).rejects.toThrow(/zero rows/);
  // Rolled back wholesale: no demote claimed for a reprice that did not land.
  expect(db.__tables.customers[0].waveguard_tier).toBe(tierBeforeRun);
  expect(db.__tables.scheduled_services[0].estimated_price).toBe(95);
  // A CONCURRENT invoice is the one acceptable skip — the visit bills at
  // its already-fixed terms and the rest of the wind-down proceeds.
  db.__tables.invoices = [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'paid' }];
  await applyScopedWindDown('cust-1', plan, { requestId: 'req-1' });
  expect(db.__tables.customers[0].waveguard_tier).toBe('Bronze');
  expect(db.__tables.scheduled_services[0].estimated_price).toBe(95);
});

test('the wind-down transaction takes the rung-6 customer-comms lock as its FIRST statement — booking and ledger writers serialize on the same key', async () => {
  db.__tables.invoices = [];
  db.__tables.service_requests = [{ id: 'req-1', metadata: null }];
  seedCustomer();
  db.__statements.length = 0;
  await applyScopedWindDown('cust-1', {
    ok: true, inScope: ['lawn_care'], remaining: ['pest_control'], tierBefore: 'Silver', tierAfter: 'Bronze',
    monthlyLane: false, perApplicationLane: true, remainingRates: [], perAppRows: [],
  }, { requestId: 'req-1' });
  const [begin, first] = db.__statements;
  expect(begin).toEqual({ begin: true });
  expect(first).toEqual({ raw: expect.stringContaining('pg_advisory_xact_lock'), bindings: ['customer-comms:cust-1'] });
  // The key is the shared writer lock, byte for byte (utils/customer-comms-lock).
  const probe = []; await lockCustomerComms({ raw: async (sql, b) => probe.push({ raw: sql, bindings: b }) }, 'cust-1');
  expect(first).toEqual(probe[0]);
});

test('the churn wind-down transaction takes the rung-6 lock before rewriting the tier and ledger', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  db.__tables.scheduled_services = [];
  db.__statements.length = 0;
  await processCancellationRequest({ customerId: 'cust-1', reason: 'moving', actor: { type: 'portal' } });
  const firstRaw = db.__statements.find((s) => s.raw);
  expect(firstRaw).toEqual({ raw: expect.stringContaining('pg_advisory_xact_lock'), bindings: ['customer-comms:cust-1'] });
  expect(db.__tables.customers[0].waveguard_tier).toBeNull();
});

test('the churn EPISODE is minted on the first churn (no stamp on the row) and returned to the caller', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'moving', requestId: 'req-1' });
  expect(result.churned).toBe(true);
  const customer = db.__tables.customers[0];
  expect(customer.churn_episode_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.churnEpisodeId).toBe(customer.churn_episode_id);
});

test('a repeat run on a still-churned row REUSES the stamped episode — never re-minted', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  Object.assign(db.__tables.customers[0], { pipeline_stage: 'churned', active: false, churned_at: '2026-08-01', churn_episode_id: 'ep-first' });
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'moving', requestId: 'req-2' });
  expect(result.churned).toBe(true);
  expect(db.__tables.customers[0].churn_episode_id).toBe('ep-first');
  expect(result.churnEpisodeId).toBe('ep-first');
});

test('a LIVE row still carrying a stale episode (a promotion that never cleared the stamp) churns under a FRESH episode', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  Object.assign(db.__tables.customers[0], { pipeline_stage: 'active_customer', active: true, churned_at: null, churn_episode_id: 'ep-stale' });
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'moving', requestId: 'req-3' });
  expect(result.churned).toBe(true);
  const c = db.__tables.customers[0];
  expect(c.churn_episode_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(c.churn_episode_id).not.toBe('ep-stale');
  expect(result.churnEpisodeId).toBe(c.churn_episode_id);
});

test('the episode is chosen from the row AS LOCKED — a stamp that landed between the entry read and the lock is reused, never overwritten', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  // A concurrent cancel committed its episode after this run's entry read.
  const orig = db.transaction;
  db.transaction = async (fn) => { Object.assign(db.__tables.customers[0], { pipeline_stage: 'churned', active: false, churn_episode_id: 'ep-race' }); return orig(fn); };
  try {
    const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'moving', requestId: 'req-3' });
    expect(result.churned).toBe(true);
    expect(db.__tables.customers[0].churn_episode_id).toBe('ep-race');
    expect(result.churnEpisodeId).toBe('ep-race');
    // Lock order inside the wind-down: rung 6, then the customers row.
    const raws = db.__statements.filter((s) => s.raw).map((s) => s.bindings && s.bindings[0]);
    expect(raws[0]).toBe('customer-comms:cust-1');
  } finally {
    db.transaction = orig;
  }
});

test('gate OFF: the episode is still minted under the customers row lock', async () => {
  seedCustomer();
  const orig = db.transaction;
  db.transaction = async (fn) => { Object.assign(db.__tables.customers[0], { pipeline_stage: 'churned', active: false, churn_episode_id: 'ep-race-legacy' }); return orig(fn); };
  try {
    const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'moving', requestId: 'req-4' });
    expect(result.churned).toBe(true);
    expect(db.__tables.customers[0].churn_episode_id).toBe('ep-race-legacy');
    expect(result.churnEpisodeId).toBe('ep-race-legacy');
    // H0 residue untouched: tier and rate stay (byte-identical wind-down).
    expect(db.__tables.customers[0].waveguard_tier).toBe('Gold');
  } finally {
    db.transaction = orig;
  }
});

test('churn facts follow the row AS LOCKED: a concurrent churn that landed after the entry read is a REPEAT churn (stamps preserved)', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  const orig = db.transaction;
  db.transaction = async (fn) => {
    Object.assign(db.__tables.customers[0], { pipeline_stage: 'churned', active: false, churned_at: '2026-08-01', churn_reason: 'moved', churn_mrr: 140, churn_episode_id: 'ep-first' });
    return orig(fn);
  };
  try {
    const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'too pricey', requestId: 'req-5' });
    expect(result.churned).toBe(true);
    const c = db.__tables.customers[0];
    expect(c.churned_at).toBe('2026-08-01');
    expect(c.churn_reason).toBe('moved');
    expect(c.churn_episode_id).toBe('ep-first');
    expect(result.churnEpisodeId).toBe('ep-first');
  } finally { db.transaction = orig; }
});

test('churn facts follow the row AS LOCKED: a reactivation that landed after the entry read makes this a FRESH churn (new stamps, new episode)', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  seedCustomer();
  Object.assign(db.__tables.customers[0], { pipeline_stage: 'churned', active: false, churned_at: '2026-08-01', churn_episode_id: 'ep-old' });
  const orig = db.transaction;
  let reactivated = false;
  db.transaction = async (fn) => {
    if (!reactivated) {
      reactivated = true;
      Object.assign(db.__tables.customers[0], { pipeline_stage: 'active_customer', active: true, churned_at: null, churn_reason: null, churn_episode_id: null });
    }
    return orig(fn);
  };
  try {
    const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'too pricey', requestId: 'req-6' });
    expect(result.churned).toBe(true);
    const c = db.__tables.customers[0];
    expect(c.churned_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.churn_episode_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.churn_episode_id).not.toBe('ep-old');
    expect(result.churnEpisodeId).toBe(c.churn_episode_id);
  } finally { db.transaction = orig; }
});
