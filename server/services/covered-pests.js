'use strict';

/**
 * The ONE list of pest nouns the general pest plan covers, as regex sources. reservice-scheduler builds its pest-noun
 * vocabulary (RESERVICE_PEST_NOUNS_SOURCE — the lane classifier, the pest-report classifier and the drafter's prescreen
 * all read it) from this list. It tracks estimate-service-details.js's "Covered pests" row (ants incl. ghost / big-headed /
 * carpenter / fire ants, large roaches / "palmetto bugs", spiders, crickets, earwigs, silverfish, millipedes, centipedes,
 * pillbugs, scorpions, wasps, stink & boxelder bugs) plus the common synonyms of those covered pests (roly-poly and
 * sowbug for pillbug, cockroach for roach). A test asserts every covered pest in that row is matched.
 *
 * Deliberately NOT here: the excluded specialties (termites, mosquitoes — reservice-scheduler's excluded-specialty list;
 * every pest under the estimate copy's "Separate services": German roaches, fleas, bed bugs, rodents, wildlife —
 * SEPARATE_SERVICE_PEST_NOUN_SOURCES below; and the pests the CATALOG sells as their own services — ticks (tick_control /
 * flea_tick) and bees (bee_wasp_removal) — CATALOG_SEPARATE_PEST_NOUN_SOURCES below). The classifier that authorizes / requires
 * the covered re-service reads ONLY this covered row (plus synonyms; hornets ride with wasps — the company facts cover hornet
 * nests on regular visits). Generic words (pest, bug) stay for the broad prescreen. (Codex round-34 P2, PR #5336)
 */
const COVERED_PEST_NOUN_SOURCES = Object.freeze([
  'pests?',
  '(?<!\\bchinch\\s+)bugs?',
  'palmetto\\s*bugs?',
  'ants?',
  'roach(?:es)?',
  'cockroach(?:es)?',
  'spider\\w*',
  '(?<!\\bmole\\s+)crickets?',
  'earwigs?',
  'silverfish',
  'millipedes?',
  'centipedes?',
  'pill\\s*bugs?|roly[- ]?poly|roly[- ]?polies|sow\\s*bugs?',
  'scorpions?',
  'wasps?',
  'hornets?',
  'stink\\s*bugs?',
  'boxelder\\s*bugs?',
]);

/**
 * The pests the estimate copy lists under "Separate services" — NOT part of the general pest plan, so a report of one
 * is an EXCLUDED SPECIALTY (same mechanism as bed bugs / protocols.json bed_bug), never a free general-pest re-service.
 * The set is derived at load from estimate-service-details.js's pest "Separate services" row ("German-roach cleanouts,
 * fleas, bed bugs, rodents, wildlife, turf insect programs"): each item maps to a noun source here; an item that maps to
 * null is a program, not a pest noun. An item the copy adds that is missing from this map fails LOUDLY at load, so the two
 * cannot drift silently.
 */
const SEPARATE_SERVICE_ITEM_SOURCES = Object.freeze({
  'german-roach cleanouts': 'german[- ]?(?:cock)?roach(?:es)?',
  fleas: 'fleas?',
  'bed bugs': 'bed[- ]?bugs?',
  rodents: 'rodents?|rats?|mice|mouse',
  wildlife: 'wildlife',
  'turf insect programs': null,
});

// Load-time derivation must NEVER throw: this module sits under reservice-scheduler, which portal request paths load. A copy
// rewrite (main's lawn/estimate copy was reworked and dropped the old "Covered turf insects" row) once made the throw take
// down every request that touched the scheduler (CI: request-app-receipts 500s). On any drift it falls back to the KNOWN
// static set and reports it on `DERIVATION`; a test asserts the derivation is clean, so drift fails CI instead of production.
function separateServiceItems() {
  const { SERVICE_DETAILS_COPY } = require('./estimate-service-details');
  const rows = [];
  const walk = (o) => {
    if (Array.isArray(o)) {
      if (o[0] === 'Separate services' && typeof o[1] === 'string' && /\bfleas\b/i.test(o[1])) rows.push(o[1]);
      o.forEach(walk);
    } else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(SERVICE_DETAILS_COPY);
  if (!rows.length) return null;
  return rows[0].split(/,\s*/).map((item) => item.trim().toLowerCase());
}
const DERIVATION = { separateServices: 'copy', turfInsects: 'copy', unmapped: [] };
function safely(fn) {
  try { return fn(); } catch (err) { return null; }
}
let derivedSeparate = safely(separateServiceItems);
if (!derivedSeparate) { DERIVATION.separateServices = 'fallback'; derivedSeparate = Object.keys(SEPARATE_SERVICE_ITEM_SOURCES); }
const SEPARATE_SERVICE_ITEMS = Object.freeze(derivedSeparate);
DERIVATION.unmapped.push(...SEPARATE_SERVICE_ITEMS.filter((item) => !Object.prototype.hasOwnProperty.call(SEPARATE_SERVICE_ITEM_SOURCES, item)).map((item) => `separate:${item}`));
const SEPARATE_SERVICE_PEST_NOUN_SOURCES = Object.freeze(SEPARATE_SERVICE_ITEMS.map((item) => SEPARATE_SERVICE_ITEM_SOURCES[item]).filter(Boolean));

/**
 * TURF insects — the lawn program's "Covered turf insects" row in estimate-service-details.js ("Chinch bugs, sod webworms,
 * armyworms, white grubs & mole crickets"). They are LAWN-lane pests, matched BEFORE the generic household nouns (chinch
 * BUGS, mole CRICKETS would otherwise read as general pest). Derived at load from the copy like the separate-services set;
 * an item the copy adds without a mapping fails loudly. (Codex round-33 P2, PR #5336)
 */
const TURF_INSECT_ITEM_SOURCES = Object.freeze({
  'chinch bugs': 'chinch\\s*bugs?',
  'sod webworms': '(?:sod\\s*)?webworms?',
  armyworms: 'army\\s*worms?',
  'white grubs': '(?:white\\s*)?grubs?',
  'mole crickets': 'mole\\s*crickets?',
});
function turfInsectItems() {
  const { SERVICE_DETAILS_COPY } = require('./estimate-service-details');
  const rows = [];
  const walk = (o) => {
    if (Array.isArray(o)) {
      // the lawn copy's covered-insects row: "Covered turf insects" (old copy) / "Covered insects" (reworked copy)
      if (/^covered (?:turf )?insects$/i.test(String(o[0])) && typeof o[1] === 'string' && /chinch/i.test(o[1])) rows.push(o[1]);
      o.forEach(walk);
    } else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(SERVICE_DETAILS_COPY);
  if (!rows.length) return null;
  return rows[0].split(/\s+[\u2014\u2013-]\s+/)[0].split(/\s*,\s*|\s*&\s*|\s+and\s+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}
let derivedTurf = safely(turfInsectItems);
if (!derivedTurf) { DERIVATION.turfInsects = 'fallback'; derivedTurf = Object.keys(TURF_INSECT_ITEM_SOURCES); }
const TURF_INSECT_ITEMS = Object.freeze(derivedTurf);
DERIVATION.unmapped.push(...TURF_INSECT_ITEMS.filter((item) => !Object.prototype.hasOwnProperty.call(TURF_INSECT_ITEM_SOURCES, item)).map((item) => `turf:${item}`));
// unmapped items are skipped (never thrown); the DERIVATION report + its test catch them
const TURF_INSECT_NOUN_SOURCES = Object.freeze(TURF_INSECT_ITEMS.map((item) => TURF_INSECT_ITEM_SOURCES[item]).filter(Boolean));

/**
 * Pests the service CATALOG sells as their own services (models/migrations service_library: tick_control, flea_tick,
 * bee_wasp_removal) and the covered-pests row does not list: an EXCLUDED specialty (never a free general-pest re-service),
 * keyed by the catalog service_key that sells them (a test asserts each key is in the migrations).
 */
const CATALOG_SEPARATE_PEST_ITEM_SOURCES = Object.freeze({
  tick_control: 'ticks?',
  flea_tick: 'ticks?',
  bee_wasp_removal: '(?:honey\\s*)?bees?',
});
const CATALOG_SEPARATE_PEST_NOUN_SOURCES = Object.freeze([...new Set(Object.values(CATALOG_SEPARATE_PEST_ITEM_SOURCES))]);

/**
 * ONE shared rule for a service LABEL that leads with a specialty (Codex round-35 P2, PR #5336): a label is specialty-led
 * when a specialty word (termite, mosquito, rodent, tree & shrub, palm, and every separate-service / catalog-separate pest)
 * appears BEFORE any "pest" word. A pest-led combined label — "Pest & Rodent Control Service", "Quarterly Pest + Termite
 * Bait Station Service" (catalog pest_control; combined-service cutover migration 20260612000031) — is a pest service.
 * Used by reservice-scheduler.laneForCallbackRow (callback lanes) and sms-shadow-drafter.customerHasPestRelationship.
 */
const MOSQUITO_NOUN_SOURCE = 'mosquito(?:e?s)?';
const TERMITE_NOUN_SOURCE = 'termites?';
const SPECIALTY_LABEL_SOURCES = Object.freeze([
  TERMITE_NOUN_SOURCE, MOSQUITO_NOUN_SOURCE, '\\btrees?\\b', '\\bshrubs?\\b', '\\bpalm\\b',
  ...SEPARATE_SERVICE_PEST_NOUN_SOURCES, ...CATALOG_SEPARATE_PEST_NOUN_SOURCES,
]);
const SPECIALTY_LABEL_RE = new RegExp(`(?:${SPECIALTY_LABEL_SOURCES.join('|')})`, 'i');
function specialtyLedLabel(label) {
  const text = String(label || '');
  const specialtyAt = text.search(SPECIALTY_LABEL_RE);
  if (specialtyAt < 0) return false;
  const pestAt = text.search(/\bpest\b/i);
  return pestAt < 0 || specialtyAt < pestAt;
}

module.exports = { specialtyLedLabel, MOSQUITO_NOUN_SOURCE, TERMITE_NOUN_SOURCE, DERIVATION, COVERED_PEST_NOUN_SOURCES, SEPARATE_SERVICE_ITEMS, SEPARATE_SERVICE_PEST_NOUN_SOURCES, TURF_INSECT_ITEMS, TURF_INSECT_NOUN_SOURCES, CATALOG_SEPARATE_PEST_ITEM_SOURCES, CATALOG_SEPARATE_PEST_NOUN_SOURCES };
