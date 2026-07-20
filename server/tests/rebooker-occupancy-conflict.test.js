/**
 * SmartRebooker.reschedule tech-blind occupancy gate (schedule-conflict
 * lane): the kept-tech overlap check is `if (keptTechId)` + a
 * technician_id-scoped WHERE, so it could never match technician-NULL rows
 * and was skipped entirely for techless visits (reachable via rain-out and
 * reschedule-sms) — the public reschedule silently double-booked. The
 * reschedule now ALSO runs the shared occupancy check (any overlapping row,
 * regardless of technician_id) and fails with the same 409/SLOT_TAKEN shape
 * the tech check uses. Batch movers (rain-out route pushes) pass
 * options.excludeServiceIds so the batch never clashes with itself.
 *
 * The check is guarded by a DATE-wide advisory lock (occupancy:<date>) taken
 * BEFORE the tech-scoped slot-reserve lock: the tech keys are per-tech, so
 * two writers with different techs (or one assigned + one unassigned) took
 * different locks, both passed the tech-blind check under READ COMMITTED,
 * and both committed an overlap. The lock helpers are jest.requireActual'd
 * (only findConflictingVisits is stubbed) so the assertions below see the
 * real lock statements on trx.raw.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  // Real lock helpers (they only issue trx.raw advisory-lock statements the
  // suite asserts on); only the probe itself is stubbed.
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

// Dynamic future dates — hardcoded fixtures time-bomb the suite.
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const BASE = dayOffset(10);
const TARGET = dayOffset(12);

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
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}

function rawFactory(label) {
  return jest.fn((sql, bindings) => ({ label, sql, bindings }));
}

// Every slot-reserve advisory-lock key a transaction took, in acquisition
// order — the ordering IS the deadlock contract (date-occupancy before tech).
function slotReserveKeys(trx) {
  return trx.raw.mock.calls
    .filter((c) => Array.isArray(c[1]) && c[1][0] === 'slot-reserve')
    .map((c) => c[1][1]);
}

function service(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: null, // techless: the tech-scoped check never ran here
    scheduled_date: BASE,
    window_start: '09:00:00',
    window_end: '11:00:00',
    status: 'confirmed',
    ...overrides,
  };
}

function wireRescheduleMocks(svc) {
  const serviceLookup = chain({ first: jest.fn().mockResolvedValue(svc) });
  const trxScheduled = chain({ update: jest.fn().mockResolvedValue(1) });
  const historyInsert = chain();
  const logInsert = chain();
  const followupShift = chain({ update: jest.fn().mockResolvedValue(0) });
  const logCount = chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });

  const trx = jest.fn((table) => {
    if (table === 'scheduled_services') return trxScheduled;
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.fn = { now: jest.fn(() => 'NOW()') };

  const dbQueries = [serviceLookup, followupShift, logCount];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return dbQueries.shift();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { trx, trxScheduled };
}

describe('reschedule — shared occupancy conflict gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    findConflictingVisits.mockResolvedValue([]);
  });

  test('techless move: any overlapping row now 409s with SLOT_TAKEN (was silent)', async () => {
    wireRescheduleMocks(service());
    findConflictingVisits.mockResolvedValue([{ id: 'svc-other', technician_id: null }]);

    await expect(
      SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_sms'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
  });

  test('clean occupancy lets a techless move commit, with the shared-module call shape', async () => {
    const { trx, trxScheduled } = wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_sms',
    );
    expect(result.success).toBe(true);
    expect(trxScheduled.update).toHaveBeenCalled();

    expect(findConflictingVisits).toHaveBeenCalledWith({
      db: trx,
      date: TARGET,
      windowStart: '09:00',
      windowEnd: '11:00',
      excludeServiceIds: ['svc-1'],
      // Matches the tech check's status semantics: a completed morning
      // visit must never block an afternoon move.
      excludeStatuses: ['cancelled', 'completed'],
    });

    // Date-wide occupancy lock FIRST (guards the tech-blind probe), then the
    // tech-scoped slot-reserve lock with the `unassigned` key shape
    // slot-reservation.js uses — the fixed acquisition order that keeps the
    // single path, series path, and zone-null confirm deadlock-free.
    expect(slotReserveKeys(trx)).toEqual([`occupancy:${TARGET}`, `unassigned:${TARGET}`]);

    // The date lock must be HELD when the probe runs — a lock taken after
    // the check would leave the same READ COMMITTED race it exists to close.
    const dateLockOrder = trx.raw.mock.invocationCallOrder[0];
    expect(dateLockOrder).toBeLessThan(findConflictingVisits.mock.invocationCallOrder[0]);
  });

  test('batch moves (rain-out) exclude every visit in the sweep, deduped', async () => {
    wireRescheduleMocks(service());

    await SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'tech',
      { allowLive: true, excludeServiceIds: ['svc-1', 'svc-2', 'svc-3'] },
    );

    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      excludeServiceIds: ['svc-1', 'svc-2', 'svc-3'],
    }));
  });

  test('tech-assigned move keeps the tech-scoped check AND runs the occupancy gate', async () => {
    const { trx, trxScheduled } = wireRescheduleMocks(service({ technician_id: 'tech-1' }));

    await SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin',
    );

    // Existing tech-scoped probe still runs (its query hits the trx builder)...
    expect(trxScheduled.where).toHaveBeenCalledWith('technician_id', 'tech-1');
    // ...alongside the new tech-blind check, under date-occupancy THEN the
    // tech-keyed lock.
    expect(findConflictingVisits).toHaveBeenCalledTimes(1);
    expect(slotReserveKeys(trx)).toEqual([`occupancy:${TARGET}`, `tech-1:${TARGET}`]);
  });

  test('different-tech concurrent writers serialize on ONE shared date key (their tech locks differ)', async () => {
    // The P1 this round closes: the occupancy check is tech-blind, but its
    // only guard was the tech-scoped lock — writers moving DIFFERENT techs
    // (or one assigned + one unassigned) onto the same date took different
    // locks, both passed the global check under READ COMMITTED, and both
    // committed overlapping rows. The date key must be identical across
    // techs so those writers actually serialize.
    const runA = wireRescheduleMocks(service({ id: 'svc-a', technician_id: 'tech-1' }));
    await SmartRebooker.reschedule(
      'svc-a', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin',
    );
    const keysA = slotReserveKeys(runA.trx);

    const runB = wireRescheduleMocks(service({ id: 'svc-b', technician_id: null }));
    await SmartRebooker.reschedule(
      'svc-b', TARGET, { start: '10:00', end: '12:00' }, 'customer_request', 'customer_sms',
    );
    const keysB = slotReserveKeys(runB.trx);

    // Tech-scoped keys differ — on their own they can't serialize this pair.
    expect(keysA[1]).toBe(`tech-1:${TARGET}`);
    expect(keysB[1]).toBe(`unassigned:${TARGET}`);
    // The date-wide key is tech-independent and FIRST for both writers.
    expect(keysA[0]).toBe(`occupancy:${TARGET}`);
    expect(keysB[0]).toBe(keysA[0]);
  });
});

// ---------------------------------------------------------------------------
// Series path (rescheduleSeries) — the two P1s codex found in the SERIES leg:
//   1. a shifted sibling that would overlap an occupied window must be
//      MOVED-OR-ABORTED, never committed unassigned-but-overlapping (an
//      unassigned row still OCCUPIES its window under the tech-blind check).
//   2. the projected-date advisory locks must be acquired BEFORE the parent
//      row UPDATE, so the global order (advisory date locks -> row locks)
//      holds on the series path and can't deadlock a concurrent single move.
// Real lock helpers (acquireOccupancyLocks issues the trx.raw statements the
// assertions read); only findConflictingVisits is stubbed.
// ---------------------------------------------------------------------------
describe('rescheduleSeries — shared occupancy conflict gate + lock order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    findConflictingVisits.mockResolvedValue([]);
  });

  // Every occupancy advisory lock a transaction took, in acquisition order.
  function occupancyLockOrder(trx) {
    const out = [];
    trx.raw.mock.calls.forEach((c, i) => {
      if (Array.isArray(c[1]) && c[1][0] === 'slot-reserve' && String(c[1][1]).startsWith('occupancy:')) {
        out.push(trx.raw.mock.invocationCallOrder[i]);
      }
    });
    return out;
  }

  test('unresolvable sibling overlap ABORTS the series (SLOT_TAKEN) — never commits an unassigned-but-overlapping row', async () => {
    const anchor = {
      id: 'svc-1', customer_id: 'cust-1', technician_id: null,
      scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00',
      status: 'confirmed',
      recurring_parent_id: null, is_recurring: true, recurring_pattern: 'weekly',
      recurring_nth: null, recurring_weekday: null, recurring_interval_days: null,
    };
    const siblings = [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
      { id: 'svc-2', status: 'confirmed', scheduled_date: dayOffset(17), window_start: '09:00:00', window_end: '11:00:00', technician_id: 'tech-9' },
    ];
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
    const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
    const anchorUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const sibUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const historyInsert = chain();
    const logInsert = chain();

    const scheduledQueue = [siblingsQuery, seriesClashProbe, anchorUpdate, sibUpdate];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return historyInsert;
      if (table === 'reschedule_log') return logInsert;
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      throw new Error(`Unexpected db table ${table}`);
    });

    // Anchor window is clear; the recomputed sibling lands on an occupied one.
    findConflictingVisits
      .mockResolvedValueOnce([])                     // anchor occupancy check
      .mockResolvedValueOnce([{ id: 'other-job' }]); // sibling occupancy check

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
    )).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });

    // The KEY invariant: the overlapping sibling is NEVER written — no
    // unassigned-but-overlapping row commits; the whole trx rolls back.
    expect(sibUpdate.update).not.toHaveBeenCalled();
  });

  test('month-based series takes the date advisory locks BEFORE the parent row UPDATE', async () => {
    const anchor = {
      id: 'svc-1', customer_id: 'cust-1', technician_id: null,
      scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00',
      status: 'confirmed',
      recurring_parent_id: null, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_nth: null, recurring_weekday: null, recurring_interval_days: null,
    };
    const siblings = [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
    ];
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
    const parentUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
    const anchorUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
    const logInsert = chain();

    // Month-based order: siblings SELECT, parent UPDATE, seriesClash probe,
    // anchor UPDATE.
    const scheduledQueue = [siblingsQuery, parentUpdate, seriesClashProbe, anchorUpdate];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return chain();
      if (table === 'reschedule_log') return logInsert;
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      throw new Error(`Unexpected db table ${table}`);
    });

    const result = await SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin',
    );
    expect(result.success).toBe(true);

    // The parent recurrence-anchor UPDATE ran…
    expect(parentUpdate.update).toHaveBeenCalled();
    // …and the date advisory lock was HELD first (rung 1 before the first row
    // lock) — the inversion that would deadlock a concurrent single move.
    const lockOrders = occupancyLockOrder(trx);
    expect(lockOrders.length).toBeGreaterThan(0);
    expect(lockOrders[0]).toBeLessThan(parentUpdate.update.mock.invocationCallOrder[0]);
  });
});
