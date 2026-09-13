/**
 * Owner blackout days — shared lookup for every surface that offers or
 * commits customer-facing dates (admin Settings → Scheduling → Blackout
 * days; table: schedule_blackout_dates).
 *
 * Two layers, one enforcement point:
 *   - one-off dates      (table: schedule_blackout_dates)
 *   - weekly days off    (system_settings key `schedule_weekly_days_off`:
 *                         JSON array of JS day-of-week ints, 0=Sun…6=Sat —
 *                         every matching date is treated as blacked out)
 *
 * Consumers:
 *   - scheduling/find-time.js       (offer enumeration: /book, reschedule,
 *                                    estimate route-aware slots, AI searches)
 *   - estimate-slot-availability.js (ASAP capacity fallback enumerates its
 *                                    own dates)
 *   - rebooker.findRescheduleOptions (rain-out SMS alternates)
 *   - routes/booking.js /confirm + slot-reservation reserveSlot (REDEMPTION
 *     re-check: a signed offer minted before the blackout was added must not
 *     stay bookable)
 *   - recurring-appointment-seeder   (nudges recurring children off closed
 *                                    days)
 *
 * All helpers FAIL OPEN (empty set / false) — an availability or commit
 * outage is worse than an offered day off; the office alert + dispatch board
 * still surface anything that slips through.
 */

const db = require('../../models/db');
const logger = require('../logger');

const WEEKLY_DAYS_OFF_KEY = 'schedule_weekly_days_off';

function toDateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).split('T')[0];
}

// Day-of-week (0=Sun…6=Sat) of a YYYY-MM-DD string. The noon anchor keeps
// the calendar date stable across server timezones (same trick as
// find-time's enumerateDates).
function dowOfDateStr(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay();
}

// Set of day-of-week ints the business takes off every week. Fail-open
// (empty set), like the date helpers.
// Pure parse of the stored JSON value — malformed config fails open (empty
// set) without touching the DB, so the strict reader below can share it.
function parseWeeklyDaysOff(value) {
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  } catch {
    return new Set();
  }
}

// `conn` (optional): a caller already inside a transaction passes its trx so
// the lookup never checks out a SECOND pool connection while holding
// scheduling locks — under load every such caller would otherwise wait on an
// exhausted pool with its locks held (codex #3562 r18 P1).
// A failed optional read inside a caller's transaction would leave it
// ABORTED (25P02 on every later statement) despite the catch — so when
// `conn` is a transaction the read runs in a SAVEPOINT (nested trx), the
// same shape getBlackoutLayers uses, and rolls back to it on error.
const readOptional = (conn, fn) => (conn && conn.isTransaction && typeof conn.transaction === 'function'
  ? conn.transaction((sp) => fn(sp))
  : fn(conn));

async function getWeeklyDaysOff(conn = db) {
  try {
    const row = await readOptional(conn, (dbh) => dbh('system_settings').where('key', WEEKLY_DAYS_OFF_KEY).first('value'));
    return parseWeeklyDaysOff(row && row.value);
  } catch (err) {
    logger.warn(`[blackout-dates] weekly days-off lookup failed (failing open): ${err.message}`);
    return new Set();
  }
}

// Concrete YYYY-MM-DD dates within [fromStr, toStr] whose day-of-week is in
// dowSet. Pure — exported for tests.
function expandWeeklyDaysOff(fromStr, toStr, dowSet) {
  const dates = [];
  if (!dowSet || !dowSet.size) return dates;
  const start = new Date(fromStr + 'T12:00:00');
  const end = new Date(toStr + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (dowSet.has(d.getDay())) dates.push(toDateStr(d));
  }
  return dates;
}

// Set of YYYY-MM-DD blackout dates within [fromStr, toStr] (inclusive) —
// one-off dates plus every weekly-day-off occurrence in the range.
async function getBlackoutDates(fromStr, toStr, conn = db) {
  let dates = new Set();
  try {
    const rows = await readOptional(conn, (dbh) => dbh('schedule_blackout_dates')
      .whereBetween('date', [fromStr, toStr])
      .select('date'));
    dates = new Set(rows.map((r) => toDateStr(r.date)));
  } catch (err) {
    logger.warn(`[blackout-dates] range lookup failed (failing open): ${err.message}`);
  }
  const weekly = await getWeeklyDaysOff(conn);
  for (const d of expandWeeklyDaysOff(fromStr, toStr, weekly)) dates.add(d);
  return dates;
}

// Both blackout layers for a series-generation horizon, read through the
// CALLER's conn: { dates: Set<YYYY-MM-DD>, weeklyDaysOff: Set<dow> }. The
// weeklyDaysOff layer lets consumers enforce weekly closures on dates past
// the expanded horizon (long-cadence plans generate years out). `conn` may
// be a transaction — the reads run in a nested transaction (SAVEPOINT), and
// unlike the fail-open helpers above this THROWS on a lookup failure, so a
// failed read rolls the savepoint back instead of leaving the caller's
// transaction aborted; callers treat the rejection as their fail-open.
async function getBlackoutLayers(fromStr, toStr, conn = db) {
  return conn.transaction(async (sp) => {
    const weeklyRow = await sp('system_settings').where('key', WEEKLY_DAYS_OFF_KEY).first('value');
    const weeklyDaysOff = parseWeeklyDaysOff(weeklyRow && weeklyRow.value);
    const rows = await sp('schedule_blackout_dates')
      .whereBetween('date', [fromStr, toStr])
      .select('date');
    const dates = new Set(rows.map((r) => toDateStr(r.date)));
    for (const d of expandWeeklyDaysOff(fromStr, toStr, weeklyDaysOff)) dates.add(d);
    return { dates, weeklyDaysOff };
  });
}

// True when a single date is blacked out (one-off or weekly). Accepts
// YYYY-MM-DD strings OR JS Date values (pg DATE columns arrive as either
// depending on the caller) — String() on a Date is a locale string that
// would silently never match.
// `conn`: a transaction to read through. A caller already inside a txn must
// pass it (codex r10/r11 P2) — reading through the module-global `db` checks
// out a SECOND pooled connection while the first is held, so enough
// concurrent callers wait on connections each other holds until acquisition
// times out and this lookup fails open. getWeeklyDaysOff has always taken a
// conn; this is the other half.
async function isBlackoutDate(dateVal, conn = db) {
  const dateStr = toDateStr(dateVal);
  if (!dateStr) return false;
  const weekly = await getWeeklyDaysOff(conn);
  if (weekly.has(dowOfDateStr(dateStr))) return true;
  try {
    // Through readOptional's savepoint, like its siblings (codex r12 P2): a
    // failed query inside a CALLER'S transaction aborts that transaction, so
    // returning false here would leave the next statement to fail 25P02 —
    // turning documented fail-open behaviour into a failed accept/extend.
    const row = await readOptional(conn, (dbh) => dbh('schedule_blackout_dates')
      .where('date', dateStr)
      .first('id'));
    return !!row;
  } catch (err) {
    logger.warn(`[blackout-dates] date lookup failed (failing open): ${err.message}`);
    return false;
  }
}

// Closure-state advisory lock — serializes the blackout-date / weekly-days-off
// mutation endpoints (routes/admin-schedule.js: PUT /blackout-dates/weekly,
// POST /blackout-dates, DELETE /blackout-dates/:id) against the capacity
// reservation transaction's closure-state read (arrival-route.js
// assertCapacityEligibility → getBlackoutLayers). Without this, a READ
// COMMITTED reservation can read the pre-mutation closure state and commit a
// hold for a day the admin closes a moment later (codex #4346 P2).
//
// Namespace + key MUST stay in lockstep with the other holders of the
// 'slot-reserve' advisory namespace (see tech-day-lock.js header) — same
// hashtext(namespace) classid, distinct key ('closure-state') so this lock
// never collides with a tech-day key.
//
// Lock order: readers (the capacity check inside a reservation transaction)
// already hold the date occupancy lock, tech-day fences, and row locks
// before taking this lock SHARED. Writers (the three mutation endpoints)
// take ONLY this lock, EXCLUSIVE, before their write, and hold no other
// scheduling lock. A writer therefore never holds anything a reader could be
// waiting on, so no lock-order cycle is possible.
//
// xact-scoped: `conn` MUST already be inside a transaction. This is a lock,
// not a fail-open lookup — a missing transaction throws rather than
// silently no-op'ing (a no-op here would recreate the exact race it exists
// to close).
const CLOSURE_LOCK_NAMESPACE = 'slot-reserve';
const CLOSURE_LOCK_KEY = 'closure-state';

async function lockClosureState(conn, { exclusive = false } = {}) {
  if (!conn?.isTransaction) {
    throw Object.assign(new Error('lockClosureState requires an open transaction'), { code: 'TRANSACTION_REQUIRED' });
  }
  const sql = exclusive
    ? 'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))'
    : 'SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))';
  await conn.raw(sql, [CLOSURE_LOCK_NAMESPACE, CLOSURE_LOCK_KEY]);
}

module.exports = {
  getBlackoutDates,
  getBlackoutLayers,
  parseWeeklyDaysOff,
  isBlackoutDate,
  getWeeklyDaysOff,
  expandWeeklyDaysOff,
  lockClosureState,
  WEEKLY_DAYS_OFF_KEY,
};
