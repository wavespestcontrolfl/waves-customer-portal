'use strict';

/**
 * Is this visit a bed bug HEAT or HYBRID job, judged by its service name?
 *
 * Heat and hybrid bed bug work share one prep sheet (prep.bed_bug_heat);
 * chemical work keeps prep.bed_bug (owner ruling 2026-09-24 kept that guide
 * chemical-only). The names come from the pricing engine labels ("Bed Bug
 * Heat Treatment", "Bed Bug Hybrid Heat + Residual Program") and the protocol
 * matcher terms ("heat bed bug", "hybrid bed bug").
 *
 * One list feeds the appointment tagger, the manual prep sender (both the
 * heat guide's match and the chemical guide's exclusion) so the two guides
 * never claim the same visit.
 */

const BED_BUG_HEAT_KEYWORDS = Object.freeze([
  'bed bug heat',
  'bed bug hybrid',
  'heat bed bug',
  'hybrid bed bug',
]);

function isBedBugHeatServiceType(serviceType) {
  // Plain lowercase substring, the same test the manual sender's SQL runs
  // (LOWER(service_type) LIKE '%keyword%'), so the two always agree.
  const name = String(serviceType || '').toLowerCase();
  return BED_BUG_HEAT_KEYWORDS.some((keyword) => name.includes(keyword));
}

module.exports = { BED_BUG_HEAT_KEYWORDS, isBedBugHeatServiceType };
