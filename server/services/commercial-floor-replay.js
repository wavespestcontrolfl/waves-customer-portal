// Commercial account-minimum replay evidence (floors disarmed owner
// 2026-08-17; codex #3432 r1 P0 + r2 P0 + r3 P0).
//
// A pre-disarm estimate whose stored commercial row sits EXACTLY at its
// era's minimum was clamped there — replaying it live under the disarmed
// engine (public pricing-bundle rebuild OR the authoritative
// serverRecomputeFromEstimateData path membership reconciliation uses)
// would silently reopen the quote at the lower raw buildup, and
// acceptance/write-back would lock that drifted amount.
//
// The evidence is PER SERVICE (r3 P0): a post-disarm quote can land a line
// exactly on a legacy value by coincidence (the buildup inputs are
// continuous), and an estimate-wide boolean would then re-arm every
// commercial floor on replay and RAISE a different sub-minimum line.
// Scoped to the matching service, the coincidence is always harmless — an
// armed clamp at exactly its own floor value is the identity.
//
// minApplied is NOT usable as the signal — the disarmed engine stamps it
// on every sub-reference price. Shared by estimate-public
// (savedFloorReplayOverrides) and admin-estimate-persistence
// (serverRecomputeFromEstimateData) so view-time and save-time replays
// resolve the same evidence — the same split the pest-curve and
// tree-shrub-knob replays follow.

const COMMERCIAL_LEGACY_MIN_ANNUAL = {
  commercial_lawn: 1200,
  commercial_tree_shrub: 900,
  commercial_pest: 900,
  commercial_mosquito: 720,
  commercial_termite_bait: 900,
  commercial_rodent_bait: 900,
};

// Service keys whose stored annual sits exactly at that service's legacy
// minimum. Empty array = no evidence (replay live).
function commercialFloorBoundServices(estData = {}) {
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
  const armed = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = recurringServiceKey(row) || row.service;
    const legacyMin = COMMERCIAL_LEGACY_MIN_ANNUAL[key];
    if (!legacyMin) continue;
    // Durable provenance stamp (codex #3432 r6 P0): an ARMED replay
    // regenerates the row with the post-split fields, so if that result is
    // persisted back (membership reconcile → whole-blob write) the marker
    // exclusion below would erase the evidence on the NEXT replay and drop
    // the quote to the disarmed buildup. The pricers stamp legacyFloorArmed
    // on every floors-armed output, so once legacy, always legacy — across
    // any number of persist/replay cycles.
    if (row.legacyFloorArmed === true) { armed.add(key); continue; }
    // Post-split rows are otherwise NOT legacy evidence (r5 P0):
    // interiorOption/interiorScope shipped WITH the disarm, and a new
    // combined price can round to the legacy value while its exterior-only
    // variant is lower — arming would clamp that variant up and erase the
    // customer's toggled savings on the next authoritative replay.
    if (row.interiorOption || row.interiorScope) continue;
    const annual = Number(row.annual);
    if (Number.isFinite(annual) && Math.abs(annual - legacyMin) < 0.005) armed.add(key);
  }
  return [...armed];
}

module.exports = {
  COMMERCIAL_LEGACY_MIN_ANNUAL,
  commercialFloorBoundServices,
};
