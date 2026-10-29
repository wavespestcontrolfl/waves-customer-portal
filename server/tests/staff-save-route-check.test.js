/**
 * GATE_ROUTE_CHECK_STAFF_SAVES (owner 2026-10-29, Route Check Everywhere 2a):
 * the shared advisory route check the staff saves run on the visit they wrote.
 * Pins: the gate is read at call time and unset changes nothing; the check
 * is findConflictingVisits with arrivalWindow { serviceId, roads: 'cache' }
 * (no Google call); an infeasible route is a warning, never a throw; an
 * unassigned or windowless visit is not checked; placeMovedVisit gets the save
 * transaction.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(),
}));

const logger = require('../services/logger');
const occupancy = require('../services/scheduling/occupancy');
const arrivalRoute = require('../services/scheduling/arrival-route');
const routeCheck = require('../services/scheduling/staff-save-route-check');

const ROUTE_WARNING = 'Could not verify the route\'s arrival windows on 2099-01-15. Review the route before driving it.';
const visit = { serviceId: 'svc-1', date: '2099-01-15', windowStart: '10:00:00', windowEnd: '11:00:00', technicianId: 'tech-1' };
const gateOn = () => {
  process.env.GATE_ROUTE_CHECK_STAFF_SAVES = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
};
let placeSpy;

beforeEach(() => {
  jest.clearAllMocks();
  occupancy.findConflictingVisits.mockResolvedValue([]);
  placeSpy = jest.spyOn(arrivalRoute, 'placeMovedVisit').mockResolvedValue([1]);
});
afterEach(() => {
  delete process.env.GATE_ROUTE_CHECK_STAFF_SAVES;
  delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  delete process.env.GATE_SCHEDULING_CAPACITY;
  placeSpy.mockRestore();
});

describe('the gate reader (call time)', () => {
  test('unset reads off, even with the arrival-window check on', () => {
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    expect(arrivalRoute.routeCheckStaffSavesLive()).toBe(false);
  });

  test('on needs the arrival-window route check itself: without it the second probe would only repeat the overlap probe', () => {
    process.env.GATE_ROUTE_CHECK_STAFF_SAVES = 'true';
    expect(arrivalRoute.routeCheckStaffSavesLive()).toBe(false);
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    expect(arrivalRoute.routeCheckStaffSavesLive()).toBe(true);
  });

  test('flipping the env between calls takes effect with no reload', () => {
    gateOn();
    expect(routeCheck.routeCheckLive()).toBe(true);
    delete process.env.GATE_ROUTE_CHECK_STAFF_SAVES;
    expect(routeCheck.routeCheckLive()).toBe(false);
  });
});

describe('staffSaveRouteWarnings', () => {
  test('gate off: no probe, no warning', async () => {
    expect(await routeCheck.staffSaveRouteWarnings(jest.fn(), visit)).toEqual([]);
    expect(occupancy.findConflictingVisits).not.toHaveBeenCalled();
  });

  test('gate on: probes the saved visit with cached road times, excluding itself, on the admin status set', async () => {
    gateOn();
    const conn = jest.fn();
    expect(await routeCheck.staffSaveRouteWarnings(conn, visit)).toEqual([]);
    expect(occupancy.findConflictingVisits).toHaveBeenCalledTimes(1);
    expect(occupancy.findConflictingVisits).toHaveBeenCalledWith({
      db: conn, date: '2099-01-15', windowStart: '10:00', windowEnd: '11:00', excludeServiceIds: ['svc-1'],
      excludeStatuses: ['cancelled', 'completed', 'skipped', 'no_show'],
      arrivalWindow: { serviceId: 'svc-1', roads: 'cache' },
    });
  });

  test('gate on: an infeasible route is returned as the checker\'s own warning, deduplicated', async () => {
    gateOn();
    occupancy.findConflictingVisits.mockResolvedValue([
      { id: 'svc-1', conflict_reason: 'arrival_window', warning: ROUTE_WARNING },
      { id: 'svc-1', conflict_reason: 'arrival_window', warning: ROUTE_WARNING },
    ]);
    expect(await routeCheck.staffSaveRouteWarnings(jest.fn(), visit)).toEqual([ROUTE_WARNING]);
  });

  test('gate on: runs under a savepoint when the connection has one, so a failed read cannot poison the save', async () => {
    gateOn();
    const sp = jest.fn();
    const conn = Object.assign(jest.fn(), { transaction: jest.fn(async (fn) => fn(sp)) });
    await routeCheck.staffSaveRouteWarnings(conn, visit);
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    expect(occupancy.findConflictingVisits.mock.calls[0][0].db).toBe(sp);
  });

  test('gate on: a failed check warns nothing, logs, and never throws', async () => {
    gateOn();
    occupancy.findConflictingVisits.mockRejectedValue(new Error('road read broke'));
    expect(await routeCheck.staffSaveRouteWarnings(jest.fn(), visit)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('road read broke'));
  });

  test.each([
    ['an unassigned visit', { technicianId: null }],
    ['a windowless visit', { windowStart: null, windowEnd: null }],
    ['a visit with no end', { windowEnd: null }],
  ])('gate on: %s is not checked', async (_label, patch) => {
    gateOn();
    expect(await routeCheck.staffSaveRouteWarnings(jest.fn(), { ...visit, ...patch })).toEqual([]);
    expect(occupancy.findConflictingVisits).not.toHaveBeenCalled();
  });
});

describe('placeStaffSavedVisit', () => {
  test('gate off: placeMovedVisit is not called', async () => {
    expect(await routeCheck.placeStaffSavedVisit(jest.fn(), { serviceId: 'svc-1' })).toBeNull();
    expect(placeSpy).not.toHaveBeenCalled();
  });

  test('gate on: placeMovedVisit gets the save transaction as a staff save, with the source', async () => {
    gateOn();
    const trx = jest.fn();
    expect(await routeCheck.placeStaffSavedVisit(trx, { serviceId: 'svc-1', source: 'bulk_reschedule' })).toEqual([1]);
    expect(placeSpy).toHaveBeenCalledWith(trx, { serviceId: 'svc-1', staffSave: true, source: 'bulk_reschedule' });
  });
});

// GATE_ROUTE_CHECK_AUTO_SAVES (owner 2026-10-29, Route Check Everywhere 2b)
describe('GATE_ROUTE_CHECK_AUTO_SAVES: placeAutoSavedVisit', () => {
  const autoOn = () => {
    process.env.GATE_ROUTE_CHECK_AUTO_SAVES = 'true';
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  };
  const trx = { isTransaction: true };
  afterEach(() => { delete process.env.GATE_ROUTE_CHECK_AUTO_SAVES; });

  test('the reader is read at call time and needs the arrival-window route check; the staff gate does not turn it on', () => {
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    expect(arrivalRoute.routeCheckAutoSavesLive()).toBe(false);
    process.env.GATE_ROUTE_CHECK_STAFF_SAVES = 'true';
    expect(arrivalRoute.routeCheckAutoSavesLive()).toBe(false);
    process.env.GATE_ROUTE_CHECK_AUTO_SAVES = 'true';
    expect(arrivalRoute.routeCheckAutoSavesLive()).toBe(true);
    delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    expect(arrivalRoute.routeCheckAutoSavesLive()).toBe(false);
  });

  test('gate off: touches nothing, even with the staff gate on', async () => {
    gateOn();
    expect(await routeCheck.placeAutoSavedVisit(trx, { serviceId: 'svc-1', source: 'completion_followup' })).toBeNull();
    expect(placeSpy).not.toHaveBeenCalled();
  });

  test('gate on: the written row goes to the staff writer on the caller transaction, cache roads only, with its source', async () => {
    autoOn();
    expect(await routeCheck.placeAutoSavedVisit(trx, { visit: { id: 'svc-9' }, source: 'package_followup' })).toEqual([1]);
    expect(placeSpy).toHaveBeenCalledTimes(1);
    expect(placeSpy).toHaveBeenCalledWith(trx, { serviceId: 'svc-9', staffSave: true, source: 'package_followup' });
  });

  test('gate on: no connection or no visit id is a quiet no-op', async () => {
    autoOn();
    expect(await routeCheck.placeAutoSavedVisit(null, { serviceId: 'svc-1' })).toBeNull();
    expect(await routeCheck.placeAutoSavedVisit(trx, { visit: undefined })).toBeNull();
    expect(await routeCheck.placeAutoSavedVisit(trx)).toBeNull();
    expect(placeSpy).not.toHaveBeenCalled();
  });

  test('gate on: a throwing placement is one warning line and a null, never a throw', async () => {
    autoOn();
    placeSpy.mockRejectedValueOnce(new Error('route boom'));
    expect(await routeCheck.placeAutoSavedVisit(trx, { serviceId: 'svc-1', source: 'call_booking' })).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('route boom'));
  });

  test('never warns, notifies or buys: only placeMovedVisit is called', async () => {
    autoOn();
    await routeCheck.placeAutoSavedVisit(trx, { serviceId: 'svc-1' });
    expect(occupancy.findConflictingVisits).not.toHaveBeenCalled();
    expect(placeSpy).toHaveBeenCalledWith(trx, { serviceId: 'svc-1', staffSave: true });
  });
});
