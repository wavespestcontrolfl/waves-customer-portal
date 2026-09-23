/**
 * Packing geometry — the ONE shared implementation of "what real stops exist
 * on the calendar today, and how close can a candidate legally pack against
 * one" for every customer-facing picker (find-time.js, availability.js's
 * legacy zone engine, routes/booking.js's fan-out).
 *
 * Extracted after three straight Codex rounds each found one more input a
 * LOCAL copy of this geometry had forgotten to read (an out-of-zone stop, a
 * version-2 combined allocation, a stop's own credit) — every engine was
 * reimplementing the same "anchor set + packed bound" logic with a slightly
 * different omission. There is now exactly one anchor loader and one bound
 * formula; an engine that needs either calls these instead of rebuilding
 * them.
 *
 * loadPackingAnchors() is a thin, date-wide wrapper over
 * scheduling/occupancy.js's listOccupiedWindows() (unchanged, well-tested
 * logic: every committed stop regardless of zone or technician, version-2
 * combined allocations expanded via visit-capacity.js's occupiedRows, each
 * stop's own expected-minutes credit via expected-service-minutes.js) —
 * reshaped to the raw/expected-end field names every packing consumer
 * reads. It is loaded UNCONDITIONALLY: expected-minutes credit and combined-
 * allocation expansion are catalog/schema facts, not something
 * GATE_SLOT_TRAVEL_GAP should hide. Only DRIVE-TIME filtering (whether a
 * candidate near one of these anchors gets rejected) is gated, by the
 * caller, via travel-gap.js's violatesTravelGap/travelGapEnabled.
 *
 * packedBounds() is travel-gap.js's own expected-end/padding formula
 * (requiredGapMinutes/effectiveEndMinutes), reused rather than re-derived,
 * for the two bounds a packed offer needs: the latest a candidate can start
 * before `next`, and the earliest it can start after `prev`. Both are ALSO
 * clamped so the candidate's RAW (uncredited) window can never overlap a
 * neighbour's RAW window — credit may shrink the buffer, never manufacture
 * an overlap travel-gap.js's own real-overlap check would reject downstream
 * with no fallback (Codex r4 P1, r5 P1: this clamp was previously applied to
 * only one of the two bounds).
 */
const { listOccupiedWindows } = require('./occupancy');
const { paddingMinutesOf, effectiveEndMinutes } = require('./travel-gap');

/**
 * Every committed stop across the whole date range, regardless of zone or
 * technician (unassigned included) — version-2 combined allocations already
 * expanded to their summed span, each with its own expected-minutes credit.
 * Loaded independently of GATE_SLOT_TRAVEL_GAP; a caller that only wants
 * unfiltered anchors (no drive-time rejection) still gets the real anchor
 * set from this call. Returns [] on an empty/invalid range (same contract
 * as listOccupiedWindows).
 *
 * @param {Object} opts
 * @param {Function} [opts.db] — connection/trx (defaults to the shared pool inside listOccupiedWindows)
 * @param {string} opts.dateFrom
 * @param {string} opts.dateTo
 * @param {string[]} [opts.excludeServiceIds]
 * @returns {Promise<Array<{id, technician_id, customer_id, date,
 *   rawStartMin, rawEndMin, expectedEndMin, lat, lng, hold}>>}
 */
async function loadPackingAnchors({ db, dateFrom, dateTo, excludeServiceIds = [] } = {}) {
  const rows = await listOccupiedWindows({
    ...(db ? { db } : {}),
    dateFrom,
    dateTo,
    excludeServiceIds,
    withCoords: true,
  });
  return rows.map((row) => {
    const rawStartMin = row.startMin;
    // listOccupiedWindows' own endMin is already the allocation-expanded
    // (version-2 combined) span — the real, promised window, never adjusted
    // by credit (occupiedRows in visit-capacity.js).
    const rawEndMin = row.endMin;
    const windowMinutes = Number.isFinite(row.windowMinutes) ? row.windowMinutes : Math.max(0, rawEndMin - rawStartMin);
    const expected = Number.isFinite(row.expectedMinutes) ? Math.min(row.expectedMinutes, windowMinutes) : windowMinutes;
    return {
      id: row.id,
      technician_id: row.technician_id,
      customer_id: row.customer_id,
      date: row.date,
      rawStartMin,
      rawEndMin,
      // The credited effective end (owner ruling 2026-09-23) — never earlier
      // than rawStartMin, never later than rawEndMin.
      expectedEndMin: rawStartMin + expected,
      lat: row.lat ?? null,
      lng: row.lng ?? null,
      hold: row.hold === true,
    };
  });
}

/**
 * The two packed bounds for a candidate of `durationMinutes` (own credited
 * `expectedMinutes`, defaulting to the full duration — zero padding) sitting
 * between `prev` and `next` (either a packing anchor from
 * loadPackingAnchors, or null/undefined for "no neighbour on this side" —
 * an HQ leg, an empty day edge). `driveIn`/`driveOut` are the modeled drive
 * minutes to/from prev/next; `buffer` is the flat customer-facing turnaround
 * minutes (0 = no neighbour-buffer geometry, e.g. the gate off or a
 * staff/optimizer caller — both bounds degrade to the legacy drive-only
 * shape).
 *
 * Returns { earliestStart, latestStart }, each null when that side has no
 * neighbour (nothing to bound against). Neither bound reflects the day's
 * open/close hours or "now" — a caller combines these with its own
 * dayOpen/dayClose/todayFloor as it already does.
 *
 * earliestStart: prev's own credited effective end (+ drive + prev's own
 * reduced buffer), floored at prev's RAW end — a candidate can never start
 * before prev's promised window truly closes, however much credit prev
 * carries (Codex r5 P1).
 *
 * latestStart: measured from the candidate's own credited effective end
 * against next's real, never-adjusted window start (+ drive + the
 * candidate's own reduced buffer), then capped at
 * next.rawStartMin - durationMinutes — the candidate's REAL (full-duration)
 * window can never reach next's raw start, however much credit the
 * candidate carries (Codex r4 P1).
 */
function packedBounds({ prev, next, durationMinutes, expectedMinutes, driveIn = 0, driveOut = 0, buffer = 0 }) {
  const ownExpected = Number.isFinite(expectedMinutes) ? Math.min(expectedMinutes, durationMinutes) : durationMinutes;

  let earliestStart = null;
  if (prev) {
    const prevEntity = {
      startMin: prev.rawStartMin,
      endMin: prev.rawEndMin,
      expectedMinutes: prev.expectedEndMin - prev.rawStartMin,
    };
    const prevBuffer = Math.max(0, buffer - paddingMinutesOf(prevEntity));
    earliestStart = Math.max(effectiveEndMinutes(prevEntity) + driveIn + prevBuffer, prev.rawEndMin);
  }

  let latestStart = null;
  if (next) {
    const candidateEntity = { startMin: 0, endMin: durationMinutes, expectedMinutes: ownExpected };
    const nextBuffer = Math.max(0, buffer - paddingMinutesOf(candidateEntity));
    const latestEnd = next.rawStartMin - driveOut - nextBuffer;
    latestStart = Math.min(latestEnd - ownExpected, next.rawStartMin - durationMinutes);
  }

  return { earliestStart, latestStart };
}

module.exports = { loadPackingAnchors, packedBounds };
