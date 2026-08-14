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

// Statuses that were never (or are no longer) a stop on today's ROUTE at
// all — used for the position/total figures ("Now at stop 2 of 6").
// Completed visits stay route stops here: the truck really did park there
// today, and position/total must include them or "stop 4 of 6" would
// renumber itself every time a stop finishes.
const NOT_A_ROUTE_STOP_STATUSES = ['cancelled', 'skipped', 'no_show', 'rescheduled'];

// scheduled_date / stops_ahead_shown_date arrive as 'YYYY-MM-DD' strings or
// midnight-UTC Dates depending on the driver path — normalize to the
// etDateString() key shape (same normalization as track-transitions).
function dateOnly(value) {
  if (!value) return null;
  const s = String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * @returns {Promise<{stopsAhead: number, yourStop: number, totalStops: number}|null>}
 *   stopsAhead — clamped stops-ahead (0..CAP) to display;
 *   yourStop / totalStops — the visit's 1-based position on today's route
 *   and the route's stop count (completed stops included), feeding the
 *   "Now at stop X of Y / You're stop Z" strip. Null when the count
 *   shouldn't render (gate off, no tech, not today, terminal visit,
 *   beyond the cap, or any error).
 */
async function computeStopsAhead(db, serviceId, opts = {}) {
  if (!gateEnvValue('GATE_STOPS_AWAY')) return null;
  try {
    const today = opts.today || etDateString();
    const svc = await db('scheduled_services')
      .where({ id: serviceId })
      .first(
        'id', 'technician_id', 'scheduled_date', 'status', 'track_state',
        'stops_ahead_min_shown', 'stops_ahead_shown_date'
      );
    if (!svc || !svc.technician_id) return null;
    // The target itself must be a real upcoming stop — terminal visits AND
    // rescheduled placeholders (which can retain track_state='scheduled')
    // never display a count.
    if (NOT_A_STOP_STATUSES.includes(svc.status)) return null;
    const trackState = svc.track_state || 'scheduled';
    // Only the pre-dispatch scheduled state shows a count. en_route and
    // later are null: both clients render stopsAhead exclusively on their
    // scheduled cards ("on the way" copy owns the en-route state), and
    // persisting an undisplayed en-route zero would let a same-day rewind
    // back to scheduled clamp the real count to a floor no one ever saw.
    if (trackState !== 'scheduled') return null;
    const svcDate = dateOnly(svc.scheduled_date);
    if (!svcDate || svcDate !== today) return null;

    // Target sort tuple and preceding count come from ONE statement (one
    // READ COMMITTED snapshot): a route reorder committing between two
    // separate queries would compare the new route against the target's
    // OLD tuple and could persist a false "You're next". Predicates on the
    // candidate rows:
    //  - status: not terminal and not a rescheduled phantom
    //  - live-hold: dead estimate-slot holds linger until the cleanup cron
    //    deletes them (same predicate as route-reorder LIVE_HOLD_SQL)
    //  - track_state: can lead or permanently diverge from status (e.g.
    //    markComplete leaves status='confirmed' + track_state='complete'),
    //    so tracker-terminal rows drop out by track_state too — NULL-safe,
    //    since NOT IN alone silently drops NULL-track_state rows.
    // Ordering matches the dispatch day-plan (route_order, window, created)
    // with id as deterministic tiebreak. A "stop" is the repo's sibling
    // identity — (customer_id, appointment slot), the same key
    // appointment-reminders merges on: sibling rows for one slot read as
    // ONE stop via COUNT(DISTINCT (customer, slot)), while a customer's
    // separate same-day appointment (other slot / other property) stays a
    // real stop. Only the target's OWN sibling group is excluded, so a
    // sibling of the target never counts as ahead of itself but the
    // customer's genuinely-earlier other appointment still does.
    // Three figures from the same rows in one pass:
    //   ahead      — live (not-yet-serviced) stops sorting before the target;
    //                this is the number the cap and clamp govern.
    //   before_all — ROUTE stops (completed included) before the target →
    //                yourStop = before_all + 1.
    //   others_all — every route stop today besides the target's own group →
    //                totalStops = others_all + 1.
    const liveExcl = NOT_A_STOP_STATUSES.map(() => '?').join(', ');
    const routeExcl = NOT_A_ROUTE_STOP_STATUSES.map(() => '?').join(', ');
    const STOP_KEY = "(s.customer_id, COALESCE(s.window_start, '23:59'::time))";
    const PRECEDES = `(COALESCE(s.route_order, 999), COALESCE(s.window_start, '23:59'::time), s.created_at, s.id)
              < (COALESCE(t.route_order, 999), COALESCE(t.window_start, '23:59'::time), t.created_at, t.id)`;
    const countRes = await db.raw(
      `WITH target AS (
         SELECT id, customer_id, technician_id, scheduled_date, route_order, window_start, created_at
           FROM scheduled_services
          WHERE id = ?::uuid
       )
       SELECT
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE ${PRECEDES}
             AND s.status NOT IN (${liveExcl})
             AND (s.track_state IS NULL OR s.track_state NOT IN ('complete', 'cancelled'))
         )::int AS ahead,
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE ${PRECEDES}
             AND s.status NOT IN (${routeExcl})
             AND (s.track_state IS NULL OR s.track_state <> 'cancelled')
         )::int AS before_all,
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE s.status NOT IN (${routeExcl})
             AND (s.track_state IS NULL OR s.track_state <> 'cancelled')
         )::int AS others_all,
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE ${PRECEDES}
             AND (s.status = 'completed' OR s.track_state = 'complete')
         )::int AS done_before,
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE ${PRECEDES}
             AND (s.status IN ('en_route', 'on_site')
                  OR s.track_state IN ('en_route', 'on_property'))
         )::int AS working_before
         FROM scheduled_services s, target t
        WHERE s.technician_id = t.technician_id
          AND s.scheduled_date = t.scheduled_date
          AND NOT (s.customer_id = t.customer_id
                   AND s.window_start IS NOT DISTINCT FROM t.window_start)
          AND (s.reservation_expires_at IS NULL OR s.reservation_expires_at > NOW())`,
      [svc.id, ...NOT_A_STOP_STATUSES, ...NOT_A_ROUTE_STOP_STATUSES, ...NOT_A_ROUTE_STOP_STATUSES]
    );
    const agg = countRes?.rows?.[0];
    const raw = Number(agg?.ahead);
    const yourStop = Number(agg?.before_all) + 1;
    const totalStops = Number(agg?.others_all) + 1;
    // The truck's REAL position, measured — never derived from the clamped
    // count (a clamped numeral with a derived position fabricates "Now at
    // stop X"). currentStop = finished stops before you, +1 while the tech
    // is actively at/driving to one of them.
    const doneBefore = Number(agg?.done_before);
    const workingBefore = Number(agg?.working_before);
    const currentStop = (Number.isFinite(doneBefore) ? doneBefore : 0)
      + (Number.isFinite(workingBefore) && workingBefore > 0 ? 1 : 0);
    if (!Number.isFinite(raw) || !Number.isFinite(yourStop) || !Number.isFinite(totalStops)) return null;

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
      // Guarded so an unchanged floor writes nothing (this runs on the 15s
      // tracker poll — an unconditional UPDATE would churn row versions,
      // locks, and WAL on every poll of every open portal). A write is
      // needed only when the date rolls over or the floor lowers.
      const res = await db.raw(
        `UPDATE scheduled_services
            SET stops_ahead_min_shown = CASE
                  WHEN stops_ahead_shown_date = ?::date
                    THEN LEAST(stops_ahead_min_shown, ?::int)
                  ELSE ?::int
                END,
                stops_ahead_shown_date = ?::date
          WHERE id = ?::uuid
            AND (stops_ahead_shown_date IS DISTINCT FROM ?::date
                 OR stops_ahead_min_shown IS NULL
                 OR stops_ahead_min_shown > ?::int)
          RETURNING stops_ahead_min_shown`,
        [today, clamped, clamped, today, svc.id, today, clamped]
      );
      if (res?.rows?.[0]) {
        const persisted = Number(res.rows[0].stops_ahead_min_shown);
        return Number.isFinite(persisted)
          ? { stopsAhead: Math.min(persisted, clamped), yourStop, totalStops, currentStop }
          : null;
      }
      // Zero rows updated = today's stored floor is already ≤ this value
      // (nothing needed writing) — or the visit vanished mid-poll. Re-read
      // to tell them apart and display the authoritative floor.
      const cur = await db('scheduled_services')
        .where({ id: svc.id })
        .first('stops_ahead_min_shown', 'stops_ahead_shown_date');
      const curMin = cur?.stops_ahead_min_shown == null ? null : Number(cur.stops_ahead_min_shown);
      if (Number.isInteger(curMin) && dateOnly(cur?.stops_ahead_shown_date) === today) {
        return { stopsAhead: Math.min(curMin, clamped), yourStop, totalStops, currentStop };
      }
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
  NOT_A_ROUTE_STOP_STATUSES,
};
