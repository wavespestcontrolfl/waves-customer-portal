/**
 * Office Combine window handling (Visit Groups Unblock, Lane 2 — owner
 * ruling 2026-09-03): abutPlan moves LATER unattached rows to start where
 * the running union ends (rounded up to the hour), never anchors or
 * windowless rows; combineRows only moves when the window rule is the
 * sole refusal, and surfaces every other refusal before anything moves.
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
const mockCreateOrJoin = jest.fn();
jest.mock('../services/visit-groups', () => {
  const real = jest.requireActual('../services/visit-groups');
  return { dateOnly: real.dateOnly, toMinutes: real.toMinutes, createOrJoinVisit: (...args) => mockCreateOrJoin(...args) };
});

const { abutPlan, combineRows } = require('../services/visit-combine');

const row = (id, start, end, extra = {}) => ({ id, scheduled_date: '2026-09-04', window_start: start, window_end: end, visit_id: null, ...extra });
const from = (start, end = null) => ({ scheduled_date: '2026-09-04', window_start: start, window_end: end, visit_id: null });
const mv = (id, start, end, fromStart, fromEnd) => ({ id, scheduledDate: '2026-09-04', start, end, from: from(fromStart, fromEnd) });

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

  test('a half-hour union end rounds UP to the hour (admin windows start on the hour)', () => {
    expect(abutPlan([row('a', '09:00', '10:30'), row('b', '13:00', '14:00')]))
      .toEqual([mv('b', '11:00', '12:00', '13:00', '14:00')]);
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

  test('windowless rows are ignored; a missing end uses the duration (default 60)', () => {
    expect(abutPlan([row('a', '09:00', null, { estimated_duration_minutes: 90 }), row('b', '13:00', '14:00'), row('w', null, null)]))
      .toEqual([mv('b', '11:00', '12:00', '13:00', '14:00')]);
  });
});

describe('combineRows', () => {
  const ids = ['lawn', 'pest'];
  const createOrJoin = mockCreateOrJoin;
  beforeEach(() => {
    mockDb.mockReset();
    mockReschedule.mockReset();
    mockCreateOrJoin.mockReset();
  });

  test('groups without moving when the rows already chain', async () => {
    createOrJoin.mockResolvedValueOnce({ id: 'v1' });
    const out = await combineRows({ serviceIds: ids, createdBy: 'admin:t1' });
    expect(out).toEqual({ visit: { id: 'v1' }, moved: [] });
    expect(mockReschedule).not.toHaveBeenCalled();
  });

  test('a non-window refusal surfaces untouched and moves nothing', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: autopay_enrolled'));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toThrow('autopay_enrolled');
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('a window refusal moves the later row silently, then groups', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockResolvedValueOnce({ id: 'v2' });
    mockDb.mockImplementation(() => ({
      whereIn: () => ({
        select: async () => [row('lawn', '11:00:00', '12:00:00'), row('pest', '14:00:00', '15:00:00')],
      }),
    }));
    mockReschedule.mockResolvedValue({ success: true });
    const out = await combineRows({ serviceIds: ids, createdBy: 'admin:t1' });
    expect(mockReschedule).toHaveBeenCalledTimes(1);
    expect(mockReschedule).toHaveBeenCalledWith('pest', '2026-09-04', { start: '12:00', end: '13:00' }, 'admin', 'admin', {
      adminWindowRules: true, overlapAdvisory: true, sourceSurface: 'dispatch_board', notifyRequested: false,
      // Pinned to the observed row: a concurrent edit makes the move miss.
      expect: { scheduled_date: '2026-09-04', window_start: '14:00:00', window_end: '15:00:00', visit_id: null },
    });
    expect(out).toEqual({ visit: { id: 'v2' }, moved: [mv('pest', '12:00', '13:00', '14:00:00', '15:00:00')] });
    expect(createOrJoin).toHaveBeenCalledTimes(2);
  });

  test('a window refusal with nothing movable (later row is an anchor) re-throws the window refusal', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    mockDb.mockImplementation(() => ({
      whereIn: () => ({
        select: async () => [row('lawn', '11:00', '12:00'), row('pest', '14:00', '15:00', { visit_id: 'v9' })],
      }),
    }));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toThrow('rows not mutually groupable: window');
    expect(mockReschedule).not.toHaveBeenCalled();
  });

  test('a failed grouping AFTER the moves puts every moved row back, in reverse order, then rethrows', async () => {
    createOrJoin
      .mockRejectedValueOnce(new Error('rows not mutually groupable: window'))
      .mockRejectedValueOnce(new Error('visit membership conflict: a row is already terminal'));
    mockDb.mockImplementation(() => ({
      whereIn: () => ({ select: async () => [row('a', '08:00', '09:00'), row('b', '11:00', '12:00'), row('c', '15:00', '17:00')] }),
    }));
    mockReschedule.mockResolvedValue({ success: true });
    await expect(combineRows({ serviceIds: ['a', 'b', 'c'], createdBy: 'admin:t1' }))
      .rejects.toThrow('visit membership conflict: a row is already terminal');
    const calls = mockReschedule.mock.calls.map((c) => [c[0], c[2].start, c[2].end]);
    expect(calls).toEqual([
      ['b', '09:00', '10:00'], ['c', '10:00', '12:00'], // the moves
      ['c', '15:00', '17:00'], ['b', '11:00', '12:00'], // the revert, last moved first
    ]);
    // The revert pins the window the move landed on.
    expect(mockReschedule.mock.calls[2][5].expect).toEqual({ scheduled_date: '2026-09-04', window_start: '10:00', window_end: '12:00', visit_id: null });
  });

  test('a failed second move reverts the first; a revert that fails is named in the error', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    mockDb.mockImplementation(() => ({
      whereIn: () => ({ select: async () => [row('a', '08:00', '09:00'), row('b', '11:00', '12:00'), row('c', '15:00', '17:00')] }),
    }));
    mockReschedule
      .mockResolvedValueOnce({ success: true }) // b moves
      .mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a on_site job'), { statusCode: 409 })) // c fails
      .mockRejectedValueOnce(new Error('slot taken')); // b's revert fails
    await expect(combineRows({ serviceIds: ['a', 'b', 'c'], createdBy: 'admin:t1' }))
      .rejects.toThrow(/Cannot reschedule a on_site job — 1 moved appointment\(s\) could not be put back, fix by hand: b \(now 09:00–10:00, was 11:00–12:00\)/);
    expect(mockReschedule).toHaveBeenCalledTimes(3);
    expect(createOrJoin).toHaveBeenCalledTimes(1);
  });

  test('a rebooker refusal mid-move propagates (the route maps its statusCode)', async () => {
    createOrJoin.mockRejectedValueOnce(new Error('rows not mutually groupable: window'));
    mockDb.mockImplementation(() => ({
      whereIn: () => ({ select: async () => [row('lawn', '11:00', '12:00'), row('pest', '14:00', '15:00')] }),
    }));
    mockReschedule.mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a on_site job'), { statusCode: 409 }));
    await expect(combineRows({ serviceIds: ids, createdBy: 'admin:t1' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(createOrJoin).toHaveBeenCalledTimes(1);
  });
});
