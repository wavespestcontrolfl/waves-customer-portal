/**
 * Lawn report measured cold (lawn report rebuild P36, GATE_LAWN_MEASURED_COLD).
 *
 * The seasonal-dip sentence says the lawn is slowing for the season. In
 * southwest Florida an October can be warm, so the calendar alone must not say
 * it: the sentence prints only when >= 2 of the 7 ET calendar nights before the
 * VISIT's day had a low at or below 55F (lawn-seasonality.js holds the pure
 * rule). This module reads those nights for a property and freezes the verdict
 * with the visit.
 *
 * Freeze: service_records.structured_notes.lawnMeasuredCold, a MAP keyed by the
 * visit day (YYYY-MM-DD), first writer wins per key with the guard in the
 * UPDATE predicate (no preceding read, no row lock). A report token is a
 * permanent customer document, so once a verdict is settled every later render
 * replays it. The key is the day, not the assessment: the verdict is a fact
 * about (property, day), and a corrected visit date simply asks a new question.
 *
 * Settled = at least 2 cold nights (true), or all 7 nights read and fewer than
 * 2 cold (false). Anything else (a missing night, a failed read) is unknown:
 * never frozen, never printed as a dip, and the caller marks the render
 * uncacheable so a transient failure is retried on the next view.
 */

const logger = require('../logger');
const { fetchNightlyMinsF, toCoordinate } = require('./application-conditions');
const {
  trailingNightDates, coldNightsInTrailingWeek, measuredColdMet,
} = require('./lawn-seasonality');

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The frozen entry for this visit day, or null. Only an entry carrying a
// boolean verdict counts: a malformed one is treated as absent.
function storedMeasuredColdFor(structuredNotes, day) {
  if (!day) return null;
  const map = parseJsonObject(structuredNotes).lawnMeasuredCold;
  if (!map || typeof map !== 'object') return null;
  const entry = map[day];
  return entry && typeof entry === 'object' && typeof entry.met === 'boolean' ? entry : null;
}

// Reads the 7 nights before `visitDay` for a property and applies the rule.
// null when nothing could be read; otherwise { met: true|false|null, nights,
// coldNights }. Never freezes (the tech-tips ranking uses it as is).
async function readMeasuredCold({ latitude, longitude, visitDay } = {}) {
  const dates = trailingNightDates(visitDay);
  if (!dates) return null;
  const nights = await fetchNightlyMinsF({ latitude, longitude, dates });
  if (!nights) return null;
  const mins = nights.map((n) => n.minF);
  return { met: measuredColdMet(mins), nights, coldNights: coldNightsInTrailingWeek(mins).cold };
}

async function freezeMeasuredCold(serviceRecordId, day, entry, knex) {
  if (!serviceRecordId || !day || !entry) return null;
  try {
    const updated = await knex('service_records')
      .where({ id: serviceRecordId })
      // First writer wins PER DAY: the guard is this key's absence, in the
      // predicate, with no preceding read.
      .whereRaw(
        "COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnMeasuredCold' -> ? IS NULL",
        [day],
      )
      .update({
        // Two-level merge: the inner || adds this key to the existing map, the
        // outer || puts the map back (same shape as the lawn week-weather freeze).
        structured_notes: knex.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || jsonb_build_object('lawnMeasuredCold',"
          + " COALESCE(COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnMeasuredCold', '{}'::jsonb) || ?::jsonb)",
          [JSON.stringify({ [day]: entry })],
        ),
      });
    if (updated > 0) return entry;
    // Lost the race for this key: adopt the winner's verdict so both renders agree.
    const row = await knex('service_records').where({ id: serviceRecordId }).first('structured_notes');
    return storedMeasuredColdFor(row?.structured_notes, day);
  } catch (err) {
    logger.warn(`[lawn-measured-cold] freeze failed for ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

/**
 * The verdict for one visit, frozen with the visit.
 *
 * @param {object} args
 * @param {object} args.service the report's service row (structured_notes, id, coordinates)
 * @param {string} args.day the visit day, YYYY-MM-DD
 * @param {object} args.knex
 * @param {boolean} args.allowFetch false = replay a frozen verdict only (no weather call)
 * @returns {Promise<{met: boolean|null, frozen: boolean, unfrozen: boolean, pendingReason: string|null}>}
 *   met: true prints the dip sentence; false/null do not.
 *   frozen: the verdict is the one frozen with the visit (read back or just written). Anything else is
 *     DEGRADED: cold-dependent first-writer-wins freezes must not be created from it.
 *   unfrozen: a read or the freeze FAILED, so the output is not reproducible (do not cache, defer a pinned send).
 *   pendingReason: nothing failed, the verdict cannot be read YET (no coordinates): do not cache.
 */
async function resolveVisitMeasuredCold({ service, day, knex, allowFetch = false } = {}) {
  const stored = storedMeasuredColdFor(service?.structured_notes, day);
  if (stored) return { met: stored.met, frozen: true, unfrozen: false, pendingReason: null };
  // Not opted in (Ask Waves, email, other builders): no weather call. Unknown,
  // so no dip sentence; the caller treats the build as degraded and uncacheable.
  if (!allowFetch) return { met: null, frozen: false, unfrozen: false, pendingReason: null };

  const latitude = service?.customer_latitude ?? service?.latitude ?? service?.lat;
  const longitude = service?.customer_longitude ?? service?.longitude ?? service?.lng;
  const latN = toCoordinate(latitude);
  const lonN = toCoordinate(longitude);
  if (latN == null || lonN == null || (latN === 0 && lonN === 0)) {
    // The hourly geocoder backstop may still fill the coordinates (same rule
    // as the lawn week weather): pending, not failed.
    return { met: null, frozen: false, unfrozen: false, pendingReason: 'no_coordinates' };
  }

  let read = null;
  try {
    read = await readMeasuredCold({ latitude: latN, longitude: lonN, visitDay: day });
  } catch (err) {
    logger.warn(`[lawn-measured-cold] read failed: ${err.message}`);
  }
  // A failed or incomplete read is unknown, never "not cold".
  if (!read || read.met === null) return { met: null, frozen: false, unfrozen: true, pendingReason: null };

  const canonical = await freezeMeasuredCold(service.id, day, {
    // The entry names the question it answers.
    serviceDate: day,
    met: read.met,
    coldNights: read.coldNights,
    nights: read.nights,
    source: 'open_meteo',
    frozenAt: new Date().toISOString(),
  }, knex);
  if (canonical) return { met: canonical.met, frozen: true, unfrozen: false, pendingReason: null };
  // Read fine but could not persist: this render is not reproducible. Use our
  // own verdict for the live view, but never cache it.
  return { met: read.met, frozen: false, unfrozen: true, pendingReason: null };
}

module.exports = {
  storedMeasuredColdFor,
  readMeasuredCold,
  freezeMeasuredCold,
  resolveVisitMeasuredCold,
};
