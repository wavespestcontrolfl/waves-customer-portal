/**
 * GATE_ROUTE_WARNING_DETAIL, the save side: the conflict row a staff save gets back carries the worded
 * warning plus `base_warning` (the unchanged sentence, so a snapshot compared between a review and its
 * apply does not drift with the clock), and one log line records why. Gate off: today's row.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);
jest.mock('../models/db', () => jest.fn());
const mockCheck = jest.fn();
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: () => true,
  checkArrivalPlacement: (...args) => mockCheck(...args),
}));

const { findConflictingVisits } = require('../services/scheduling/occupancy');

const args = (arrivalWindow) => ({ db: jest.fn(), date: '2026-11-04', windowStart: '14:00', windowEnd: '16:00', arrivalWindow });

beforeEach(() => { jest.clearAllMocks(); });

test('a worded warning rides with its unchanged sentence, and the log line names the cause', async () => {
  mockCheck.mockResolvedValue({ feasible: false, reason: 'arrival_window', target: { id: 't' },
    warning: 'Route on 2026-11-04: Stop 6 (2–4 PM window) would arrive 4:12 PM, 12 min late.',
    baseWarning: 'The route on 2026-11-04 cannot keep every promised arrival window.',
    diagnostics: { placement: 'saved', travelSource: 'picker_cache', lateStopIds: ['v6'] } });
  const rows = await findConflictingVisits(args({ serviceId: 'svc-1', roads: 'cache' }));
  expect(mockCheck.mock.calls[0][0]).toMatchObject({ detail: true });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ conflict_reason: 'arrival_window', warning: expect.stringContaining('Stop 6 (2–4 PM window)'),
    base_warning: 'The route on 2026-11-04 cannot keep every promised arrival window.' });
  expect(mockLogger.info).toHaveBeenCalledWith('[route-warning] service=svc-1 date=2026-11-04 reason=arrival_window placement=saved late=v6 travel=picker_cache');
});

test('gate off (no worded warning): the row has no base_warning, and the log line still records the reason', async () => {
  mockCheck.mockResolvedValue({ feasible: false, reason: 'route_unverified', target: { id: 't' }, warning: 'Could not verify the route\'s arrival windows on 2026-11-04. Review the route before driving it.',
    diagnostics: { cause: 'no_pin' } });
  const rows = await findConflictingVisits(args({ serviceId: 'svc-1', roads: 'cache' }));
  expect(rows[0]).not.toHaveProperty('base_warning');
  expect(mockLogger.info).toHaveBeenCalledWith('[route-warning] service=svc-1 date=2026-11-04 reason=route_unverified placement=- late=- travel=- cause=no_pin');
});

test('a check that is not a staff save (no cached road times) neither asks for detail nor logs', async () => {
  mockCheck.mockResolvedValue({ feasible: false, reason: 'arrival_window', target: { id: 't' }, warning: 'x' });
  await findConflictingVisits(args({ serviceId: 'svc-1' }));
  expect(mockCheck.mock.calls[0][0].detail).toBe(false);
  expect(mockLogger.info).not.toHaveBeenCalled();
});

test('a fit logs nothing', async () => {
  mockCheck.mockResolvedValue({ feasible: true });
  expect(await findConflictingVisits(args({ serviceId: 'svc-1', roads: 'cache' }))).toEqual([]);
  expect(mockLogger.info).not.toHaveBeenCalled();
});

describe('a reviewed reschedule compares the unchanged sentence, not the clock times', () => {
  test('the conflict snapshot uses base_warning when the warning is worded', async () => {
    jest.resetModules();
    jest.doMock('../services/scheduling/occupancy', () => ({
      ...jest.requireActual('../services/scheduling/occupancy'),
      findConflictingVisits: jest.fn(async () => [{ id: 'v1', conflict_reason: 'arrival_window',
        warning: 'Route on 2026-11-04: Stop 6 (2–4 PM window) would arrive 4:12 PM, 12 min late.',
        base_warning: 'The route on 2026-11-04 cannot keep every promised arrival window.' }]),
    }));
    const rebooker = require('../services/rebooker');
    const target = { id: 'v1', date: '2026-11-04', windowStart: '14:00', windowEnd: '16:00' };
    const probe = async () => (await rebooker.probeMoveConflicts({ conn: jest.fn(), target, excludeServiceIds: [], options: {} })).snapshot[0];
    expect(await probe()).toMatchObject({ reason: 'arrival_window', warning: 'The route on 2026-11-04 cannot keep every promised arrival window.' });
  });
});
