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

  test('gate on: taken from four days out, with the customer excluded and the technician carried', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockResolvedValue([{ id: 'x' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(3) })).toBe(false);
    expect(findConflictingVisits).not.toHaveBeenCalled();
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(4) })).toBe(true);
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ date: day(4), excludeCustomerId: 'c1', technicianId: 't1' }));
  });

  test('gate on: a free hour is not taken; a windowless row is never probed', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(30) })).toBe(false);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, window_start: null, scheduled_date: day(30) })).toBe(false);
    expect(findConflictingVisits).toHaveBeenCalledTimes(1);
  });

  test('handOffTakenHours keeps the input array and counts the hand-offs', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockImplementation(async ({ date }) => (date === day(40) ? [{ id: 'x' }] : []));
    const rows = [{ ...row, scheduled_date: day(20) }, { ...row, scheduled_date: day(40) }];
    const out = await planTakenHour.handOffTakenHours('conn', rows);
    expect(out.handedOff).toBe(1);
    expect(out.rows[1]).toMatchObject({ window_start: null, recurring_dispatch_due_date: day(40) });
    expect(rows[1].window_start).toBe('09:00');
  });
});
