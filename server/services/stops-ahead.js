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
 *      floor persists on EVERY sibling row of the visit's stop
 *      (stops_ahead_min_shown + stops_ahead_shown_date) — siblings are
 *      one physical stop but each row has its own track token — so all
 *      surfaces and all sibling links agree across reloads.
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
      .first('id', 'technician_id', 'scheduled_date', 'status', 'track_state');
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
    // status can LEAD track_state: tech-track commits the operational
    // transition first and the tracker transition is best-effort — if the
    // second step fails, a visit already underway keeps
    // track_state='scheduled'. A live operational status makes the target
    // ineligible: the planned-route count must not display (or persist a
    // floor) for a stop the tech is already traveling to or working.
    if (svc.status === 'en_route' || svc.status === 'on_site') return null;
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
    // Do NOT add property_id/service_address_* to this key: the stamp is
    // not sibling-uniform (admin add-a-line, dispatch follow-ups, and
    // estimate-converter same-trip rows leave it NULL next to a stamped
    // sibling), so a property-qualified key would split one real visit
    // into two stops — and count the target's own line item as ahead of
    // it. The cost of the current key is only the same-customer,
    // same-window, different-property collapse, unreachable for a
    // single-tech route.
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
    // The comparison anchors at the SIBLING GROUP's earliest route tuple,
    // not the requested row's own: the route optimizer assigns route_order
    // per ROW, so another customer's stop can sort between two siblings —
    // anchoring per-row would count that customer as ahead on one
    // sibling's link but not the other's, and the truck visits the group
    // once, at its earliest position. Cancelled/rescheduled/dead-hold
    // siblings can't anchor (their tuple is stale), but the target row
    // itself always can — it was already validated eligible above.
    const countRes = await db.raw(
      `WITH target_row AS (
         SELECT id, customer_id, technician_id, scheduled_date, window_start
           FROM scheduled_services
          WHERE id = ?::uuid
       ),
       target AS (
         SELECT tr.customer_id, tr.technician_id, tr.scheduled_date, tr.window_start,
                g.route_order, g.created_at, g.id,
                (SELECT MIN(ss.stops_ahead_min_shown)
                   FROM scheduled_services ss
                  WHERE ss.technician_id = tr.technician_id
                    AND ss.scheduled_date = tr.scheduled_date
                    AND ss.customer_id = tr.customer_id
                    AND ss.window_start IS NOT DISTINCT FROM tr.window_start
                    AND ss.stops_ahead_shown_date = ?::date) AS group_floor
           FROM target_row tr
           JOIN LATERAL (
             SELECT s.route_order, s.created_at, s.id
               FROM scheduled_services s
              WHERE s.technician_id = tr.technician_id
                AND s.scheduled_date = tr.scheduled_date
                AND s.customer_id = tr.customer_id
                AND s.window_start IS NOT DISTINCT FROM tr.window_start
                AND (s.id = tr.id
                     OR (s.status NOT IN (${routeExcl})
                         AND (s.track_state IS NULL OR s.track_state <> 'cancelled')
                         AND (s.reservation_expires_at IS NULL OR s.reservation_expires_at > NOW())))
              ORDER BY COALESCE(s.route_order, 999), COALESCE(s.window_start, '23:59'::time), s.created_at, s.id
              LIMIT 1
           ) g ON TRUE
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
             AND (s.status = 'completed'
                  OR (s.track_state = 'complete' AND s.status NOT IN (${routeExcl})))
         )::int AS done_before,
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE ${PRECEDES}
             AND (s.status = 'on_site' OR s.track_state = 'on_property')
             AND s.status NOT IN (${liveExcl})
             AND (s.track_state IS NULL OR s.track_state NOT IN ('complete', 'cancelled'))
         )::int AS at_before,
         COUNT(DISTINCT ${STOP_KEY}) FILTER (
           WHERE ${PRECEDES}
             AND (s.status = 'en_route' OR s.track_state = 'en_route')
             AND s.status NOT IN (${liveExcl})
             AND (s.track_state IS NULL OR s.track_state NOT IN ('complete', 'cancelled'))
         )::int AS enroute_before,
         MIN(t.group_floor)::int AS group_floor
         FROM scheduled_services s, target t
        WHERE s.technician_id = t.technician_id
          AND s.scheduled_date = t.scheduled_date
          AND NOT (s.customer_id = t.customer_id
                   AND s.window_start IS NOT DISTINCT FROM t.window_start)
          AND (s.reservation_expires_at IS NULL OR s.reservation_expires_at > NOW())`,
      // Binding order mirrors the SQL order: the group_floor subquery's
      // display date, the sibling-anchor lateral (route-excluded), then
      // the FILTERs — ahead (live-excluded),
      // before_all / others_all / done_before (route-excluded), and
      // at_before / enroute_before (live-excluded again — terminal-status
      // precedence: a completed/cancelled row with a stale active
      // track_state must not fabricate an active stop, matching the
      // tracking routes).
      [
        svc.id,
        today,
        ...NOT_A_ROUTE_STOP_STATUSES,
        ...NOT_A_STOP_STATUSES,
        ...NOT_A_ROUTE_STOP_STATUSES,
        ...NOT_A_ROUTE_STOP_STATUSES,
        ...NOT_A_ROUTE_STOP_STATUSES,
        ...NOT_A_STOP_STATUSES,
        ...NOT_A_STOP_STATUSES,
      ]
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
    const atBefore = Number(agg?.at_before);
    const enrouteBefore = Number(agg?.enroute_before);
    // Three truthful truck phases (a merely-en-route stop must not read as
    // "Now at"): atStop = physically AT a stop (on-site/on-property);
    // headingToStop = driving to one (en-route); neither = between stops.
    // A stop that is somehow both reads as AT (on-property wins).
    const atStop = Number.isFinite(atBefore) && atBefore > 0;
    const headingToStop = !atStop && Number.isFinite(enrouteBefore) && enrouteBefore > 0;
    const currentStop = (Number.isFinite(doneBefore) ? doneBefore : 0)
      + (atStop || headingToStop ? 1 : 0);
    if (!Number.isFinite(raw) || !Number.isFinite(yourStop) || !Number.isFinite(totalStops)) return null;

    // Clamp against the persisted floor — the GROUP's smallest same-day
    // floor (fetched in the same snapshot as the count), not the requested
    // row's own: siblings are one stop with separate tokens, and a sibling
    // row added mid-day starts with a NULL floor — clamping on the row
    // alone would leave its link above the cap (generic state) while the
    // older sibling's link keeps showing a number. The SQL already
    // restricted the MIN to rows whose shown_date is today, so a stale
    // floor from another day never clamps.
    const groupFloorRaw = agg?.group_floor;
    const groupFloor = groupFloorRaw == null ? null : Number(groupFloorRaw);
    let clamped = raw;
    if (Number.isInteger(groupFloor)) clamped = Math.min(raw, groupFloor);
    if (clamped > STOPS_AHEAD_DISPLAY_CAP) return null;

    // Persist the floor ATOMICALLY (single conditional UPDATE, no
    // read-modify-write): concurrent portal/public polls can interleave, and
    // a stale request re-persisting its larger value would both regress the
    // floor and let the displayed count go up. The floor lives on the whole
    // SIBLING GROUP, not just the requested row: siblings are one physical
    // stop but each row has its own public token (and the authenticated
    // canonical query can select either), so a per-row floor would let one
    // sibling's link display a number another sibling's link already
    // clamped below. floor_val folds this request's clamped value with the
    // group's smallest same-day stored floor (LEAST ignores a NULL MIN);
    // the UPDATE stamps that value onto every sibling row, and RETURNING
    // hands back the authoritative minimum so every racer displays the
    // same floor. Only values that were actually SHOWN (≤ cap) reach this
    // statement, so a raw count of 7 never stores. A value is only
    // DISPLAYED once it is durably the floor: if the UPDATE fails or
    // returns no row, return null (generic state) rather than show a
    // number the clamp never recorded — an unrecorded number could be
    // exceeded by a later poll, violating the never-increase contract.
    try {
      // Guarded so an unchanged floor writes nothing (this runs on the 15s
      // tracker poll — an unconditional UPDATE would churn row versions,
      // locks, and WAL on every poll of every open portal). A write is
      // needed only when the date rolls over or the floor lowers.
      const res = await db.raw(
        `WITH grp AS (
           SELECT customer_id, technician_id, scheduled_date, window_start
             FROM scheduled_services
            WHERE id = ?::uuid
         ),
         floor_val AS (
           SELECT LEAST(?::int, MIN(CASE WHEN s.stops_ahead_shown_date = ?::date
                                         THEN s.stops_ahead_min_shown END)) AS v
             FROM scheduled_services s, grp g
            WHERE s.technician_id = g.technician_id
              AND s.scheduled_date = g.scheduled_date
              AND s.customer_id = g.customer_id
              AND s.window_start IS NOT DISTINCT FROM g.window_start
         )
         UPDATE scheduled_services u
            SET stops_ahead_min_shown = f.v,
                stops_ahead_shown_date = ?::date
           FROM floor_val f, grp g
          WHERE u.technician_id = g.technician_id
            AND u.scheduled_date = g.scheduled_date
            AND u.customer_id = g.customer_id
            AND u.window_start IS NOT DISTINCT FROM g.window_start
            AND (u.stops_ahead_shown_date IS DISTINCT FROM ?::date
                 OR u.stops_ahead_min_shown IS NULL
                 OR u.stops_ahead_min_shown > f.v)
          RETURNING f.v AS stops_ahead_min_shown`,
        [svc.id, clamped, today, today, today]
      );
      if (res?.rows?.[0]) {
        const persisted = Number(res.rows[0].stops_ahead_min_shown);
        return Number.isFinite(persisted)
          ? { stopsAhead: Math.min(persisted, clamped), yourStop, totalStops, currentStop, atStop, headingToStop }
          : null;
      }
      // Zero rows updated = every sibling row's same-day floor is already
      // ≤ this value (nothing needed writing) — or the visit vanished
      // mid-poll. Re-read the GROUP minimum to tell them apart and display
      // the authoritative floor.
      const reRead = await db.raw(
        `SELECT MIN(s.stops_ahead_min_shown)::int AS min_shown
           FROM scheduled_services s, scheduled_services t
          WHERE t.id = ?::uuid
            AND s.technician_id = t.technician_id
            AND s.scheduled_date = t.scheduled_date
            AND s.customer_id = t.customer_id
            AND s.window_start IS NOT DISTINCT FROM t.window_start
            AND s.stops_ahead_shown_date = ?::date`,
        [svc.id, today]
      );
      const curMinRaw = reRead?.rows?.[0]?.min_shown;
      const curMin = curMinRaw == null ? null : Number(curMinRaw);
      if (Number.isInteger(curMin)) {
        return { stopsAhead: Math.min(curMin, clamped), yourStop, totalStops, currentStop, atStop, headingToStop };
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

// True when the visit's scheduled_date is today in ET — the only day
// computeStopsAhead can ever return a count, so callers gate their
// stops-ahead polling on it (a stale or far-future scheduled link would
// otherwise poll forever for a count that cannot render).
function isServiceDateToday(scheduledDate, today = etDateString()) {
  const d = dateOnly(scheduledDate);
  return d != null && d === today;
}

module.exports = {
  computeStopsAhead,
  isServiceDateToday,
  STOPS_AHEAD_DISPLAY_CAP,
  TERMINAL_STATUSES,
  NOT_A_STOP_STATUSES,
  NOT_A_ROUTE_STOP_STATUSES,
};
