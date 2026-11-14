/**
 * The office's "Skip this visit" (owner decision 2026-11-13) on the dispatch status route:
 * PUT /api/admin/dispatch/:serviceId/status { status: 'skipped' }.
 *
 * Before this change the route took 'skipped' from any caller for any visit: a technician could drop a plan visit
 * with no make-up, and a visit with an invoice or a card on it went to `skipped` with none of the cancel
 * follow-through. Now it is the office only, only an open plan visit with no money, card or linked visit on it
 * (services/visit-skip.js, judged before the transaction and again under the row lock), and it sends no customer
 * text and books no make-up visit.
 *
 * The real rule runs here against the route; only its money and card classifier is mocked
 * (appointment-cancel-impact.test.js covers that). visit-skip.test.js pins the rule's full matrix.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const actor = { role: 'admin' };
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: actor.role };
      req.technicianId = 'staff-1';
      req.techRole = actor.role;
      return next();
    },
  };
});
const mockTransitionJobStatus = jest.fn();
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});
const mockImpact = jest.fn();
jest.mock('../services/appointment-cancel-impact', () => ({
  ...jest.requireActual('../services/appointment-cancel-impact'),
  computeCancelAppointmentImpact: (...a) => mockImpact(...a),
}));
const mockNotifyVisitCancelled = jest.fn();
jest.mock('../services/tech-visit-notifications', () => ({
  ...jest.requireActual('../services/tech-visit-notifications'),
  notifyVisitCancelled: (...a) => mockNotifyVisitCancelled(...a),
}));
// What a CANCEL of the same visit runs and a skip must not: the make-up visit, and the cancellation notice.
const mockReseed = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/recurring-series-cancel-reseed', () => ({
  ...jest.requireActual('../services/recurring-series-cancel-reseed'),
  runPostCancelSeriesReseed: (...a) => mockReseed(...a),
}));
const mockHandleCancellation = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/appointment-reminders', () => ({ handleCancellation: (...a) => mockHandleCancellation(...a) }));
const mockRunFollowThrough = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/visit-cancellation-followthrough', () => ({ runVisitCancellationFollowThrough: (...a) => mockRunFollowThrough(...a) }));

// scheduled_services in memory, behind a knex-shaped builder that honours the equality filters the route and the rule
// write. `beforeTransaction` models a change that lands between the route's first read and its write transaction.
jest.mock('../models/db', () => {
  const state = { rows: [], writes: [], beforeTransaction: null, transactions: 0 };
  const norm = (column) => String(column).replace(/^scheduled_services\./, '');
  const builder = (table, tag) => {
    const filters = [];
    const b = {
      where(column, value) {
        if (column && typeof column === 'object') filters.push((row) => Object.entries(column).every(([key, val]) => row[norm(key)] === val));
        else filters.push((row) => row[norm(column)] === value);
        return b;
      },
      leftJoin() { return b; },
      forUpdate() { return b; },
      select() { return b; },
      rows() { return (table === 'scheduled_services' ? state.rows : []).filter((row) => filters.every((match) => match(row))); },
      async first() { const [row] = b.rows(); return row ? { ...row } : undefined; },
      async update(changes) { state.writes.push({ table, op: 'update', via: tag, changes }); b.rows().forEach((row) => Object.assign(row, changes)); return 1; },
      async insert(row) { state.writes.push({ table, op: 'insert', via: tag, row }); return [1]; },
    };
    return b;
  };
  const dbFn = (table) => builder(table, 'pool');
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (callback) => {
    state.transactions += 1;
    if (state.beforeTransaction) state.beforeTransaction(state.rows);
    const trx = (table) => builder(table, 'trx');
    trx.isTrx = true;
    trx.raw = async () => ({});
    trx.fn = dbFn.fn;
    return callback(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');
const { _private: { MESSAGES } } = require('../services/visit-skip');

let server;
let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((done) => server.close(done)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/admin/dispatch/${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const skip = (id = 'visit-2', body = {}) => call('PUT', `${id}/status`, { status: 'skipped', ...body });

// A quarterly pest plan far in the future: visit-1 done, visit-2 the one the office skips, visit-3 after it.
const planVisit = (over = {}) => ({
  id: 'visit-2', customer_id: 'customer-1', technician_id: 'tech-9', status: 'pending', track_state: 'scheduled',
  scheduled_date: '2040-03-20', window_start: '13:00', window_end: '15:00', service_type: 'Pest Control',
  is_recurring: true, recurring_parent_id: 'visit-1', recurring_pattern: 'quarterly', is_callback: false,
  followup_included: false, source_action: null, customer_confirmed: true, ...over,
});
const seed = (over = {}) => {
  db.__state.rows = [
    planVisit({ id: 'visit-1', recurring_parent_id: null, status: 'completed', scheduled_date: '2039-12-20' }),
    planVisit(over),
    planVisit({ id: 'visit-3', scheduled_date: '2040-06-20' }),
  ];
};
const visit = (id = 'visit-2') => db.__state.rows.find((row) => row.id === id);

beforeEach(() => {
  actor.role = 'admin';
  for (const mock of [mockTransitionJobStatus, mockImpact, mockNotifyVisitCancelled, mockReseed, mockHandleCancellation, mockRunFollowThrough]) mock.mockReset();
  mockTransitionJobStatus.mockResolvedValue({ ok: true, adminPayload: null });
  mockImpact.mockResolvedValue({ card_cancel_refusals: ['plan_makeup_visit'] });
  Object.assign(db.__state, { writes: [], beforeTransaction: null, transactions: 0 });
  seed();
});

describe('PUT /:serviceId/status { status: "skipped" }', () => {
  test('the office skips an open plan visit: one transition to skipped, the note kept, nothing a cancel would run', async () => {
    const { status, body } = await skip('visit-2', { notes: 'Skipped from appointment sidebar\nNote: away until April' });
    expect([status, body]).toEqual([200, { success: true }]);
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
    const [transition] = mockTransitionJobStatus.mock.calls[0];
    expect(transition).toMatchObject({
      jobId: 'visit-2', fromStatus: 'pending', toStatus: 'skipped', transitionedBy: 'staff-1',
      notes: 'Skipped from appointment sidebar\nNote: away until April',
    });
    // The rule judged the visit twice for this staff member: before the transaction (PaymentIntent lookups fill the
    // cache), then inside the transition's own transaction from that cache alone (no Stripe call under the row lock).
    expect(transition.trx.isTrx).toBe(true);
    const [[, before], [, underLock]] = mockImpact.mock.calls;
    expect(mockImpact.mock.calls.map(([id]) => id)).toEqual(['visit-2', 'visit-2']);
    expect(before).toEqual({ conn: db, actorId: 'staff-1', piCache: expect.any(Map), piCacheOnly: false });
    expect(underLock).toEqual({ conn: transition.trx, actorId: 'staff-1', piCache: before.piCache, piCacheOnly: true });
    // A skip is not a cancel: no make-up visit, no cancellation notice or text, no cancel follow-through.
    expect(mockReseed).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
    // The route's only writes: the audit line for the status change.
    expect(db.__state.writes.map((write) => [write.table, write.op])).toEqual([['activity_log', 'insert']]);
  });

  test('the assigned technician is told the stop left the route, as for a cancel', async () => {
    await skip();
    expect(mockNotifyVisitCancelled).toHaveBeenCalledTimes(1);
    expect(mockNotifyVisitCancelled).toHaveBeenCalledWith({
      visitId: 'visit-2', technicianId: 'tech-9', actorId: 'staff-1',
      snapshot: { date: '2040-03-20', windowStart: '13:00', windowEnd: '15:00' }, previousStatus: 'pending',
    });
  });

  test('the technician named is the one on the COMMITTED row, not the one the route first read', async () => {
    mockTransitionJobStatus.mockResolvedValue({ ok: true, adminPayload: { tech_id: 'tech-B', scheduled_date: '2040-03-21', window_start: '08:00', window_end: '10:00' } });
    await skip();
    expect(mockNotifyVisitCancelled).toHaveBeenCalledWith(expect.objectContaining({
      technicianId: 'tech-B', snapshot: { date: '2040-03-21', windowStart: '08:00', windowEnd: '10:00' },
    }));
  });

  test('a visit with no technician sends no notice', async () => {
    seed({ technician_id: null });
    expect((await skip()).status).toBe(200);
    expect(mockNotifyVisitCancelled).not.toHaveBeenCalled();
  });

  test('a technician cannot skip a visit, even their own', async () => {
    actor.role = 'technician';
    seed({ technician_id: 'staff-1' });
    const { status, body } = await skip();
    expect([status, body]).toEqual([403, { error: 'Admin access required for this action', code: 'admin_required' }]);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(db.__state.transactions).toBe(0);
    expect(db.__state.writes).toEqual([]);
  });

  test.each([
    ['a visit that is paid for already', { refusals: ['plan_makeup_visit', 'prepaid_coverage'] }, 'skip_prepaid', MESSAGES.prepaid],
    ['a visit with an invoice on it', { refusals: ['invoice_linked'] }, 'skip_has_money_or_links', MESSAGES.has_money_or_links],
    ['a visit with a card on it', { refusals: ['card_rail_present'] }, 'skip_has_money_or_links', MESSAGES.has_money_or_links],
    ['a one-time visit', { row: { is_recurring: false, recurring_parent_id: null } }, 'skip_not_plan_visit', MESSAGES.not_plan_visit],
    ['a visit the technician is driving to', { row: { status: 'confirmed', track_state: 'en_route' } }, 'skip_not_live', MESSAGES.not_live],
  ])('%s is refused with 409 and a sentence for the office; nothing is written', async (_label, { refusals, row }, code, message) => {
    if (refusals) mockImpact.mockResolvedValue({ card_cancel_refusals: refusals });
    if (row) seed(row);
    const { status, body } = await skip();
    expect([status, body]).toEqual([409, { error: message, code }]);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockNotifyVisitCancelled).not.toHaveBeenCalled();
    // Refused before the transaction: no row lock was taken for it.
    expect(db.__state.transactions).toBe(0);
    expect(db.__state.writes).toEqual([]);
    expect(visit().status).toBe(row?.status || 'pending');
  });

  test('the visit is judged again under the row lock: one that became a booster since the first check is refused', async () => {
    db.__state.beforeTransaction = (rows) => { Object.assign(rows.find((row) => row.id === 'visit-2'), { is_recurring: false }); };
    const { status, body } = await skip();
    expect([status, body]).toEqual([409, { error: MESSAGES.not_plan_visit, code: 'skip_not_plan_visit' }]);
    expect(db.__state.transactions).toBe(1);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  test('an invoice that lands between the two checks refuses the skip under the lock', async () => {
    mockImpact.mockResolvedValueOnce({ card_cancel_refusals: [] }).mockResolvedValueOnce({ card_cancel_refusals: ['invoice_linked'] });
    const { status, body } = await skip();
    expect([status, body]).toEqual([409, { error: MESSAGES.has_money_or_links, code: 'skip_has_money_or_links' }]);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockNotifyVisitCancelled).not.toHaveBeenCalled();
  });

  test.each([
    ['before the transaction', (failure) => mockImpact.mockRejectedValue(failure), 0],
    ['under the row lock', (failure) => mockImpact.mockResolvedValueOnce({ card_cancel_refusals: [] }).mockRejectedValueOnce(failure), 1],
  ])('a failed read of the money and card state %s fails the skip; it never goes through unjudged', async (_when, arrange, transactions) => {
    arrange(new Error('invoices read failed'));
    const { status } = await skip();
    expect(status).toBe(500);
    expect(db.__state.transactions).toBe(transactions);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(db.__state.writes).toEqual([]);
  });

  test('a resend on a visit that is already skipped succeeds without a second judgment or a second notice', async () => {
    seed({ status: 'skipped' });
    mockImpact.mockResolvedValue({ card_cancel_refusals: ['invoice_linked'] });
    const { status, body } = await skip();
    expect([status, body]).toEqual([200, { success: true }]);
    expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({ jobId: 'visit-2', fromStatus: 'skipped', toStatus: 'skipped' });
    expect(mockImpact).not.toHaveBeenCalled();
    expect(mockNotifyVisitCancelled).not.toHaveBeenCalled();
  });

  test.each(['cancelled', 'completed', 'no_show'])('a visit that is already %s cannot be skipped', async (current) => {
    seed({ status: current });
    const { status } = await skip();
    expect(status).toBe(409);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  test('a single-visit cancel of the same visit still books its make-up visit: the skip changed nothing there', async () => {
    const { status } = await call('PUT', 'visit-2/status', { status: 'cancelled', notifyCustomer: false });
    expect(status).toBe(200);
    expect(mockReseed).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'visit-2', source: 'admin-dispatch-status-cancel' }));
    // The skip rule is not consulted for a cancel.
    expect(mockImpact).not.toHaveBeenCalled();
  });
});
