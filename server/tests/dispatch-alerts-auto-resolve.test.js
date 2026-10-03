jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({
  getIo: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
}));

const { getIo } = require('../sockets');
const dispatchAlerts = require('../services/dispatch-alerts');

// codex P1, pre-push audit on 925e9e977: distinguish a SYSTEM-driven
// resolve (a status transition, a reassignment clearing staleness, a
// tracking-key supersession) from a person explicitly clicking Resolve.
// no-show-detector.js's alreadyHasOpenAlert treats a resolved row WITHOUT
// payload.superseded_at as a human ack that must keep blocking recreation
// under the same tracking_key forever — autoResolveOverdueAlertsForJob
// (cancellation/completion/arrival/skip/no-show) resolved tracking alerts
// with no stamp, so reversing an erroneous status change under the same
// promise + technician permanently starved a fresh office alert.

// A single dispatch_alerts UPDATE chain (where -> whereNull -> update ->
// returning), reused for both autoResolveOverdueAlertsForJob's own
// open-alerts SELECT and resolveAlert's per-row UPDATE. clearTrackingBells
// separately touches 'notifications' when the resolved row is
// no_show_detector-sourced — a harmless passthrough chain here.
function fakeTrx({ openAlertIds = [], updateReturns = [] } = {}) {
  const selectForOpenAlerts = jest.fn().mockResolvedValue(openAlertIds.map((id) => ({ id })));
  const openAlertsChain = { whereIn: () => openAlertsChain, where: () => openAlertsChain, whereNull: () => openAlertsChain, select: selectForOpenAlerts };

  const returning = jest.fn();
  updateReturns.forEach((rows) => returning.mockResolvedValueOnce(rows));
  if (!updateReturns.length) returning.mockResolvedValue([]);
  const update = jest.fn(() => ({ returning }));
  const whereNull = jest.fn(() => ({ update }));
  const where = jest.fn(() => ({ whereNull }));

  const notificationsChain = { whereIn: () => notificationsChain, whereNull: () => notificationsChain, where: () => notificationsChain, update: jest.fn() };

  const trx = jest.fn((table) => {
    if (table === 'notifications') return notificationsChain;
    if (table !== 'dispatch_alerts') throw new Error(`fake trx: unexpected table ${table}`);
    return { whereIn: openAlertsChain.whereIn, where };
  });
  trx.fn = { now: jest.fn(() => 'NOW()') };
  trx.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return { trx, where, whereNull, update, returning, selectForOpenAlerts };
}

beforeEach(() => {
  jest.clearAllMocks();
  const emit = jest.fn();
  getIo.mockReturnValue({ to: jest.fn(() => ({ emit })) });
});

describe('resolveAlert auto stamp', () => {
  test('auto: true stamps payload.superseded_at on the same UPDATE', async () => {
    const row = { id: 'alert-1', type: 'tech_late', payload: { source: 'no_show_detector', tracking_key: 'k' }, resolved_at: 'NOW()' };
    const { trx, where, whereNull, update } = fakeTrx({ updateReturns: [[row]] });

    await dispatchAlerts.resolveAlert({ id: 'alert-1', trx, auto: true });

    expect(where).toHaveBeenCalledWith({ id: 'alert-1' });
    expect(whereNull).toHaveBeenCalledWith('resolved_at');
    const patch = update.mock.calls[0][0];
    expect(patch.payload).toEqual(expect.objectContaining({
      __raw: expect.stringContaining("jsonb_build_object('superseded_at'"),
    }));
  });

  test('auto omitted (default) never touches payload — a human resolve stays quiet', async () => {
    const row = { id: 'alert-1', type: 'tech_late', payload: { source: 'no_show_detector' }, resolved_at: 'NOW()' };
    const { trx, update } = fakeTrx({ updateReturns: [[row]] });

    await dispatchAlerts.resolveAlert({ id: 'alert-1', resolvedBy: 'tech-1', trx });

    const patch = update.mock.calls[0][0];
    expect(patch).toEqual({ resolved_at: 'NOW()', resolved_by: 'tech-1' });
    expect(patch.payload).toBeUndefined();
  });
});

describe('autoResolveOverdueAlertsForJob stamps every resolve as automatic', () => {
  test('a cancellation/completion/arrival/skip/no-show transition stamps superseded_at on the tracking alert it clears', async () => {
    const row = { id: 'alert-1', type: 'tech_late', payload: { source: 'no_show_detector', tracking_key: 'k' }, resolved_at: 'NOW()' };
    const { trx, update } = fakeTrx({ openAlertIds: ['alert-1'], updateReturns: [[row]] });

    const result = await dispatchAlerts.autoResolveOverdueAlertsForJob({ jobId: 'visit-1', trx, toStatus: 'cancelled' });

    expect(result).toEqual({ resolved: 1 });
    const patch = update.mock.calls[0][0];
    expect(patch.payload).toEqual(expect.objectContaining({
      __raw: expect.stringContaining("jsonb_build_object('superseded_at'"),
    }));
  });

  test('the arrival (on_site) transition stamps too — a wrong arrival reversed later must still allow a fresh alert', async () => {
    const row = { id: 'alert-1', type: 'unassigned_overdue', payload: { source: 'no_show_detector', tracking_key: 'k' }, resolved_at: 'NOW()' };
    const { trx, update } = fakeTrx({ openAlertIds: ['alert-1'], updateReturns: [[row]] });

    await dispatchAlerts.autoResolveOverdueAlertsForJob({ jobId: 'visit-1', trx, toStatus: 'on_site' });

    expect(update.mock.calls[0][0].payload).toEqual(expect.objectContaining({
      __raw: expect.stringContaining("jsonb_build_object('superseded_at'"),
    }));
  });

  test('no-op statuses never touch dispatch_alerts at all', async () => {
    const { trx } = fakeTrx();
    const result = await dispatchAlerts.autoResolveOverdueAlertsForJob({ jobId: 'visit-1', trx, toStatus: 'rescheduled' });
    expect(result).toEqual({ resolved: 0 });
    expect(trx).not.toHaveBeenCalled();
  });
});

describe('supersedeInvalidSprayHolds', () => {
  const card = (over = {}) => ({ id: 'alert-9', payload: { for_date: '2026-10-03', window_start: '09:00:00', ...over } });
  const live = { id: 'visit-1', status: 'confirmed', scheduled_date: '2026-10-03', window_start: '09:00:00' };
  // dispatch_alerts: the open-card read, then each resolve UPDATE; scheduled_services: the visit read.
  function trxWith({ cards, visit }) {
    const { trx, update } = fakeTrx({ updateReturns: cards.map((c) => [{ id: c.id, type: 'lawn_spray_hold', payload: c.payload, resolved_at: 'NOW()' }]) });
    const real = trx.getMockImplementation();
    const open = { where: () => ({ whereNull: () => ({ select: async () => cards }) }) };
    let reads = 0;
    trx.mockImplementation((table) => {
      if (table === 'scheduled_services') return { where: () => ({ first: async () => visit }) };
      if (table === 'dispatch_alerts' && reads++ === 0) return open;
      return real(table);
    });
    return { trx, update };
  }

  test.each([
    ['cancelled', { ...live, status: 'cancelled' }],
    ['arrived', { ...live, status: 'on_site' }],
    ['rescheduled', { ...live, status: 'rescheduled' }],
    ['moved to another day', { ...live, scheduled_date: '2026-10-07' }],
    ['time moved', { ...live, window_start: '14:00:00' }],
    ['gone', null],
  ])('%s: the open card is superseded with the auto stamp', async (name, visit) => {
    const { trx, update } = trxWith({ cards: [card()], visit });
    expect(await dispatchAlerts.supersedeInvalidSprayHolds({ jobId: 'visit-1', trx })).toEqual({ resolved: 1 });
    expect(update.mock.calls[0][0].payload).toEqual(expect.objectContaining({ __raw: expect.stringContaining("jsonb_build_object('superseded_at'") }));
  });

  test('a visit that is still valid keeps its card, and a job with no open card reads no visit', async () => {
    const { trx } = trxWith({ cards: [card()], visit: live });
    expect(await dispatchAlerts.supersedeInvalidSprayHolds({ jobId: 'visit-1', trx })).toEqual({ resolved: 0 });
    const none = trxWith({ cards: [], visit: live });
    expect(await dispatchAlerts.supersedeInvalidSprayHolds({ jobId: 'visit-1', trx: none.trx })).toEqual({ resolved: 0 });
  });

  test('the overdue family keeps its status table: rescheduled is still a no-op and only its own types are read', async () => {
    const { trx } = fakeTrx();
    expect(await dispatchAlerts.autoResolveOverdueAlertsForJob({ jobId: 'visit-1', trx, toStatus: 'rescheduled' })).toEqual({ resolved: 0 });
    expect(trx).not.toHaveBeenCalled();
    expect(dispatchAlerts.OVERDUE_ALERT_TYPES).toEqual(['tech_late', 'unassigned_overdue']);
  });
});

describe('dropInvalidSprayHolds (the queue read)', () => {
  const row = (over = {}) => ({ id: 'spray-1', type: 'lawn_spray_hold', job_id: 'visit-1', resolved_at: null,
    payload: { for_date: '2026-10-03', window_start: '09:00:00' },
    visit_status: 'confirmed', scheduled_date: '2026-10-03', window_start: '09:00:00', ...over });
  const other = { id: 'late-1', type: 'tech_late', job_id: 'visit-2', resolved_at: null, payload: {}, visit_status: 'completed', scheduled_date: '2026-09-01' };

  function dbWithResolve() {
    const { trx, update } = fakeTrx({ updateReturns: [[{ id: 'spray-1', type: 'lawn_spray_hold', payload: {}, resolved_at: 'NOW()' }]] });
    const db = require('../models/db');
    db.mockImplementation(trx);
    db.transaction = async (fn) => fn(trx);
    return { update, db };
  }

  test('a placement edit by direct update (date or window changed): the card is left out and superseded, other types untouched', async () => {
    for (const edit of [{ scheduled_date: '2026-10-08' }, { window_start: '14:00:00' }, { visit_status: 'cancelled' }, { visit_status: null, scheduled_date: null }]) {
      jest.clearAllMocks();
      const { update } = dbWithResolve();
      const rows = [row(edit), other];
      const out = await dispatchAlerts.dropInvalidSprayHolds(rows, '2026-10-03');
      expect(out).toEqual([other]);
      expect(update.mock.calls[0][0].payload).toEqual(expect.objectContaining({ __raw: expect.stringContaining("jsonb_build_object('superseded_at'") }));
    }
  });

  test('a past day\'s card is dropped even if its visit never moved', async () => {
    dbWithResolve();
    expect(await dispatchAlerts.dropInvalidSprayHolds([row()], '2026-10-04')).toEqual([]);
  });

  test('a valid card is returned unchanged, with no write', async () => {
    const { update } = dbWithResolve();
    const rows = [row(), other];
    expect(await dispatchAlerts.dropInvalidSprayHolds(rows, '2026-10-03')).toEqual(rows);
    expect(update).not.toHaveBeenCalled();
  });

  test('no spray hold in the rows: nothing is read or written', async () => {
    const { db } = dbWithResolve();
    const rows = [other];
    expect(await dispatchAlerts.dropInvalidSprayHolds(rows, '2026-10-03')).toBe(rows);
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed supersede still hides the card; a caller that did not join the visit keeps it', async () => {
    const db = require('../models/db');
    db.mockImplementation(() => { throw new Error('write failed'); });
    db.transaction = async () => { throw new Error('write failed'); };
    expect(await dispatchAlerts.dropInvalidSprayHolds([row({ scheduled_date: '2026-10-08' })], '2026-10-03')).toEqual([]);
    const bare = row();
    delete bare.visit_status;
    expect(await dispatchAlerts.dropInvalidSprayHolds([bare], '2026-10-03')).toEqual([bare]);
  });

  test('the list route reads the visit status in its one joined select and filters only the unresolved view', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    expect(src).toMatch(/'s\.status as visit_status'/);
    expect(src).toMatch(/unresolved\s*\?\s*await require\('\.\.\/services\/dispatch-alerts'\)\.dropInvalidSprayHolds\(allRows/);
  });
});

