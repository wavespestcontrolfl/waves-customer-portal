/**
 * Service-type classification + time-of-day defaults for auto-dispatch.
 *
 * `scheduled_services.service_type` is free-form text. We map it to:
 *   - a technician_capabilities category (general | mosquito | lawn | rodent | exclusion | termite)
 *   - a default time-of-day window, per the owner's routing rule:
 *       pest-family (general / rodent / exclusion / termite / mosquito) → EARLY morning
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

// The two RODENT lines (owner 2026-11-21: the second technician traps, the owner seals).
//
// `rodent` (trapping & bait) is only work a key or a name SAYS is trapping or bait: a trap job, a
// trap check, bait stations, monitoring, a trap-only retainer. Every other rodent job is the
// `exclusion` line: sealing, wire mesh, roof-entry covers, sanitation, entry-point plugging, the
// rodent inspection, the guarantee bundle the estimate engine sells (exclusion + bait stations),
// dead-rodent removal, and the GENERAL rodent visit ("Rodent Control": the first look at a rodent
// problem, which is what /book's rodent choice, the booking-link text for an inspection and an
// estimate hold saved under the lead's interest all save). So a rodent name this file has never
// seen goes to the exclusion line's technician, who does the first visit and the inspection, and
// never to the trapping technician by default. Sanitation, sealing and plugging count only beside
// a rodent, attic or entry-point word: "Cockroach sanitation" stays general pest and "Lawn
// Plugging" stays lawn.
const RODENT_WORD = '(?:rodent|\\brats?\\b|\\bmice\\b|\\bmouse\\b)';
// A trapping or bait word, or the combined pest plan's own label ("Pest & Rodent Control", key
// pest_rodent_quarterly: the pest plan with rodent bait stations, pest-led everywhere in this repo).
const TRAP_OR_BAIT_WORD = '(?:trap|bait|monitor|retainer|pest\\s*(?:&|and)\\s*rodent)';
const EXCLUSION_NAME = new RegExp([
  // Exclusion work, whatever else the name says ("Rodent Exclusion & Trapping" is the first visit).
  'exclusion', 'wire[\\s_]*mesh', 'bird[\\s_]*box', 'roof[-\\s_]?entry',
  '(?:rodent|attic).*sanitation', 'sanitation.*(?:rodent|attic)',
  '(?:rodent|entry[-\\s_]?points?).*(?:plug|seal)', '(?:plug|seal)\\w*.*(?:rodent|entry[-\\s_]?points?)',
  // Any other rodent name with no trapping or bait word in it. Each part of a two-service name
  // ("Rodent Control + Termite Bait Station Service") is read by itself.
  `(?:^|\\+)(?![^+]*${TRAP_OR_BAIT_WORD})[^+]*${RODENT_WORD}`,
].join('|'), 'i');

// Ordered; the first regex match wins. General pest is the fallback. Exclusion is first, so a
// two-service name with an exclusion part ("Rodent Control + Termite Inspection", what /book saves
// for two choices) reads exclusion. 'rodent' is reached only by a name with a trapping or bait word.
const CATEGORY_PATTERNS = [
  ['exclusion', EXCLUSION_NAME],
  ['termite', /termit|foam[_\s]*recurring|recurring[_\s]*foam|wdo|bora\s*care|wood[- ]?destroy|soil\s*(poison|treat)|pre[- ]?slab|preconstruction/i],
  ['rodent', /rodent|\brat\b|\brats\b|mice|\bmouse\b|trapping/i],
  ['mosquito', /mosquito|no[- ]?see[- ]?um|midge/i],
  ['lawn', /lawn|turf|fertiliz|weed\s*control|fungus|grass|aeration|de[- ]?thatch|tree\s*&?\s*(and\s*)?shrub|\bt\s*&\s*s\b|ornamental|palm\s*(injection|treat)/i],
];

const LAWN_FAMILY = new Set(['lawn']);

// The technician_capabilities category vocabulary — every value
// classifyServiceCategory can return. The Team tab editor, the new-hire seed,
// and the CHECK constraint on technician_capabilities.service_category all
// derive from this list; a new category is a migration, not just a regex.
const CAPABILITY_CATEGORIES = ['general', 'mosquito', 'lawn', 'rodent', 'exclusion', 'termite'];

// services.category (the service library) -> capability category / service line.
// inspection / specialty / other / anything unknown names no category of its own:
// the caller falls through to the visit NAME (classifyServiceCategory). One table,
// shared by the service-line map (scheduling/line-technician.js) and the
// capability readers (technician-capabilities.js, GATE_TECH_JOB_TYPE_CHECKS).
const CATALOG_CATEGORY_LINES = Object.freeze({
  pest_control: 'general',
  mosquito: 'mosquito',
  lawn_care: 'lawn',
  tree_shrub: 'lawn',
  rodent: 'rodent',
  termite: 'termite',
  wdo: 'termite',
});

/** The capability category a services.category names, or null when it names none. */
function categoryForCatalogCategory(catalogCategory) {
  const key = String(catalogCategory || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CATALOG_CATEGORY_LINES, key) ? CATALOG_CATEGORY_LINES[key] : null;
}

// The service library holds trapping and exclusion under ONE category ('rodent'), and the rodent
// inspection under 'inspection', so the category cannot tell the two rodent lines apart. The
// service KEY does (owner 2026-11-21, rodent jobs = A: "you seal, he traps"; the owner keeps attic
// sanitation, the rodent inspection that prices a sealing job and the first visit). A job sold with
// trapping and exclusion together is the owner's first visit; its trap checks are their own
// services on the rodent line. A key listed here keeps its line when staff rename the row.
const CATALOG_KEY_LINES = Object.freeze({
  rodent_exclusion: 'exclusion',
  rodent_exclusion_only: 'exclusion',
  rodent_trapping_exclusion: 'exclusion',
  rodent_trapping_exclusion_sanitation: 'exclusion',
  rodent_trapping_sanitation: 'exclusion',
  rodent_wire_mesh: 'exclusion',
  rodent_bird_box: 'exclusion',
  rodent_sanitation_light: 'exclusion',
  rodent_sanitation_standard: 'exclusion',
  rodent_sanitation_heavy: 'exclusion',
  rodent_inspection: 'exclusion',
  // The general rodent visit ("Rodent Pest Control Service"): the first look, as the inspection.
  rodent_general_one_time: 'exclusion',
  // Dead-rodent removal and odor treatment: cleanup, reported with the sanitation services.
  rodent_dead_animal_removal: 'exclusion',
  // Trapping and bait stations: the rodent line.
  rodent_trapping: 'rodent',
  rodent_trapping_followup: 'rodent',
  rodent_trap_check_additional: 'rodent',
  rodent_bait_quarterly: 'rodent',
  rodent_bait_setup: 'rodent',
  rodent_monitoring: 'rodent',
  trap_only_retainer_monthly: 'rodent',
  trap_only_retainer_plus: 'rodent',
  trap_only_retainer_standard: 'rodent',
});

/**
 * The capability category / service line a service-library row names, or null when it names
 * none (the caller then reads the visit NAME). `row` = { service_key, category, name }, any
 * of them optional. The key first (CATALOG_KEY_LINES), then the category. A 'rodent' row whose
 * key is not listed (a service added to the library later) is the rodent line only when its own
 * catalog NAME says trapping or bait; otherwise it is exclusion, as an unknown rodent name is.
 */
function lineForCatalogRow(row) {
  if (!row) return null;
  const key = String(row.service_key || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATALOG_KEY_LINES, key)) return CATALOG_KEY_LINES[key];
  const line = categoryForCatalogCategory(row.category);
  if (line !== 'rodent') return line;
  return row.name && classifyServiceCategory(row.name) === 'rodent' ? 'rodent' : 'exclusion';
}

function classifyServiceCategory(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  // A caller with no visit name passes the service KEY as the name (a key-only slot search): a
  // listed key decides first, the same way the catalog row would.
  const key = s.trim();
  if (Object.prototype.hasOwnProperty.call(CATALOG_KEY_LINES, key)) return CATALOG_KEY_LINES[key];
  for (const [cat, re] of CATEGORY_PATTERNS) {
    if (re.test(s)) return cat;
  }
  return 'general';
}

function serviceFamily(serviceType) {
  const text = String(serviceType || '').replace(/_/g, ' ');
  const hasLawn = CATEGORY_PATTERNS.find(([key]) => key === 'lawn')[1].test(text);
  const hasPest = /pest|insect|\bant\b|roach|spider|flea|tick/i.test(text)
    || CATEGORY_PATTERNS.some(([key, pattern]) => key !== 'lawn' && pattern.test(text));
  if (hasLawn && hasPest) return null;
  const category = classifyServiceCategory(text);
  if (category === 'lawn') return 'lawn';
  if (category !== 'general' || /pest|insect|\bant\b|roach|spider|flea|tick/i.test(text)) return 'pest';
  return null;
}

// A finite preference, measured in route-score minutes. Work rows contribute
// their actual allowance; several services at one visit do not count as
// several geographic stops. Empty, unknown and balanced days stay neutral.
function serviceFamilyPreference(rows, serviceType, { before, after } = {}) {
  const family = serviceFamily(serviceType);
  if (!family) return 0;
  const work = { lawn: 0, pest: 0 };
  for (const row of rows) {
    const key = serviceFamily(row.service_type);
    if (key) work[key] += Math.max(0, Number(row.estimated_duration_minutes) || 60);
  }
  const total = work.lawn + work.pest;
  const other = family === 'lawn' ? 'pest' : 'lawn';
  const dominance = total ? (work[family] - work[other]) / total : 0;
  const previous = serviceFamily(before?.service_type);
  const next = serviceFamily(after?.service_type);
  const switches = Number(!!previous && previous !== family) + Number(!!next && next !== family)
    - Number(!!previous && !!next && previous !== next);
  return 8 * dominance - 3 * switches;
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
  if (key === 'afternoon' && require('../scheduling/policy').capacityEnabled()) {
    // Half-open anchor range: the final 16:00 start promises arrival by 18:00.
    return { ...TIME_WINDOWS.afternoon, endMin: 17 * 60, label: '1:00–6:00 PM' };
  }
  return TIME_WINDOWS[key] || null;
}

module.exports = {
  TIME_WINDOWS,
  CAPABILITY_CATEGORIES,
  CATALOG_CATEGORY_LINES,
  CATALOG_KEY_LINES,
  categoryForCatalogCategory,
  lineForCatalogRow,
  classifyServiceCategory,
  serviceFamily,
  serviceFamilyPreference,
  defaultTimeWindow,
  timeWindowForPreferenceKey,
};
