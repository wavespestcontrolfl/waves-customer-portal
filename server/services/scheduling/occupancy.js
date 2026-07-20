/**
 * Shared schedule-occupancy check — the single source of truth for
 * "does this date + time window clash with anything already on the calendar",
 * REGARDLESS of technician_id.
 *
 * Why tech-blind: Waves runs exactly ONE active field technician, so any
 * time overlap between visits is a real-world clash whether the rows carry
 * a technician_id, carry different ones, or carry none (AI-assistant
 * zone-engine confirms, rebooker series-conflict unassigns, and admin
 * unassigned creates all write technician_id-NULL rows that the per-tech
 * conflict checks used to sail past).
 *
 * Predicate provenance (kept in lockstep with the existing commit gates —
 * routes/booking.js createSelfBooking's conflictQuery, rebooker.js's
 * overlap checks, slot-reservation.js's applyWindowOverlapFilter):
 *   - Overlap:  window_start < :end  AND
 *               COALESCE(window_end, window_start + COALESCE(NULLIF(
 *                 estimated_duration_minutes, 0), 60) minutes) > :start
 *   - Holds:    reservation_expires_at IS NULL OR > NOW() — a live
 *     estimate-slot hold occupies real route time; an expired one is dead
 *     weight awaiting cleanup and never blocks.
 *   - Windowless rows (window_start IS NULL — converter/seeder placeholder
 *     rows): the SQL overlap predicate above evaluates NULL for them, so
 *     every existing gate ignores them. This module deliberately keeps that
 *     convention — placeholder rows must remain inert to conflicts.
 *   - Statuses: the default exclusion set is ['cancelled'] — the exact set
 *     createSelfBooking's commit gate uses (anything not cancelled occupies
 *     its window, including completed same-day rows). Callers whose existing
 *     gates exclude more (rebooker excludes 'completed' too so a done
 *     morning visit never blocks an afternoon move) pass excludeStatuses to
 *     match their own commit semantics exactly — an offer/commit mismatch in
 *     either direction is how the /book 409 dead-end loop happened.
 *
 * NOTE: the estimate-slot surfaces (estimate-slot-availability.js +
 * slot-reservation.js) are verified correct and intentionally NOT refactored
 * onto this module — possible follow-up, not this lane.
 */
const defaultDb = require('../../models/db');

const DEFAULT_DURATION_MINUTES = 60;

// ---- date-wide occupancy advisory lock (shared by every gate writer) -------
//
// findConflictingVisits is GLOBAL — all techs + unassigned + live holds — but
// the per-writer slot-reserve locks are keyed by TECH or ZONE. Two writers on
// the same date with different techs (or one assigned + one unassigned) take
// DIFFERENT locks, both pass this tech-blind check under READ COMMITTED, and
// both commit overlapping rows (the P1 this module's callers close). One key
// per calendar date, taken by EVERY writer that COMMITS behind this gate
// (rebooker single + series, availability.js zone-null confirm), serializes
// them so exactly one wins the window.
//
// Namespace note: reuses the 'slot-reserve' namespace the tech/zone locks
// already live in — pg_advisory_xact_lock(hashtext(ns), hashtext(key)) is a
// two-int lock, so the distinct `occupancy:<date>` KEY is a different lock
// from `<tech>:<date>` or `zone:<id>:<date>`; sharing the namespace string
// just keeps the family together, it does not make them collide.
//
// ============================ ORDERING CONTRACT ============================
//
// THE global scheduling lock order. Every writer that BLOCKS on a schedule
// check and then COMMITS a scheduled_services row acquires locks in exactly
// this sequence, skipping the rungs it doesn't need — never reordering them:
//
//   1. date-occupancy   'slot-reserve' / `occupancy:<YYYY-MM-DD>`  (THIS module)
//   2. self-booking     'self-booking-confirm' / `<customerId>:<date>`
//   3. technician       'slot-reserve' / `<techId|'unassigned'>:<date>`
//   4. zone             'slot-reserve' / `zone:<zoneId|'unknown'>:<date>`
//   5. global day cap   'self-booking-day-cap' / `<date>`
//                       (availability.acquireSelfBookingDayCapLock)
//
// Coarsest first. Rung 1 is a whole calendar day and is therefore ALWAYS
// taken first; a consistent global order is what makes the set deadlock-free
// (two writers can share any subset of rungs and still acquire them in the
// same relative order). Multi-date callers take their rung-1 keys in ascending
// date order — use acquireOccupancyLocks(). pg_advisory_xact_lock auto-releases
// at commit/rollback.
//
// WHY EVERY BLOCKING WRITER MUST TAKE RUNG 1 — not just the tech-blind ones:
// findConflictingVisits is GLOBAL but reads COMMITTED rows only. A writer that
// skips the date lock can hold an UNCOMMITTED overlapping insert while a
// date-lock holder runs its tech-blind check, sees nothing, and commits on top
// of it. So the date lock is not "the lock the tech-blind check needs" — it is
// the lock every writer owes the tech-blind checkers. A narrower rung cannot
// substitute: the rebooker takes rungs 1+3 only, so a zone lock (rung 4) is
// never shared with it and never serializes against it.
//
// THE SECOND HALF OF THE CONTRACT — every rung-1 holder MUST run the global
// predicate (findConflictingVisits, same trx, AFTER the lock, BEFORE its
// insert/commit) and abort on a hit. The lock only SERIALIZES writers; it
// cannot WIDEN what a writer's own check sees. A writer that waits its turn
// on rung 1 and then re-validates a zone-scoped or tech-scoped predicate
// still sails past a committed different-tech / different-zone / unassigned
// row that predicate never selects — serialized double-booking is still
// double-booking. Writers KEEP their narrow checks (they are correct fast
// paths and produce the writer's specific error shapes: zone capacity,
// SLOT_TAKEN variants); the global probe is the backstop behind them, thrown
// as the same conflict error the writer already uses. The one deliberate
// narrowing: the estimate-hold path probes with includeHolds:false — a hold
// must never stack over a COMMITTED visit (the offer->409 dead-end class),
// but hold-vs-hold coexistence stays governed by its narrow tech/zone
// checks, and whichever overlapping hold GRADUATES second is stopped by
// commitReservation's own probe.
//
// WRITERS (each verified against this order; "+ probe" = the global
// predicate runs under rung 1 before that writer's insert/commit):
//   routes/booking.js createSelfBooking ......... 1 -> 2 -> 3(if tech) -> 4 -> 5
//     + probe (no exclusions) after its tech/zone/hold fast-path check.
//   services/availability.js confirmBooking ..... 1 -> 4 -> 5
//     Rung 1 is unconditional here — the ZONE-RESOLVED branch fast-paths a
//     zone-scoped occupied set, so it is exactly the "uncommitted insert the
//     rebooker's global check can't see" case above. + probe on BOTH branches
//     (shared call after the zone fast-path; excludes the onboarding
//     reschedule's replaced service + dispatch rows).
//   services/rebooker.js rescheduleVisit (single)  1 -> 3
//     + probe (IS its primary check — excludes the moving row).
//   services/rebooker.js series sweep ........... 1 (all target dates, sorted,
//     up front, BEFORE the loop's per-sibling rung-3 locks) -> 3 per sibling
//     + probe per occurrence (excludes every sibling moving in the sweep).
//   services/slot-reservation.js reserveSlot .... 1 -> 3 -> 4
//     + probe with includeHolds:false (committed visits only — see above;
//     its own estimate's stale holds were already deleted in-txn). The
//     same-slot REFRESH leg (idempotent retry) runs the same probe under
//     the same rung-1 lock BEFORE extending the hold's expiry — a hold
//     whose window a committed visit has since taken is superseded
//     (released, delete-only) and the reserve throws instead of refreshing.
//   services/slot-reservation.js commitReservation  1
//     + probe with includeHolds:false excluding its own hold row — runs even
//     when no accept-time duration resolved (the narrow tech-scoped check is
//     skipped then, but graduation still commits real occupancy).
//
// ESTIMATE-HOLD PATH — why rungs 3+4 do NOT cover it, and rung 1 was added:
// reserveSlot inserts a customer-NULL hold row that findConflictingVisits
// COUNTS (includeHolds), and commitReservation graduates that hold to a real
// booking while possibly WIDENING window_end (the commit-time duration can
// exceed the held one). Both are therefore real occupancy writers. Their zone
// leg (rung 4) serializes them against the self-booking writers only —
// the rebooker takes rungs 1+3 and NO zone lock, so an estimate hold and a
// rebooker move on the same date shared nothing and could interleave. The
// unassigned case is worse: commitReservation's own conflict query drops its
// technician predicate when the row has no tech, making it a tech-blind
// writer outright. Both now take rung 1 first. commitReservation is often
// handed the estimate-accept transaction (routes/estimate-public.js), which
// takes no scheduling locks of its own, so rung 1 is still that txn's first.
//
// EXEMPT — read-only or occupancy-shrinking, no lock required:
//   routes/booking.js buildBookingAvailability, availability.getAvailableSlots,
//   auto-dispatch/candidate-slots, estimate-slot-availability.js + find-time
//     — OFFER surfaces. They read (listOccupiedWindows) and commit nothing;
//       every offer is re-validated under lock at its own commit gate.
//   services/rain-out.js — computes the batch and delegates EVERY write to
//     rebooker.rescheduleVisit, so its moves take rungs 1+3 there.
//   services/call-recording-processor.js booking txn — the ONE writer whose
//     COMMIT is exempt by owner rule (book + flag, never block), so its
//     in-txn conflict read stays advisory and lock-free. Deliberately so:
//     that txn's post-insert work row-locks leads/customers/estimates, and
//     the estimate-accept txn locks those same tables BEFORE taking rung 1
//     inside commitReservation — holding rung 1 across the call txn would
//     invert that order (deadlock-abort risk to a booking that must never
//     fail on a lock). Reliable DETECTION is restored post-commit: a
//     dedicated short rung-1 transaction (date locks — one per distinct
//     date, sorted ascending — + one findConflictingVisits read PER ROW the
//     call created, the primary and its follow-up child each against its
//     own date/window; no row locks) re-checks and feeds the triage card.
//     Serializing just the CHECK suffices because every
//     committing writer runs the global predicate under rung 1: by the time
//     the recheck's lock is granted, a concurrent writer either already saw
//     the call booking's committed row (and aborted itself) or committed
//     first and is visible to the recheck.
//   slot-reservation releaseReservation / releaseExpiredReservations — delete
//     only. Removing occupancy can never create an overlap.
// ===========================================================================
const OCCUPANCY_LOCK_NS = 'slot-reserve';

function occupancyLockKey(dateStr) {
  return `occupancy:${String(dateStr).split('T')[0]}`;
}

async function acquireOccupancyLock(trx, dateStr) {
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [OCCUPANCY_LOCK_NS, occupancyLockKey(dateStr)],
  );
}

// Acquire the date-wide occupancy lock for MANY dates in one transaction
// (series reschedules probe/write several target dates). Dedups + sorts so two
// concurrent multi-date movers always grab a shared pair in the SAME order and
// can never deadlock by swapping them.
async function acquireOccupancyLocks(trx, dateStrs) {
  const dates = [...new Set(
    (dateStrs || []).filter(Boolean).map((d) => String(d).split('T')[0]),
  )].sort();
  for (const d of dates) {
    // Sequential on purpose: a Promise.all would fire the lock statements in
    // arbitrary completion order, defeating the sorted-acquisition guarantee.
    await acquireOccupancyLock(trx, d);
  }
}

// Matches createSelfBooking's commit-gate status predicate. See header.
const DEFAULT_EXCLUDE_STATUSES = ['cancelled'];

const CONFLICT_COLUMNS = [
  'id', 'customer_id', 'technician_id', 'scheduled_date',
  'window_start', 'window_end', 'status', 'service_type',
  'estimated_duration_minutes', 'reservation_expires_at', 'source_estimate_id',
];

/**
 * Overlapping scheduled_services rows for one date + window. Tech-blind.
 *
 * @param {object} args
 * @param {object} [args.db]                knex instance OR transaction
 * @param {string} args.date               ET calendar date 'YYYY-MM-DD'
 *                                          (scheduled_date is a plain DATE)
 * @param {string} args.windowStart        'HH:MM' / 'HH:MM:SS'
 * @param {string} args.windowEnd          'HH:MM' / 'HH:MM:SS'
 * @param {Array}  [args.excludeServiceIds] rows to ignore — the row being
 *                                          moved, plus (for batch moves like
 *                                          rain-out route pushes / series
 *                                          shifts) every sibling moving in
 *                                          the same sweep.
 * @param {string} [args.excludeCustomerId] ignore this customer's own rows
 *                                          (callers with their own
 *                                          same-customer semantics).
 * @param {Array}  [args.excludeStatuses]   statuses that do NOT occupy —
 *                                          default ['cancelled'].
 * @param {boolean}[args.includeHolds]      false drops live estimate holds
 *                                          (customer_id NULL + live
 *                                          reservation_expires_at) from the
 *                                          result; default true — holds
 *                                          occupy real route time.
 * @returns {Promise<Array>} overlapping rows (chronological), [] if none.
 */
async function findConflictingVisits({
  db = defaultDb,
  date,
  windowStart,
  windowEnd,
  excludeServiceIds = [],
  excludeCustomerId = null,
  excludeStatuses = DEFAULT_EXCLUDE_STATUSES,
  includeHolds = true,
} = {}) {
  if (!date || !windowStart || !windowEnd) return [];
  const excludeIds = (excludeServiceIds || []).filter(Boolean).map(String);

  const query = db('scheduled_services')
    .where('scheduled_date', String(date).split('T')[0])
    .whereNotIn('status', excludeStatuses)
    // Expired estimate-slot holds are dead weight until cleanup reclaims
    // them — same active-reservation predicate every existing gate uses.
    .where((q) => {
      q.whereNull('reservation_expires_at')
        .orWhereRaw('reservation_expires_at > NOW()');
    })
    // COALESCE the nullable window_end (admin edits can leave a start with
    // no end) — same predicate as slot-reservation/rebooker/createSelfBooking.
    // window_start-NULL placeholder rows evaluate NULL here and stay inert.
    .whereRaw(
      "window_start < ?::time AND COALESCE(window_end, window_start + ((COALESCE(NULLIF(estimated_duration_minutes, 0), ?)::text || ' minutes')::interval)) > ?::time",
      [windowEnd, DEFAULT_DURATION_MINUTES, windowStart],
    );
  if (excludeIds.length) query.whereNotIn('id', excludeIds);
  if (excludeCustomerId) {
    // customer_id <> ? is NULL (not true) for customer-NULL hold rows, so a
    // bare whereNot would silently drop every hold — keep them explicitly.
    query.where((q) => {
      q.whereNull('customer_id').orWhereNot('customer_id', excludeCustomerId);
    });
  }
  if (!includeHolds) {
    // Hold rows are customer_id NULL with a reservation stamp; everything
    // else (including committed customer-NULL legacy rows without one) stays.
    query.where((q) => {
      q.whereNotNull('customer_id').orWhereNull('reservation_expires_at');
    });
  }
  const rows = await query.select(CONFLICT_COLUMNS).orderBy('window_start', 'asc');
  return Array.isArray(rows) ? rows : [];
}

/**
 * Range variant for offer builders: every occupying row (same status/hold/
 * windowless conventions as findConflictingVisits) across [dateFrom, dateTo],
 * for JS-side overlap filtering of many candidate slots in one query.
 * Returns rows with a normalized `date` ('YYYY-MM-DD') plus `startMin` /
 * `endMin` (minutes from midnight, window_end defaulted from
 * estimated_duration_minutes or 60 — same fallback as the SQL predicate).
 */
async function listOccupiedWindows({
  db = defaultDb,
  dateFrom,
  dateTo,
  excludeServiceIds = [],
  excludeStatuses = DEFAULT_EXCLUDE_STATUSES,
} = {}) {
  if (!dateFrom || !dateTo) return [];
  const excludeIds = (excludeServiceIds || []).filter(Boolean).map(String);

  const query = db('scheduled_services')
    .whereBetween('scheduled_date', [dateFrom, dateTo])
    .whereNotIn('status', excludeStatuses)
    .where((q) => {
      q.whereNull('reservation_expires_at')
        .orWhereRaw('reservation_expires_at > NOW()');
    })
    // Windowless placeholder rows are inert to conflicts (see header).
    .whereNotNull('window_start');
  if (excludeIds.length) query.whereNotIn('id', excludeIds);
  const rows = await query.select(CONFLICT_COLUMNS);
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const row of rows) {
    const startMin = timeToMinutes(row.window_start);
    if (startMin == null) continue;
    const endMin = timeToMinutes(row.window_end);
    const durationMin = Number(row.estimated_duration_minutes) > 0
      ? Number(row.estimated_duration_minutes)
      : DEFAULT_DURATION_MINUTES;
    out.push({
      ...row,
      date: normalizeDate(row.scheduled_date),
      startMin,
      endMin: endMin != null ? endMin : startMin + durationMin,
    });
  }
  return out;
}

function timeToMinutes(value) {
  if (value == null || value === '') return null;
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value);
}

// Half-open interval overlap — identical semantics to the SQL predicate
// (start < otherEnd AND end > otherStart), so back-to-back windows touch
// without clashing.
function windowsOverlap(aStartMin, aEndMin, bStartMin, bEndMin) {
  return aStartMin < bEndMin && aEndMin > bStartMin;
}

module.exports = {
  findConflictingVisits,
  listOccupiedWindows,
  windowsOverlap,
  acquireOccupancyLock,
  acquireOccupancyLocks,
  DEFAULT_DURATION_MINUTES,
  DEFAULT_EXCLUDE_STATUSES,
  _internals: { timeToMinutes, normalizeDate, occupancyLockKey },
};
