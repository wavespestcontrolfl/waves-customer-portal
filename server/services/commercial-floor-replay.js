// Commercial account-minimum replay evidence (floors disarmed owner
// 2026-08-17; codex #3432 r1 P0 + r2 P0).
//
// A pre-disarm estimate whose stored commercial row sits EXACTLY at its
// era's minimum was clamped there — replaying it live under the disarmed
// engine (public pricing-bundle rebuild OR the authoritative
// serverRecomputeFromEstimateData path membership reconciliation uses)
// would silently reopen the quote at the lower raw buildup, and
// acceptance/write-back would lock that drifted amount. Row evidence only:
// the disarmed engine never lands on these exact values except when the
// clamp bound, and a coincidental exact-equality re-arms a clamp that is a
// no-op at that price. minApplied is NOT usable as the signal — the
// disarmed engine stamps it on every sub-reference price.
//
// Shared by estimate-public (savedFloorReplayOverrides) and
// admin-estimate-persistence (serverRecomputeFromEstimateData) so the
// view-time and save-time replays resolve the same evidence — the same
// split the pest-curve and tree-shrub-knob replays follow.

const COMMERCIAL_LEGACY_MIN_ANNUAL = {
  commercial_lawn: 1200,
  commercial_tree_shrub: 900,
  commercial_pest: 900,
  commercial_mosquito: 720,
  commercial_termite_bait: 900,
  commercial_rodent_bait: 900,
};

function commercialFloorBoundEvidence(estData = {}) {
  // Lazy require: estimate-converter sits high in the service graph and a
  // top-level require here could form a load-order cycle.
  const { recurringServiceKey } = require('./estimate-converter');
  const rows = [];
  const result = estData?.result && typeof estData.result === 'object' ? estData.result : null;
  for (const rec of [result?.recurring, estData?.recurring]) {
    if (rec && Array.isArray(rec.services)) rows.push(...rec.services);
  }
  for (const container of [estData?.engineResult, result]) {
    if (container && Array.isArray(container.lineItems)) rows.push(...container.lineItems);
  }
  return rows.some((row) => {
    if (!row || typeof row !== 'object') return false;
    const legacyMin = COMMERCIAL_LEGACY_MIN_ANNUAL[recurringServiceKey(row) || row.service];
    if (!legacyMin) return false;
    const annual = Number(row.annual);
    return Number.isFinite(annual) && Math.abs(annual - legacyMin) < 0.005;
  });
}

module.exports = {
  COMMERCIAL_LEGACY_MIN_ANNUAL,
  commercialFloorBoundEvidence,
};
