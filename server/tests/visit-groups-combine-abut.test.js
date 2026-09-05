/**
 * Office Combine window handling (Visit Groups Unblock, Lane 2 — owner
 * ruling 2026-09-03): abutPlan moves LATER unattached rows onto the
 * running union end (rounded DOWN to the hour so the landing stays
 * connected), never anchors or windowless rows; combineRows only moves
 * when the window rule is the sole refusal, preflights an attached
 * visit's freeze, plans from that visit's whole membership, holds the
 * cohort's reminders across the moves, and puts moved rows back when a
 * later step fails.
 */
const mockDb = jest.fn();
jest.mock('../models/db', () => {
  const fn = (...args) => mockDb(...args);
  fn.transaction = async (cb) => cb(fn);
  fn.raw = jest.fn();
  return fn;
});
const mockReschedule = jest.fn();
jest.mock('../services/rebooker', () => ({ reschedule: (...args) => mockReschedule(...args) }));
const mockNotifyVisitRescheduled = jest.fn().mockReturnValue(null);
jest.mock('../services/tech-visit-notifications', () => ({ notifyVisitRescheduled: (...args) => mockNotifyVisitRescheduled(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockCreateOrJoin = jest.fn();
const mockFrozen = jest.fn();
const mockOpenMembers = jest.fn();
const mockLockStop = jest.fn();
const mockClaimHold = jest.fn();
const mockReleaseHold = jest.fn();
jest.mock('../services/visit-groups', () => {
  const real = jest.requireActual('../services/visit-groups');
  return {
    dateOnly: real.dateOnly,
    toMinutes: real.toMinutes,
    MOVE_HOLD_TTL_MS: 24 * 60 * 60 * 1000,
    createOrJoinVisit: (...args) => mockCreateOrJoin(...args),
    frozenVisitVerdict: (...args) => mockFrozen(...args),
    openMembers: (...args) => mockOpenMembers(...args),
    lockStopForRow: (...args) => mockLockStop(...args),
    claimReminderHoldInTx: (...args) => mockClaimHold(...args),
    releaseReminderHoldByToken: (...args) => mockReleaseHold(...args),
  };
});

const { abutPlan, combineRows } = require('../services/visit-combine');

const row = (id, start, end, extra = {}) => ({ id, scheduled_date: '2026-09-04', window_start: start, window_end: end, visit_id: null, ...extra });
const from = (start, end = null) => ({ scheduled_date: '2026-09-04', window_start: start, window_end: end, visit_id: null });
const mv = (id, start, end, fromStart, fromEnd) => ({ id, scheduledDate: '2026-09-04', start, end, from: from(fromStart, fromEnd) });
const MOVE_OPTS = { adminWindowRules: true, overlapAdvisory: true, sourceSurface: 'dispatch_board', notifyRequested: false, keepStatus: true, suppressTechNotice: true };

describe('abutPlan', () => {
  test('moves the later row to start when the earlier one ends, keeping its span', () => {
    expect(abutPlan([row('lawn', '11:00:00', '12:00:00'), row('pest', '14:00:00', '15:00:00')]))
      .toEqual([mv('pest', '12:00', '13:00', '14:00:00', '15:00:00')]);
  });

  test('input order does not matter — the earliest row anchors', () => {
    expect(abutPlan([row('pest', '14:00', '15:00'), row('lawn', '11:00', '12:00')]))
      .toEqual([mv('pest', '12:00', '13:00', '14:00', '15:00')]);
  });

  test('touching or overlapping rows stay where they are', () => {
    expect(abutPlan([row('a', '09:00', '10:00'), row('b', '10:00', '11:00')])).toEqual([]);
    expect(abutPlan([row('a', '09:00', '11:00'), row('b', '10:00', '12:00')])).toEqual([]);
  });

  test('an off-hour union end lands the row on the hour BELOW it, so the landing stays connected (GH codex r1 P1)', () => {
    // 09:00–10:30 → land at 10:00 (overlapping the half hour), never 11:00
    // — the connected-window rule the retry re-runs refuses a gap.
    expect(abutPlan([row('a', '09:00', '10:30'), row('b', '13:00', '14:00')]))
      .toEqual([mv('b', '10:00', '11:00', '13:00', '14:00')]);
  });

  test('three rows chain one after another', () => {
    expect(abutPlan([row('a', '08:00', '09:00'), row('b', '11:00', '12:00'), row('c', '15:00', '17:00')]))
      .toEqual([mv('b', '09:00', '10:00', '11:00', '12:00'), mv('c', '10:00', '12:00', '15:00', '17:00')]);
  });

  test('a row already attached to a visit is an anchor and never moves', () => {
    // The attached row is the later one: nothing can move it, so no plan.
    expect(abutPlan([row('a', '09:00', '10:00'), row('b', '13:00', '14:00', { visit_id: 'v1' })])).toEqual([]);
    // The attached row is the earlier one: the free row moves onto it.
    expect(abutPlan([row('a', '09:00', '10:00', { visit_id: 'v1' }), row('b', '13:00', '14:00')]))
      .toEqual([mv('b', '10:00', '11:00', '13:00', '14:00')]);
  });

  test('windowless rows are ignored; an earlier row with no end counts as its start (the grouping predicate), a moved row with no end keeps its duration (GH codex r1 P1)', () => {
    // a has no end: the predicate sees 09:00–09:00, so b lands AT 09:00 —
    // a duration-derived 10:30 would leave a gap the retry refuses.
    expect(abutPlan([row('a', '09:00', null, { estimated_duration_minutes: 90 }), row('b', '13:00', '14:00'), row('w', null, null)]))
      .toEqual([mv('b', '09:00', '10:00', '13:00', '14:00')]);
    // The MOVED row's own missing end materializes from its duration.
    expect(abutPlan([row('a', '09:00', '10:00'), row('b', '13:00', null, { estimated_duration_minutes: 90 })]))
      .toEqual([mv('b', '10:00', '11:30', '13:00', null)]);
  });
});

describe('combineRows', () => {
  const ids = ['lawn', 'pest'];
  const createOrJoin = mockCreateOrJoin;
  const selectRows = (rows) => mockDb.mockImplementation(() => ({ whereIn: () => ({ select: async () => rows }) }));
  beforeEach(() => {
    mockDb.mockReset();
    mockReschedule.mockReset();
    mockNotifyVisitRescheduled.mockClear();
    mockCreateOrJoin.mockReset();
    mockFrozen.mockReset().mockResolvedValue({ frozen: false, reason: null });
    mockOpenMembers.mockReset().mockResolvedValue([]);
    mockLockStop.mockReset().mockResolvedValue('key');
    mockClaimHold.mockReset().mockResolvedValue(['r1', 'r2']);
    mockReleaseHold.mockReset().mockResolvedValue();
  });

  test('groups without moving when the rows already chain', async () => {
    createOrJoin.mockResolvedValueOnce({ id: 'v1' });
    const out = await combineRows({ serviceIds: ids, createdBy: 'admin:t1' });
    expect(out).toEqual({ visit: { id: 'v1' }, moved: [] });
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockClaimHold).not.toHaveBeenCalled();
  });

  test('a non-window refusal surfaces untouched and moves nothing', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: autopay_enrolled'));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toThrow('autopay_enrolled');
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('a window refusal holds the cohort, moves the later row silently (status kept), groups, then releases the hold', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockResolvedValueOnce({ id: 'v2' });
    selectRows([row('lawn', '11:00:00', '12:00:00'), row('pest', '14:00:00', '15:00:00')]);
    mockReschedule.mockResolvedValue({ success: true });
    const out = await combineRows({ serviceIds: ids, createdBy: 'admin:t1' });
    expect(mockReschedule).toHaveBeenCalledTimes(1);
    expect(mockReschedule).toHaveBeenCalledWith('pest', '2026-09-04', { start: '12:00', end: '13:00' }, 'admin', 'admin', {
      ...MOVE_OPTS,
      // Pinned to the observed row: a concurrent edit makes the move miss.
      expect: { scheduled_date: '2026-09-04', window_start: '14:00:00', window_end: '15:00:00', visit_id: null },
    });
    expect(out).toEqual({ visit: { id: 'v2' }, moved: [mv('pest', '12:00', '13:00', '14:00:00', '15:00:00')] });
    expect(createOrJoin).toHaveBeenCalledTimes(2);
    // The hold: under the first row's stop lock, every cohort row, BEFORE
    // the first move; released by its token after the grouping.
    expect(mockLockStop).toHaveBeenCalledWith(expect.anything(), 'lawn');
    const [, cohort, stamp] = mockClaimHold.mock.calls[0];
    expect(cohort).toEqual(['lawn', 'pest']);
    expect(stamp.holdToken).toMatch(/^[0-9a-f]{32}$/);
    expect(stamp.holdUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(mockClaimHold.mock.invocationCallOrder[0]).toBeLessThan(mockReschedule.mock.invocationCallOrder[0]);
    expect(mockReleaseHold).toHaveBeenCalledWith(stamp.holdToken);
    expect(mockReleaseHold.mock.invocationCallOrder[0]).toBeGreaterThan(createOrJoin.mock.invocationCallOrder[1]);
  });

  test('a live hold held by another mover refuses the combine (409) before anything moves', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    selectRows([row('lawn', '11:00', '12:00'), row('pest', '14:00', '15:00')]);
    mockClaimHold.mockRejectedValueOnce(Object.assign(new Error('another move of this stop is still in progress — try again shortly'), { code: 'VISIT_MOVE_HOLD_ACTIVE' }));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MOVE_HOLD_ACTIVE' });
    expect(mockReschedule).not.toHaveBeenCalled();
    // Any other claim failure is a 503 — nothing moved, nothing to release.
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    mockClaimHold.mockRejectedValueOnce(new Error('db down'));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'VISIT_MOVE_HOLD_FAILED' });
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  test('a window refusal with nothing movable (later row is an anchor) re-throws the window refusal', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    selectRows([row('lawn', '11:00', '12:00'), row('pest', '14:00', '15:00', { visit_id: 'v9' })]);
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toThrow('rows not mutually groupable: window');
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockClaimHold).not.toHaveBeenCalled();
  });

  test('a selected row attached to a FROZEN visit is refused before any move (GH codex r1 P1)', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    selectRows([row('lawn', '09:00', '10:00', { visit_id: 'v1' }), row('pest', '14:00', '15:00')]);
    mockFrozen.mockResolvedValueOnce({ frozen: true, reason: 'link_issued' });
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toThrow('visit membership conflict: target frozen (link_issued)');
    expect(mockFrozen).toHaveBeenCalledWith(expect.anything(), 'v1');
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockClaimHold).not.toHaveBeenCalled();
  });

  test('an attached visit contributes its WHOLE membership as anchors — the free row lands after the stop, not inside it (GH codex r1 P1)', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockResolvedValueOnce({ id: 'v1' });
    // Selected: the 09–10 child of v1 and a free 14–15 row. v1's other
    // child (10–12) is not selected but is part of the stop.
    selectRows([row('child-a', '09:00', '10:00', { visit_id: 'v1' }), row('free', '14:00', '15:00')]);
    mockOpenMembers.mockResolvedValueOnce([
      { id: 'child-a', scheduled_date: '2026-09-04', window_start: '09:00', window_end: '10:00', technician_id: null, status: 'confirmed' },
      { id: 'child-b', scheduled_date: '2026-09-04', window_start: '10:00', window_end: '12:00', technician_id: null, status: 'confirmed' },
    ]);
    mockReschedule.mockResolvedValue({ success: true });
    const out = await combineRows({ serviceIds: ['child-a', 'free'], createdBy: 'admin:t1' });
    expect(mockOpenMembers).toHaveBeenCalledWith(expect.anything(), 'v1');
    expect(mockReschedule).toHaveBeenCalledTimes(1);
    expect(mockReschedule.mock.calls[0].slice(0, 3)).toEqual(['free', '2026-09-04', { start: '12:00', end: '13:00' }]);
    expect(out.moved).toEqual([mv('free', '12:00', '13:00', '14:00', '15:00')]);
    // The hold covers the unselected member too.
    expect(mockClaimHold.mock.calls[0][1]).toEqual(['child-a', 'free', 'child-b']);
  });

  test('a failed grouping AFTER the moves puts every moved row back, in reverse order, releases the hold, then rethrows', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockRejectedValueOnce(new Error('visit membership conflict: a row is already terminal'));
    selectRows([row('a', '08:00', '09:00'), row('b', '11:00', '12:00'), row('c', '15:00', '17:00')]);
    mockReschedule.mockResolvedValue({ success: true });
    await expect(combineRows({ serviceIds: ['a', 'b', 'c'], createdBy: 'admin:t1' }))
      .rejects.toThrow('visit membership conflict: a row is already terminal');
    const calls = mockReschedule.mock.calls.map((c) => [c[0], c[2].start, c[2].end]);
    expect(calls).toEqual([
      ['b', '09:00', '10:00'], ['c', '10:00', '12:00'], // the moves
      ['c', '15:00', '17:00'], ['b', '11:00', '12:00'], // the revert, last moved first
    ]);
    // The revert pins the window the move landed on and keeps status too.
    expect(mockReschedule.mock.calls[2][5]).toEqual({ ...MOVE_OPTS, expect: { scheduled_date: '2026-09-04', window_start: '10:00', window_end: '12:00', visit_id: null } });
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  test('a failed second move reverts the first; a revert that fails is named in the error and the hold is KEPT', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    selectRows([row('a', '08:00', '09:00'), row('b', '11:00', '12:00'), row('c', '15:00', '17:00')]);
    mockReschedule
      .mockResolvedValueOnce({ success: true }) // b moves
      .mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a on_site job'), { statusCode: 409 })) // c fails
      .mockRejectedValueOnce(new Error('slot taken')); // b's revert fails
    await expect(combineRows({ serviceIds: ['a', 'b', 'c'], createdBy: 'admin:t1' }))
      .rejects.toThrow(/Cannot reschedule a on_site job — 1 moved appointment\(s\) could not be put back, fix by hand: b \(now 09:00–10:00, was 11:00–12:00\)/);
    expect(mockReschedule).toHaveBeenCalledTimes(3);
    expect(createOrJoin).toHaveBeenCalledTimes(1);
    // A stranded row stays quiet until the stamp expires (the safe direction).
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  test('an open-ended row that was moved goes back OPEN-ENDED on compensation (rebooker clearWindowEnd; pre-push P1)', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockRejectedValueOnce(new Error('rows not mutually groupable: technician'));
    selectRows([row('a', '09:00', '10:00'), row('b', '13:00', null, { estimated_duration_minutes: 90 })]);
    mockReschedule.mockResolvedValue({ success: true });
    await expect(combineRows({ serviceIds: ['a', 'b'], createdBy: 'admin:t1' })).rejects.toThrow('technician');
    expect(mockReschedule.mock.calls[0].slice(0, 3)).toEqual(['b', '2026-09-04', { start: '10:00', end: '11:30' }]);
    expect(mockReschedule.mock.calls[0][5].clearWindowEnd).toBeUndefined();
    expect(mockReschedule.mock.calls[1].slice(0, 3)).toEqual(['b', '2026-09-04', { start: '13:00', end: null }]);
    expect(mockReschedule.mock.calls[1][5]).toEqual({ ...MOVE_OPTS, clearWindowEnd: true, expect: { scheduled_date: '2026-09-04', window_start: '10:00', window_end: '11:30', visit_id: null } });
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  test('the holders hear about the moves ONLY after the grouping stands — one card per moved row, from the committed holder, the combining staff member as actor (Codex r7 P1)', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockResolvedValueOnce({ id: 'v1' });
    selectRows([row('a', '08:00', '09:00'), row('b', '11:00', '12:00'), row('c', '15:00', '17:00')]);
    mockReschedule
      .mockResolvedValueOnce({ success: true, technicianId: 'tech-b' })
      .mockResolvedValueOnce({ success: true, technicianId: null }); // c is unassigned: nobody to tell
    await combineRows({ serviceIds: ['a', 'b', 'c'], createdBy: 'admin:t1', actorId: 't1' });
    // Every move (and any rollback) rides suppressTechNotice; the card comes from here.
    for (const call of mockReschedule.mock.calls) expect(call[5].suppressTechNotice).toBe(true);
    expect(mockNotifyVisitRescheduled).toHaveBeenCalledTimes(1);
    expect(mockNotifyVisitRescheduled).toHaveBeenCalledWith({
      visitId: 'b', technicianId: 'tech-b', actorId: 't1',
      previous: { date: '2026-09-04', windowStart: '11:00', windowEnd: '12:00' },
      snapshot: { date: '2026-09-04', windowStart: '09:00', windowEnd: '10:00' },
    });
    expect(mockNotifyVisitRescheduled.mock.invocationCallOrder[0]).toBeGreaterThan(createOrJoin.mock.invocationCallOrder[1]);
  });

  test('a grouping that fails after the moves tells nobody (the rows went back, silently)', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockRejectedValueOnce(new Error('visit membership conflict: a row is already terminal'));
    selectRows([row('a', '08:00', '09:00'), row('b', '11:00', '12:00')]);
    mockReschedule.mockResolvedValue({ success: true, technicianId: 'tech-b' });
    await expect(combineRows({ serviceIds: ['a', 'b'], createdBy: 'admin:t1', actorId: 't1' })).rejects.toThrow('membership conflict');
    expect(mockReschedule).toHaveBeenCalledTimes(2);
    expect(mockNotifyVisitRescheduled).not.toHaveBeenCalled();
  });

  test('a rebooker refusal mid-move propagates (the route maps its statusCode)', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    selectRows([row('lawn', '11:00', '12:00'), row('pest', '14:00', '15:00')]);
    mockReschedule.mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a on_site job'), { statusCode: 409 }));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(createOrJoin).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });
});
