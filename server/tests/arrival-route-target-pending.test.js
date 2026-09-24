/**
 * loadArrivalRouteContext — treatTargetAsPending (codex #4678 round-1
 * finding C, tech-out redistribution's fit pre-check).
 *
 * With arrival-window routing on, checkArrivalPlacement's activeTarget
 * short-circuit (arrival-route.js) reports route_unverified for a target
 * that is itself en_route/on_site TODAY on its OWN date — correct when
 * evaluating that same technician's route, but wrong when the target is
 * being evaluated for placement on a DIFFERENT candidate technician's route
 * (own tech-out redistribution's whole point: the absent tech's live
 * en_route stop must still be placeable on someone else's day).
 * treatTargetAsPending bypasses just this one flag; every other context
 * field is unaffected — proven here by asserting activeTarget alone.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/geocoder', () => ({ buildAddress: jest.fn(() => '123 Main St'), geocodeAddress: jest.fn() }));

const db = require('../models/db');
const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');

const SERVICE_ID = 'svc-en-route';
const CANDIDATE_TECH = 'tech-candidate';
const DATE = '2026-10-01';

function storedRow(overrides = {}) {
  return {
    id: SERVICE_ID, customer_id: 'cust-1', technician_id: 'tech-absent', scheduled_date: DATE,
    window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, status: 'en_route',
    route_order: 1, created_at: '2026-09-01T00:00:00Z', lat: 27.5, lng: -82.5,
    visit_id: null, reservation_expires_at: null, actual_end_time: null, check_out_time: null,
    completed_at: null, time_window: null, service_type: 'general_pest', service_id: null,
    source_estimate_id: null, updated_at: null,
    service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null,
    reservation_service_mix: null, reservation_policy_version: null,
    ...overrides,
  };
}

function chain(overrides = {}) {
  const c = {};
  Object.assign(c, {
    where: jest.fn(function where(arg) { if (typeof arg === 'function') arg.call(c, c); return c; }),
    orWhere: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
  });
  return Object.assign(c, overrides);
}

// Two sequential 'scheduled_services' reads: the stored-row lookup, then
// dayStopsQuery's day rows (empty — irrelevant to activeTarget itself).
function wire(row) {
  const storedChain = chain({ first: jest.fn().mockResolvedValue(row) });
  const rowsChain = chain();
  rowsChain.then = (res) => Promise.resolve([]).then(res);
  const queue = [storedChain, rowsChain];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return queue.shift() || chain();
    throw new Error(`unexpected table ${table}`);
  });
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.isTransaction = false;
}

describe('loadArrivalRouteContext — treatTargetAsPending', () => {
  test('an en_route target today is activeTarget by default', async () => {
    wire(storedRow());
    const context = await loadArrivalRouteContext({
      conn: db, serviceId: SERVICE_ID, date: DATE, technicianId: CANDIDATE_TECH, excludeServiceIds: [SERVICE_ID],
    });
    expect(context.activeTarget).toBe(true);
  });

  test('treatTargetAsPending bypasses activeTarget for the same en_route row', async () => {
    wire(storedRow());
    const context = await loadArrivalRouteContext({
      conn: db, serviceId: SERVICE_ID, date: DATE, technicianId: CANDIDATE_TECH, excludeServiceIds: [SERVICE_ID],
      treatTargetAsPending: true,
    });
    expect(context.activeTarget).toBe(false);
  });

  test('a non-live stop is never activeTarget, flag or not', async () => {
    wire(storedRow({ status: 'confirmed' }));
    const context = await loadArrivalRouteContext({
      conn: db, serviceId: SERVICE_ID, date: DATE, technicianId: CANDIDATE_TECH, excludeServiceIds: [SERVICE_ID],
    });
    expect(context.activeTarget).toBe(false);
  });

  test('a target on a DIFFERENT date is never activeTarget, flag or not', async () => {
    wire(storedRow({ scheduled_date: '2026-10-02' }));
    const context = await loadArrivalRouteContext({
      conn: db, serviceId: SERVICE_ID, date: DATE, technicianId: CANDIDATE_TECH, excludeServiceIds: [SERVICE_ID],
    });
    expect(context.activeTarget).toBe(false);
  });
});
