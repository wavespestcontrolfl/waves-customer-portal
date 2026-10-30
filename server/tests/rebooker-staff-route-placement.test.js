/**
 * Staff route insertion (GATE_STAFF_ROUTE_INSERTION, owner 2026-10-25 "save
 * order"): when a staff move's arrival check placed the visit between stops,
 * rescheduleOnce numbers the day in that order AFTER the row's own CAS write
 * (arrival-route.js placeMovedVisit, which reads the gate itself and is
 * stubbed here). Proves only rescheduleOnce's decision to call it; the
 * placement and the numbers it writes are proven in
 * staff-route-insertion.test.js and on PostgreSQL in
 * admin-arrival-window-save-db.test.js. Harness shared in shape with
 * rebooker-capacity-placement.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
  planCallFollowUpShift: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({ clearTechCurrentJob: jest.fn().mockResolvedValue(null) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/scheduling/day-stops', () => ({
  ...jest.requireActual('../services/scheduling/day-stops'),
  preloadServiceLocations: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  prepareArrivalCapacity: jest.fn(),
  verifyArrivalCapacity: jest.fn(),
  persistArrivalOrder: jest.fn(),
  placeMovedVisit: jest.fn(),
}));
jest.mock('../routes/booking', () => ({ _internals: { bookInsertionOffersLive: jest.fn() } }));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { prepareArrivalCapacity, verifyArrivalCapacity, persistArrivalOrder, placeMovedVisit } = require('../services/scheduling/arrival-route');
const { bookInsertionOffersLive } = require('../routes/booking')._internals;
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const BASE = dayOffset(10);
const TARGET = dayOffset(12);
const TECH = 'tech-1';
const savedGate = process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  else process.env.GATE_ADMIN_ARRIVAL_WINDOWS = savedGate;
});

function updateResult(count) {
  const p = Promise.resolve(count);
  return { then: p.then.bind(p), catch: p.catch.bind(p),
    returning: jest.fn().mockResolvedValue(count ? [{ id: 'svc-1', technician_id: TECH }] : []) };
}

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    orWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    forShare: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockImplementation(() => updateResult(1)),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}

function service(overrides = {}) {
  return { id: 'svc-1', customer_id: 'cust-1', technician_id: TECH, visit_id: null, estimated_duration_minutes: 60,
    scheduled_date: BASE, window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', ...overrides };
}

function wireRescheduleMocks(svc) {
  const trxScheduled = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
  const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ first: jest.fn().mockResolvedValue(null) });
    if (table === 'scheduled_services') return trxScheduled;
    if (['job_status_history', 'reschedule_log', 'series_moves'].includes(table)) return chain();
    if (table === 'technicians') {
      return chain({ first: jest.fn().mockResolvedValue({ id: TECH, name: 'Tech', employment_status: 'active', field_dispatchable: true }) });
    }
    if (table === 'technician_absences') return chain({ first: jest.fn().mockResolvedValue(undefined) });
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.fn = { now: jest.fn(() => 'NOW()') };
  const dbQueries = [chain({ first: jest.fn().mockResolvedValue(svc) }), chain({ first: jest.fn().mockResolvedValue({ count: '1' }) })];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services' || table === 'reschedule_log') return dbQueries.shift();
    if (table === 'series_moves') return chain();
    throw new Error(`Unexpected db table ${table}`);
  });
  return { trx, trxScheduled };
}

// The staff screens' options (Reschedule, drag-and-drop, Edit's series commit).
const STAFF = { adminWindowRules: true, overlapAdvisory: true };
const move = (date, window, options) => SmartRebooker.reschedule('svc-1', date, window, 'admin', 'admin', options);

describe('rescheduleOnce numbers the day after a staff move', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    placeMovedVisit.mockResolvedValue(['svc-before', 'svc-1']);
    bookInsertionOffersLive.mockReturnValue(false);
  });

  test('a staff date move calls the placement on the save transaction, after the CAS write', async () => {
    const { trx, trxScheduled } = wireRescheduleMocks(service());
    const result = await move(TARGET, { start: '09:00', end: '10:00' }, STAFF);
    expect(result.success).toBe(true);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    // A staff move: its day is numbered on its picker's road times (GATE_SAVE_ROAD_TIMES).
    expect(placeMovedVisit).toHaveBeenCalledWith(trx, { serviceId: 'svc-1', staffSave: true, lateDays: true });
    // ...and its check reads the same road times (GATE_SAVE_ROAD_TIMES).
    expect(require('../services/scheduling/occupancy').findConflictingVisits).toHaveBeenCalledWith(
      expect.objectContaining({ arrivalWindow: expect.objectContaining({ serviceId: 'svc-1', roads: 'cache' }) }));
    expect(placeMovedVisit.mock.invocationCallOrder[0]).toBeGreaterThan(trxScheduled.update.mock.invocationCallOrder[0]);
  });

  test('a same-day start change is a move too', async () => {
    wireRescheduleMocks(service());
    await move(BASE, { start: '13:00', end: '14:00' }, STAFF);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
  });

  test('Quick Move opts in with placeInRoute (its day options use the staff check)', async () => {
    wireRescheduleMocks(service());
    await move(TARGET, { start: '09:00', end: '10:00' }, { overlapAdvisory: true, placeInRoute: true });
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit).toHaveBeenCalledWith(expect.anything(), { serviceId: 'svc-1', staffSave: true, lateDays: true });
  });

  // staffSave is the move's overlapAdvisory: the tech-out auto-mover (placeInRoute
  // without it) keeps numbering its day on the model.
  test('the tech-out auto-mover is no staff save', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/tech-out-auto-move.js'), 'utf8');
    expect(src).toContain('placeInRoute: true');
    expect(src).not.toContain('overlapAdvisory');
  });

  test('callers that never used the staff check keep today\'s behavior', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());
    await move(TARGET, { start: '09:00', end: '10:00' }, { overlapAdvisory: true });
    expect(placeMovedVisit).not.toHaveBeenCalled();
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ route_order: null }));
  });

  test('no move, no placement: same day, technician and start', async () => {
    wireRescheduleMocks(service());
    await move(BASE, { start: '09:00', end: '10:00' }, STAFF);
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });

  test('a row that keeps a visit id still asks: the placement itself leaves a stop shared with a live member alone', async () => {
    wireRescheduleMocks(service({ visit_id: 'visit-1' }));
    await move(TARGET, { start: '09:00', end: '10:00' }, { ...STAFF, visitPolicy: 'single' });
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
  });

  test('the capacity commit keeps its own order write', async () => {
    bookInsertionOffersLive.mockReturnValue(true);
    prepareArrivalCapacity.mockResolvedValue({ options: {}, fingerprint: 'fp-1', travel: null });
    verifyArrivalCapacity.mockResolvedValue({ feasible: true, routeOrder: ['svc-1'], target: { scheduled_date: TARGET, technician_id: TECH } });
    wireRescheduleMocks(service());
    await move(TARGET, { start: '09:00', end: '10:00' }, { ...STAFF, technicianId: TECH, capacityPlacement: true });
    expect(persistArrivalOrder).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });
});

describe('the series and Edit saves place only the visit the staff check placed (source guards)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

  test('rescheduleSeries places every occurrence it moves, after that occurrence\'s CAS write', () => {
    const src = read('../services/rebooker.js');
    const start = src.indexOf('async rescheduleSeries(serviceId, newDate, newWindow, reason, initiatedBy, options = {}) {');
    const end = src.indexOf('// Read-only preview of what rescheduleSeries would touch', start);
    const body = src.slice(start, end);
    const statement = 'await placeMovedVisit(trx, { serviceId: sib.id, staffSave: overlapAdvisory, ...(overlapAdvisory === true ? { lateDays: true } : {}) });';
    const call = body.indexOf(statement);
    expect(call).toBeGreaterThan(-1);
    expect(body.indexOf('placeMovedVisit(', call + statement.length)).toBe(-1);
    const guard = body.lastIndexOf('if (updateData.window_start\n          && (useArrivalWindows || options.placeInRoute === true)', call);
    expect(guard).toBeGreaterThan(body.indexOf('.update(updateData, SERIES_MOVE_SNAPSHOT_COLUMNS);'));
  });

  test('the Edit save places the edited visit after its moves, unless the office typed a new route number', () => {
    const src = read('../routes/admin-schedule.js');
    expect(src).toContain("if (useArrivalWindows && (scheduleMoveForNotice || assignmentNeedsChange) && !routeNumberTyped) {\n"
      + "        await require('../services/scheduling/arrival-route').placeMovedVisit(trx, { serviceId: req.params.id, staffSave: true, lateDays: true });");
    // Its advisory check reads the pickers' road times too (GATE_SAVE_ROAD_TIMES).
    expect(src).toContain("arrivalWindow: { serviceId: req.params.id, changes: updates, roads: 'cache' },");
    expect(src).toContain("const routeNumberTyped = Number.isInteger(updates.route_order)\n"
      + "        && updates.route_order !== (commsPeek?.route_order ?? null);");
  });
});
