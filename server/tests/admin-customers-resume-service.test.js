/**
 * POST /admin/customers/:id/resume-service — the missing un-pause.
 *
 * billing-cron sets customers.service_paused_at + service_pause_reason when
 * autopay's 3-retry ladder exhausts, and processMonthlyBilling then filters
 * on .whereNull('service_paused_at'). Migration 20260418000002 described an
 * admin action to unset it; that action was never built, so the pause was
 * permanent — dues stopped for good even after the customer paid, and the
 * only remedy was editing the row by hand.
 *
 * Contract:
 *   - clears BOTH columns, so the monthly cron picks the customer back up
 *   - idempotent: a second click (or one that loses a race) is a no-op, not
 *     a second audit row
 *   - writes an audit note carrying the original pause date and reason
 *   - 404s an unknown or soft-deleted customer
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Programmable per-test state.
const state = { customer: null, updates: [], interactions: [], updateMatches: 1 };

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = { _table: table, _where: {}, _notNull: [], _null: [] };
    q.where = (criteria) => { Object.assign(q._where, criteria); return q; };
    q.whereNull = (col) => { q._null.push(col); return q; };
    q.whereNotNull = (col) => { q._notNull.push(col); return q; };
    q.first = async () => {
      if (table !== 'customers') return null;
      if (!state.customer) return null;
      if (q._null.includes('deleted_at') && state.customer.deleted_at) return null;
      return state.customer;
    };
    q.update = async (patch) => {
      state.updates.push({ table, where: { ...q._where }, notNull: [...q._notNull], patch });
      return state.updateMatches;
    };
    q.insert = (row) => {
      state.interactions.push(row);
      const p = Promise.resolve([1]);
      // The route attaches .catch() to the insert promise.
      return p;
    };
    return q;
  });
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  db.raw = jest.fn((sql) => sql);
  return db;
});

const adminCustomersRoute = require('../routes/admin-customers');

// Invoke the handler directly (no supertest at the repo root): the admin-auth
// middleware is mocked above, so the handler only needs req.params/body and a
// res.json/res.status spy.
async function resumeService(id, body = {}) {
  const layer = adminCustomersRoute.stack.find(
    (l) => l.route?.path === '/:id/resume-service' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('POST /:id/resume-service is not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id }, body, technicianId: 'admin-1' };
  let payload = null;
  let status = 200;
  const res = {
    status: (code) => { status = code; return res; },
    json: (p) => { payload = p; return res; },
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { status, body: payload };
}

beforeEach(() => {
  state.customer = null;
  state.updates = [];
  state.interactions = [];
  state.updateMatches = 1;
});

const PAUSED = {
  id: 'cust-1',
  service_paused_at: '2026-05-02T12:00:00Z',
  service_pause_reason: 'autopay_final_failure',
};

describe('POST /admin/customers/:id/resume-service', () => {
  test('clears BOTH pause columns so the monthly cron picks the customer back up', async () => {
    state.customer = { ...PAUSED };

    const res = await resumeService('cust-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, resumed: true, pauseReason: 'autopay_final_failure' });
    const update = state.updates.find((u) => u.table === 'customers');
    expect(update).toBeTruthy();
    // Leaving service_pause_reason behind strands a stale reason on a
    // customer who is no longer paused.
    expect(update.patch).toEqual({ service_paused_at: null, service_pause_reason: null });
    // The guard that makes two concurrent clicks safe.
    expect(update.notNull).toContain('service_paused_at');
  });

  test('records an audit note carrying the original pause date and reason', async () => {
    state.customer = { ...PAUSED };

    await resumeService('cust-1', { notes: 'card updated by phone' });

    const note = state.interactions[0];
    expect(note).toBeTruthy();
    expect(note.subject).toBe('Billing resumed');
    expect(note.body).toContain('2026-05-02');
    expect(note.body).toContain('autopay_final_failure');
    // The no-back-billing promise is what makes this safe to click, so it
    // belongs in the record and not only in the UI.
    expect(note.body).toContain('no back-billing');
    expect(note.body).toContain('card updated by phone');
    expect(note.admin_user_id).toBe('admin-1');
  });

  test('is a no-op on a customer who is not paused — no update, no audit row', async () => {
    state.customer = { id: 'cust-1', service_paused_at: null, service_pause_reason: null };

    const res = await resumeService('cust-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, resumed: false, reason: 'not_paused' });
    expect(state.updates.filter((u) => u.table === 'customers')).toHaveLength(0);
    expect(state.interactions).toHaveLength(0);
  });

  test('a concurrent click that loses the race writes no second audit row', async () => {
    state.customer = { ...PAUSED };
    // Another request cleared the pause between our read and our write.
    state.updateMatches = 0;

    const res = await resumeService('cust-1');

    expect(res.body).toMatchObject({ resumed: false, reason: 'not_paused' });
    expect(state.interactions).toHaveLength(0);
  });

  test('404s an unknown customer', async () => {
    state.customer = null;
    const res = await resumeService('nope');
    expect(res.status).toBe(404);
  });

  test('404s a soft-deleted customer', async () => {
    state.customer = { ...PAUSED, deleted_at: '2026-01-01T00:00:00Z' };
    const res = await resumeService('cust-1');
    expect(res.status).toBe(404);
  });
});
