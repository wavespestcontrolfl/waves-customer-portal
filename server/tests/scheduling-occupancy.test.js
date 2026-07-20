/**
 * Shared occupancy module (services/scheduling/occupancy.js) — the single
 * tech-blind conflict source for /book offers, rebooker moves, call-booking
 * advisory flags, and zone-null confirms. Covers: the overlap predicate and
 * its bindings, the status exclusion sets, the live-hold predicate, the
 * exclude options (service ids / customer, null-safe for hold rows), and the
 * windowless-rows-are-inert convention.
 */
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const {
  findConflictingVisits,
  listOccupiedWindows,
  windowsOverlap,
  acquireOccupancyLock,
  acquireOccupancyLocks,
  DEFAULT_EXCLUDE_STATUSES,
} = require('../services/scheduling/occupancy');

// Knex-ish recording builder: chainable, grouped-where callbacks receive the
// builder (as `this` and first arg), and the builder is thenable so awaiting
// any chain tail resolves `rows`.
function makeQuery(rows = []) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    orWhereNull: jest.fn().mockReturnThis(),
    orWhereNot: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  });
  return builder;
}

describe('findConflictingVisits', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns [] without touching the DB when date or window is missing', async () => {
    expect(await findConflictingVisits({ db })).toEqual([]);
    expect(await findConflictingVisits({ db, date: '2099-01-05', windowStart: '09:00' })).toEqual([]);
    expect(await findConflictingVisits({ db, windowStart: '09:00', windowEnd: '10:00' })).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });

  test('queries the date with the shared overlap + live-hold predicates, tech-blind', async () => {
    const rows = [{ id: 'svc-9', technician_id: null, window_start: '09:00:00' }];
    const q = makeQuery(rows);
    db.mockReturnValue(q);

    const found = await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00',
    });

    expect(found).toEqual(rows);
    expect(db).toHaveBeenCalledWith('scheduled_services');
    expect(q.where).toHaveBeenCalledWith('scheduled_date', '2099-01-05');
    // Default status set mirrors createSelfBooking's commit gate exactly.
    expect(q.whereNotIn).toHaveBeenCalledWith('status', ['cancelled']);
    expect(DEFAULT_EXCLUDE_STATUSES).toEqual(['cancelled']);
    // Expired holds never block; live ones do.
    expect(q.whereNull).toHaveBeenCalledWith('reservation_expires_at');
    expect(q.orWhereRaw).toHaveBeenCalledWith('reservation_expires_at > NOW()');
    // Same COALESCE(window_end, start + duration-or-60) overlap predicate as
    // the existing gates — window_start NULL rows evaluate NULL and stay
    // inert (converter/seeder placeholders never conflict).
    const [overlapSql, bindings] = q.whereRaw.mock.calls[0];
    expect(overlapSql).toContain('window_start < ?::time');
    expect(overlapSql).toContain('COALESCE(window_end');
    expect(overlapSql).toContain('NULLIF(estimated_duration_minutes, 0)');
    expect(bindings).toEqual(['10:00', 60, '09:00']);
    // No technician_id predicate anywhere — the check is deliberately
    // tech-blind (one active tech: any overlap is a real clash).
    const allWheres = q.where.mock.calls.filter((c) => typeof c[0] === 'string').map((c) => c[0]);
    expect(allWheres).not.toContain('technician_id');
  });

  test('a datetime-ish date is clamped to its ET calendar day string', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await findConflictingVisits({
      db, date: '2099-01-05T00:00:00.000Z', windowStart: '09:00', windowEnd: '10:00',
    });
    expect(q.where).toHaveBeenCalledWith('scheduled_date', '2099-01-05');
  });

  test('excludeServiceIds drops the moving batch (falsy entries filtered)', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00',
      excludeServiceIds: ['svc-1', null, undefined, 'svc-2'],
    });
    expect(q.whereNotIn).toHaveBeenCalledWith('id', ['svc-1', 'svc-2']);
  });

  test('caller-specific status sets pass through (rebooker excludes completed too)', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00',
      excludeStatuses: ['cancelled', 'completed'],
    });
    expect(q.whereNotIn).toHaveBeenCalledWith('status', ['cancelled', 'completed']);
  });

  test('excludeCustomerId is null-safe: customer-NULL hold rows still count', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00',
      excludeCustomerId: 'cust-1',
    });
    // A bare whereNot('customer_id', x) is SQL-NULL for hold rows and would
    // silently drop every live estimate hold — the module must group
    // whereNull(customer_id) OR customer_id <> x instead.
    expect(q.whereNull).toHaveBeenCalledWith('customer_id');
    expect(q.orWhereNot).toHaveBeenCalledWith('customer_id', 'cust-1');
  });

  test('includeHolds:false filters live estimate-hold rows out', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00',
      includeHolds: false,
    });
    expect(q.whereNotNull).toHaveBeenCalledWith('customer_id');
    expect(q.orWhereNull).toHaveBeenCalledWith('reservation_expires_at');
  });
});

describe('listOccupiedWindows', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns [] without touching the DB when the range is missing', async () => {
    expect(await listOccupiedWindows({ db })).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });

  test('windowless placeholder rows are excluded up front (inert convention)', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await listOccupiedWindows({ db, dateFrom: '2099-01-01', dateTo: '2099-01-14' });
    expect(q.whereBetween).toHaveBeenCalledWith('scheduled_date', ['2099-01-01', '2099-01-14']);
    expect(q.whereNotNull).toHaveBeenCalledWith('window_start');
    expect(q.whereNotIn).toHaveBeenCalledWith('status', ['cancelled']);
  });

  test('normalizes dates and derives endMin with the duration-or-60 fallback', async () => {
    const q = makeQuery([
      // Unassigned row with an explicit end.
      { id: 'a', scheduled_date: '2099-01-05', window_start: '09:00:00', window_end: '10:30:00', estimated_duration_minutes: null },
      // Techless hold with no end and a stamped duration.
      { id: 'b', scheduled_date: new Date('2099-01-06T05:00:00Z'), window_start: '13:00:00', window_end: null, estimated_duration_minutes: 45 },
      // No end, zero duration → the SQL predicate's 60-minute fallback.
      { id: 'c', scheduled_date: '2099-01-07', window_start: '08:00:00', window_end: null, estimated_duration_minutes: 0 },
    ]);
    db.mockReturnValue(q);
    const rows = await listOccupiedWindows({ db, dateFrom: '2099-01-01', dateTo: '2099-01-14' });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ date: '2099-01-05', startMin: 540, endMin: 630 });
    expect(rows[1]).toMatchObject({ date: '2099-01-06', startMin: 780, endMin: 825 });
    expect(rows[2]).toMatchObject({ date: '2099-01-07', startMin: 480, endMin: 540 });
  });

  test('excludeServiceIds (the rescheduling row) passes through', async () => {
    const q = makeQuery([]);
    db.mockReturnValue(q);
    await listOccupiedWindows({
      db, dateFrom: '2099-01-01', dateTo: '2099-01-14', excludeServiceIds: ['svc-7'],
    });
    expect(q.whereNotIn).toHaveBeenCalledWith('id', ['svc-7']);
  });
});

describe('windowsOverlap', () => {
  test('half-open semantics match the SQL predicate', () => {
    expect(windowsOverlap(540, 600, 570, 630)).toBe(true); // partial
    expect(windowsOverlap(540, 600, 540, 600)).toBe(true); // identical
    expect(windowsOverlap(540, 600, 555, 585)).toBe(true); // contained
    expect(windowsOverlap(540, 600, 600, 660)).toBe(false); // back-to-back touch
    expect(windowsOverlap(540, 600, 480, 540)).toBe(false); // back-to-back before
    expect(windowsOverlap(540, 600, 660, 720)).toBe(false); // disjoint
  });
});

describe('date-wide occupancy advisory lock', () => {
  const makeTrx = () => ({ raw: jest.fn().mockResolvedValue(undefined) });

  test('acquireOccupancyLock takes ONE tech-independent xact lock keyed by calendar date', async () => {
    const trx = makeTrx();
    await acquireOccupancyLock(trx, '2099-01-05');
    expect(trx.raw).toHaveBeenCalledTimes(1);
    // Same two-int advisory family as the tech/zone slot-reserve locks —
    // shared namespace string, DISTINCT occupancy:<date> key.
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['slot-reserve', 'occupancy:2099-01-05'],
    );
  });

  test('a datetime-ish date is clamped to its calendar day (same key as the plain-date caller)', async () => {
    const trx = makeTrx();
    await acquireOccupancyLock(trx, '2099-01-05T14:00:00.000Z');
    expect(trx.raw.mock.calls[0][1]).toEqual(['slot-reserve', 'occupancy:2099-01-05']);
  });

  test('acquireOccupancyLocks dedups and locks in ascending date order regardless of input order', async () => {
    // Two concurrent series movers with overlapping date sets must grab the
    // shared dates in the SAME order — sorted acquisition is the only thing
    // standing between them and a swap deadlock.
    const trx = makeTrx();
    await acquireOccupancyLocks(trx, [
      '2099-02-01', '2099-01-05T09:00', null, '2099-01-05', '2099-01-19', undefined,
    ]);
    expect(trx.raw.mock.calls.map((c) => c[1][1])).toEqual([
      'occupancy:2099-01-05', 'occupancy:2099-01-19', 'occupancy:2099-02-01',
    ]);
  });

  test('acquireOccupancyLocks with nothing to lock never touches the DB', async () => {
    const trx = makeTrx();
    await acquireOccupancyLocks(trx, []);
    await acquireOccupancyLocks(trx, [null, undefined]);
    await acquireOccupancyLocks(trx, undefined);
    expect(trx.raw).not.toHaveBeenCalled();
  });
});

/**
 * THE ORDERING CONTRACT, asserted at every writer.
 *
 * Global order (occupancy.js header):
 *   1 date-occupancy → 2 self-booking-confirm → 3 tech → 4 zone → 5 day-cap
 *
 * Round-2 P1: the order used to differ per writer (rebooker occupancy→tech,
 * zone-null confirm zone→day-cap→occupancy, createSelfBooking customer→tech→
 * zone→day-cap with NO date lock at all). That permitted a three-way deadlock
 * AND left writers whose uncommitted inserts the tech-blind checkers could not
 * see. Each writer's runtime lock sequence is asserted in its own suite; this
 * one is the cross-writer invariant — every blocking writer's FIRST scheduling
 * lock is rung 1, from the shared helper, so no two of them can invert.
 */
describe('ORDERING CONTRACT — rung 1 is first at every writer', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  // [label, source, slice-start marker, the rung-1 call expected inside it]
  const WRITERS = [
    ['createSelfBooking (routes/booking.js)',
      read('routes/booking.js'), 'txResult = await db.transaction',
      'await acquireOccupancyLock(trx, slotDateStr);'],
    ['confirmBooking (services/availability.js)',
      read('services/availability.js'), 'const { booking, scheduled } = await runBookingWork(',
      'await acquireOccupancyLock(trx, dateStr);'],
    ['reserveSlot (services/slot-reservation.js)',
      read('services/slot-reservation.js'), 'async function reserveSlot(',
      'await acquireOccupancyLock(trx, date);'],
    ['commitReservation (services/slot-reservation.js)',
      read('services/slot-reservation.js'), 'async function commitReservation(',
      'await acquireOccupancyLock(client, lockedDate);'],
  ];

  test.each(WRITERS)('%s takes the shared date lock before any other advisory lock', (_label, src, startMarker, rungOneCall) => {
    const startIdx = src.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    const rungOneIdx = src.indexOf(rungOneCall, startIdx);
    expect(rungOneIdx).toBeGreaterThan(startIdx);
    // No hand-rolled pg_advisory_xact_lock beats it to the punch. (Rung 1 is
    // taken via the shared helper, so it never appears in this scan itself.)
    const firstRawLockIdx = src.indexOf('pg_advisory_xact_lock', startIdx);
    if (firstRawLockIdx > -1) expect(rungOneIdx).toBeLessThan(firstRawLockIdx);
  });

  test('the rebooker takes rung 1 first on BOTH its paths — single, and series (all dates up front)', () => {
    const src = read('services/rebooker.js');
    // Single move: date lock, then the tech-scoped lock.
    const singleIdx = src.indexOf('await acquireOccupancyLock(trx, newDateStr);');
    const singleTechIdx = src.indexOf("['slot-reserve', `${keptTechId || 'unassigned'}:${newDateStr}`],");
    expect(singleIdx).toBeGreaterThan(-1);
    expect(singleTechIdx).toBeGreaterThan(singleIdx);
    // Series: the multi-date acquisition is sorted-ascending (acquireOccupancyLocks)
    // and precedes every per-sibling tech lock in the loop below it.
    const seriesIdx = src.indexOf('await acquireOccupancyLocks(trx, projectedDates);');
    expect(seriesIdx).toBeGreaterThan(-1);
    for (const techLock of [
      "['slot-reserve', `${options.technicianId}:${String(date).split('T')[0]}`],",
      "['slot-reserve', `${sib.technician_id}:${String(date).split('T')[0]}`],",
    ]) {
      const idx = src.indexOf(techLock);
      expect(idx).toBeGreaterThan(seriesIdx);
    }
  });

  test('series parent recurrence-anchor UPDATE (first row lock) comes AFTER the date advisory locks', () => {
    // The series path's month-based branch UPDATEs (row-locks) the recurring
    // parent. That row lock must follow the rung-1 date advisory locks, never
    // precede them — otherwise a concurrent single reschedule holding a
    // target-date advisory lock while waiting to touch this parent row
    // deadlocks against this txn holding the parent row and waiting for the
    // advisory lock. Pinned at the source so a future edit can't reintroduce
    // the inversion.
    const src = read('services/rebooker.js');
    const locksIdx = src.indexOf('await acquireOccupancyLocks(trx, projectedDates);');
    const parentUpdateIdx = src.indexOf('.where({ id: parentId }).update({');
    expect(locksIdx).toBeGreaterThan(-1);
    expect(parentUpdateIdx).toBeGreaterThan(-1);
    // Advisory date locks first…
    expect(parentUpdateIdx).toBeGreaterThan(locksIdx);
    // …and NO parent-row UPDATE precedes them (the inversion this closes).
    expect(src.lastIndexOf('.where({ id: parentId }).update({', locksIdx)).toBe(-1);
  });

  test('every writer imports rung 1 from the shared module — no private key shapes', () => {
    // A local copy of the lock statement would have to reproduce the
    // namespace AND the `occupancy:<date>` key exactly; one drift and the
    // writer silently stops serializing against the others.
    for (const rel of [
      'routes/booking.js',
      'services/availability.js',
      'services/slot-reservation.js',
      'services/rebooker.js',
    ]) {
      const src = read(rel);
      expect(src).toContain('scheduling/occupancy');
      expect(src).toContain('acquireOccupancyLock');
      // The key shape lives in exactly one place.
      expect(src).not.toContain('occupancy:${');
    }
  });

  test('the header documents the order AND the exemptions (the contract is the doc)', () => {
    const header = read('services/scheduling/occupancy.js').split('const OCCUPANCY_LOCK_NS')[0];
    expect(header).toContain('ORDERING CONTRACT');
    // The five rungs, in order.
    const rungs = ['date-occupancy', 'self-booking', 'technician', 'zone', 'global day cap'];
    let cursor = -1;
    for (const rung of rungs) {
      const idx = header.indexOf(rung, cursor + 1);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
    // Every writer named, so a new one can't be added without meeting the doc.
    for (const writer of [
      'createSelfBooking', 'confirmBooking', 'rescheduleVisit', 'series sweep',
      'reserveSlot', 'commitReservation',
    ]) {
      expect(header).toContain(writer);
    }
    // ...and every exemption justified rather than merely omitted.
    expect(header).toContain('EXEMPT');
    for (const exempt of [
      'buildBookingAvailability', 'rain-out.js', 'call-recording-processor.js',
      'releaseReservation',
    ]) {
      expect(header).toContain(exempt);
    }
  });
});
