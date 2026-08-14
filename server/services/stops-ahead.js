/**
 * Stops-before-you count for the customer tracker (GATE_STOPS_AWAY).
 *
 * Amazon-style "N stops away" on the portal ServiceTracker and the public
 * /track/<token> page. Owner rulings 2026-08-14:
 *
 *   1. Route order IS customer-visible — but only as a bare count, never
 *      any other customer's information.
 *   2. CAP: the number only ever displays at 3 or fewer. Above 3 the
 *      helper returns null and the UI stays in its generic
 *      "on today's route" state.
 *   3. CLAMP: once a customer has seen a number it never increases. The
 *      floor persists on the visit row (stops_ahead_min_shown +
 *      stops_ahead_shown_date) so both surfaces agree across reloads.
 *      The floor is only honored for its own display date — a visit
 *      rescheduled to another day starts fresh.
 *
 * The count is SORT POSITION in the tech's day plan, never arithmetic on
 * route_order (which is nullable and rarely set). Ordering matches the
 * dispatch day-plan query (dispatch.js jobs):
 *   COALESCE(route_order, 999), COALESCE(window_start, '23:59'), created_at
 * with id appended as a deterministic tiebreak for the row-value compare.
 *
 * Read-path fail-soft: this helper never throws — any error returns null
 * and the tracker renders exactly as it did before this feature. It fires
 * no customer communications.
 */
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { gateEnvValue } = require('../config/feature-gates');

const STOPS_AHEAD_DISPLAY_CAP = 3;

// Operational statuses that remove a stop from "ahead of you": done,
// called off, or skipped stops aren't visited before yours anymore.
// (Matches the terminal set formatScheduledTracker/track-public key off.)
const TERMINAL_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

// Statuses that never count as a stop ahead: terminal ones plus
// 'rescheduled' phantoms — a rescheduled row is a non-actionable
// placeholder whose replacement visit is the real stop (mirrors
// route-reorder EXCLUDE_STATUSES / dispatch BOARD_HIDDEN_STATUSES).
// en_route / on_site stay countable: a stop the tech is at right now IS
// still ahead of you.
const NOT_A_STOP_STATUSES = [...TERMINAL_STATUSES, 'rescheduled'];

// scheduled_date / stops_ahead_shown_date arrive as 'YYYY-MM-DD' strings or
// midnight-UTC Dates depending on the driver path — normalize to the
// etDateString() key shape (same normalization as track-transitions).
function dateOnly(value) {
  if (!value) return null;
  const s = String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * @returns {Promise<number|null>} clamped stops-ahead (0..CAP) to display,
 *   or null when the count shouldn't render (gate off, no tech, not today,
 *   terminal visit, beyond the cap, or any error).
 */
async function computeStopsAhead(db, serviceId, opts = {}) {
  if (!gateEnvValue('GATE_STOPS_AWAY')) return null;
  try {
    const today = opts.today || etDateString();
    const svc = await db('scheduled_services')
      .where({ id: serviceId })
      .first(
        'id', 'technician_id', 'scheduled_date', 'status', 'track_state',
        'route_order', 'window_start', 'created_at',
        'stops_ahead_min_shown', 'stops_ahead_shown_date'
      );
    if (!svc || !svc.technician_id) return null;
    if (TERMINAL_STATUSES.includes(svc.status)) return null;
    const trackState = svc.track_state || 'scheduled';
    // Once the tech is on the property (or later) the count is meaningless.
    if (trackState !== 'scheduled' && trackState !== 'en_route') return null;
    const svcDate = dateOnly(svc.scheduled_date);
    if (!svcDate || svcDate !== today) return null;

    let raw;
    if (trackState === 'en_route') {
      // The truck is driving to THIS stop — nothing is ahead of it.
      raw = 0;
    } else {
      const countRows = await db('scheduled_services')
        .where({ technician_id: svc.technician_id })
        .where('scheduled_date', svcDate)
        .whereNot('id', svc.id)
        .whereNotIn('status', NOT_A_STOP_STATUSES)
        // Dead estimate-slot holds linger until the cleanup cron deletes
        // them — same live-hold predicate as route-reorder LIVE_HOLD_SQL.
        .whereRaw('(reservation_expires_at IS NULL OR reservation_expires_at > NOW())')
        .whereRaw(
          `(COALESCE(route_order, 999), COALESCE(window_start, '23:59'::time), created_at, id)
             < (COALESCE(?::int, 999), COALESCE(?::time, '23:59'::time), ?::timestamptz, ?::uuid)`,
          [svc.route_order, svc.window_start, svc.created_at, svc.id]
        )
        .count('id as n');
      raw = Number(countRows?.[0]?.n);
      if (!Number.isFinite(raw)) return null;
    }

    // Clamp against the persisted floor — valid only for today's display.
    const minShownRaw = svc.stops_ahead_min_shown;
    const minShown = minShownRaw == null ? null : Number(minShownRaw);
    const floorIsToday = Number.isInteger(minShown)
      && dateOnly(svc.stops_ahead_shown_date) === today;
    let clamped = raw;
    if (floorIsToday) clamped = Math.min(raw, minShown);
    if (clamped > STOPS_AHEAD_DISPLAY_CAP) return null;

    // Persist the floor ATOMICALLY (single conditional UPDATE, no
    // read-modify-write): concurrent portal/public polls can interleave, and
    // a stale request re-persisting its larger value would both regress the
    // floor and let the displayed count go up. LEAST() keeps the stored
    // floor monotone for the day (LEAST ignores a NULL column), the CASE
    // resets it on a new display date, and RETURNING hands back the
    // authoritative minimum so every racer displays the same floor. Only
    // values that were actually SHOWN (≤ cap) reach this statement, so a
    // raw count of 7 never stores. A value is only DISPLAYED once it is
    // durably the floor: if the UPDATE fails or returns no row, return
    // null (generic state) rather than show a number the clamp never
    // recorded — an unrecorded number could be exceeded by a later poll,
    // violating the never-increase contract.
    try {
      const res = await db.raw(
        `UPDATE scheduled_services
            SET stops_ahead_min_shown = CASE
                  WHEN stops_ahead_shown_date = ?::date
                    THEN LEAST(stops_ahead_min_shown, ?::int)
                  ELSE ?::int
                END,
                stops_ahead_shown_date = ?::date
          WHERE id = ?::uuid
          RETURNING stops_ahead_min_shown`,
        [today, clamped, clamped, today, svc.id]
      );
      const persisted = Number(res?.rows?.[0]?.stops_ahead_min_shown);
      if (Number.isFinite(persisted)) return Math.min(persisted, clamped);
    } catch (err) {
      logger.warn(`[stops-ahead] floor persist failed for ${svc.id}: ${err.message}`);
    }
    return null;
  } catch (err) {
    logger.warn(`[stops-ahead] compute failed for ${serviceId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  computeStopsAhead,
  STOPS_AHEAD_DISPLAY_CAP,
  TERMINAL_STATUSES,
  NOT_A_STOP_STATUSES,
};
