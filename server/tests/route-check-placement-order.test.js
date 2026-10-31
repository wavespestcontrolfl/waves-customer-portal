/**
 * GATE_ROUTE_CHECK_STAFF_SAVES: placement first, then the route warning
 * (Codex P1 on 9837f0c3d4). Uses the REAL arrival evaluator on an in-memory
 * route (helpers/in-memory-route.js): a visit read where it is saved can miss a
 * promise that the staff placement then fixes, so a warning collected before
 * placement would reach staff for an order the save replaces.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(),
}));

const occupancy = require('../services/scheduling/occupancy');
const arrivalRoute = require('../services/scheduling/arrival-route');
const routeCheck = require('../services/scheduling/staff-save-route-check');
const { createRoute, DATE } = require('./helpers/in-memory-route');

const VISIT = { serviceId: 'target', date: DATE, windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech' };
let route;
let placeSpy;
const trx = Object.assign(jest.fn(), { isTransaction: true });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ROUTE_CHECK_STAFF_SAVES = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
  route = createRoute();
  occupancy.findConflictingVisits.mockImplementation(async () => route.conflictRows());
  placeSpy = jest.spyOn(arrivalRoute, 'placeMovedVisit').mockImplementation(async () => route.place());
});
afterEach(() => {
  placeSpy.mockRestore();
  delete process.env.GATE_ROUTE_CHECK_STAFF_SAVES;
  delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  delete process.env.GATE_STAFF_ROUTE_INSERTION;
});

test('premise (real evaluator): read where it is saved the visit misses a promise; placement puts it first and the day fits', () => {
  expect(route.savedFit()).toMatchObject({ feasible: false, reason: 'arrival_window' });
  expect(route.place()).toEqual(['target', 'other']);
  expect(route.savedFit().feasible).toBe(true);
});

test('placement first, then the check: no stale warning reaches staff', async () => {
  await routeCheck.placeStaffSavedVisit(trx, { serviceId: 'target', source: 'intelligence_bar' });
  expect(await routeCheck.staffSaveRouteWarnings(trx, VISIT)).toEqual([]);
  expect(route.state.target.route_order).toBe(1);
});

test('the old order (check, then placement) is the bug: it warns about an order the save replaces', async () => {
  const warnings = await routeCheck.staffSaveRouteWarnings(trx, VISIT);
  expect(warnings).toHaveLength(1);
  await routeCheck.placeStaffSavedVisit(trx, { serviceId: 'target' });
  expect(await routeCheck.staffSaveRouteWarnings(trx, VISIT)).toEqual([]);
});

test('placement that cannot certify a day leaves the check to warn (a route that really misses still warns)', async () => {
  placeSpy.mockResolvedValue(null);
  expect(await routeCheck.staffSaveRouteWarnings(trx, VISIT)).toHaveLength(1);
});
