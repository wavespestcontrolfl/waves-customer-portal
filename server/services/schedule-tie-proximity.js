/**
 * Schedule tie-proximity ordering (owner ruling 2026-09-26)
 *
 * In a technician's day list, two appointments that start at the same time
 * (or close to it) should show in whichever order keeps the truck moving —
 * the one closer to the previous stop shows first, never the one that
 * happened to get booked first. This module is DISPLAY ONLY: it returns an
 * order index for each stop; nothing here writes route_order or anything
 * else to the database, and it sends no customer communication.
 *
 * Behind GATE_SCHEDULE_TIE_PROXIMITY (server/config/feature-gates.js) —
 * callers check the gate themselves and skip this module entirely when it
 * is off, so gate-off behavior is byte-identical to before this module
 * existed.
 *
 * Rules (owner-approved defaults):
 *   - A "tie" is any stop whose window start is within TIE_WINDOW_MINUTES of
 *     the EARLIEST remaining stop's start (the "anchor"), recomputed on every
 *     pick — never a fixed bucket. A stop is never pulled ahead of one whose
 *     start is more than TIE_WINDOW_MINUTES earlier, because it can only ever
 *     become a candidate once it IS the earliest remaining (or within the
 *     window of whatever is).
 *   - When the previous stop has coordinates, geocoded candidates are ranked
 *     by drive time from it (shortest first, ties broken by their original
 *     relative order — a stable sort); ungeocoded candidates sort after them.
 *     When the previous stop is ungeocoded, proximity is unknowable and the
 *     candidates keep their existing relative order until a point is known.
 *   - "Previous stop" is the stop just placed in the OUTPUT order (planned,
 *     not actual completion). The first pick of the day measures from
 *     `origin` (HQ by default).
 *   - Stops with no window start at all stay at the end, in their original
 *     relative order — same fallback the client's own windowStart sort uses
 *     today.
 *
 * Uses the ONE shared in-house drive-time estimator (route-optimizer.js's
 * haversine + milesToDriveMinutes, itself gated by GATE_DRIVE_TIME_CALIBRATION)
 * — no new Google API calls, no new estimator.
 */
const { haversine, milesToDriveMinutes, HQ } = require('./route-optimizer');

// Owner ruling 2026-09-26: a tie is a start within 30 minutes of the anchor.
const TIE_WINDOW_MINUTES = 30;

/**
 * Parse a stop's window start into minutes-of-day. Accepts the same shapes
 * the client's own parser does — a Postgres `time` string ("08:00:00"),
 * "H:MM", or a bare "8:00" — and returns null for anything else (no window
 * start at all, or unparseable). Mirrors
 * client/src/components/schedule/MobileDispatchList.jsx's parseHHMM so the
 * server and client agree on what counts as timed.
 */
function parseWindowStartMinutes(windowStart) {
  if (windowStart == null) return null;
  const m = String(windowStart).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

/** True when a stop carries a usable lat/lng pair (not null, not 0/0). */
function hasCoords(stop) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
}

/** Drive minutes between two {lat,lng} points under the shared estimator. */
function driveMinutesBetween(from, to) {
  return milesToDriveMinutes(haversine(from.lat, from.lng, to.lat, to.lng));
}

/**
 * Order ONE technician's day by tie-proximity. `stops` is that tech's
 * services for a single day; each item needs at least `id`, `windowStart`,
 * `lat`, `lng`. Returns a NEW array of shallow copies in display order, each
 * carrying a 0-based `displayOrder`. Input objects are never mutated.
 *
 * `origin` is the point the FIRST pick's drive time is measured from — HQ by
 * default (owner ruling: "first stop of the day measures from HQ/office").
 */
function orderStopsByTieProximity(stops, { origin = HQ } = {}) {
  const entries = (Array.isArray(stops) ? stops : []).map((stop, idx) => ({
    stop,
    idx,
    startMin: parseWindowStartMinutes(stop?.windowStart),
    coords: hasCoords(stop) ? { lat: Number(stop.lat), lng: Number(stop.lng) } : null,
  }));

  const timed = entries.filter((e) => e.startMin != null);
  // Stable: Array#filter preserves relative order, matching the client's
  // "no window start stays at the end, in incoming order" fallback.
  const untimed = entries.filter((e) => e.startMin == null);

  const remaining = [...timed];
  const picked = [];
  let previous = origin;

  while (remaining.length > 0) {
    let anchor = remaining[0].startMin;
    for (const e of remaining) if (e.startMin < anchor) anchor = e.startMin;

    const candidates = remaining.filter((e) => e.startMin <= anchor + TIE_WINDOW_MINUTES);
    const geocodedCandidates = candidates.filter((e) => e.coords);

    let next;
    if (previous && geocodedCandidates.length > 0) {
      next = geocodedCandidates.reduce((best, e) => {
        const drive = driveMinutesBetween(previous, e.coords);
        const bestDrive = driveMinutesBetween(previous, best.coords);
        // Strict less-than keeps the earlier (stable) candidate on a tie.
        return drive < bestDrive ? e : best;
      }, geocodedCandidates[0]);
    } else {
      // The immediately previous stop has no usable point, so proximity is
      // unknowable. Preserve the candidates' existing order rather than
      // ranking from an older stop (or reusing HQ after the first pick).
      next = candidates[0];
    }

    remaining.splice(remaining.indexOf(next), 1);
    picked.push(next);
    previous = next.coords;
  }

  return [...picked, ...untimed].map((e, i) => ({ ...e.stop, displayOrder: i }));
}

// Stamps a per-technician `displayOrder` (schedule-tie-proximity) onto each
// payload in place. `rows` optionally supplies coordinates by id (the week
// feed's raw visit_lat/visit_lng) when the payloads don't carry lat/lng.
function stampTieProximityDisplayOrder(payloads, rows = null) {
  const rowById = rows ? new Map(rows.map((r) => [r.id, r])) : null;
  const byTech = new Map();
  payloads.forEach((p) => {
    if (!p.technicianId) return;
    if (!byTech.has(p.technicianId)) byTech.set(p.technicianId, []);
    const row = rowById && rowById.get(p.id);
    byTech.get(p.technicianId).push(row
      ? { id: p.id, windowStart: p.windowStart, lat: row.visit_lat, lng: row.visit_lng }
      : p);
  });
  const orderById = new Map();
  byTech.forEach((stops) => {
    orderStopsByTieProximity(stops).forEach((o) => orderById.set(o.id, o.displayOrder));
  });
  payloads.forEach((p) => {
    if (orderById.has(p.id)) p.displayOrder = orderById.get(p.id);
  });
}

module.exports = {
  orderStopsByTieProximity,
  stampTieProximityDisplayOrder,
  parseWindowStartMinutes,
  TIE_WINDOW_MINUTES,
};
