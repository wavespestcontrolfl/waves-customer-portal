/**
 * scheduling/plan-taken-hour.js + the shared plan-writer probe it uses
 * (window-rules.js occupancyBlockFor / seriesCandidateDateClashRows, moved
 * from routes/admin-schedule.js unchanged). Owner 2026-10-22, audit D4.
 */
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(async () => []),
}));

const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { occupancyBlockFor, seriesCandidateDateClashRows, ADMIN_OCCUPANCY_EXCLUDE_STATUSES } = require('../services/scheduling/window-rules');
const planTakenHour = require('../services/scheduling/plan-taken-hour');
const { etDateString, addETDays } = require('../utils/datetime-et');

const day = (n) => etDateString(addETDays(new Date(), n));

describe('occupancyBlockFor (moved from admin-schedule.js, same results)', () => {
  test.each([
    [{ window_start: '09:00', window_end: '10:00' }, { start: '09:00', end: '10:00' }],
    [{ window_start: '09:00:00', window_end: '10:30:00' }, { start: '09:00', end: '10:30' }],
    [{ window_start: '09:00', window_end: null, estimated_duration_minutes: 90 }, { start: '09:00', end: '10:30' }],
    [{ window_start: '09:00', window_end: '08:00' }, { start: '09:00', end: '10:00' }],
    [{ window_start: '23:30', window_end: null, estimated_duration_minutes: 60 }, { start: '23:30', end: '23:59' }],
    [{ window_start: null }, null],
    [{ window_start: '25:00' }, null],
  ])('%j -> %j', (row, block) => {
    expect(occupancyBlockFor(row)).toEqual(block);
  });
});

describe('seriesCandidateDateClashRows', () => {
  afterEach(() => findConflictingVisits.mockReset().mockImplementation(async () => []));

  test('a caller may pass its own statuses (the hand-off passes the night tool\'s)', async () => {
    await seriesCandidateDateClashRows('conn', { window_start: '09:00', window_end: '10:00' }, '2026-11-03', { excludeStatuses: ['x'] });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ excludeStatuses: ['x'] }));
  });

  test('interviews only when asked', async () => {
    await seriesCandidateDateClashRows('conn', { window_start: '09:00', window_end: '10:00' }, '2026-11-03', { includeInterviews: true });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ includeInterviews: true }));
  });

  test('existing callers (no options): the same tech-blind probe as before', async () => {
    await seriesCandidateDateClashRows('conn', { window_start: '09:00', window_end: '10:00' }, '2026-11-03');
    expect(findConflictingVisits).toHaveBeenCalledWith({
      db: 'conn', date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00', excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
    });
  });

  test('a windowless template reads nothing', async () => {
    expect(await seriesCandidateDateClashRows('conn', { window_start: null }, '2026-11-03')).toEqual([]);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });
});

describe('plan-taken-hour', () => {
  afterEach(() => {
    delete process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF;
    findConflictingVisits.mockReset().mockImplementation(async () => []);
  });
  const row = { customer_id: 'c1', technician_id: 't1', window_start: '09:00', window_end: '10:00' };

  test('hand-off fields clear every time field and set the due date', () => {
    expect(planTakenHour.handoffFields('2026-11-03T00:00:00.000Z')).toEqual({
      window_start: null, window_end: null, time_window: null, window_display: null, route_order: null,
      recurring_dispatch_due_date: '2026-11-03',
    });
  });

  test('gate off: never taken, nothing read', async () => {
    findConflictingVisits.mockResolvedValue([{ id: 'x' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(30) })).toBe(false);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('gate on: taken from four days out, with the technician carried and the night tool\'s statuses', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockResolvedValue([{ id: 'x', customer_id: 'c2' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(3) })).toBe(false);
    expect(findConflictingVisits).not.toHaveBeenCalled();
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(4) })).toBe(true);
    const probe = findConflictingVisits.mock.calls[0][0];
    expect(probe).toMatchObject({ date: day(4), technicianId: 't1' });
    // No customer is excluded wholesale (Codex #6476 r1 P1); a rescheduled or completed row is no stop (r1 P2).
    expect(probe.excludeCustomerId).toBeUndefined();
    expect(probe.excludeStatuses).toEqual(expect.arrayContaining(['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed']));
    // The owner's booked interviews hold the hour too, as for the night tool.
    expect(probe.includeInterviews).toBe(true);
  });

  test('an interview in the hour (no customer) is taken', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockResolvedValue([{ id: 'interview:app-1', customer_id: null, conflict_reason: 'interview' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, recurring_parent_id: 'parent-1', scheduled_date: day(30) })).toBe(true);
  });

  // The same customer is one stop only at the same place: the night tool's
  // own rule (auto-dispatch/current-conflict.js samePlaceIds), measured from
  // the plan's stored parent row (Codex #6476 r1 P1).
  describe('the same customer', () => {
    // A knex-shaped read of the place rows samePlaceIds asks for.
    const placeConn = (places) => {
      const q = { leftJoin: () => q, whereIn: () => q, select: async () => places };
      return jest.fn(() => q);
    };
    const sameCustomerRow = { ...row, recurring_parent_id: 'parent-1', scheduled_date: day(30) };
    beforeEach(() => { process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true'; });

    test('at the same property: one stop, not taken', async () => {
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }]);
      const conn = placeConn([{ id: 'parent-1', property_id: 'prop-a' }, { id: 'own', property_id: 'prop-a' }]);
      expect(await planTakenHour.takenHourHandoff(conn, sameCustomerRow)).toBe(false);
    });

    test('at another property: taken', async () => {
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }]);
      const conn = placeConn([{ id: 'parent-1', property_id: 'prop-a' }, { id: 'own', property_id: 'prop-b' }]);
      expect(await planTakenHour.takenHourHandoff(conn, sameCustomerRow)).toBe(true);
    });

    test('a place that cannot be read, or no parent to measure from: taken', async () => {
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }]);
      expect(await planTakenHour.takenHourHandoff(placeConn([]), sameCustomerRow)).toBe(true);
      expect(await planTakenHour.takenHourHandoff(placeConn([]), { ...sameCustomerRow, recurring_parent_id: null })).toBe(true);
    });

    test('its own stop beside another customer\'s: taken', async () => {
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }, { id: 'other', customer_id: 'c2' }]);
      const conn = placeConn([{ id: 'parent-1', property_id: 'prop-a' }, { id: 'own', property_id: 'prop-a' }]);
      expect(await planTakenHour.takenHourHandoff(conn, sameCustomerRow)).toBe(true);
    });

    test('an explicit place wins over the row\'s own parent (the top-up passes its parent)', async () => {
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }]);
      const conn = placeConn([{ id: 'parent-2', property_id: 'prop-a' }, { id: 'own', property_id: 'prop-a' }]);
      expect(await planTakenHour.takenHourHandoff(conn, { ...row, scheduled_date: day(30) }, { placeId: 'parent-2' })).toBe(false);
    });
  });

  test('gate on: a free hour is not taken; a windowless row is never probed', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(30) })).toBe(false);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, window_start: null, scheduled_date: day(30) })).toBe(false);
    expect(findConflictingVisits).toHaveBeenCalledTimes(1);
  });

  test('handOffTakenHours keeps the input array and counts the hand-offs', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockImplementation(async ({ date }) => (date === day(40) ? [{ id: 'x', customer_id: 'c2' }] : []));
    const rows = [{ ...row, scheduled_date: day(20) }, { ...row, scheduled_date: day(40) }];
    const out = await planTakenHour.handOffTakenHours('conn', rows);
    expect(out.handedOff).toBe(1);
    expect(out.rows[1]).toMatchObject({ window_start: null, recurring_dispatch_due_date: day(40) });
    expect(rows[1].window_start).toBe('09:00');
  });
});
