/**
 * Which /book funnel service a service the texting AI is talking about is —
 * an EXPLICIT table, no substring or keyword heuristic (Codex #5406 r1 P2 +
 * independent review: the recurring seeder's classifier both over-matched —
 * anything containing "ant", "Lawn Fungus Treatment" read as a lawn funnel
 * service — and under-matched — "Termite Inspection Service" read as termite
 * bait and "Rodent Pest Control" as rodent bait, so /book's own `termite` and
 * `rodent` choices were withheld).
 *
 * Funnel keys are the ones routes/booking.js books (BOOKING_FUNNEL_SERVICE_
 * DURATIONS): pest_control, lawn_care, mosquito, tree_shrub, termite, rodent,
 * bora_care. Anything NOT in these tables has no funnel service and OPEN TIMES
 * is withheld: actual bait, WDO and palm-injection work, add-on treatments,
 * events and every one-off catalog row stay off /book here on purpose.
 *
 * Two lookups, both exact:
 *   funnelKeyForCatalogKey(service_key)  — the catalog row's key
 *   funnelKeyForServiceName(name)        — a display name (funnel labels and
 *                                          the known catalog names), compared
 *                                          whole, case-insensitively
 */

// services.service_key → /book funnel key. Audited key by key against the
// catalog seeds/renames (see sms-book-funnel-map.test.js for the withheld
// list): only a row whose job IS the funnel's job is mapped.
const FUNNEL_KEY_BY_CATALOG_KEY = Object.freeze({
  // pest_control: the general pest visit, any cadence
  pest_control: 'pest_control',
  pest_recurring: 'pest_control',
  pest_onetime: 'pest_control',
  // The one-time pest identity: prod carries the admin-created
  // one_time_pest_control row, migration-built databases its documented twin
  // pest_initial_cleanout (20260825000011 CONDITIONAL_SEEDS; both quote as
  // the engine's oneTimePest line — public-services-menu.js).
  one_time_pest_control: 'pest_control',
  pest_initial_cleanout: 'pest_control',
  pest_general_monthly: 'pest_control',
  pest_general_bimonthly: 'pest_control',
  pest_general_quarterly: 'pest_control',
  pest_general_semiannual: 'pest_control',
  // lawn_care: the lawn program visit (no fungicide / aeration / dethatching /
  // top-dressing / insect knockdown — those are their own jobs)
  lawn_care: 'lawn_care',
  lawn_care_basic: 'lawn_care',
  lawn_care_standard: 'lawn_care',
  lawn_care_enhanced: 'lawn_care',
  lawn_care_premium: 'lawn_care',
  lawn_care_6week: 'lawn_care',
  lawn_care_monthly: 'lawn_care',
  lawn_care_quarterly: 'lawn_care',
  lawn_care_recurring: 'lawn_care',
  lawn_care_one_time: 'lawn_care',
  lawn_recurring: 'lawn_care',
  lawn_onetime: 'lawn_care',
  // mosquito: the spray visit (no event spray, no misting system)
  mosquito: 'mosquito',
  mosquito_monthly: 'mosquito',
  mosquito_seasonal: 'mosquito',
  mosquito_recurring: 'mosquito',
  mosquito_one_time: 'mosquito',
  mosquito_onetime: 'mosquito',
  // tree_shrub
  tree_shrub: 'tree_shrub',
  tree_shrub_6week: 'tree_shrub',
  tree_shrub_program: 'tree_shrub',
  tree_shrub_quarterly: 'tree_shrub',
  // termite: the INSPECTION (never bait, liquid, trenching, bond or WDO)
  termite_inspection: 'termite',
  // rodent: the general rodent visit and the inspection (never bait,
  // trapping, exclusion or sanitation work)
  rodent_general_one_time: 'rodent',
  rodent_inspection: 'rodent',
  // bora_care
  bora_care: 'bora_care',
});

// Display name (lower-cased, whole string) → funnel key: the funnel's own
// labels (booking.js BOOKING_FUNNEL_SERVICE_LABELS / ALIASES) and the catalog
// names of the rows above that are known by name. Any other name is resolved
// through the catalog (sms-shadow-drafter bookFunnelKeyFor), never guessed.
const FUNNEL_KEY_BY_NAME = Object.freeze({
  'pest control': 'pest_control',
  'general pest control (monthly)': 'pest_control',
  'general pest control (quarterly)': 'pest_control',
  'lawn care': 'lawn_care',
  'mosquito control': 'mosquito',
  'mosquito control (monthly)': 'mosquito',
  'seasonal mosquito control service': 'mosquito',
  'tree & shrub': 'tree_shrub',
  'every 6 weeks tree & shrub care service': 'tree_shrub',
  'bi-monthly tree & shrub care service': 'tree_shrub',
  'tree & shrub care program': 'tree_shrub',
  'termite inspection': 'termite',
  'termite inspection service': 'termite',
  'rodent control': 'rodent',
  'rodent pest control': 'rodent',
  'rodent pest control service': 'rodent',
  'bora-care wood treatment': 'bora_care',
  'bora-care wood treatment service': 'bora_care',
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function funnelKeyForCatalogKey(serviceKey) {
  const key = String(serviceKey || '').trim().toLowerCase();
  return key && hasOwn(FUNNEL_KEY_BY_CATALOG_KEY, key) ? FUNNEL_KEY_BY_CATALOG_KEY[key] : '';
}

function funnelKeyForServiceName(name) {
  const text = String(name || '').trim().toLowerCase();
  return text && hasOwn(FUNNEL_KEY_BY_NAME, text) ? FUNNEL_KEY_BY_NAME[text] : '';
}

module.exports = { FUNNEL_KEY_BY_CATALOG_KEY, FUNNEL_KEY_BY_NAME, funnelKeyForCatalogKey, funnelKeyForServiceName };
