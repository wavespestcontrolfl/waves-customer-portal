// Unit tests for the cancellation auto-processor: pulling a customer's upcoming
// visits off the calendar, stopping recurrence, and churning the account.

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
      whereNotIn(col, vals) { conds.push((r) => !vals.includes(r[col])); return q; },
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

  test('pulls upcoming visits, stops recurrence, and churns the customer', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', cancelled_at: null, recurring_ongoing: true },
      { id: 's2', customer_id: 'c1', status: 'pending', cancelled_at: null, recurring_ongoing: true },
      { id: 's3', customer_id: 'c1', status: 'completed', cancelled_at: null, recurring_ongoing: false },
      { id: 's4', customer_id: 'c1', status: 'cancelled', cancelled_at: new Date(), recurring_ongoing: false },
      { id: 's5', customer_id: 'other', status: 'pending', cancelled_at: null, recurring_ongoing: true },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req1' });

    // Only the two non-terminal, not-yet-cancelled visits for c1 are pulled.
    expect(trackTransitions.cancel).toHaveBeenCalledTimes(2);
    expect(trackTransitions.cancel).toHaveBeenCalledWith('s1', expect.any(Object));
    expect(trackTransitions.cancel).toHaveBeenCalledWith('s2', expect.any(Object));
    expect(result.cancelledCount).toBe(2);

    const svc = (id) => db.__tables.scheduled_services.find((r) => r.id === id);
    expect(svc('s1').status).toBe('cancelled');
    expect(svc('s1').track_state).toBe('cancelled');
    expect(svc('s1').cancelled_at).toBeInstanceOf(Date);

    // A completed visit is never touched.
    expect(svc('s3').status).toBe('completed');

    // Recurrence stopped for this customer only.
    expect(svc('s1').recurring_ongoing).toBe(false);
    expect(svc('s2').recurring_ongoing).toBe(false);
    expect(svc('s5').recurring_ongoing).toBe(true);

    // Customer churned / inactive.
    const cust = db.__tables.customers[0];
    expect(cust.active).toBe(false);
    expect(cust.pipeline_stage).toBe('churned');
    expect(cust.churned_at).toBeInstanceOf(Date);
    expect(cust.churn_reason).toBe(CHURN_REASON);
    expect(cust.churn_reason.length).toBeLessThanOrEqual(30);
    expect(result.churned).toBe(true);

    // Audit note written to the customer timeline.
    expect(db.__tables.customer_interactions).toHaveLength(1);
    expect(db.__tables.customer_interactions[0].customer_id).toBe('c1');
  });

  test('is idempotent: already-churned customer with no open visits is a no-op', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'cancelled', cancelled_at: new Date(), recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'churned', active: false }];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req2' });

    expect(trackTransitions.cancel).not.toHaveBeenCalled();
    expect(result.cancelledCount).toBe(0);
    expect(result.churned).toBe(false);
    expect(db.__tables.customer_interactions).toHaveLength(0);
  });

  test('throws when customerId is missing', async () => {
    await expect(processCancellationRequest({})).rejects.toThrow(/customerId/);
  });
});
