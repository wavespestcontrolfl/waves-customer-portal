/**
 * CURRENT CONFLICT — whether a visit cannot stay in the slot it holds
 * (owner 2026-10-09: "it should be moving appointments that overlap").
 * ACTIVE ONLY while GATE_AUTO_DISPATCH_CONFLICT_MOVES is on
 * (config.conflictMovesEnabled, carried here as ctx.conflictMoves); off,
 * this module reads nothing and returns null.
 *
 * Two conflicts, both read with the same sources the move writer and the
 * offer surfaces use (never a re-expression of them):
 *   closed_day  the visit's date is an owner blackout day or weekly day off
 *               (scheduling/blackout-dates.js isBlackoutDate);
 *   overlap     the visit's own arrival span overlaps another live stop that
 *               date: the rebooker's read-only probe (probeMoveConflicts,
 *               booked interviews included) expanded by occupancy.js's
 *               occupiedRows. The visit's own group is excluded. So is every
 *               other row of the same customer AT THE SAME PLACE (two
 *               services at one address in one hour are one stop for the
 *               technician, grouped or not; the same customer's second
 *               property is a different stop, visit-groups.js canJoin) and,
 *               once there are two technicians, a row assigned to a different
 *               one (owner 2026-10-03: only the same technician or an
 *               unassigned row counts).
 *
 * The result only lifts the score bar and the drive floor for this visit
 * (move-rules.js). Every other guard still applies to it: eligibility, the
 * 73-hour and reminder freeze, person-placed, customer-confirmed, the flex
 * window, preferences and the writer's own overlap check on the destination.
 * A visit with no arrival window is never in conflict here.
 */
const { toDateStr } = require('./dates');
const { occupiedRows, windowsOverlap } = require('../scheduling/occupancy');

const FULL_DAY = { start: '00:00', end: '23:59' };

function hhmmToMin(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return Number.isNaN(h) ? null : h * 60 + (m || 0);
}

function sameCustomer(row, service) {
  return !!row.customer_id && String(row.customer_id) === String(service.customer_id);
}

// A row a different technician works is not this technician's stop.
function isOtherStop(row, service) {
  return !(row.technician_id && service.technician_id && String(row.technician_id) !== String(service.technician_id));
}

// Where a row is worked: its linked property, else its own service address,
// else '' (the customer's primary address).
function placeKey(row) {
  if (row.property_id) return `p:${row.property_id}`;
  const line = String(row.service_address_line1 || '').trim().toLowerCase();
  return line ? `a:${line}|${String(row.service_address_zip || '').trim()}` : '';
}

// Ids among `rows` that are the visit's own customer at the visit's own
// place: one stop with the visit, not a conflict. The probe's projection
// carries no location, so the place is read here (Codex #6207 r1 P1: a
// customer with two properties booked into one hour IS a conflict).
async function samePlaceIds(db, service, rows) {
  const ids = rows.filter((r) => sameCustomer(r, service)).map((r) => String(r.id));
  if (!ids.length) return new Set();
  const places = await db('scheduled_services')
    .whereIn('id', [String(service.id), ...ids])
    .select('id', 'property_id', 'service_address_line1', 'service_address_zip');
  const byId = new Map(places.map((p) => [String(p.id), placeKey(p)]));
  const own = byId.get(String(service.id));
  // A row that cannot be read is treated as a different place (a conflict).
  return new Set(ids.filter((id) => byId.has(id) && byId.get(id) === own));
}

async function overlappingStopIds(service, ctx, excludeIds, dateStr) {
  // Required lazily, like candidate-slots.js (the writer modules load on use).
  const { probeMoveConflicts, occupancyProbeEnd } = require('../rebooker');
  const start = hhmmToMin(service.window_start);
  const end = hhmmToMin(occupancyProbeEnd(service.window_start, service.window_end, service.estimated_duration_minutes));
  if (start == null || end == null) return [];
  const { rows } = await probeMoveConflicts({
    conn: ctx.db,
    target: {
      id: `auto-dispatch-conflict-probe:${dateStr}`, date: dateStr, windowStart: FULL_DAY.start, windowEnd: FULL_DAY.end, technicianId: null,
    },
    excludeServiceIds: [...excludeIds],
  });
  const overlapping = occupiedRows(rows)
    .filter((r) => isOtherStop(r, service) && r.startMin != null && Number.isFinite(r.endMin))
    .filter((r) => windowsOverlap(start, end, r.startMin, r.endMin));
  const samePlace = await samePlaceIds(ctx.db, service, overlapping);
  return overlapping.map((r) => String(r.id)).filter((id) => !samePlace.has(id));
}

/**
 * The visit's conflict, or null. `{ kind: 'closed_day', date }` or
 * `{ kind: 'overlap', date, with: [row ids] }` — ids and codes only.
 * A read failure propagates: the caller's evaluation fails for this visit
 * and the run records it, rather than a conflict being guessed either way.
 */
async function currentConflict(service, ctx, excludeIds) {
  if (!ctx.conflictMoves || !service.window_start) return null;
  const dateStr = toDateStr(service.scheduled_date);
  const { isBlackoutDate } = require('../scheduling/blackout-dates');
  if (await isBlackoutDate(dateStr, ctx.db)) return { kind: 'closed_day', date: dateStr };
  const ids = await overlappingStopIds(service, ctx, excludeIds || new Set([String(service.id)]), dateStr);
  return ids.length ? { kind: 'overlap', date: dateStr, with: ids } : null;
}

module.exports = { currentConflict, _internals: { isOtherStop, placeKey, samePlaceIds, overlappingStopIds } };
