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
 * and every pest under the estimate copy's "Separate services": German roaches, fleas, bed bugs, rodents, wildlife —
 * SEPARATE_SERVICE_PEST_NOUN_SOURCES below). Generic words (pest, bug) and ticks / bees / hornets (in NEITHER row of the
 * copy) stay as pest nouns for continuity.
 */
const COVERED_PEST_NOUN_SOURCES = Object.freeze([
  'pests?',
  'bugs?',
  'palmetto\\s*bugs?',
  'ants?',
  'roach(?:es)?',
  'cockroach(?:es)?',
  'spider\\w*',
  'crickets?',
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
  'bees?',
  'ticks?',
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
  if (!rows.length) throw new Error('covered-pests: the pest "Separate services" row is missing from estimate-service-details');
  return rows[0].split(/,\s*/).map((item) => item.trim().toLowerCase());
}
const SEPARATE_SERVICE_ITEMS = Object.freeze(separateServiceItems());
const unmapped = SEPARATE_SERVICE_ITEMS.filter((item) => !Object.prototype.hasOwnProperty.call(SEPARATE_SERVICE_ITEM_SOURCES, item));
if (unmapped.length) throw new Error(`covered-pests: map these "Separate services" items to a pest noun source (or null): ${unmapped.join(', ')}`);
const SEPARATE_SERVICE_PEST_NOUN_SOURCES = Object.freeze(SEPARATE_SERVICE_ITEMS.map((item) => SEPARATE_SERVICE_ITEM_SOURCES[item]).filter(Boolean));

module.exports = { COVERED_PEST_NOUN_SOURCES, SEPARATE_SERVICE_ITEMS, SEPARATE_SERVICE_PEST_NOUN_SOURCES };
