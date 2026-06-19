/**
 * Service-type classification + time-of-day defaults for auto-dispatch.
 *
 * `scheduled_services.service_type` is free-form text. We map it to:
 *   - a technician_capabilities category (general | mosquito | lawn | rodent | termite)
 *   - a default time-of-day window, per the owner's routing rule:
 *       pest-family (general / rodent / termite / mosquito) → EARLY morning
 *       lawn-family  (lawn / tree & shrub)                   → MID/LATE morning
 *     (the day runs 08:00–17:00).
 *
 * Pure module — no DB, no I/O — so it unit-tests in isolation.
 */

// Internal time-of-day buckets as minute-of-day windows. early/morning/midday/
// afternoon mirror the property_preferences.preferred_time enum; late_morning is
// an internal bucket used as the lawn-family service default.
const TIME_WINDOWS = {
  early_morning: { key: 'early_morning', startMin: 8 * 60, endMin: 10 * 60, label: '8:00–10:00 AM' },
  morning:       { key: 'morning',       startMin: 9 * 60, endMin: 11 * 60, label: '9:00–11:00 AM' },
  late_morning:  { key: 'late_morning',  startMin: 10 * 60, endMin: 12 * 60, label: '10:00 AM–12:00 PM' },
  midday:        { key: 'midday',        startMin: 11 * 60, endMin: 13 * 60, label: '11:00 AM–1:00 PM' },
  afternoon:     { key: 'afternoon',     startMin: 13 * 60, endMin: 17 * 60, label: '1:00–5:00 PM' },
  no_preference: { key: 'no_preference', startMin: 8 * 60, endMin: 17 * 60, label: 'Anytime 8–5' },
};

// Ordered most-specific-first; first regex match wins. General pest is the fallback.
const CATEGORY_PATTERNS = [
  ['termite', /termit|wdo|bora\s*care|wood[- ]?destroy|soil\s*(poison|treat)|pre[- ]?slab|preconstruction/i],
  ['rodent', /rodent|\brat\b|\brats\b|mice|\bmouse\b|trapping|exclusion/i],
  ['mosquito', /mosquito|no[- ]?see[- ]?um|midge/i],
  ['lawn', /lawn|turf|fertiliz|weed\s*control|fungus|grass|aeration|de[- ]?thatch|tree\s*&?\s*(and\s*)?shrub|\bt\s*&\s*s\b|ornamental|palm\s*(injection|treat)/i],
];

const LAWN_FAMILY = new Set(['lawn']);

function classifyServiceCategory(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  for (const [cat, re] of CATEGORY_PATTERNS) {
    if (re.test(s)) return cat;
  }
  return 'general';
}

/**
 * Default time-of-day window for a service when the customer has no explicit
 * preferred_time. Lawn-family → mid/late morning; everything pest-family → early.
 */
function defaultTimeWindow(serviceType) {
  const category = classifyServiceCategory(serviceType);
  return LAWN_FAMILY.has(category) ? TIME_WINDOWS.late_morning : TIME_WINDOWS.early_morning;
}

// Map the property_preferences.preferred_time enum → a TIME_WINDOWS bucket.
function timeWindowForPreferenceKey(key) {
  if (!key || key === 'no_preference') return null;
  return TIME_WINDOWS[key] || null;
}

module.exports = {
  TIME_WINDOWS,
  classifyServiceCategory,
  defaultTimeWindow,
  timeWindowForPreferenceKey,
};
