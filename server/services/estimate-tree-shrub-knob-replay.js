/**
 * Saved Tree & Shrub knob state for estimate replay.
 *
 * The v4.7 T&S knobs (shrub-density factor, routine palm-care reserve,
 * callback reserve) are DB-authoritative and mutate live pricing constants.
 * Every replay path re-runs generateEstimate under whatever the constants
 * say NOW, so without an input-level override an admin flip between save
 * and view/accept would re-price an ALREADY-SENT quote and then lock and
 * bill the new amount.
 *
 * Shared by BOTH authoritative replay paths — the public one
 * (estimate-public#extractEngineInputs) and the server-authoritative
 * recompute (admin-estimate-persistence#serverRecomputeFromEstimateData,
 * which membership-lapse reconciliation drives) — the same way
 * estimate-manual-discount-replay is shared. One home, no drift.
 *
 * Provenance rules:
 *  - stamped values (quote.pricingKnobs) replay verbatim;
 *  - a stored T&S estimate with NO stamp predates the knobs entirely, so it
 *    replays NEUTRAL — it could only ever have been priced with them off;
 *  - an estimate with no T&S line at all returns null (inject nothing), so
 *    fresh quotes keep resolving the live config.
 */

const NEUTRAL_TREE_SHRUB_KNOBS = {
  densityFactor: 1,
  perPalmAnnual: 0,
  minutesPerPalmVisit: 0,
  callbackReservePerVisit: 0,
};

function treeShrubKnobSignalForReplay(estData = {}) {
  const result = estData?.result && typeof estData.result === 'object' ? estData.result : (estData || {});
  const lineItems = [
    ...(Array.isArray(result?.lineItems) ? result.lineItems : []),
    ...(Array.isArray(estData?.engineResult?.lineItems) ? estData.engineResult.lineItems : []),
  ];
  const tsLine = lineItems.find((li) => (li?.service || '') === 'tree_shrub');
  // Admin V2 persists ONLY the mapped legacy envelope (result.results.ts /
  // tsMeta) with no raw lineItems, so the mapped stamp is a first-class
  // source here — without it those quotes would replay off live knobs.
  const tsMeta = (result?.results?.tsMeta && typeof result.results.tsMeta === 'object')
    ? result.results.tsMeta
    : (estData?.result?.results?.tsMeta || null);
  const hasMappedTs = !!tsMeta || (Array.isArray(result?.results?.ts) && result.results.ts.length > 0);
  if (!tsLine && !hasMappedTs) return null;
  const stamped = (tsLine && tsLine.pricingKnobs) || (tsMeta && tsMeta.pricingKnobs);
  if (!stamped || typeof stamped !== 'object') return { ...NEUTRAL_TREE_SHRUB_KNOBS };
  const pick = (key) => {
    const n = Number(stamped[key]);
    return Number.isFinite(n) ? n : NEUTRAL_TREE_SHRUB_KNOBS[key];
  };
  return {
    densityFactor: pick('densityFactor'),
    perPalmAnnual: pick('perPalmAnnual'),
    minutesPerPalmVisit: pick('minutesPerPalmVisit'),
    callbackReservePerVisit: pick('callbackReservePerVisit'),
  };
}

module.exports = { treeShrubKnobSignalForReplay, NEUTRAL_TREE_SHRUB_KNOBS };
