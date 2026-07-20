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
  DEFAULT_DURATION_MINUTES,
  DEFAULT_EXCLUDE_STATUSES,
  _internals: { timeToMinutes, normalizeDate },
};
