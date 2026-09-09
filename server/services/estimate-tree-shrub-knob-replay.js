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

// ── Termite station cost (plan 2026-09-03 §A1) ───────────────────────────
// The Trelona station cost moved 22.05 → 24.00 on 2026-09-09 and, once
// catalog-linked, moves whenever the approved vendor price does. Every
// replay path re-runs generateEstimate under the LIVE value, so without an
// input-level override a sent $610 install would re-price to $653 on
// revisit / accept and the options sheet would fail closed on the drift.
// Same contract as the T&S knobs above, one home for both replay paths:
//  - a stamped line (pricingKnobs.stationCost) replays verbatim;
//  - a stored termite line with NO stamp predates the stamp, so it could
//    only have been priced at the pre-A1 constant for its system — that
//    constant is kept HERE as the no-stamp default (never read from the
//    live constants, which have moved on);
//  - no termite line anywhere → null (fresh quotes resolve the live value).
const PRE_STAMP_TERMITE_STATION_COST = Object.freeze({
  trelona: 22.05, // Apr 2026 wholesale ($352.80 / 16), the value every unstamped quote priced under
  advance: 13.16,
});
// The A1 value (2026-09-09, $384 / 16). An UNSTAMPED row can also be a
// post-A1 client-fallback save (the Admin V1 estimator stamps since A1, but
// a row saved by a client bundle cached from before this deploy would not),
// so the stored RESULT is consulted before the pre-stamp default applies:
// if the persisted install reproduces from the station count at exactly one
// of the two known costs, that cost is the evidence. Neither reproducing
// (property modifiers in play) → the pre-stamp default, which is what every
// unstamped row priced under before the stamp existed.
const A1_TERMITE_STATION_COST = Object.freeze({ trelona: 24.00, advance: 13.16 });
// Per-station labor-material + misc buildup and the install multiplier as
// they have stood since Apr 2026 — the reader must not read live constants.
const TERMITE_INSTALL_BUILDUP = Object.freeze({ laborMaterial: 5.25, misc: 0.75, multiplier: 1.45 });
function unstampedTermiteStationCost(system, stations, storedInstall) {
  const legacy = PRE_STAMP_TERMITE_STATION_COST[system];
  const current = A1_TERMITE_STATION_COST[system];
  if (!Number.isFinite(legacy)) return null;
  const n = Number(stations);
  const install = Number(storedInstall);
  if (!(n > 0) || !(install > 0) || !Number.isFinite(current) || current === legacy) return legacy;
  const priced = (cost) => Math.round(n * (cost + TERMITE_INSTALL_BUILDUP.laborMaterial + TERMITE_INSTALL_BUILDUP.misc) * TERMITE_INSTALL_BUILDUP.multiplier);
  const matchesLegacy = priced(legacy) === Math.round(install);
  const matchesCurrent = priced(current) === Math.round(install);
  if (matchesCurrent && !matchesLegacy) return current;
  return legacy;
}

// Representation normalization: the stored termite result, whichever shape
// the estimate persisted it in. The MAPPED envelope (results.tmBait — the
// only shape Admin V2 saves) wins over a raw line for the same reason tsMeta
// wins above: a revision replaces the mapped result but can leave an agent
// draft's older raw engineResult in place. Returns null when no termite
// result exists anywhere.
function firstDefined(...values) {
  for (const value of values) if (value != null) return value;
  return undefined;
}
function termiteRawLine(estData) {
  const result = estData && typeof estData.result === 'object' ? estData.result : estData;
  const lineItems = [
    ...(Array.isArray(result && result.lineItems) ? result.lineItems : []),
    ...(Array.isArray(estData && estData.engineResult && estData.engineResult.lineItems) ? estData.engineResult.lineItems : []),
  ];
  return lineItems.find((li) => li && li.service === 'termite_bait') || null;
}
function termiteMappedEnvelope(estData) {
  const result = estData && typeof estData.result === 'object' ? estData.result : estData;
  const tmBait = result && result.results && result.results.tmBait;
  return tmBait && typeof tmBait === 'object' ? tmBait : null;
}
function storedTermiteResult(estData = {}) {
  const line = termiteRawLine(estData);
  const mapped = termiteMappedEnvelope(estData);
  if (!line && !mapped) return null;
  const m = mapped || {};
  const r = line || {};
  const install = r.installation || {};
  return {
    stamp: firstDefined(m.pricingKnobs, r.pricingKnobs) || null,
    system: String(firstDefined(m.selectedSystem, m.system, r.selectedSystem, r.system, 'trelona')).toLowerCase(),
    stations: firstDefined(m.sta, r.stations),
    install: firstDefined(m.ti, m.ai, install.retailValue, install.price),
  };
}

// Replay decision: stamped replays verbatim; unstamped is read against the
// stored install (see unstampedTermiteStationCost); nothing stored → null.
function termiteKnobSignalForReplay(estData = {}) {
  const stored = storedTermiteResult(estData);
  if (!stored) return null;
  const stampedCost = stored.stamp && typeof stored.stamp === 'object' ? Number(stored.stamp.stationCost) : NaN;
  if (Number.isFinite(stampedCost) && stampedCost > 0) {
    return { system: String(stored.stamp.system || stored.system).toLowerCase(), stationCost: stampedCost };
  }
  const fallback = unstampedTermiteStationCost(stored.system, stored.stations, stored.install);
  return Number.isFinite(fallback) ? { system: stored.system, stationCost: fallback } : null;
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
  // The MAPPED envelope is authoritative and EXCLUSIVE whenever it exists
  // (see the knob signal above for why): a revision replaces result but
  // leaves an agent draft's original raw engineResult in place, so a raw
  // line marked service_line can be older than mapped columns that priced
  // no service-line palms — falling through to it would re-promote the
  // count on replay (pre-push r5 P0). A mapped envelope with no palm stamp
  // (pre-v4.7 tsMeta, or ts rows alone) is a legacy line; the raw line is
  // consulted only when there is no mapped result at all.
  const source = hasMappedTs
    ? ((tsMeta && tsMeta.palmCountSource) || null)
    : ((tsLine && tsLine.palmCountSource) || null);
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
  termiteKnobSignalForReplay,
  PRE_STAMP_TERMITE_STATION_COST,
  treeShrubKnobSignalForReplay,
  NEUTRAL_TREE_SHRUB_KNOBS,
  treeShrubPalmProvenanceForReplay,
  applyTreeShrubPalmReplay,
};
