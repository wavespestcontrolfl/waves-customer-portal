jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn().mockResolvedValue({ id: 'resolved' }) }));
const { evaluateNoShow, latestPromises, trackingKey, resolveLegacyCollision } = require('../services/no-show-detector');
const { resolveAlert } = require('../services/dispatch-alerts');
const { replay } = require('../../ops/agents/replay-no-show-detector');

describe('missing tracking stages', () => {
  const promise = { visit_id: 'visit', start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' };
  const visit = { id: 'visit', status: 'pending', scheduled_date: '2026-09-10' };
  const at = (time, extra = {}) => evaluateNoShow({ visit: { ...visit, ...extra }, promise, now: new Date(`2026-09-10T${time}:00-04:00`) });
  test('45 minutes warns; an en-route stamp stops stage 1 but cannot stop stage 2', () => {
    expect(at('09:44')).toBeNull();
    expect(at('09:45')?.stage).toBe(1);
    expect(at('09:45', { en_route_at: '2026-09-10T09:30:00-04:00' })).toBeNull();
    expect(at('11:30', { en_route_at: '2026-09-10T09:30:00-04:00' })).toMatchObject({ stage: 2, evidence: 'missing_tracking' });
  });
  test('a later arrival is not used in the past, but an observed arrival clears the card', () => {
    const stamps = { arrived_at: '2026-09-10T11:40:00-04:00' };
    expect(at('11:30', stamps)?.stage).toBe(2);
    expect(at('11:45', stamps)).toBeNull();
    expect(at('11:30', { arrived_at: '2026-09-09T09:30:00-04:00' })?.stage).toBe(2);
  });
  test('an internal move cannot reset the old promised window', () => {
    expect(at('11:30', { scheduled_date: '2026-09-12', window_start: '14:00' })?.stage).toBe(2);
    expect(at('11:30', { status: 'completed' })).toBeNull();
  });
  test('a newer unknown communication window cannot be replaced by an older known one', () => {
    const map = latestPromises([promise, { ...promise, start_at: null, communicated_at: '2026-09-10T08:00:00-04:00' }], new Date('2026-09-10T12:00:00-04:00'));
    expect(map.get('visit').start_at).toBeNull();
  });
  test('replay reconstructs state before a later completion and compares both thresholds', () => {
    const report = replay({ synthetic: true, from: '2026-09-01T00:00:00Z', to: '2026-09-11T00:00:00Z', visits: [{
      id: 'visit', initial: visit, promises: [promise], events: [{ at: '2026-09-10T12:00:00-04:00', patch: { status: 'completed' } }],
      outcome: 'late', complaint_at: '2026-09-10T11:40:00-04:00',
    }] });
    expect(report.thresholds.map((r) => [r.stage1_minutes, r.stage1_alerts, r.stage2_alerts, r.before_complaint])).toEqual([[45, 1, 1, 2], [60, 1, 1, 2]]);
  });
  test('replay sees departure evidence cleared between thresholds on the next cron tick', () => {
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T11:00:00-04:00', visits: [{
      id: 'visit', initial: { ...visit, en_route_at: '2026-09-10T09:30:00-04:00' }, promises: [promise],
      events: [{ at: '2026-09-10T10:07:00-04:00', patch: { en_route_at: null } }], outcome: 'tracking_gap',
    }] });
    for (const result of report.thresholds) expect(result.alerts).toMatchObject([{ stage: 1, at: '2026-09-10T14:10:00.000Z' }]);
  });
  test('replay counts a null latest promised window as missing coverage, not covered', () => {
    // new Date(null).getTime() is 0 — a finite, valid instant (the epoch) —
    // not NaN, so a naive `!Number.isFinite(new Date(start_at).getTime())`
    // guard lets an unknown latest window (start_at: null, the legacy-move
    // case latestPromises models) slip through as "covered" and understate
    // missing evidence in the backtest (codex P1).
    const report = replay({ synthetic: true, from: '2026-09-09T00:00:00-04:00', to: '2026-09-10T00:00:00-04:00', visits: [{
      id: 'visit', initial: visit, events: [],
      promises: [{ start_at: null, communicated_at: '2026-09-09T12:00:00-04:00', source: 'call' }],
      outcome: 'unknown',
    }] });
    for (const result of report.thresholds) expect(result.missing_promise_visits).toBe(1);
  });

});

describe('tracking key (reassignment refreshes the office alert)', () => {
  const base = { visitId: 'visit', startAt: '2026-09-10T13:00:00.000Z', stage: 2, type: 'tech_late' };
  test('a different recipient tech changes the key, even with promise/stage/type unchanged', () => {
    const keyForA = trackingKey({ ...base, recipient: 'tech-a' });
    const keyForB = trackingKey({ ...base, recipient: 'tech-b' });
    expect(keyForA).not.toBe(keyForB);
    // Same reason: the sweep's `alert.payload?.tracking_key !== key` branch
    // (no-show-detector.js sweep()) resolves the alert holding keyForA once
    // the live key is keyForB, so a reassigned stage-2 visit gets its office
    // alert resolved and recreated instead of sitting stale under the old
    // tech_id — /admin/dispatch/alerts joins tech_name off that stale
    // tech_id otherwise (codex P1).
  });
  test('an unassigned visit and a same-visit assigned visit never collide on the "unassigned" placeholder', () => {
    const unassigned = trackingKey({ ...base, type: 'unassigned_overdue', recipient: null });
    const assigned = trackingKey({ ...base, recipient: 'tech-a' });
    expect(unassigned).not.toBe(assigned);
  });
  test('identical inputs are stable (no spurious resolve/recreate churn on an unchanged visit)', () => {
    expect(trackingKey({ ...base, recipient: 'tech-a' })).toBe(trackingKey({ ...base, recipient: 'tech-a' }));
  });
});

describe('resolveLegacyCollision (legacy alert handover)', () => {
  // The partial unique index behind createAlertOnce
  // (idx_dispatch_alerts_tech_late_one_unresolved /
  // ..._unassigned_overdue_one_unresolved) has no payload.source condition,
  // so an unresolved LEGACY tech_late/unassigned_overdue row (the older
  // cron detectors, no payload.source) blocks the detector's own insert for
  // the same (type, job_id) forever, even though the sweep's cleanup loop
  // deliberately never auto-resolves a non-detector-sourced row (codex P1).
  function fakeAlertsTable(rows) {
    const whereRaw = jest.fn().mockResolvedValue(rows);
    const whereNull = jest.fn(() => ({ whereRaw }));
    const where = jest.fn(() => ({ whereNull }));
    const trx = jest.fn((name) => { expect(name).toBe('dispatch_alerts'); return { where }; });
    return { trx, where, whereNull, whereRaw };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('an unresolved legacy tech_late row (no payload.source) is resolved so the handover can insert', async () => {
    const legacyRow = { id: 'legacy-1', job_id: 'visit-1', type: 'tech_late', payload: { delay_minutes: 12 } };
    const { trx, where, whereNull, whereRaw } = fakeAlertsTable([legacyRow]);

    const count = await resolveLegacyCollision(trx, { jobId: 'visit-1', type: 'tech_late' });

    expect(where).toHaveBeenCalledWith({ job_id: 'visit-1', type: 'tech_late' });
    expect(whereNull).toHaveBeenCalledWith('resolved_at');
    expect(whereRaw.mock.calls[0][0]).toMatch(/payload->>'source'.*!=\s*'no_show_detector'/);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).toHaveBeenCalledWith({ id: 'legacy-1', trx });
    expect(count).toBe(1);
  });

  test('no unresolved legacy row → nothing to resolve, no-op', async () => {
    const { trx } = fakeAlertsTable([]);
    const count = await resolveLegacyCollision(trx, { jobId: 'visit-2', type: 'unassigned_overdue' });
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  test('every matching legacy row is resolved, not just the first', async () => {
    const rows = [
      { id: 'legacy-1', job_id: 'visit-3', type: 'unassigned_overdue', payload: null },
      { id: 'legacy-2', job_id: 'visit-3', type: 'unassigned_overdue', payload: {} },
    ];
    const { trx } = fakeAlertsTable(rows);

    const count = await resolveLegacyCollision(trx, { jobId: 'visit-3', type: 'unassigned_overdue' });

    expect(resolveAlert).toHaveBeenCalledTimes(2);
    expect(resolveAlert).toHaveBeenNthCalledWith(1, { id: 'legacy-1', trx });
    expect(resolveAlert).toHaveBeenNthCalledWith(2, { id: 'legacy-2', trx });
    expect(count).toBe(2);
  });
});
