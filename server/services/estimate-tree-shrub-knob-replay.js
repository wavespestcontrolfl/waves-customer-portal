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

const { authoritativeMappedTermiteEnvelope } = require('./estimate-termite-program-rows');

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
// An UNSTAMPED row can also be a post-A1 client-fallback save (the Admin V1
// estimator stamps since A1, but a row saved by a client bundle cached from
// before this deploy would not), so the stored RESULT is consulted — against
// the era table below — before the pre-stamp default applies.
// Per-station labor-material + misc buildup as it has stood since Apr 2026,
// and the install multiplier — the reader must not read live constants.
const TERMITE_INSTALL_BUILDUP = Object.freeze({ laborMaterial: 5.25, misc: 0.75, multiplier: 1.45 });
// Every (station cost, multiplier) era an unstamped quote can have priced
// under, newest first — including the pre-April-2026 era
// (20260428000004: Advance $14 / Trelona $24 at 1.75×) so an old Advance
// row is not forced onto today's constants (codex #4313 P1). The FIRST era
// that reproduces the stored install exactly wins.
const TERMITE_INSTALL_ERAS = Object.freeze({
  trelona: [
    { stationCost: 24.00, installMultiplier: 1.45 },
    { stationCost: 22.05, installMultiplier: 1.45 },
    { stationCost: 24.00, installMultiplier: 1.75 },
  ],
  advance: [
    { stationCost: 13.16, installMultiplier: 1.45 },
    { stationCost: 14.00, installMultiplier: 1.75 },
  ],
});
const KNOWN_TERMITE_MULTIPLIERS = Object.freeze([1.45, 1.75]);
// A pre-stamp environment may also have carried an ADMIN-TUNED station cost
// (the migration preserves anything other than the retired 22.05), so two
// more sources of evidence are consulted before the default: a raw line's
// persisted materialCost (stations × (cost + buildup)) pins the cost to a
// cent, and a mapped envelope's install inverts exactly under the stored
// modifiers. Each is accepted only when it reproduces the stored install
// and sits in a plausible hardware band (codex #4313 r3/r4/r5 P1).
const PLAUSIBLE_STATION_COST = Object.freeze({ min: 5, max: 80 });
function unstampedTermiteInstallBasis(system, stations, storedInstall, storedMaterialCost, modifiers) {
  const eras = TERMITE_INSTALL_ERAS[system];
  if (!eras) return null;
  const legacy = { stationCost: PRE_STAMP_TERMITE_STATION_COST[system], installMultiplier: TERMITE_INSTALL_BUILDUP.multiplier };
  const n = Number(stations);
  const install = Math.round(Number(storedInstall));
  if (!(n > 0) || !(install > 0)) return legacy;
  const buildup = TERMITE_INSTALL_BUILDUP.laborMaterial + TERMITE_INSTALL_BUILDUP.misc;
  const mult = modifiers ? modifiers.mult : 1;
  const adj = modifiers ? modifiers.adj : 0;
  // The install formula under the stored modifiers (neutral when unknown —
  // then only a known era can match exactly).
  const priced = (cost, multiplier) => Math.round(n * (cost + buildup) * multiplier * mult + adj);
  const plausible = (cost, multiplier) => cost >= PLAUSIBLE_STATION_COST.min && cost <= PLAUSIBLE_STATION_COST.max && priced(cost, multiplier) === install;
  const era = eras.find((e) => priced(e.stationCost, e.installMultiplier) === install);
  if (era) return { ...era };
  const material = Number(storedMaterialCost);
  if (material > 0) {
    const derived = Math.round((material / n - buildup) * 100) / 100;
    const multiplier = KNOWN_TERMITE_MULTIPLIERS.find((m) => plausible(derived, m));
    if (multiplier) return { stationCost: derived, installMultiplier: multiplier };
  }
  if (modifiers) {
    for (const multiplier of KNOWN_TERMITE_MULTIPLIERS) {
      const inverted = Math.round(((install - adj) / (n * multiplier * mult) - buildup) * 10000) / 10000;
      if (plausible(inverted, multiplier)) return { stationCost: inverted, installMultiplier: multiplier };
    }
  }
  return legacy;
}

// The install modifiers the stored quote priced under, decided by the
// engine's own deriveModifiers from the persisted inputs (engineInputs /
// inputs / engineRequest.profile). null when no inputs are stored (no
// evidence → never invert) or the stored shapes disagree.
function storedTermiteModifiers(estData = {}) {
  const { deriveModifiers } = require('./pricing-engine/modifiers');
  const profiles = [estData?.engineInputs, estData?.inputs, estData?.engineRequest?.profile]
    .filter((p) => p && typeof p === 'object');
  if (!profiles.length) return null;
  const seen = profiles.map((profile) => {
    const m = deriveModifiers(profile);
    return { mult: Number(m.termiteConstructionMult) || 1, adj: Number(m.termiteFoundationAdj) || 0 };
  });
  const agree = seen.every((m) => m.mult === seen[0].mult && m.adj === seen[0].adj);
  return agree ? seen[0] : null;
}

// Representation normalization: the stored termite result, whichever shape
// the estimate persisted it in. The MAPPED envelope (results.tmBait — the
// only shape Admin V2 saves) wins over a raw line for the same reason tsMeta
// wins above. Returns null when no termite result exists anywhere.
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
function storedTermiteResult(estData = {}) {
  const line = termiteRawLine(estData);
  const mapped = authoritativeMappedTermiteEnvelope(estData);
  if (!line && !mapped) return null;
  const m = mapped || {};
  const r = line || {};
  const install = r.installation || {};
  const system = String(firstDefined(m.selectedSystem, m.system, r.selectedSystem, r.system, 'trelona')).toLowerCase();
  const storedPlan = String(firstDefined(
    m.plan,
    r.plan,
    m.pricingKnobs && m.pricingKnobs.plan,
    r.pricingKnobs && r.pricingKnobs.plan,
  ) || '').toLowerCase();
  // The Admin V1 envelope carries BOTH installs (ai = Advance, ti =
  // Trelona); the stored system decides which one this quote sold
  // (codex #4313 r9 P0). Only the other is a fallback when the sold one
  // is absent (older single-system envelopes).
  const mappedInstall = system === 'advance' ? firstDefined(m.ai, m.ti) : firstDefined(m.ti, m.ai);
  return {
    stamp: firstDefined(m.pricingKnobs, r.pricingKnobs) || null,
    // Stored-result evidence owns program identity. Leave older rows without
    // a program stamp alone: they predate annual-plan requests, while every
    // priced quote created by this lane persists quarterly or annual here.
    plan: ['annual_protection', 'quarterly'].includes(storedPlan) ? storedPlan : null,
    system,
    stations: firstDefined(m.sta, r.stations),
    install: firstDefined(mappedInstall, install.retailValue, install.price),
    materialCost: install.materialCost,
    modifiers: storedTermiteModifiers(estData),
  };
}

// Every install knob a stamped line carries replays verbatim (codex #4313
// r5 P1: a later multiplier / buildup / floor edit must not move a sent
// install either); an unstamped line replays the pre-stamp values of those
// knobs, which never changed before the stamp existed.
const PRE_STAMP_TERMITE_INSTALL_KNOBS = Object.freeze({
  laborMaterial: TERMITE_INSTALL_BUILDUP.laborMaterial,
  misc: TERMITE_INSTALL_BUILDUP.misc,
  installMultiplier: TERMITE_INSTALL_BUILDUP.multiplier,
  minStations: 8,
});
function termiteKnobSignalForReplay(estData = {}) {
  const stored = storedTermiteResult(estData);
  if (!stored) return null;
  const stamp = stored.stamp && typeof stored.stamp === 'object' ? stored.stamp : null;
  const stampedCost = stamp ? Number(stamp.stationCost) : NaN;
  if (Number.isFinite(stampedCost) && stampedCost > 0) {
    const knob = (key) => (Number.isFinite(Number(stamp[key])) ? Number(stamp[key]) : PRE_STAMP_TERMITE_INSTALL_KNOBS[key]);
    const planKnobs = stored.plan === 'annual_protection'
      ? { plan: 'annual_protection', setupPerStation: knob('setupPerStation'), annualBase: knob('annualBase'), annualStep: knob('annualStep'), bracketStations: knob('bracketStations'), bracketFloor: knob('bracketFloor') }
      : (stored.plan === 'quarterly' ? { plan: 'quarterly' } : {});
    return {
      system: String(stamp.system || stored.system).toLowerCase(),
      stationCost: stampedCost,
      laborMaterial: knob('laborMaterial'),
      misc: knob('misc'),
      installMultiplier: knob('installMultiplier'),
      minStations: knob('minStations'),
      // The annual plan's own constants replay from day one (plan §A2).
      ...planKnobs,
    };
  }
  const basis = unstampedTermiteInstallBasis(stored.system, stored.stations, stored.install, stored.materialCost, stored.modifiers);
  return basis && Number.isFinite(basis.stationCost)
    ? {
      system: stored.system,
      ...(stored.plan ? { plan: stored.plan } : {}),
      ...PRE_STAMP_TERMITE_INSTALL_KNOBS,
      stationCost: basis.stationCost,
      installMultiplier: basis.installMultiplier,
    }
    : null;
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
