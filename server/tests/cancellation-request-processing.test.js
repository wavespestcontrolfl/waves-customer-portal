// Unit tests for the cancellation auto-processor: pulling a customer's upcoming
// visits off the calendar, stopping recurrence, churning the account, and
// winding down billing.

jest.mock('../services/track-transitions', () => ({
  cancel: jest.fn().mockResolvedValue({ ok: true, state: 'cancelled' }),
}));

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Minimal stateful knex fake keyed by table name. Rows live on db.__tables so
// tests can seed and assert against them directly.
jest.mock('../models/db', () => {
  const tables = {};
  const matchesAll = (row, conds) => conds.every((c) => c(row));
  function makeQuery(table) {
    const rows = tables[table] || (tables[table] = []);
    const conds = [];
    const q = {
      where(criteria, val) {
        if (typeof criteria === 'string') conds.push((r) => r[criteria] === val);
        else Object.entries(criteria || {}).forEach(([k, v]) => conds.push((r) => r[k] === v));
        return q;
      },
      whereNot(col, val) { conds.push((r) => r[col] !== val); return q; },
      whereNull(col) { conds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { conds.push((r) => r[col] != null); return q; },
      whereNotIn(col, vals) { conds.push((r) => !vals.includes(r[col])); return q; },
      whereRaw(sql) {
        if (/track_state\s+IS\s+DISTINCT\s+FROM\s+'complete'/i.test(sql)) {
          conds.push((r) => r.track_state !== 'complete'); // JS !== treats null correctly
        }
        return q;
      },
      select() { return Promise.resolve(rows.filter((r) => matchesAll(r, conds))); },
      first() { return Promise.resolve(rows.find((r) => matchesAll(r, conds)) || null); },
      update(updates) {
        let n = 0;
        rows.forEach((r) => { if (matchesAll(r, conds)) { Object.assign(r, updates); n += 1; } });
        return Promise.resolve(n);
      },
      insert(payload) {
        (Array.isArray(payload) ? payload : [payload]).forEach((p) => rows.push({ ...p }));
        return Promise.resolve([1]);
      },
    };
    return q;
  }
  const db = (table) => makeQuery(table);
  db.__tables = tables;
  db.__reset = () => { Object.keys(tables).forEach((k) => delete tables[k]); };
  return db;
});

const db = require('../models/db');
const trackTransitions = require('../services/track-transitions');
const { processCancellationRequest, CHURN_REASON } = require('../services/cancellation-processor');

describe('processCancellationRequest', () => {
  beforeEach(() => {
    db.__reset();
    trackTransitions.cancel.mockClear();
  });

  test('pulls upcoming visits, stops recurrence, churns + winds down billing', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      { id: 's2', customer_id: 'c1', status: 'pending', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      { id: 's3', customer_id: 'c1', status: 'completed', track_state: 'complete', cancelled_at: null, recurring_ongoing: false },
      { id: 's4', customer_id: 'c1', status: 'cancelled', track_state: 'cancelled', cancelled_at: new Date(), recurring_ongoing: false },
      { id: 's5', customer_id: 'other', status: 'pending', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
    ];
    db.__tables.customers = [
      { id: 'c1', pipeline_stage: 'active_customer', active: true, autopay_enabled: true, next_charge_date: new Date() },
    ];
    db.__tables.payments = [
      { id: 'p1', customer_id: 'c1', status: 'failed', superseded_by_payment_id: null, next_retry_at: new Date() },
      { id: 'p2', customer_id: 'c1', status: 'paid', superseded_by_payment_id: null, next_retry_at: null },
      { id: 'p3', customer_id: 'other', status: 'failed', superseded_by_payment_id: null, next_retry_at: new Date() },
    ];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req1' });

    // Only the two non-terminal, not-yet-cancelled visits for c1 are pulled.
    expect(trackTransitions.cancel).toHaveBeenCalledTimes(2);
    expect(result.cancelledCount).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);

    const svc = (id) => db.__tables.scheduled_services.find((r) => r.id === id);
    expect(svc('s1').status).toBe('cancelled');
    expect(svc('s1').track_state).toBe('cancelled');
    expect(svc('s1').cancelled_at).toBeInstanceOf(Date);
    expect(svc('s3').status).toBe('completed'); // completed visit never touched

    // Recurrence stopped for this customer only.
    expect(svc('s1').recurring_ongoing).toBe(false);
    expect(svc('s2').recurring_ongoing).toBe(false);
    expect(svc('s5').recurring_ongoing).toBe(true);

    // Customer churned / inactive + billing wound down.
    const cust = db.__tables.customers[0];
    expect(cust.active).toBe(false);
    expect(cust.pipeline_stage).toBe('churned');
    expect(cust.autopay_enabled).toBe(false);
    expect(cust.next_charge_date).toBeNull();
    expect(cust.churned_at).toBeInstanceOf(Date);
    expect(cust.churn_reason).toBe(CHURN_REASON);
    expect(cust.churn_reason.length).toBeLessThanOrEqual(30);
    expect(result.churned).toBe(true);

    // Armed failed-payment retry disarmed — for this customer only.
    expect(db.__tables.payments.find((p) => p.id === 'p1').next_retry_at).toBeNull();
    expect(db.__tables.payments.find((p) => p.id === 'p3').next_retry_at).toBeInstanceOf(Date);

    // Audit note written once.
    expect(db.__tables.customer_interactions).toHaveLength(1);
    expect(db.__tables.customer_interactions[0].customer_id).toBe('c1');
  });

  test('does not force-cancel or overcount a genuinely-complete visit (inconsistent status)', async () => {
    db.__tables.scheduled_services = [
      // status not literally 'completed' but track_state IS complete — must be left alone.
      { id: 'sC', customer_id: 'c1', status: 'pending', track_state: 'complete', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req2' });

    const sC = db.__tables.scheduled_services[0];
    expect(sC.status).toBe('pending');       // not force-cancelled
    expect(sC.track_state).toBe('complete');
    expect(result.cancelledCount).toBe(0);   // not overcounted
    expect(result.ok).toBe(true);
  });

  test('already-churned account is re-inactivated but keeps its original churn date and writes no new note', async () => {
    const originalChurnedAt = new Date('2026-01-01T00:00:00Z');
    db.__tables.scheduled_services = [];
    db.__tables.payments = [];
    // pipeline is already churned but active was left true (the finding-2 case).
    db.__tables.customers = [
      { id: 'c1', pipeline_stage: 'churned', active: true, churned_at: originalChurnedAt, churn_reason: 'old', autopay_enabled: true },
    ];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req3' });

    const cust = db.__tables.customers[0];
    expect(cust.active).toBe(false);                  // finding 2: active flipped even when already churned
    expect(cust.autopay_enabled).toBe(false);
    expect(cust.churned_at).toBe(originalChurnedAt);  // original churn timestamp preserved
    expect(cust.churn_reason).toBe('old');            // original reason preserved
    expect(result.churned).toBe(true);
    expect(db.__tables.customer_interactions).toHaveLength(0); // no duplicate audit note
  });

  test('throws when customerId is missing', async () => {
    await expect(processCancellationRequest({})).rejects.toThrow(/customerId/);
  });
});
