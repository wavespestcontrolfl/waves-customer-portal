/**
 * Combo route check, engine (scope ~/combo-visit-route-check-scope-20261003,
 * owner 2026-10-03). A visit shared by two or more services answered
 * `route_unverified` on every path, because certifying one half alone would
 * under-count the work at the stop. A caller that moves the WHOLE visit
 * passes `unit: true`: under GATE_COMBO_ROUTE_CHECK the members leave the
 * day's rows and ride the target as one stop with their summed work.
 * Anything that is not one clean stop, every caller that does not pass
 * `unit`, and the gate off all keep today's answer.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
let mockDayRows = [];
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: () => {
    const q = { where: () => q, then: (resolve, reject) => Promise.resolve(mockDayRows).then(resolve, reject) };
    return q;
  },
  guardedCoordSelects: () => [],
  serviceLocationSelects: () => [],
  resolveServiceLocation: async (row) => ({ lat: row.lat, lng: row.lng }),
}));

const { loadArrivalRouteContext, evaluateArrivalPlacement, _internals: { foldVisitUnit } } = require('../services/scheduling/arrival-route');

const DATE = '2035-03-06';
const stop = (id, over = {}) => ({
  id, visit_id: 'v1', technician_id: 't1', customer_id: 'c1', scheduled_date: DATE, status: 'confirmed',
  window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 30, route_order: 1,
  created_at: '2035-01-01T00:00:00Z', lat: 27.5, lng: -82.5, ...over,
});

// One scheduled_services read each: the target (first), the grouped probe
// (first('id')), the siblings (select).
function fakeConn({ target, siblings }) {
  const conn = jest.fn((table) => {
    const state = { filters: {} };
    const chain = {};
    for (const m of ['leftJoin', 'whereNot', 'whereNotIn', 'whereNull', 'orWhereNull', 'orderBy']) chain[m] = () => chain;
    chain.where = (...args) => { if (args[0] === 'scheduled_services.id') state.byId = true; return chain; };
    chain.first = async (...cols) => {
      if (table !== 'scheduled_services') return null;
      if (state.byId) return target;
      return cols[0] === 'id' ? (siblings[0] ? { id: siblings[0].id } : null) : null;
    };
    chain.select = async () => (table === 'scheduled_services' ? siblings : []);
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  });
  conn.isTransaction = false;
  return conn;
}
const load = (conn, options = {}) => loadArrivalRouteContext({ conn, serviceId: 'a', date: '2035-03-08', ...options });

beforeEach(() => { mockDayRows = []; delete process.env.GATE_COMBO_ROUTE_CHECK; delete process.env.GATE_SCHEDULING_CAPACITY; });
afterAll(() => { delete process.env.GATE_COMBO_ROUTE_CHECK; });

describe('foldVisitUnit', () => {
  test('two services at one stop become one target with their summed work and both ids', () => {
    const a = stop('a');
    const b = stop('b', { estimated_duration_minutes: 45, window_start: '09:00:00', window_end: '09:45:00' });
    const unit = foldVisitUnit(a, a, [b]);
    expect(unit.memberIds).toEqual(['a', 'b']);
    // a: max(60-minute span, 30) = 60; b: max(45-minute span, 45) = 45.
    expect(unit.estimated_duration_minutes).toBe(105);
    expect(unit.id).toBe('a');
  });

  test('a pending length change on the tapped service is in the total', () => {
    const stored = stop('a', { estimated_duration_minutes: 60 });
    const edited = { ...stored, estimated_duration_minutes: 120 };
    expect(foldVisitUnit(edited, stored, [stop('b', { estimated_duration_minutes: 60 })]).estimated_duration_minutes).toBe(180);
  });

  test('not one clean stop: another technician, other or missing coordinates, another day, or a member under way', () => {
    const a = stop('a');
    expect(foldVisitUnit(a, a, [stop('b', { technician_id: 't2' })])).toBe(null);
    expect(foldVisitUnit(a, a, [stop('b', { lat: 27.6 })])).toBe(null);
    expect(foldVisitUnit(a, a, [stop('b', { lat: null, lng: null })])).toBe(null);
    expect(foldVisitUnit(a, a, [stop('b', { scheduled_date: '2035-03-07' })])).toBe(null);
    expect(foldVisitUnit(a, a, [stop('b', { status: 'on_site' })])).toBe(null);
    expect(foldVisitUnit({ ...a, lat: null }, a, [stop('b')])).toBe(null);
  });
});

describe('loadArrivalRouteContext({ unit })', () => {
  test('gate on + unit: the visit is one ungrouped target and its members are off the day', async () => {
    process.env.GATE_COMBO_ROUTE_CHECK = 'true';
    mockDayRows = [stop('b', { scheduled_date: '2035-03-08' }), stop('x', { visit_id: null, scheduled_date: '2035-03-08', lat: 27.4, lng: -82.4 })];
    const context = await load(fakeConn({ target: stop('a'), siblings: [stop('b')] }), { unit: true });
    expect(context.grouped).toBe(false);
    expect(context.target.memberIds).toEqual(['a', 'b']);
    expect(context.target.estimated_duration_minutes).toBe(120);
    expect(context.rows.map((row) => row.id)).toEqual(['x']);
    // The engine then places it like any single visit, never "unverified" for being grouped.
    const fit = evaluateArrivalPlacement(context, { windowStart: '09:00', windowEnd: '11:00', durationMinutes: 120 });
    expect(fit.reason).not.toBe('route_unverified');
  });

  test('gate off, no unit, or not one clean stop: grouped, exactly as before', async () => {
    const conn = () => fakeConn({ target: stop('a'), siblings: [stop('b')] });
    const gateOff = await load(conn(), { unit: true });
    expect(gateOff.grouped).toBe(true);
    expect(gateOff.target.memberIds).toBeUndefined();
    process.env.GATE_COMBO_ROUTE_CHECK = 'true';
    const noUnit = await load(conn());
    expect(noUnit.grouped).toBe(true);
    const mixedTech = await load(fakeConn({ target: stop('a'), siblings: [stop('b', { technician_id: 't2' })] }), { unit: true });
    expect(mixedTech.grouped).toBe(true);
    expect(evaluateArrivalPlacement(mixedTech, { windowStart: '09:00', windowEnd: '11:00', durationMinutes: 60 }).reason).toBe('route_unverified');
  });

  test('a visit with no live sibling is not grouped and is untouched by unit', async () => {
    process.env.GATE_COMBO_ROUTE_CHECK = 'true';
    const solo = await load(fakeConn({ target: stop('a'), siblings: [] }), { unit: true });
    expect(solo.grouped).toBe(false);
    expect(solo.target.memberIds).toBeUndefined();
    expect(solo.target.estimated_duration_minutes).toBe(30);
  });
});

describe('who asks for the whole visit', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  test('the staff availability box does (the hint route, on both slot-finder paths, and the picked-hour verdict); nothing else does', () => {
    const hints = read('services/scheduling/find-time-hints.js');
    const verdict = hints.slice(hints.indexOf('async function pickedByArrivalChecker'));
    expect(verdict.slice(0, verdict.indexOf('if (fit.feasible)'))).toContain('unit: true,');
    // The hint route marks its existing-visit request; the slot finder forwards
    // that mark on the capacity path and on the non-capacity path.
    expect(read('routes/admin-schedule-find-time.js')).toContain('arrivalWindow: { serviceId, changes: hintChanges, unit: true }');
    const findTime = read('services/scheduling/find-time.js');
    expect(findTime.split('unit: opts.arrivalWindow.unit === true').length - 1).toBe(2);
    expect(findTime.includes('unit: true')).toBe(false);
    for (const file of ['routes/booking.js', 'services/slot-reservation.js', 'services/rebooker.js', 'services/rain-out.js', 'services/tech-out-auto-move.js', 'services/scheduling/occupancy.js', 'routes/admin-schedule.js']) {
      expect(read(file).includes('unit: true')).toBe(false);
    }
  });
});
