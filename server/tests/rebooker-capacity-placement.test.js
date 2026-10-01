/**
 * Mid-route insertion certification on the single-visit public reschedule
 * commit (owner 2026-09-28; docs/public-route-contracts.md) — the reschedule
 * counterpart to PR #5231's /book capacity commit.
 *
 * reschedule-public.js's picker now offers a slot BETWEEN two existing
 * stops (capacityPlacement: bookInsertionOffersLive()) the same way /book's
 * self-booking offers do. Committing one safely requires the SAME
 * prepareArrivalCapacity / verifyArrivalCapacity / persistArrivalOrder
 * sequence createSelfBooking runs — otherwise the day/tech move would clear
 * route_order (the existing "append-only" behavior) and the stop would land
 * unnumbered at the end of the day, not at the position it was offered at.
 *
 * This file proves the WIRING inside rescheduleOnce (services/rebooker.js):
 * when the caller opts in (options.capacityPlacement: true — ONLY
 * reschedule-public.js sets it) AND the live canonical reader
 * (routes/booking.js's bookInsertionOffersLive, re-read here rather than
 * trusted from the caller) says the policy is live, prepare runs before any
 * lock, verify runs under the SAME tech-day lock rung the plain occupancy
 * checks already take, and persist runs only after the row's own CAS write
 * lands. The arrival-route engine's OWN simulation correctness (a feasible
 * slot stays feasible, a stale stored order is corrected) is proven
 * separately against real PostgreSQL in booking-capacity-commit-db.test.js —
 * this suite stubs prepareArrivalCapacity/verifyArrivalCapacity/
 * persistArrivalOrder themselves, the same way the sibling
 * rebooker-occupancy-conflict.test.js stubs findConflictingVisits, so it
 * can assert WHERE and WHEN rescheduleOnce calls them without needing a
 * live database or the whole-route simulation.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
  planCallFollowUpShift: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/scheduling/day-stops', () => ({
  ...jest.requireActual('../services/scheduling/day-stops'),
  preloadServiceLocations: jest.fn().mockResolvedValue(undefined),
}));
// The three capacity primitives createSelfBooking already relies on
// (booking-capacity-commit-db.test.js proves their own behavior against
// real Postgres) — stubbed here so this suite tests only rescheduleOnce's
// OWN decision to call them, not the whole-route simulation.
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  prepareArrivalCapacity: jest.fn(),
  verifyArrivalCapacity: jest.fn(),
  persistArrivalOrder: jest.fn(),
}));
// The canonical live reader (routes/booking.js) — never trusted from the
// caller; rescheduleOnce re-reads it itself (see the comment on
// options.capacityPlacement in services/rebooker.js).
jest.mock('../routes/booking', () => ({
  _internals: { bookInsertionOffersLive: jest.fn() },
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { prepareArrivalCapacity, verifyArrivalCapacity, persistArrivalOrder } = require('../services/scheduling/arrival-route');
const { bookInsertionOffersLive } = require('../routes/booking')._internals;
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const BASE = dayOffset(10);
const TARGET = dayOffset(12);
const TECH = 'tech-1';

function updateResult(count, rows) {
  const p = Promise.resolve(count);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    returning: jest.fn().mockResolvedValue(rows ?? (count ? [{ id: 'svc-1', technician_id: TECH }] : [])),
  };
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

function rawFactory(label) {
  return jest.fn((sql, bindings) => ({ label, sql, bindings }));
}

function service(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: TECH,
    visit_id: null,
    estimated_duration_minutes: 60,
    scheduled_date: BASE,
    window_start: '09:00:00',
    window_end: '11:00:00',
    status: 'confirmed',
    ...overrides,
  };
}

function wireRescheduleMocks(svc) {
  const serviceLookup = chain({ first: jest.fn().mockResolvedValue(svc) });
  const trxScheduled = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
  const historyInsert = chain();
  const logInsert = chain();
  const logCount = chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });

  const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ first: jest.fn().mockResolvedValue(null) });
    if (table === 'scheduled_services') return trxScheduled;
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    if (table === 'series_moves') return chain();
    if (table === 'technicians') {
      return chain({ first: jest.fn().mockResolvedValue({ id: svc.technician_id || TECH, name: 'Tech', employment_status: 'active', field_dispatchable: true }) });
    }
    if (table === 'technician_absences') return chain({ first: jest.fn().mockResolvedValue(undefined) });
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.fn = { now: jest.fn(() => 'NOW()') };

  const dbQueries = [serviceLookup, logCount];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return dbQueries.shift();
    if (table === 'series_moves') return chain();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { trx, trxScheduled };
}

// A DATE move (BASE -> TARGET) that also carries a technician — the ONE case
// this lane changes: route_order would otherwise always be nulled.
const MOVE_ARGS = ['svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve'];

describe('rescheduleOnce — mid-route insertion certification (options.capacityPlacement)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    findConflictingVisits.mockResolvedValue([]);
    prepareArrivalCapacity.mockResolvedValue({ options: {}, fingerprint: 'fp-1', travel: null });
    verifyArrivalCapacity.mockResolvedValue({ feasible: true, routeOrder: ['svc-before', 'svc-1', 'svc-after'], target: { scheduled_date: TARGET, technician_id: TECH } });
    persistArrivalOrder.mockResolvedValue(undefined);
    bookInsertionOffersLive.mockReturnValue(true);
  });

  test('gate on + capacityPlacement: true — prepares before any lock, verifies under the trx, and persists the certified order after the CAS write', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(...MOVE_ARGS, { technicianId: TECH, capacityPlacement: true, travelGap: true });

    expect(result.success).toBe(true);
    expect(prepareArrivalCapacity).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'svc-1', date: TARGET, technicianId: TECH, windowStart: '09:00', windowEnd: '11:00',
    }));
    expect(verifyArrivalCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'fp-1' }),
      expect.objectContaining({ conn: expect.any(Function), windowStart: '09:00', windowEnd: '11:00' }),
    );
    // Verify runs on the SAME trx the CAS write and lock calls use.
    expect(verifyArrivalCapacity.mock.calls[0][1].conn).toHaveBeenCalled(); // trx is a jest.fn table accessor
    expect(persistArrivalOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ feasible: true }), 'svc-1');
    // persist runs AFTER the row's own CAS write, not before.
    const updateOrder = trxScheduled.update.mock.invocationCallOrder[0];
    const persistOrder = persistArrivalOrder.mock.invocationCallOrder[0];
    expect(persistOrder).toBeGreaterThan(updateOrder);
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ route_order: null }));
  });

  test('verify failure refuses with the standard "pick another appointment" 409 and never writes the row', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());
    verifyArrivalCapacity.mockRejectedValue(Object.assign(new Error('This time is no longer available. Please choose another appointment.'), {
      code: 'SLOT_UNAVAILABLE', status: 409, statusCode: 409, isOperational: true,
    }));

    await expect(
      SmartRebooker.reschedule(...MOVE_ARGS, { technicianId: TECH, capacityPlacement: true, travelGap: true }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_UNAVAILABLE' });

    expect(prepareArrivalCapacity).toHaveBeenCalled();
    expect(verifyArrivalCapacity).toHaveBeenCalled();
    expect(persistArrivalOrder).not.toHaveBeenCalled();
    expect(trxScheduled.update).not.toHaveBeenCalled();
  });

  test('gate off (bookInsertionOffersLive false) — unchanged: prepare/verify/persist never run, route_order still nulled on the move', async () => {
    bookInsertionOffersLive.mockReturnValue(false);
    const { trxScheduled } = wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(...MOVE_ARGS, { technicianId: TECH, capacityPlacement: true, travelGap: true });

    expect(result.success).toBe(true);
    expect(prepareArrivalCapacity).not.toHaveBeenCalled();
    expect(verifyArrivalCapacity).not.toHaveBeenCalled();
    expect(persistArrivalOrder).not.toHaveBeenCalled();
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ route_order: null }));
  });

  test('caller omits capacityPlacement (every OTHER rebooker.reschedule caller — admin dispatch, auto-dispatch, rain-out, SMS reply) — unchanged even with the gate live', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(...MOVE_ARGS, { technicianId: TECH, travelGap: true });

    expect(result.success).toBe(true);
    expect(prepareArrivalCapacity).not.toHaveBeenCalled();
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ route_order: null }));
  });

  test('a grouped visit (visit_id set) never attempts certification, even with capacityPlacement: true — moveVisitAsUnit forwards options unchanged into its own per-member calls tagged visitPolicy:"single"', async () => {
    const { trxScheduled } = wireRescheduleMocks(service({ visit_id: 'visit-1' }));

    const result = await SmartRebooker.reschedule(
      ...MOVE_ARGS,
      { technicianId: TECH, capacityPlacement: true, travelGap: true, visitPolicy: 'single' },
    );

    expect(result.success).toBe(true);
    expect(prepareArrivalCapacity).not.toHaveBeenCalled();
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ route_order: null }));
  });

  test('a genuine no-op (same day, same tech, same window) never attempts certification — nothing about this stop\'s placement changed', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(
      'svc-1', BASE, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
      { technicianId: TECH, capacityPlacement: true, travelGap: true },
    );

    expect(result.success).toBe(true);
    expect(prepareArrivalCapacity).not.toHaveBeenCalled();
    // route_order is simply absent from the update — never invalidated.
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.not.objectContaining({ route_order: null }));
  });

  test('a same-day, same-tech WINDOW change DOES attempt certification (Codex round 1 P1, PR #5267) — the picker can offer a mid-route slot on the same day, and the stored route_order must not silently survive a move that changed this stop\'s place in the route', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(
      'svc-1', BASE, { start: '13:00', end: '15:00' }, 'customer_request', 'customer_self_serve',
      { technicianId: TECH, capacityPlacement: true, travelGap: true },
    );

    expect(result.success).toBe(true);
    expect(prepareArrivalCapacity).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'svc-1', date: BASE, technicianId: TECH, windowStart: '13:00', windowEnd: '15:00',
      // loadArrivalRouteContext only tries every insertion position on a
      // same-day same-tech move when the new window arrives as a CHANGE
      // (Codex r3 P1) — the evaluation option alone keeps the old position.
      changes: expect.objectContaining({ window_start: '13:00' }),
    }));
    expect(verifyArrivalCapacity).toHaveBeenCalled();
    expect(persistArrivalOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ feasible: true }), 'svc-1');
    // route_order is untouched by the CAS write itself (routeOrderInvalidated
    // is still false — no day/tech change) — persistArrivalOrder is what
    // corrects it afterward.
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.not.objectContaining({ route_order: null }));
  });

  test('the row itself is locked (FOR UPDATE) before verify — Codex round 1 P1, PR #5267: closes the race against a concurrent edit to this row\'s own duration/address/service_type', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());
    let sawLockBeforeVerify = false;
    const originalForUpdate = trxScheduled.forUpdate;
    trxScheduled.forUpdate = jest.fn(() => {
      // At the moment the lock is taken, verify must not have run yet.
      sawLockBeforeVerify = verifyArrivalCapacity.mock.calls.length === 0;
      return originalForUpdate.call(trxScheduled);
    });

    await SmartRebooker.reschedule(...MOVE_ARGS, { technicianId: TECH, capacityPlacement: true, travelGap: true });

    expect(trxScheduled.forUpdate).toHaveBeenCalled();
    expect(sawLockBeforeVerify).toBe(true);
    expect(verifyArrivalCapacity).toHaveBeenCalled();
  });
});

describe('rescheduleSeries never reads options.capacityPlacement (source guard — series stays append-only)', () => {
  test('the function body between "async rescheduleSeries(" and its closing brace never references capacityPlacement', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/rebooker.js'), 'utf8');
    const start = src.indexOf('async rescheduleSeries(serviceId, newDate, newWindow, reason, initiatedBy, options = {}) {');
    expect(start).toBeGreaterThan(-1);
    // rescheduleSeries is the last method before the module's read-only
    // preview helper — bounded by that next method's own signature rather
    // than a brace-counter (consistent with this file's other source-slice
    // guards, e.g. booking-capacity-commit.test.js).
    const end = src.indexOf('// Read-only preview of what rescheduleSeries would touch', start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('capacityPlacement');
  });
});
