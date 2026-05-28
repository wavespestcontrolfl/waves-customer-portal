/**
 * facts-sufficiency.js — the pre-gate the autonomous runner calls after
 * claiming an opportunity and before composing a brief.
 *
 * It answers one question for content-generating actions: does the facts-bank
 * have enough verified local facts to draft this city × service page WITHOUT
 * inventing anything? If not, the opportunity is routed to human review with
 * gap codes (so Adam knows which facts to populate) instead of being drafted.
 *
 * This is the bridge between the miner's data shapes and the facts-bank
 * auditor's entity ids:
 *   - opp.city is a DISPLAY name from scoring-config CITIES ("Lakewood Ranch")
 *     → facts-bank city id is the slug ("lakewood-ranch").
 *   - opp.service is a miner CATEGORY ("pest", "lawn", "tree-shrub")
 *     → facts-bank service id is the full slug ("pest-control", "lawn-care").
 *
 * Fail-closed: if the facts-bank can't be read, or the city/service can't be
 * mapped, a facts-gated action is treated as insufficient (routed to human
 * review), never silently allowed to draft.
 */

const auditor = require('../content-astro/facts-bank-auditor');
const logger = require('../logger');

// Actions that generate local body claims for a specific city × service and
// therefore require verified facts. Metadata-only / link / GBP actions are not
// gated — they don't assert local facts.
const FACTS_GATED_ACTIONS = new Set([
  'create_or_refresh_city_service_page',
  'refresh_existing_page',
  'create_customer_question_page',
  'new_supporting_blog',
]);

// Miner service category → facts-bank service entity id. The miner emits
// coarse categories; the facts-bank keys on the full service slug.
const SERVICE_CATEGORY_TO_FACTS_ID = {
  pest: 'pest-control',
  termite: 'termite',
  rodent: 'rodent',
  mosquito: 'mosquito',
  lawn: 'lawn-care',
  'tree-shrub': 'tree-shrub-care',
};

// Facts-bank service ids the miner may already emit verbatim (so we don't
// double-map). Kept in sync with content-ops/facts-bank/services/.
const KNOWN_SERVICE_IDS = new Set([
  'pest-control', 'termite', 'rodent', 'mosquito', 'lawn-care', 'tree-shrub-care',
  'bed-bug', 'cockroach', 'commercial-lawn', 'commercial-pest', 'lawn-aeration',
  'lawn-fertilization', 'lawn-pest-control', 'lawn-weed-control', 'pest-inspection',
  'termite-inspection',
]);

function normalizeCityId(city) {
  if (!city) return null;
  return String(city).toLowerCase().trim().replace(/\s+/g, '-');
}

function normalizeServiceId(service) {
  if (!service) return null;
  const s = String(service).toLowerCase().trim();
  if (KNOWN_SERVICE_IDS.has(s)) return s;
  if (SERVICE_CATEGORY_TO_FACTS_ID[s]) return SERVICE_CATEGORY_TO_FACTS_ID[s];
  return null; // unknown → fail closed
}

/**
 * check(opportunity, opts) → {
 *   applicable: bool,        // false → gate does not apply to this action
 *   sufficient: bool,        // only meaningful when applicable
 *   reason: string|null,     // 'facts_insufficient' | 'facts_unmappable' | null
 *   city_id, service_id, county,
 *   gap_codes: string[],
 *   notes: string,           // human-readable for reviewer_notes
 * }
 *
 * `opportunity` is the row from opportunity-queue.claimNext (has action_type,
 * city, service). `opts` are passed through to the auditor/loader (astroRoot,
 * astroSource, githubRef, githubClient).
 */
async function check(opportunity, opts = {}) {
  const actionType = opportunity?.action_type;
  if (!FACTS_GATED_ACTIONS.has(actionType)) {
    return { applicable: false, sufficient: true, reason: null, gap_codes: [], notes: 'action not facts-gated' };
  }

  const cityId = normalizeCityId(opportunity.city);
  const serviceId = normalizeServiceId(opportunity.service);

  // No city or service to anchor a facts-bank lookup → the action isn't a
  // city×service local-claim page; let it through (e.g. a general blog).
  if (!cityId || !serviceId) {
    return {
      applicable: false,
      sufficient: true,
      reason: null,
      gap_codes: [],
      city_id: cityId,
      service_id: serviceId,
      notes: `no city/service anchor (city=${opportunity.city || '∅'}, service=${opportunity.service || '∅'}) — facts gate not applicable`,
    };
  }

  let verdict;
  try {
    verdict = await auditor.auditCombination({ city: cityId, service: serviceId }, opts);
  } catch (err) {
    // Fail closed: can't read the facts-bank → route to human review.
    logger.warn(`[facts-sufficiency] audit failed for ${cityId}/${serviceId}: ${err.message}`);
    return {
      applicable: true,
      sufficient: false,
      reason: 'facts_check_error',
      city_id: cityId,
      service_id: serviceId,
      gap_codes: [`facts_check_error:${err.message}`],
      notes: `Facts-bank check errored (${err.message}); routed to human review (fail-closed).`,
    };
  }

  if (verdict.sufficient) {
    return {
      applicable: true,
      sufficient: true,
      reason: null,
      city_id: cityId,
      service_id: serviceId,
      county: verdict.county,
      gap_codes: [],
      notes: `facts sufficient for ${cityId} × ${serviceId}`,
    };
  }

  return {
    applicable: true,
    sufficient: false,
    reason: 'facts_insufficient',
    city_id: cityId,
    service_id: serviceId,
    county: verdict.county,
    gap_codes: verdict.gap_codes,
    notes: `Facts-bank insufficient for ${cityId} × ${serviceId}. Populate before optimizing. Gaps: ${verdict.gap_codes.join(', ')}`,
  };
}

module.exports = {
  check,
  normalizeCityId,
  normalizeServiceId,
  FACTS_GATED_ACTIONS,
  SERVICE_CATEGORY_TO_FACTS_ID,
};
