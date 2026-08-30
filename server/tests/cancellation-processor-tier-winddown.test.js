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
jest.mock('../services/plan-rate-ledger', () => ({
  resetLedgerToScalar: (...args) => mockResetLedgerToScalar(...args),
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
      whereRaw() { return q; },
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
    const trx = (table) => makeQuery(table);
    trx.isTransaction = true;
    trx.raw = async () => {};
    return fn(trx);
  };
  db.__tables = tables;
  return db;
});

const db = require('../models/db');
const { processCancellationRequest } = require('../services/cancellation-processor');

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

test('gate ON: a ledger failure FAILS CLOSED — churn errors, request flagged for review', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockResetLedgerToScalar.mockRejectedValueOnce(new Error('ledger down'));
  seedCustomer();
  const result = await processCancellationRequest({ customerId: 'cust-1', reason: 'x', requestId: 'req-1' });
  // With GATE_PLAN_RATE_LEDGER authoritative, a surviving positive component
  // would resurrect the old rate on win-back — so the whole churn write
  // reports as an error (→ partial-processing review alert) instead of
  // silently leaving the ledger stale.
  expect(result.churned).toBe(false);
  expect(result.errors).toContain('churn');
});
