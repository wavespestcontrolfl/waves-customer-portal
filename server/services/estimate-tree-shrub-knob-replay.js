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
  // The MAPPED stamp wins. A save/revision replaces estimateData.result with
  // the freshly mapped server result but leaves an agent draft's original
  // raw engineResult in place, so the raw line can be older than the
  // authoritative columns the revision just wrote. Preferring it would
  // replay superseded knob values and charge a total the stored result
  // disagrees with.
  const stamped = (tsMeta && tsMeta.pricingKnobs) || (tsLine && tsLine.pricingKnobs);
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

// Stored-result palm provenance for translator-based replays (v4.8, pre-push
// r2 P0). translateV2CallToV1Input now promotes a property-level palm count
// (typed inventory, else a trusted vision estimate) onto services.treeShrub
// so the per-palm terms price — but every persisted Admin-V2 engineRequest
// saved before that carried palms at the PROPERTY level only, and its stored
// T&S line priced NO service-line palms (tsMeta.palmCountSource 'property' /
// 'none', or a pre-stamp tsMeta with no key at all). Replaying such a request
// through the new translator would raise an already-sent quote and later bill
// the new amount. Same evidence rule as resolveStoredPestPricingVersion: the
// STORED RESULT says how the job was sold.
//   'service_line' — the stored line priced service-line palms: keep them;
//   'legacy'       — a stored T&S line with no service-line palms: strip the
//                    promoted count so the replay reprices the SAME job;
//   null           — no stored T&S line (fresh quote / service just added):
//                    the translator output stands.
function treeShrubPalmProvenanceForReplay(estData = {}) {
  const result = estData?.result && typeof estData.result === 'object' ? estData.result : (estData || {});
  const lineItems = [
    ...(Array.isArray(result?.lineItems) ? result.lineItems : []),
    ...(Array.isArray(estData?.engineResult?.lineItems) ? estData.engineResult.lineItems : []),
  ];
  const tsLine = lineItems.find((li) => (li?.service || '') === 'tree_shrub');
  const tsMeta = (result?.results?.tsMeta && typeof result.results.tsMeta === 'object')
    ? result.results.tsMeta
    : (estData?.result?.results?.tsMeta || null);
  const hasMappedTs = !!tsMeta || (Array.isArray(result?.results?.ts) && result.results.ts.length > 0);
  if (!tsLine && !hasMappedTs) return null;
  // The MAPPED stamp wins over a stale raw agent-draft line (see the knob
  // signal above for why).
  const source = (tsMeta && tsMeta.palmCountSource) || (tsLine && tsLine.palmCountSource) || null;
  return source === 'service_line' ? 'service_line' : 'legacy';
}

// Mutates a TRANSLATED v1 input in place: drops the promoted service-line
// palm count when the stored result proves the job was sold without one.
function applyTreeShrubPalmReplay(v1Input, estData = {}) {
  const treeShrub = v1Input?.services?.treeShrub;
  if (!treeShrub || typeof treeShrub !== 'object' || treeShrub.palmCount === undefined) return v1Input;
  if (treeShrubPalmProvenanceForReplay(estData) === 'legacy') delete treeShrub.palmCount;
  return v1Input;
}

module.exports = {
  treeShrubKnobSignalForReplay,
  NEUTRAL_TREE_SHRUB_KNOBS,
  treeShrubPalmProvenanceForReplay,
  applyTreeShrubPalmReplay,
};
