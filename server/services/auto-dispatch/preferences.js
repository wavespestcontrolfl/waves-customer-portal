/**
 * Customer scheduling-preference normalization for auto-dispatch.
 *
 * Reads the existing property_preferences row (preferred_day, preferred_time,
 * blackout_start/end) and normalizes it into a structure the scorer/candidate
 * generator consume. Per the owner decision (updated 2026-06-21):
 *   - blackout = HARD constraint (handled in candidate-slots)
 *   - EXPLICIT preferred_day / preferred_time (the customer set them in the
 *     portal, i.e. not 'no_preference') = HARD constraints too. Route efficiency
 *     is the optimization driver, but a customer's portal preference OVERRIDES
 *     it: candidate-slots only keeps slots on the preferred day/time, so a visit
 *     is never moved off the customer's stated day/time to shave detour.
 *   - the service-type DEFAULT time window (pest → early AM, lawn → mid/late AM,
 *     from service-category.js) is NOT a customer preference — it stays SOFT
 *     scoring so route can still optimize freely when the customer set no time.
 */
const db = require('../../models/db');
const {
  defaultTimeWindow,
  timeWindowForPreferenceKey,
  classifyServiceCategory,
} = require('./service-category');
const { toDateStr } = require('./dates');

const DAY_NAME_TO_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Pure normalizer — separated from the DB read so it unit-tests in isolation.
 */
function normalizePreferences(prefs, serviceType) {
  const preferred_days = [];
  let explicitDay = null;
  if (prefs && prefs.preferred_day && prefs.preferred_day !== 'no_preference') {
    explicitDay = prefs.preferred_day;
    if (DAY_NAME_TO_INDEX[explicitDay] != null) preferred_days.push(explicitDay);
  }

  const explicitTime = (prefs && prefs.preferred_time && prefs.preferred_time !== 'no_preference')
    ? timeWindowForPreferenceKey(prefs.preferred_time)
    : null;
  const defaultTime = defaultTimeWindow(serviceType);

  const blackout = (prefs && prefs.blackout_start && prefs.blackout_end)
    ? {
        // pg returns DATE columns as Date objects — normalize so inBlackout's
        // string comparison actually matches (else the HARD filter never fires).
        start: toDateStr(prefs.blackout_start),
        end: toDateStr(prefs.blackout_end),
      }
    : null;

  return {
    preferred_days,
    // explicit customer day pref → HARD filter in candidate-slots when non-empty
    preferred_day_indexes: preferred_days.map((d) => DAY_NAME_TO_INDEX[d]),
    preferred_time_window: explicitTime,          // explicit customer pref → HARD filter when non-null
    default_time_window: defaultTime,             // service-type default → SOFT scoring only (never a hard filter)
    effective_time_window: explicitTime || defaultTime, // explicit pref if set, else default — used by SOFT scoring
    blackout,                                     // HARD constraint, or null
    contact_preference: (prefs && prefs.contact_preference) || null,
    has_explicit_prefs: !!(explicitDay || explicitTime || blackout),
    strict: false,
    service_category: classifyServiceCategory(serviceType),
    raw_snapshot: prefs
      ? {
          preferred_day: prefs.preferred_day || null,
          preferred_time: prefs.preferred_time || null,
          blackout_start: blackout ? blackout.start : null,
          blackout_end: blackout ? blackout.end : null,
        }
      : null,
  };
}

async function getCustomerSchedulingPreferences(customerId, serviceType) {
  // No try/catch: a real read error must propagate so the orchestrator skips this
  // service (fail closed) rather than silently dropping the customer's HARD
  // blackout constraint. A missing ROW is not an error — .first() returns
  // undefined and normalizePreferences applies service-type defaults.
  const prefs = await db('property_preferences')
    .where('customer_id', customerId)
    .first(
      'preferred_day', 'preferred_time', 'contact_preference',
      'blackout_start', 'blackout_end', 'access_notes', 'special_instructions',
    );
  return normalizePreferences(prefs, serviceType);
}

module.exports = { getCustomerSchedulingPreferences, normalizePreferences, DAY_NAME_TO_INDEX };
