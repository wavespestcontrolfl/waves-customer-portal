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
// The follow-up shift is a separate fenced+transactional unit with its own
// suite (call-booking-catalog.test.js) — mocked so this suite's sequential
// db-query queue models only the rebooker's own queries.
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

// An UPDATE result that resolves to the row count like knex AND answers
// `.returning([...])` with the committed row (the reschedule writer reads the
// committed technician_id off the CAS write).
function updateResult(count, rows) {
  const p = Promise.resolve(count);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    returning: jest.fn().mockResolvedValue(rows ?? (count ? [{ id: 'svc-1', technician_id: 'tech-1' }] : [])),
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
  const trxScheduled = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
  const historyInsert = chain();
  const logInsert = chain();
  const logCount = chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });

  const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
    if (table === 'scheduled_services') return trxScheduled;
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    if (table === 'series_moves') return chain();
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.fn = { now: jest.fn(() => 'NOW()') };

  const dbQueries = [serviceLookup, logCount];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return dbQueries.shift();
    // The series writer always looks up a prior operation_key first — none here.
    if (table === 'series_moves') return chain();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { trx, trxScheduled };
}

describe('reschedule — shared occupancy conflict gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    findConflictingVisits.mockReset().mockResolvedValue([]);
  });

  test.each([null, { start: '09:00', end: '11:00' }])('single move keeps its dispatch obligation until timed: %j', async (window) => {
    const { trxScheduled } = wireRescheduleMocks(service({
      window_start: null, window_end: null, recurring_dispatch_due_date: BASE,
    }));
    const result = await SmartRebooker.reschedule('svc-1', TARGET, window, 'customer_request', 'admin');
    expect(result.success).toBe(true);
    expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({
      recurring_dispatch_due_date: window ? null : TARGET,
    }));
  });

  test('techless move: any overlapping row now 409s with SLOT_TAKEN (was silent)', async () => {
    wireRescheduleMocks(service());
    findConflictingVisits.mockResolvedValue([{ id: 'svc-other', technician_id: null }]);

    await expect(
      SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_sms'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
  });

  test('overlapAdvisory (staff dispatch): the same overlap COMMITS the move and returns a warning naming the date', async () => {
    const { trxScheduled } = wireRescheduleMocks(service());
    findConflictingVisits.mockResolvedValue([{ id: 'svc-other', technician_id: null }]);

    const result = await SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', { overlapAdvisory: true },
    );
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining(TARGET)]);
    expect(trxScheduled.update).toHaveBeenCalled();
  });

  test('keepStatus (office Combine): a pending row keeps pending and writes no status history; the default still lands on confirmed', async () => {
    const kept = wireRescheduleMocks(service({ status: 'pending' }));
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', { overlapAdvisory: true, keepStatus: true });
    expect(kept.trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
    expect(kept.trx.mock.calls.some((c) => c[0] === 'job_status_history')).toBe(false);

    const flipped = wireRescheduleMocks(service({ status: 'pending' }));
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', { overlapAdvisory: true });
    expect(flipped.trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
    expect(flipped.trx.mock.calls.some((c) => c[0] === 'job_status_history')).toBe(true);
  });

  test('clearWindowEnd: an end of null is WRITTEN as null instead of keeping the row\'s current end (Combine compensation)', async () => {
    const kept = wireRescheduleMocks(service({ window_end: '11:30:00' }));
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: null }, 'admin', 'admin', { overlapAdvisory: true, adminWindowRules: true });
    expect(kept.trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ window_start: '13:00', window_end: '11:30:00' }));

    const cleared = wireRescheduleMocks(service({ window_end: '11:30:00' }));
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: null }, 'admin', 'admin', { overlapAdvisory: true, adminWindowRules: true, clearWindowEnd: true });
    expect(cleared.trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ window_start: '13:00', window_end: null }));
  });

  test('overlapAdvisory with a clean slot carries no warnings key', async () => {
    wireRescheduleMocks(service());

    const result = await SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', { overlapAdvisory: true },
    );
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
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
      excludeStatuses: ['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed'],
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

  describe('null window_end — derived occupancy span (was: gate skipped entirely)', () => {
    afterEach(() => { delete process.env.REBOOKER_NULL_END_OCCUPANCY; });

    test('a start-but-no-end move now probes its duration-derived span and 409s on a clash', async () => {
      // Neither the target window nor the row carries an end, so the old
      // guard (`updates.window_start && windowEnd`) skipped locks AND both
      // probes — the move landed on an occupied slot with NO check. The
      // gate now derives the span the row will occupy per the read
      // predicate (start + duration) and probes that.
      wireRescheduleMocks(service({ window_end: null, estimated_duration_minutes: 90 }));
      findConflictingVisits.mockResolvedValue([{ id: 'svc-other', technician_id: null }]);

      await expect(
        SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: null }, 'customer_request', 'customer_sms'),
      ).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });

      // 90-minute duration → 10:30, NOT the flat-60 10:00 — the same
      // COALESCE(NULLIF(estimated_duration_minutes,0),60) the SQL predicate
      // applies once the row is booked.
      expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
        windowStart: '09:00',
        windowEnd: '10:30',
        excludeStatuses: ['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed'],
      }));
    });

    test('clean derived-span move commits, holds the locks, and persists window_end as NULL', async () => {
      const { trx, trxScheduled } = wireRescheduleMocks(service({ window_end: null, estimated_duration_minutes: null }));

      const result = await SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: null }, 'customer_request', 'customer_sms',
      );
      expect(result.success).toBe(true);

      // Null/0 duration falls back to 60 — identical to the SQL fallback.
      expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
        windowStart: '09:00',
        windowEnd: '10:00',
      }));
      // The derived span is the GATE only — the persisted row keeps its
      // open-ended window (admin edits leave these deliberately).
      expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ window_end: null }));
      // Locks now guard this path too (they were skipped along with the
      // probe): date-occupancy first, then the tech-scoped key.
      expect(slotReserveKeys(trx)).toEqual([`occupancy:${TARGET}`, `unassigned:${TARGET}`]);
    });

    test('REBOOKER_NULL_END_OCCUPANCY=off restores the legacy skip', async () => {
      process.env.REBOOKER_NULL_END_OCCUPANCY = 'off';
      const { trx, trxScheduled } = wireRescheduleMocks(service({ window_end: null, estimated_duration_minutes: 90 }));
      findConflictingVisits.mockResolvedValue([{ id: 'svc-other', technician_id: null }]);

      // Clash present, but with the kill switch off the gate never runs —
      // exact pre-fix behavior, the one-click revoke if enforcement starts
      // rejecting moves the business wants through.
      const result = await SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: null }, 'customer_request', 'customer_sms',
      );
      expect(result.success).toBe(true);
      expect(findConflictingVisits).not.toHaveBeenCalled();
      expect(slotReserveKeys(trx)).toEqual([]);
      expect(trxScheduled.update).toHaveBeenCalledWith(expect.objectContaining({ window_end: null }));
    });

    test('a null-end move whose derived span crosses midnight is REJECTED, not clamped', async () => {
      // deriveWindowEnd (datetime-et) is the canonical derivation and its
      // contract is inherited whole: null = validation failure, never a
      // windowless visit. A 23:59 clamp would silently leave the tail
      // unprobed, and Postgres time arithmetic would wrap the booked row's
      // effective end before its start (codex #3377 P1). Same rejection
      // admin-schedule and the IB reschedule tool raise.
      wireRescheduleMocks(service({ window_end: null, estimated_duration_minutes: 90 }));

      await expect(
        SmartRebooker.reschedule('svc-1', TARGET, { start: '23:00', end: null }, 'customer_request', 'customer_sms'),
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_WINDOW' });
      expect(findConflictingVisits).not.toHaveBeenCalled();
    });

    test('the derived-span CAS pins the observed duration; a stored end does not', async () => {
      // The probe span came FROM estimated_duration_minutes, and the admin
      // editor can commit a duration-only update concurrently — the
      // advisory locks cannot serialize it (that editor takes none). The
      // update must therefore CAS on the duration it probed with, so a
      // raced edit misses the write and 409s instead of leaving the tail
      // of the NEW duration unchecked (codex #3377 P1).
      const first = wireRescheduleMocks(service({ window_end: null, estimated_duration_minutes: 90 }));
      await SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: null }, 'customer_request', 'customer_sms',
      );
      expect(first.trxScheduled.where).toHaveBeenCalledWith({ estimated_duration_minutes: 90 });

      // With a stored end the probe never reads the duration — no pin, so
      // unrelated duration edits cannot 409 a normal windowed move.
      jest.clearAllMocks();
      db.raw = rawFactory('db.raw');
      findConflictingVisits.mockReset().mockResolvedValue([]);
      const second = wireRescheduleMocks(service({ estimated_duration_minutes: 90 }));
      await SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_sms',
      );
      const pinned = second.trxScheduled.where.mock.calls
        .some((c) => c[0] && typeof c[0] === 'object' && 'estimated_duration_minutes' in c[0]);
      expect(pinned).toBe(false);
    });

    test('a windowless move (no start either) still skips the gate — inert to the predicate', async () => {
      wireRescheduleMocks(service({ window_start: null, window_end: null }));

      const result = await SmartRebooker.reschedule(
        'svc-1', TARGET, null, 'customer_request', 'customer_sms',
      );
      expect(result.success).toBe(true);
      expect(findConflictingVisits).not.toHaveBeenCalled();
    });

    test('a stored end still wins over the derivation (unchanged fast path)', async () => {
      wireRescheduleMocks(service({ estimated_duration_minutes: 90 }));

      await SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_sms',
      );
      expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
        windowEnd: '11:00',
      }));
    });
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
  const originalPlacementGate = process.env.GATE_CUSTOMER_RECURRING_DISPATCH;
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPlacementGate === undefined) delete process.env.GATE_CUSTOMER_RECURRING_DISPATCH;
    else process.env.GATE_CUSTOMER_RECURRING_DISPATCH = originalPlacementGate;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    findConflictingVisits.mockReset().mockResolvedValue([]);
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
    const anchorUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const sibUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const historyInsert = chain();
    const logInsert = chain();

    const scheduledQueue = [siblingsQuery, siblingsQuery, parentLookup, seriesClashProbe, anchorUpdate, sibUpdate];
    const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return historyInsert;
      if (table === 'reschedule_log') return logInsert;
      if (table === 'series_moves') return chain();
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      // The series writer always looks up a prior operation_key first — none here.
      if (table === 'series_moves') return chain();
      throw new Error(`Unexpected db table ${table}`);
    });

    // Anchor window is clear; the recomputed sibling lands on an occupied one.
    findConflictingVisits
      .mockResolvedValueOnce([])                     // anchor occupancy check
      .mockResolvedValueOnce([{ id: 'other-job' }]); // sibling occupancy check

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'SLOT_TAKEN',
      // Customer surfaces branch on this to explain a plan-level day
      // conflict instead of looping "that time was just taken".
      subcode: 'SERIES_PROJECTION',
    });

    // The KEY invariant: the overlapping sibling is NEVER written — no
    // unassigned-but-overlapping row commits; the whole trx rolls back.
    expect(sibUpdate.update).not.toHaveBeenCalled();
  });

  test.each(['staff_deferred', 'sms_deferred', 'web_gate_off_deferred', 'staff_timed_marker', 'staff', 'customer', 'customer_sms', 'customer_locked', 'customer_confirmed', 'customer_rescheduled', 'customer_grouped', 'customer_anchor_taken', 'customer_stale_disclosure'])('%s: quarterly move honors disclosed future-placement scope', async (actor) => {
    const existingHandoff = ['staff_deferred', 'sms_deferred', 'web_gate_off_deferred', 'staff_timed_marker'].includes(actor);
    process.env.GATE_CUSTOMER_RECURRING_DISPATCH = actor === 'web_gate_off_deferred' ? 'false' : 'true';
    jest.spyOn(require('../services/auto-dispatch/config'), 'isCustomerRecurringDispatchEnabled').mockReturnValue(actor !== 'web_gate_off_deferred');
    const anchor = {
      id: 'svc-1', customer_id: 'cust-1', technician_id: null,
      scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00',
      status: 'confirmed',
      recurring_parent_id: null, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_nth: null, recurring_weekday: null, recurring_interval_days: null,
    };
    const siblings = [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
      { id: 'svc-2', status: 'confirmed', scheduled_date: dayOffset(100), window_start: '09:00:00', window_end: '11:00:00', technician_id: 'tech-9' },
    ];
    siblings.push({ ...siblings[1], id: 'svc-3', scheduled_date: dayOffset(190) });
    siblings.push({ ...siblings[1], id: 'svc-4', scheduled_date: dayOffset(280) });
    if (existingHandoff) {
      for (const sibling of siblings.slice(1)) {
        sibling.recurring_dispatch_due_date = sibling.scheduled_date;
        if (actor !== 'staff_timed_marker') { sibling.window_start = null; sibling.window_end = null; }
      }
    }
    const preservesFuture = ['customer_locked', 'customer_confirmed', 'customer_rescheduled', 'customer_grouped'].includes(actor);
    if (actor === 'customer_locked') siblings[1].auto_dispatch_locked = true;
    if (actor === 'customer_confirmed') siblings[1].customer_confirmed = true;
    if (actor === 'customer_rescheduled') siblings[1].status = 'rescheduled';
    if (actor === 'customer_grouped') {
      siblings[1].visit_id = 'future-visit';
      jest.spyOn(require('../services/visit-groups'), 'frozenVisitVerdict').mockResolvedValue({ frozen: false });
    }
    if (actor === 'customer') {
      // Every later date is blacked out; only the selected date is open.
      jest.spyOn(require('../services/scheduling/blackout-dates'), 'getBlackoutDates')
        .mockResolvedValue({ has: date => date !== TARGET });
    }
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
    const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
    if (actor === 'customer') {
      // A same-plan future-date collision must also become dispatch work.
      seriesClashProbe.first.mockImplementation(async () => {
        const dates = seriesClashProbe.whereIn.mock.calls[0][1];
        return dates.some(date => date !== TARGET) ? { id: 'existing-future-visit' } : undefined;
      });
    }
    const anchorUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const sibUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const historyInsert = chain();
    const logInsert = chain();

    const scheduledQueue = [siblingsQuery, siblingsQuery, parentLookup, chain(), seriesClashProbe, anchorUpdate, sibUpdate, sibUpdate, sibUpdate];
    const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return historyInsert;
      if (table === 'reschedule_log') return logInsert;
      if (table === 'series_moves') return chain();
      if (table === 'appointment_reminders') return chain({ first: jest.fn().mockResolvedValue(null), select: jest.fn().mockResolvedValue([]) });
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    if (actor === 'customer_grouped') {
      const raw = trx.raw.getMockImplementation();
      trx.raw.mockImplementation((sql, values) => sql.includes('count(*)::int AS n FROM scheduled_services WHERE visit_id')
        ? { rows: [{ n: 2 }] } : raw(sql, values));
    }
    trx.transaction = jest.fn(async (callback) => callback(trx));
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      // The series writer always looks up a prior operation_key first — none here.
      if (table === 'series_moves') return chain();
      if (table === 'appointment_reminders') return chain({ first: jest.fn().mockResolvedValue(null), select: jest.fn().mockResolvedValue([]) });
      throw new Error(`Unexpected db table ${table}`);
    });

    // Anchor window is clear; the recomputed sibling lands on an occupied one.
    findConflictingVisits
      .mockResolvedValueOnce([])                     // anchor occupancy check
      .mockResolvedValueOnce([{ id: 'other-job' }])  // second visit conflicts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'another-job' }]); // fourth visit conflicts
    if (existingHandoff) {
      findConflictingVisits.mockReset().mockResolvedValue([]);
      const source = actor === 'sms_deferred' ? 'customer_sms'
        : actor === 'web_gate_off_deferred' ? 'customer_self_serve' : 'admin';
      const result = await SmartRebooker.rescheduleSeries(
        'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', source,
        { disclosedFuturePlacementDays: null },
      );
      expect(result.success).toBe(true);
      expect(sibUpdate.update).toHaveBeenCalledTimes(3);
      const staysUntimed = actor !== 'staff_timed_marker';
      for (const [update] of sibUpdate.update.mock.calls) {
        expect(update.recurring_dispatch_due_date).toBe(staysUntimed ? update.scheduled_date : null);
        if (staysUntimed) expect(update.window_start).toBeNull();
      }
      expect(result.rescheduledOccurrences.slice(1)).toHaveLength(3);
      for (const occurrence of result.rescheduledOccurrences.slice(1)) {
        expect(occurrence.awaitingPlacement).toBe(staysUntimed);
        expect(occurrence.conflicted).toBe(false);
      }
      return;
    }
    if (actor === 'customer_anchor_taken') {
      findConflictingVisits.mockReset().mockResolvedValue([{ id: 'occupied' }]);
      await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve', { disclosedFuturePlacementDays: 3 })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
      expect(anchorUpdate.update).not.toHaveBeenCalled();
      expect(sibUpdate.update).not.toHaveBeenCalled();
      return;
    }

    if (actor === 'customer_stale_disclosure') {
      await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve', { disclosedFuturePlacementDays: null })).rejects.toMatchObject({ code: 'SCOPE_CHANGED', statusCode: 409 });
      expect(anchorUpdate.update).not.toHaveBeenCalled();
      expect(sibUpdate.update).not.toHaveBeenCalled();
      return;
    }

    if (actor === 'customer_sms') {
      // Until SMS offers the new disclosure, accepting a reply retains its
      // existing future-conflict check instead of clearing later windows.
      await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_sms')).rejects.toMatchObject({ code: 'SLOT_TAKEN', subcode: 'SERIES_PROJECTION' });
      expect(sibUpdate.update).not.toHaveBeenCalled();
      return;
    }

    const result = await SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request',
      actor === 'staff' ? 'admin' : 'customer_self_serve',
      actor === 'staff' ? { overlapAdvisory: true } : { disclosedFuturePlacementDays: 3 },
    );
    expect(result.success).toBe(true);
    if (actor === 'staff') {
      expect(result.warnings).toEqual([expect.stringMatching(/overlaps another appointment/), expect.stringMatching(/overlaps another appointment/)]);
    } else {
      expect(findConflictingVisits).toHaveBeenCalledTimes(1);
      expect(sibUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
        window_start: null, window_end: null, time_window: null, window_display: null,
        recurring_dispatch_due_date: expect.any(String),
      }), expect.any(Array));
      expect(sibUpdate.update).toHaveBeenCalledTimes(preservesFuture ? 2 : 3);
      for (const [update] of sibUpdate.update.mock.calls) expect(update.recurring_dispatch_due_date).toBe(update.scheduled_date);
      if (preservesFuture) expect(result.preservedOccurrences).toEqual([{ id: 'svc-2', date: dayOffset(100) }]);
      expect(result.rescheduledOccurrences[1]).toMatchObject({ awaitingPlacement: true, conflicted: false });
      expect(anchorUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ window_start: '09:00', window_end: '11:00' }), expect.any(Array));
    }
    // The overlapping sibling COMMITS (owner ruling — staff saves never
    // block on conflicts); the operator gets the warning instead.
    expect(sibUpdate.update).toHaveBeenCalled();
  });

  test('sibling clash BEYOND the horizon with a seeded placeholder commits at cadence WINDOWLESS — flagged, tech kept, no abort', async () => {
    // 90-day custom cadence: the first shifted occurrence lands ~90 days
    // out, past SERIES_SIBLING_CLASH_HORIZON_DAYS (60). An occupancy hit
    // there is placeholder-land (the seeder itself commits overlapping
    // placeholder rows months out), so the sweep must COMMIT the cadence
    // date and flag the occurrence for admin review — the pre-fix hard
    // abort made every offered slot 409 for two-plan customers.
    const anchor = {
      id: 'svc-1', customer_id: 'cust-1', technician_id: null,
      scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00',
      status: 'confirmed',
      recurring_parent_id: null, is_recurring: true, recurring_pattern: 'custom',
      recurring_nth: null, recurring_weekday: null, recurring_interval_days: 90,
    };
    const siblings = [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
      { id: 'svc-2', status: 'confirmed', scheduled_date: dayOffset(100), window_start: '12:00:00', window_end: '13:00:00', technician_id: 'tech-9' },
    ];
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
    const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
    const anchorUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const sibUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const historyInsert = chain();
    const logInsert = chain();

    // Reminder pre-closure for the windowless occurrence: armed-row read,
    // then the marker update (both on appointment_reminders).
    const reminderRead = chain({ first: jest.fn().mockResolvedValue({ id: 'ar-2', customer_id: 'cust-1', appointment_time: new Date('2026-12-01T13:00:00Z') }) });
    const reminderUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const reminderQueue = [reminderRead, reminderUpdate];
    const scheduledQueue = [siblingsQuery, siblingsQuery, parentLookup, seriesClashProbe, anchorUpdate, sibUpdate];
    const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return historyInsert;
      if (table === 'reschedule_log') return logInsert;
      if (table === 'series_moves') return chain();
      if (table === 'appointment_reminders') return reminderQueue.shift();
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      // The series writer always looks up a prior operation_key first — none here.
      if (table === 'series_moves') return chain();
      throw new Error(`Unexpected db table ${table}`);
    });

    // Anchor clear; the ~90-days-out sibling projection lands on an
    // occupied placeholder window.
    findConflictingVisits
      .mockResolvedValueOnce([])                     // anchor occupancy check
      .mockResolvedValueOnce([{
        id: 'other-plan-placeholder', is_recurring: true, recurring_parent_id: 'plan-2',
        status: 'pending', customer_confirmed: false, reservation_expires_at: null,
      }]); // far sibling: a seeded placeholder

    const result = await SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
    );

    expect(result.success).toBe(true);
    // The far occurrence COMMITTED (no all-or-none abort)…
    expect(sibUpdate.update).toHaveBeenCalled();
    // …kept its tech (unassignment is not a resolution)…
    expect(sibUpdate.update.mock.calls[0][0]).not.toHaveProperty('technician_id');
    // …and WITHOUT a window: a windowless row carries no occupancy, so the
    // placeholder and this occurrence never both occupy the window.
    expect(sibUpdate.update.mock.calls[0][0]).toMatchObject({ window_start: null, window_end: null, time_window: null, window_display: null });
    // …and is flagged so route callers park the admin-review notification.
    const occurrences = result.rescheduledOccurrences;
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].conflicted).toBe(false); // anchor
    expect(occurrences[1].conflicted).toBe(true);  // far sibling
    expect(occurrences[1].windowStart).toBeNull();
    expect(occurrences[1].windowEnd).toBeNull();
    // Its reminder row was pre-closed IN the trx (durable windows_preclosed
    // marker + both windows closed) — no 08:00 placeholder text can fire.
    expect(reminderUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      windows_preclosed: true, suppressed_by_sibling: true, reminder_72h_sent: true, reminder_24h_sent: true,
    }));
  });

  test('sibling clash BEYOND the horizon with a REAL booking (not a seeded placeholder) still aborts', async () => {
    // Same ~90-day projection, but the occupant is a confirmed one-off
    // booking — placeholder-land leniency must not commit a double-booking
    // on top of a real appointment (pre-push audit P1).
    const anchor = {
      id: 'svc-1', customer_id: 'cust-1', technician_id: null,
      scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00',
      status: 'confirmed',
      recurring_parent_id: null, is_recurring: true, recurring_pattern: 'custom',
      recurring_nth: null, recurring_weekday: null, recurring_interval_days: 90,
    };
    const siblings = [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
      { id: 'svc-2', status: 'confirmed', scheduled_date: dayOffset(100), window_start: '12:00:00', window_end: '13:00:00', technician_id: 'tech-9' },
    ];
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
    const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
    const anchorUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const sibUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const historyInsert = chain();
    const logInsert = chain();

    const scheduledQueue = [siblingsQuery, siblingsQuery, parentLookup, seriesClashProbe, anchorUpdate, sibUpdate];
    const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return historyInsert;
      if (table === 'reschedule_log') return logInsert;
      if (table === 'series_moves') return chain();
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      // The series writer always looks up a prior operation_key first — none here.
      if (table === 'series_moves') return chain();
      throw new Error(`Unexpected db table ${table}`);
    });

    // Anchor clear; the ~90-days-out sibling projection lands on an
    // occupied placeholder window.
    findConflictingVisits
      .mockResolvedValueOnce([])                     // anchor occupancy check
      .mockResolvedValueOnce([{
        id: 'real-one-off', is_recurring: false, recurring_parent_id: null,
        status: 'confirmed', customer_confirmed: true, reservation_expires_at: null,
      }]); // far sibling: a genuine booking

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
    )).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN', subcode: 'SERIES_PROJECTION' });
    // Nothing overlapping commits — the whole trx rolls back.
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
    const parentUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
    const anchorUpdate = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
    const logInsert = chain();

    // Month-based order: siblings SELECT, parent UPDATE, seriesClash probe,
    // anchor UPDATE.
    const scheduledQueue = [siblingsQuery, siblingsQuery, parentLookup, parentUpdate, seriesClashProbe, anchorUpdate];
    const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return chain();
      if (table === 'reschedule_log') return logInsert;
      if (table === 'series_moves') return chain();
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
      // The series writer always looks up a prior operation_key first — none here.
      if (table === 'series_moves') return chain();
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

describe('seriesOccurrenceWindow — REBOOKER_NULL_END_OCCUPANCY=off outranks the validator derivation', () => {
  const { seriesOccurrenceWindow } = require('../services/rebooker');
  // End-less sibling: the rollback toggle says "keep the legacy null end".
  const sib = { window_start: '09:00:00', window_end: null, estimated_duration_minutes: 60 };

  afterEach(() => { delete process.env.REBOOKER_NULL_END_OCCUPANCY; });

  test('switch OFF + start-only admin move: the derived end is TEMPORARY — the persisted end stays null', () => {
    process.env.REBOOKER_NULL_END_OCCUPANCY = 'off';
    const out = seriesOccurrenceWindow({ start: '10:00' }, sib, { adminWindowRules: true });
    expect(out).toEqual({ start: '10:00', end: null });
  });

  test('switch OFF still VALIDATES against the temporary end — a pre-08:00 start is fine (no floor), a late derived end is refused', () => {
    process.env.REBOOKER_NULL_END_OCCUPANCY = 'off';
    expect(seriesOccurrenceWindow({ start: '07:00' }, sib, { adminWindowRules: true }))
      .toEqual({ start: '07:00', end: null });
    // …but a derived end past the day end is refused (120-min sibling).
    expect(() => seriesOccurrenceWindow({ start: '19:00' }, { ...sib, estimated_duration_minutes: 120 }, { adminWindowRules: true }))
      .toThrow(/end by 20:00/);
  });

  test('switch ON (default): the derived end is persisted', () => {
    const out = seriesOccurrenceWindow({ start: '10:00' }, sib, { adminWindowRules: true });
    expect(out).toEqual({ start: '10:00', end: '11:00' });
  });

  test('switch OFF with a sibling that HAS an end keeps (and normalizes) that end', () => {
    process.env.REBOOKER_NULL_END_OCCUPANCY = 'off';
    const out = seriesOccurrenceWindow({ start: '10:00' }, { ...sib, window_end: '11:00:00' }, { adminWindowRules: true });
    expect(out).toEqual({ start: '10:00', end: '11:00' });
  });
});

describe('reschedule — visit membership fence (codex #3609 r13 P2)', () => {
  test('an ungrouped pre-read pins visit_id IS NULL in the CAS; an explicit single-row member move does not', async () => {
    let { trxScheduled } = wireRescheduleMocks(service());
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin');
    expect(trxScheduled.where).toHaveBeenCalledWith({ visit_id: null });
    ({ trxScheduled } = wireRescheduleMocks(service()));
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin', { visitPolicy: 'single' });
    expect(trxScheduled.where).not.toHaveBeenCalledWith({ visit_id: null });
    // a caller that fences membership itself keeps its own contract
    ({ trxScheduled } = wireRescheduleMocks(service()));
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin', { expect: { visit_id: 'v1' } });
    expect(trxScheduled.where).not.toHaveBeenCalledWith({ visit_id: null });
  });

  test('a CAS miss that finds the row grouped surfaces VISIT_MEMBERSHIP_CHANGED; a plain miss keeps the generic 409', async () => {
    let { trxScheduled } = wireRescheduleMocks(service());
    trxScheduled.update.mockImplementation(() => updateResult(0));
    trxScheduled.first.mockImplementation(async () => (trxScheduled.update.mock.calls.length ? { visit_id: 'v9' } : undefined));
    await expect(SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin'))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED' });
    ({ trxScheduled } = wireRescheduleMocks(service()));
    trxScheduled.update.mockImplementation(() => updateResult(0));
    trxScheduled.first.mockImplementation(async () => (trxScheduled.update.mock.calls.length ? { visit_id: null } : undefined));
    const err = await SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin').catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409 });
    expect(err.code).toBeUndefined();
  });

  test('a one-member visit the mover declined re-takes the stop lock in the move trx; a sibling that joined meanwhile ⇒ VISIT_MEMBERSHIP_CHANGED (r14 P2)', async () => {
    const vg = require('../services/visit-groups');
    const lockSpy = jest.spyOn(vg, 'lockStopForRow').mockResolvedValue('p1:2026-09-01');
    const membersSpy = jest.spyOn(vg, 'openMembers');
    const unitSpy = jest.spyOn(vg, 'moveVisitAsUnit').mockResolvedValue(null);
    const wire = (visitStatus, others) => {
      const { trx, trxScheduled } = wireRescheduleMocks(service({ visit_id: 'v1' }));
      const inner = trx.getMockImplementation();
      trx.mockImplementation((table) => (table === 'service_visits' ? chain({ first: jest.fn().mockResolvedValue({ status: visitStatus }) }) : inner(table)));
      membersSpy.mockResolvedValue(others);
      return { trx, trxScheduled };
    };
    try {
      // the visit gained a sibling ⇒ re-enter, and the row is NOT moved alone
      let { trx, trxScheduled } = wire('open', [{ id: 'svc-1' }, { id: 'svc-2' }]);
      await expect(SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'rain', 'admin'))
        .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED' });
      expect(lockSpy).toHaveBeenCalledWith(trx, 'svc-1');
      expect(membersSpy).toHaveBeenCalledWith(trx, 'v1');
      expect(trxScheduled.update).not.toHaveBeenCalled();
      // still alone ⇒ the single-row move commits under the stop lock
      ({ trxScheduled } = wire('open', [{ id: 'svc-1' }]));
      await expect(SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'rain', 'admin')).resolves.toMatchObject({ success: true });
      expect(trxScheduled.update).toHaveBeenCalled();
      // a visit that entered FINALIZATION after the plan is REFUSED (local
      // codex gate P0): the detach seam ignores non-open visits, so moving
      // the member would strand the parent and its issued artifacts.
      ({ trxScheduled } = wire('closing', [{ id: 'svc-1' }, { id: 'svc-2' }]));
      await expect(SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'rain', 'admin')).rejects.toMatchObject({ code: 'VISIT_FROZEN_MOVE_UNSUPPORTED' });
      expect(trxScheduled.update).not.toHaveBeenCalled();
      // the stop moved under us ⇒ same re-entry remedy
      ({ trxScheduled } = wire('open', [{ id: 'svc-1' }]));
      lockSpy.mockRejectedValueOnce(Object.assign(new Error('moved'), { code: 'VISIT_STOP_MOVED' }));
      await expect(SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'rain', 'admin')).rejects.toMatchObject({ code: 'VISIT_MEMBERSHIP_CHANGED' });
      expect(trxScheduled.update).not.toHaveBeenCalled();
      // an explicit single-row member move (the unit mover's own calls) never re-checks
      ({ trxScheduled } = wire('open', [{ id: 'svc-1' }, { id: 'svc-2' }]));
      lockSpy.mockClear();
      await expect(SmartRebooker.rescheduleOnce('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'rain', 'admin', { visitPolicy: 'single' })).resolves.toMatchObject({ success: true });
      expect(lockSpy).not.toHaveBeenCalled();
      expect(unitSpy).toHaveBeenCalledTimes(4);
    } finally {
      lockSpy.mockRestore(); membersSpy.mockRestore(); unitSpy.mockRestore();
    }
  });

  test('reschedule() re-enters ONCE on VISIT_MEMBERSHIP_CHANGED so the fresh read routes through the unit mover', async () => {
    const once = jest.spyOn(SmartRebooker, 'rescheduleOnce')
      .mockRejectedValueOnce(Object.assign(new Error('grouped'), { statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED' }))
      .mockResolvedValueOnce({ success: true, visitMove: { visitId: 'v9' } });
    try {
      const out = await SmartRebooker.reschedule('svc-1', TARGET, null, 'rain', 'admin', { allowLive: false });
      expect(out).toEqual({ success: true, visitMove: { visitId: 'v9' } });
      expect(once).toHaveBeenCalledTimes(2);
      expect(once.mock.calls[1][5]).toMatchObject({ allowLive: false, _membershipRetried: true });
      // a second membership change is NOT retried again (no unbounded loop)
      once.mockRejectedValueOnce(Object.assign(new Error('grouped'), { code: 'VISIT_MEMBERSHIP_CHANGED' }))
        .mockRejectedValueOnce(Object.assign(new Error('grouped again'), { code: 'VISIT_MEMBERSHIP_CHANGED' }));
      await expect(SmartRebooker.reschedule('svc-1', TARGET, null, 'rain', 'admin')).rejects.toThrow('grouped again');
      expect(once).toHaveBeenCalledTimes(4);
    } finally {
      once.mockRestore();
    }
  });
});
