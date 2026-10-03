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

  test('the pre-day spray hold card is cleared by the same transitions, beside the overdue family', async () => {
    const row = { id: 'alert-9', type: 'lawn_spray_hold', payload: { source: 'lawn_preday_spray_check' }, resolved_at: 'NOW()' };
    const { trx, selectForOpenAlerts } = fakeTrx({ openAlertIds: ['alert-9'], updateReturns: [[row]] });
    const whereIn = jest.fn((col, types) => ({ where: () => ({ whereNull: () => ({ select: selectForOpenAlerts }) }) }));
    const real = trx.getMockImplementation();
    trx.mockImplementation((table) => (table === 'dispatch_alerts' ? { ...real(table), whereIn } : real(table)));

    const result = await dispatchAlerts.autoResolveOverdueAlertsForJob({ jobId: 'visit-1', trx, toStatus: 'completed' });

    expect(whereIn).toHaveBeenCalledWith('type', expect.arrayContaining(['tech_late', 'unassigned_overdue', 'lawn_spray_hold']));
    expect(result).toEqual({ resolved: 1 });
    expect(dispatchAlerts.OVERDUE_ALERT_TYPES).not.toContain('lawn_spray_hold');
  });

  test('no-op statuses never touch dispatch_alerts at all', async () => {
    const { trx } = fakeTrx();
    const result = await dispatchAlerts.autoResolveOverdueAlertsForJob({ jobId: 'visit-1', trx, toStatus: 'rescheduled' });
    expect(result).toEqual({ resolved: 0 });
    expect(trx).not.toHaveBeenCalled();
  });
});
