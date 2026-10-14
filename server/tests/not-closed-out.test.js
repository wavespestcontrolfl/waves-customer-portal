/**
 * The "visit not closed out" worklist (services/not-closed-out.js, owner 2026-10-03).
 *
 * Behaviour proven here: a flagged visit gets ONE card (gate on only); completing,
 * cancelling or rebooking the visit settles its flagged rows and closes the card;
 * "This was a miss" confirms without settling; "Not a miss" settles as dismissed;
 * and a failure in any of it never reaches the caller. Synthetic data.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({ isEnabled: (name) => name === 'notClosedOutQueue' && mockGateOn }));

const mockCreateAlertOnce = jest.fn(async () => ({ created: true, row: { id: 'alert-new' } }));
const mockResolveAlert = jest.fn(async ({ id }) => ({ id }));
jest.mock('../services/dispatch-alerts', () => ({
  createAlertOnce: (...a) => mockCreateAlertOnce(...a),
  resolveAlert: (...a) => mockResolveAlert(...a),
}));

const mockEvaluateThreshold = jest.fn(async () => null);
const mockWithdrawOutreach = jest.fn(async () => ({ withdrawn: 0 }));
jest.mock('../services/workflows/missed-appointment', () => ({
  evaluateThreshold: (...a) => mockEvaluateThreshold(...a),
  withdrawOutreachIfBelowThreshold: (...a) => mockWithdrawOutreach(...a),
}));

// A tiny in-memory knex: tables are arrays of rows; where/whereNull filter them;
// update/first/select act on the filtered set. transaction(fn) runs fn on itself.
const mockTables = { reschedule_log: [], dispatch_alerts: [], scheduled_services: [] };
let mockFailTransaction = false;
const mockLocks = [];
function mockTable(name) {
  let rows = mockTables[name] || [];
  const q = {
    where(cond) { if (typeof cond !== 'string') rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
    whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
    whereIn(col, vals) { rows = rows.filter((r) => vals.includes(String(r[col]))); return q; },
    orderBy() { return q; },
    forUpdate() { mockLocks.push(name); return q; },
    async update(patch) {
      for (const r of rows) for (const [k, v] of Object.entries(patch)) r[k] = v && v.__raw ? `raw:${v.__raw}` : v;
      return rows.length;
    },
    async first(...cols) { const r = rows[0]; return r ? (cols.length ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r) : undefined; },
    async select(...cols) { return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))); },
  };
  return q;
}
function mockMakeConn() {
  const conn = (name) => mockTable(name);
  conn.fn = { now: () => 'NOW' };
  conn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  conn.transaction = async (fn) => {
    if (mockFailTransaction) throw new Error('db down');
    return fn(mockMakeConn());
  };
  return conn;
}
jest.mock('../models/db', () => mockMakeConn());

const notClosedOut = require('../services/not-closed-out');

const STAFF = '11111111-1111-4111-8111-111111111111';
const logRow = (over = {}) => ({
  id: 'log-1', scheduled_service_id: 'visit-1', reason_code: 'customer_noshow',
  resolved_at: null, resolution: null, resolved_by: null, miss_confirmed_at: null, miss_confirmed_by: null, notes: 'no_show', ...over,
});
const card = (over = {}) => ({ id: 'alert-1', type: 'visit_not_closed_out', job_id: 'visit-1', resolved_at: null, payload: { log_id: 'log-1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' }, ...over });
const service = { id: 'visit-1', technician_id: 'tech-1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' };

beforeEach(() => {
  mockGateOn = true;
  mockFailTransaction = false;
  mockLocks.length = 0;
  mockCreateAlertOnce.mockClear();
  mockResolveAlert.mockClear();
  mockEvaluateThreshold.mockClear();
  mockWithdrawOutreach.mockClear();
  mockTables.reschedule_log = [logRow()];
  mockTables.dispatch_alerts = [card()];
  mockTables.scheduled_services = [{ ...service }];
});

describe('raiseCard', () => {
  test('raises ONE deduped card for the flagged visit, naming the flagged slot', async () => {
    const out = await notClosedOut.raiseCard({ logId: 'log-1', service });
    expect(out).toEqual({ raised: true });
    expect(mockCreateAlertOnce).toHaveBeenCalledWith(expect.objectContaining({
      type: 'visit_not_closed_out', severity: 'warn', jobId: 'visit-1', techId: 'tech-1', existingPayloadSource: 'missed_appointment_check',
      payload: { source: 'missed_appointment_check', log_id: 'log-1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control', miss_confirmed: false },
    }));
  });

  test('inside a caller\'s transaction the card is raised in a savepoint, so a failure cannot poison it', async () => {
    const sp = { savepoint: true };
    const trx = { transaction: jest.fn(async (fn) => fn(sp)) };
    expect(await notClosedOut.raiseCard({ logId: 'log-1', service, trx })).toEqual({ raised: true });
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(mockCreateAlertOnce.mock.calls[0][0].trx).toBe(sp);
    trx.transaction.mockRejectedValueOnce(new Error('savepoint failed'));
    expect(await notClosedOut.raiseCard({ logId: 'log-1', service, trx })).toEqual({ raised: false });
  });

  test('a person-marked no-show is a confirmed miss from the start', async () => {
    await notClosedOut.raiseCard({ logId: 'log-1', service, confirmed: true });
    expect(mockCreateAlertOnce.mock.calls[0][0].payload.miss_confirmed).toBe(true);
  });

  test('gate off: no card; a failing alert writer never throws', async () => {
    mockGateOn = false;
    expect(await notClosedOut.raiseCard({ logId: 'log-1', service })).toEqual({ raised: false });
    expect(mockCreateAlertOnce).not.toHaveBeenCalled();
    mockGateOn = true;
    mockCreateAlertOnce.mockRejectedValueOnce(new Error('boom'));
    expect(await notClosedOut.raiseCard({ logId: 'log-1', service })).toEqual({ raised: false });
  });
});

describe('a visit that moves on settles its flagged rows', () => {
  test.each([['completed', 'completed'], ['cancelled', 'dismissed'], ['skipped', 'dismissed']])('status %s settles as %s and closes the card', async (toStatus, resolution) => {
    const out = await notClosedOut.resolveOnTransition({ jobId: 'visit-1', toStatus, resolvedBy: STAFF });
    expect(out).toEqual({ resolved: 1 });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolved_at: 'NOW', resolution, resolved_by: STAFF });
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1', resolvedBy: STAFF, auto: true }));
  });

  test.each(['no_show', 'en_route', 'on_site', 'confirmed', 'pending'])('status %s settles nothing (a marked no-show still needs rebooking)', async (toStatus) => {
    expect(await notClosedOut.resolveOnTransition({ jobId: 'visit-1', toStatus })).toEqual({ resolved: 0 });
    expect(mockTables.reschedule_log[0].resolved_at).toBeNull();
    expect(mockResolveAlert).not.toHaveBeenCalled();
  });

  test('a rebooker move settles as rebooked; a non-staff label stays on the log row only', async () => {
    await notClosedOut.resolveForService({ serviceId: 'visit-1', resolution: 'rebooked', resolvedBy: 'admin' });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolution: 'rebooked', resolved_by: 'admin' });
    // dispatch_alerts.resolved_by is a staff uuid: a label is never written there
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1', resolvedBy: null }));
  });

  test('already-settled rows and other reasons are left alone; an unknown resolution does nothing', async () => {
    mockTables.reschedule_log = [logRow({ resolved_at: 'EARLIER', resolution: 'dismissed' }), logRow({ id: 'log-2', reason_code: 'weather_rain' })];
    expect(await notClosedOut.resolveForService({ serviceId: 'visit-1', resolution: 'completed' })).toEqual({ resolved: 0 });
    expect(mockTables.reschedule_log[0].resolution).toBe('dismissed');
    expect(mockTables.reschedule_log[1].resolved_at).toBeNull();
    expect(await notClosedOut.resolveForService({ serviceId: 'visit-1', resolution: 'backlog' })).toEqual({ resolved: 0 });
  });

  test('a failure here never reaches the status change or the move', async () => {
    mockFailTransaction = true;
    await expect(notClosedOut.resolveOnTransition({ jobId: 'visit-1', toStatus: 'completed' })).resolves.toEqual({ resolved: 0 });
    await expect(notClosedOut.resolveForService({ serviceId: 'visit-1', resolution: 'rebooked' })).resolves.toEqual({ resolved: 0 });
  });
});

describe('the dispatcher\'s two decisions', () => {
  test('"This was a miss" confirms without settling, and replaces the card with a confirmed one for the same flagged slot', async () => {
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[0]).toMatchObject({ miss_confirmed_at: 'NOW', miss_confirmed_by: STAFF, resolved_at: null });
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
    expect(mockCreateAlertOnce.mock.calls[0][0].payload).toMatchObject({ log_id: 'log-1', miss_confirmed: true, scheduled_date: '2026-09-29', window_start: '09:00:00' });
  });

  test('confirming twice changes nothing the second time', async () => {
    mockTables.reschedule_log = [logRow({ miss_confirmed_at: 'EARLIER', miss_confirmed_by: STAFF })];
    mockTables.dispatch_alerts = [card({ payload: { ...card().payload, miss_confirmed: true } })];
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: 'someone-else' })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[0]).toMatchObject({ miss_confirmed_at: 'EARLIER', miss_confirmed_by: STAFF });
    expect(mockCreateAlertOnce).not.toHaveBeenCalled();
    expect(mockResolveAlert).not.toHaveBeenCalled();
  });

  test('"Not a miss" settles the row as dismissed, keeps the reason, and closes the card', async () => {
    expect(await notClosedOut.dismiss({ logId: 'log-1', dismissedBy: STAFF, note: '  customer asked to skip  ' })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolved_at: 'NOW', resolution: 'not_a_miss', resolved_by: STAFF });
    expect(String(mockTables.reschedule_log[0].notes)).toContain('raw:');
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
  });

  test('both decisions read the row under a lock, so a settle that landed first wins', async () => {
    await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF });
    await notClosedOut.dismiss({ logId: 'log-1', dismissedBy: STAFF });
    // visit first, then the log row: the order a status change or a move locks them
    expect(mockLocks).toEqual(['scheduled_services', 'reschedule_log', 'scheduled_services', 'reschedule_log']);
  });

  test('a dispatch no-show on an already-flagged visit confirms the existing row, reopening one settled earlier', async () => {
    mockTables.reschedule_log = [logRow({ resolved_at: 'EARLIER', resolution: 'backlog', resolved_by: 'migration', original_date: '2026-09-29' })];
    mockTables.dispatch_alerts = [];
    mockTables.scheduled_services = [{ ...service, status: 'no_show' }];
    // the card's own button never reopens a settled row
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF })).toEqual({ ok: false, reason: 'not_found' });
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF, reopen: true })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolved_at: null, resolution: null, resolved_by: null, miss_confirmed_at: 'NOW', miss_confirmed_by: STAFF });
    expect(mockCreateAlertOnce.mock.calls[0][0].payload).toMatchObject({ log_id: 'log-1', miss_confirmed: true });
  });

  test.each([
    ['completed in between', { status: 'completed' }],
    ['rebooked to another day in between', { status: 'no_show', scheduled_date: '2026-10-06' }],
    ['rebooked later the same day and missed again', { status: 'no_show', window_start: '14:00:00', window_end: '15:00:00' }],
  ])('a reopen never undoes the settlement of a visit %s', async (_label, visitNow) => {
    mockTables.reschedule_log = [logRow({ resolved_at: 'EARLIER', resolution: 'rebooked', resolved_by: 'admin', original_date: '2026-09-29', original_window: '09:00:00-10:00:00' })];
    mockTables.dispatch_alerts = [];
    mockTables.scheduled_services = [{ ...service, ...visitNow }];
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF, reopen: true })).toEqual({ ok: false, reason: 'visit_moved_on' });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolved_at: 'EARLIER', resolution: 'rebooked', miss_confirmed_at: null });
    expect(mockCreateAlertOnce).not.toHaveBeenCalled();
    // the visit is locked before the log row, the order a status change takes them
    expect(mockLocks).toEqual(['scheduled_services', 'reschedule_log']);
  });

  test('"Not a miss" on one of two open flagged rows hands the card to the row still open', async () => {
    mockTables.reschedule_log = [
      logRow(),
      logRow({ id: 'log-2', original_date: '2026-09-22', original_window: '13:00:00-14:00:00', miss_confirmed_at: 'THEN' }),
    ];
    expect(await notClosedOut.dismiss({ logId: 'log-1', dismissedBy: STAFF })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[1].resolved_at).toBeNull();
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
    expect(mockCreateAlertOnce.mock.calls[0][0]).toMatchObject({
      jobId: 'visit-1',
      payload: { log_id: 'log-2', scheduled_date: '2026-09-22', window_start: '13:00:00', window_end: '14:00:00', miss_confirmed: true },
    });
  });

  test('a card already on the row still open is left as it is', async () => {
    mockTables.reschedule_log = [logRow(), logRow({ id: 'log-2' })];
    mockTables.dispatch_alerts = [card({ payload: { log_id: 'log-2' } })];
    expect(await notClosedOut.dismiss({ logId: 'log-1', dismissedBy: STAFF })).toEqual({ ok: true });
    expect(mockResolveAlert).not.toHaveBeenCalled();
    expect(mockCreateAlertOnce).not.toHaveBeenCalled();
  });

  test('a series move settles every moved visit that carries an open flagged row, and only those', async () => {
    mockTables.reschedule_log = [logRow(), logRow({ id: 'log-2', scheduled_service_id: 'visit-2' }), logRow({ id: 'log-3', scheduled_service_id: 'visit-9' })];
    expect(await notClosedOut.resolveForServices({ serviceIds: ['visit-1', 'visit-2', 'visit-2', 'visit-3'], resolution: 'rebooked', resolvedBy: 'admin' })).toEqual({ resolved: 2 });
    expect(mockTables.reschedule_log.map((r) => r.resolution)).toEqual(['rebooked', 'rebooked', null]);
    expect(await notClosedOut.resolveForServices({ serviceIds: [], resolution: 'rebooked' })).toEqual({ resolved: 0 });
  });

  test('a replacement card that cannot be saved fails the decision, so its transaction rolls back and the old card stays', async () => {
    mockCreateAlertOnce.mockRejectedValueOnce(new Error('insert failed'));
    await expect(notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF })).rejects.toThrow('insert failed');
    mockTables.reschedule_log = [logRow(), logRow({ id: 'log-2' })];
    mockCreateAlertOnce.mockRejectedValueOnce(new Error('insert failed'));
    await expect(notClosedOut.dismiss({ logId: 'log-1', dismissedBy: STAFF })).rejects.toThrow('insert failed');
    // a first card for a freshly flagged visit stays best-effort
    mockCreateAlertOnce.mockRejectedValueOnce(new Error('insert failed'));
    expect(await notClosedOut.raiseCard({ logId: 'log-1', service })).toEqual({ raised: false });
  });

  test('"Done" settles a CONFIRMED miss as handled and closes its card; an unconfirmed row is refused', async () => {
    expect(await notClosedOut.markHandled({ logId: 'log-1', handledBy: STAFF })).toEqual({ ok: false, reason: 'not_confirmed' });
    expect(mockTables.reschedule_log[0].resolved_at).toBeNull();
    mockTables.reschedule_log = [logRow({ miss_confirmed_at: 'THEN' })];
    expect(await notClosedOut.markHandled({ logId: 'log-1', handledBy: STAFF })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolved_at: 'NOW', resolution: 'handled', resolved_by: STAFF, miss_confirmed_at: 'THEN' });
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
    expect(await notClosedOut.markHandled({ logId: 'log-1', handledBy: STAFF })).toEqual({ ok: false, reason: 'not_found' });
  });

  test('"Not a miss" after "This was a miss" withdraws the confirmation, so the row is not a person-marked miss', async () => {
    mockTables.reschedule_log = [logRow({ customer_id: 'cust-1' })];
    await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF });
    expect(mockTables.reschedule_log[0].miss_confirmed_at).toBe('NOW');
    expect(await notClosedOut.dismiss({ logId: 'log-1', dismissedBy: STAFF })).toEqual({ ok: true });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolution: 'not_a_miss', miss_confirmed_at: null, miss_confirmed_by: null });
    // and the customer's outreach task is re-checked against the misses that remain
    expect(mockWithdrawOutreach).toHaveBeenCalledWith('cust-1', expect.anything());
    // "Done" keeps it: a handled miss was still a miss
    mockTables.reschedule_log = [logRow({ miss_confirmed_at: 'THEN', miss_confirmed_by: STAFF })];
    await notClosedOut.markHandled({ logId: 'log-1', handledBy: STAFF });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolution: 'handled', miss_confirmed_at: 'THEN' });
  });

  test('gate turned off with a card still up: a decision still closes it, and raises no new one', async () => {
    mockGateOn = false;
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF })).toEqual({ ok: true });
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
    expect(mockCreateAlertOnce).not.toHaveBeenCalled();
    // dark: the outreach count is the old one, evaluated by the nightly check
    expect(mockEvaluateThreshold).not.toHaveBeenCalled();
  });

  test('the repeated-miss outreach is evaluated when a person first confirms the miss, once', async () => {
    mockTables.reschedule_log = [logRow({ customer_id: 'cust-1' })];
    await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF });
    expect(mockEvaluateThreshold).toHaveBeenCalledTimes(1);
    expect(mockEvaluateThreshold).toHaveBeenCalledWith('cust-1', 'confirmed_miss', expect.anything(), { logId: 'log-1' });
    await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF });
    expect(mockEvaluateThreshold).toHaveBeenCalledTimes(1);
    // it runs inside the decision's transaction (under the row lock), so the task
    // commits with the confirmation and a later "Not a miss" finds it
    expect(typeof mockEvaluateThreshold.mock.calls[0][2].transaction).toBe('function');
    // a failed evaluation never fails the decision
    mockTables.reschedule_log = [logRow({ customer_id: 'cust-1' })];
    mockEvaluateThreshold.mockRejectedValueOnce(new Error('db down'));
    expect(await notClosedOut.confirmMiss({ logId: 'log-1', confirmedBy: STAFF })).toEqual({ ok: true });
  });

  test('a row that is already settled, or not a flagged visit, is not_found for both decisions', async () => {
    mockTables.reschedule_log = [logRow({ resolved_at: 'EARLIER' })];
    expect(await notClosedOut.confirmMiss({ logId: 'log-1' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await notClosedOut.dismiss({ logId: 'log-1' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await notClosedOut.dismiss({ logId: null })).toEqual({ ok: false, reason: 'not_found' });
    mockTables.reschedule_log = [logRow({ reason_code: 'weather_rain' })];
    expect(await notClosedOut.dismiss({ logId: 'log-1' })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('reconcileOpenRows (nightly repair pass)', () => {
  test('raises a card only for visits whose open row has none, one per visit', async () => {
    mockTables.reschedule_log = [
      logRow(), // has a card (alert-1)
      logRow({ id: 'log-2', scheduled_service_id: 'visit-2', miss_confirmed_at: 'THEN', original_date: '2026-09-30', original_window: '13:00:00-14:00:00' }),
      logRow({ id: 'log-3', scheduled_service_id: 'visit-2' }),
      logRow({ id: 'log-4', scheduled_service_id: 'visit-3', resolved_at: 'EARLIER', resolution: 'completed' }),
    ];
    mockTables.scheduled_services = [{ ...service, status: 'pending' }, { ...service, id: 'visit-2', status: 'no_show' }, { ...service, id: 'visit-3', status: 'completed' }];
    expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 1, settled: 0 });
    expect(mockCreateAlertOnce).toHaveBeenCalledTimes(1);
    expect(mockCreateAlertOnce.mock.calls[0][0]).toMatchObject({
      jobId: 'visit-2',
      payload: { log_id: 'log-2', scheduled_date: '2026-09-30', window_start: '13:00:00', miss_confirmed: true },
    });
  });

  test.each([
    ['completed', { status: 'completed' }, 'completed'],
    ['cancelled', { status: 'cancelled' }, 'dismissed'],
    ['moved to another day', { status: 'pending', scheduled_date: '2026-10-06' }, 'rebooked'],
    ['moved to a later window', { status: 'confirmed', window_start: '15:00:00', window_end: '16:00:00' }, 'rebooked'],
  ])('a row whose visit is already %s is settled from the visit and its card closed', async (_label, visitNow, resolution) => {
    mockTables.reschedule_log = [logRow({ original_date: '2026-09-29', original_window: '09:00:00-10:00:00' })];
    mockTables.scheduled_services = [{ ...service, ...visitNow }];
    expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 0, settled: 1 });
    expect(mockTables.reschedule_log[0]).toMatchObject({ resolution, resolved_by: 'system' });
    expect(mockResolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-1' }));
  });

  test('an open visit still in its flagged slot, and a no_show visit, stay open', async () => {
    mockTables.reschedule_log = [logRow({ original_date: '2026-09-29', original_window: '09:00:00-10:00:00' })];
    for (const status of ['pending', 'no_show']) {
      mockTables.scheduled_services = [{ ...service, status }];
      expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 0, settled: 0 });
    }
    expect(mockTables.reschedule_log[0].resolved_at).toBeNull();
  });

  test('gate off: rows are still settled from the visit, no card is raised; a database failure never throws', async () => {
    mockTables.dispatch_alerts = [];
    mockTables.scheduled_services = [{ ...service, status: 'pending' }];
    mockGateOn = false;
    expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 0, settled: 0 });
    mockTables.scheduled_services = [{ ...service, status: 'completed' }];
    expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 0, settled: 1 });
    mockGateOn = true;
    mockTables.reschedule_log = [logRow()];
    mockFailTransaction = true;
    expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 0, settled: 0 });
    expect(mockCreateAlertOnce).not.toHaveBeenCalled();
  });
});

describe('slotChanged: only a real change of date or window is a rebooking', () => {
  const slot = { date: '2026-09-29', start: '09:00:00', end: '10:00:00' };
  test('a technician-only move at the same date and window is not', () => {
    expect(notClosedOut.slotChanged(slot, { ...slot })).toBe(false);
    expect(notClosedOut.slotChanged(slot, { date: new Date('2026-09-29T04:00:00Z'), start: '09:00', end: '10:00' })).toBe(false);
  });
  test('a new date, or a new window the same day, is', () => {
    expect(notClosedOut.slotChanged(slot, { ...slot, date: '2026-10-06' })).toBe(true);
    expect(notClosedOut.slotChanged(slot, { ...slot, start: '14:00:00', end: '15:00:00' })).toBe(true);
  });
  test('the rebooker settles on that test, single move and series', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rebooker.js'), 'utf8');
    expect(src).toMatch(/if \(notClosedOut\.slotChanged\(\s*\{ date: originalDate[\s\S]{0,260}\)\) \{\s*await notClosedOut\.resolveForService\(/);
    expect(src).toContain('moveRows.filter((r) => notClosedOut.slotChanged(slotOf(r.before), slotOf(r.after))).map((r) => r.id)');
  });
});

