/**
 * Saved floor-signal replay
 *
 * One reader for the lawn cost-floor arm state, the lawn program minimum and
 * the pest post-discount floor that a STORED estimate priced under. Every
 * replay re-runs generateEstimate against the CURRENT mutable globals, so a
 * global re-arm or disarm between save and view would otherwise re-price a
 * sent quote.
 *
 * Shared by the two replay paths so view-time and save-time resolve the same
 * evidence — estimate-public (savedFloorReplayOverrides, the public read) and
 * admin-estimate-persistence (serverRecomputeFromEstimateData's
 * replaySavedPricingKnobs branch, the authoritative recompute whose output is
 * persisted). Same split, and the same reason, as commercial-floor-replay.js.
 *
 * Tri-state is the contract: a signal is returned ONLY when the estimate
 * carries actual evidence. Absence means "replay live" and the caller must
 * inject nothing — never coerce a null to false.
 */

// ── stored inputs ───────────────────────────────────────────────

// Raw stored inputs, no replay injection — the signal readers
// (estimateLawnFloorArmed) use this to avoid recursing through the
// injection below, which itself consults those readers.
function rawEngineInputs(estData) {
  if (!estData || typeof estData !== 'object') return null;
  return (estData.engineInputs && typeof estData.engineInputs === 'object')
    ? estData.engineInputs
    : (estData.inputs && typeof estData.inputs === 'object')
      ? estData.inputs
      : null;
}

// ── lawn cost floor ─────────────────────────────────────────────

function estimateLawnFloorArmed(estData = {}) {
  // Highest priority: the engine stamps its RESOLVED arm state into
  // pricingMetadata on every post-#2827 pricing run — the authoritative
  // record of what actually priced the saved result, covering estimates the
  // GLOBAL switch armed without any explicit per-request flag (a later
  // global flip must not change how a sent quote replays).
  const stamped = estData?.result?.pricingMetadata?.lawnCostFloorArmed
    ?? estData?.engineResult?.pricingMetadata?.lawnCostFloorArmed
    ?? estData?.pricingMetadata?.lawnCostFloorArmed
    ?? estData?.result?.routingMetadata?.lawnCostFloorArmed;
  if (typeof stamped === 'boolean') return stamped;
  // Admin V2 saves persist the exact /calculate-estimate payload under
  // engineRequest ({ profile, selectedServices, options }); the adapter maps
  // options.useLawnCostFloor into services.lawn.useLawnCostFloor at replay,
  // so the raw option is that shape's arm signal.
  const reqOptions = estData?.engineRequest?.options;
  if (reqOptions && typeof reqOptions === 'object' && reqOptions.useLawnCostFloor != null) {
    return !!reqOptions.useLawnCostFloor;
  }
  const engineInputs = rawEngineInputs(estData) || {};
  const stored = engineInputs.services?.lawn?.useLawnCostFloor ?? engineInputs.useLawnCostFloor;
  if (stored != null) return !!stored;
  // Legacy engine-backed saves ({ engineInputs, engineResult }, pre-stamp,
  // no explicit flag): the stored engine rows are the only evidence the
  // quote was cost-floor priced — same enforcement-stamp rule as the v1
  // ladder path (lawnRowsShowFloorEnforcement: reporting fields are NOT
  // evidence). Without this, extractEngineInputs replays an already-sent
  // floor-priced estimate under the current disarmed default and lowers
  // view/accept (codex P2 round 11 on #2827). Evidence only arms — its
  // absence stays null (tri-state preserved; caller falls to the global).
  const engineRows = [];
  for (const li of [
    ...(Array.isArray(estData?.engineResult?.lineItems) ? estData.engineResult.lineItems : []),
    ...(Array.isArray(estData?.result?.lineItems) ? estData.result.lineItems : []),
  ]) {
    if ((li?.service || '') !== 'lawn_care') continue;
    engineRows.push(li);
    if (Array.isArray(li.tiers)) engineRows.push(...li.tiers);
  }
  if (engineRows.length && lawnRowsShowFloorEnforcement(engineRows)) return true;
  return null;
}

// Legacy pre-disarm estimates (engine armed the cost floor by default, so
// builder payloads never needed to persist the flag): the floor evidence
// lives on the stored rows as ENFORCEMENT stamps. Only stamps the armed
// machinery writes count — costFloorApplied, marginFloorGuardApplied, a
// COST_FLOOR pricing source. The reporting fields
// (minimumCollectedAnnualPrice / costFloorAnnual) ride every post-disarm
// quote too and are deliberately NOT evidence, or every new estimate would
// silently re-arm (the exact trap this branch closes).
function lawnRowsShowFloorEnforcement(rows) {
  return (Array.isArray(rows) ? rows : []).some((row) => (
    row?.costFloorApplied === true
    || row?.marginFloorGuardApplied === true
    || row?.pricingSource === 'COST_FLOOR'
    || row?.prov?.costFloorApplied === true
    || row?.prov?.pricingSource === 'COST_FLOOR'
  ));
}

// ── pest program floor ──────────────────────────────────────────

// Saved pest post-discount floor state: pricingMetadata stamps first, then
// legacy row evidence — armed-era rows carry the floor metadata itself
// (server tiers: programFloorPerVisit/programFloorAnnual; client-fallback
// rows: floorPa/floorAnn, per-visit derived through the cadence discount).
// armed stays null (inject nothing) when the estimate is silent.
const CLIENT_PEST_CADENCE_DISC = { 4: 1.0, 6: 0.85, 12: 0.7 };
function estimatePestFloorSignal(estData = {}) {
  const armStamp = estData?.result?.pricingMetadata?.pestProgramFloorArmed
    ?? estData?.engineResult?.pricingMetadata?.pestProgramFloorArmed
    ?? estData?.pricingMetadata?.pestProgramFloorArmed
    ?? estData?.result?.routingMetadata?.pestProgramFloorArmed;
  const perVisitStamp = estData?.result?.pricingMetadata?.pestProgramFloorPerVisit
    ?? estData?.engineResult?.pricingMetadata?.pestProgramFloorPerVisit
    ?? estData?.pricingMetadata?.pestProgramFloorPerVisit
    ?? estData?.result?.routingMetadata?.pestProgramFloorPerVisit;
  if (typeof armStamp === 'boolean') {
    const stampedPerVisit = Number(perVisitStamp);
    return {
      armed: armStamp,
      perVisit: Number.isFinite(stampedPerVisit) && stampedPerVisit > 0 ? stampedPerVisit : null,
    };
  }
  const result = estData?.result && typeof estData.result === 'object' ? estData.result : (estData || {});
  const rows = [];
  if (Array.isArray(result?.results?.pestTiers)) rows.push(...result.results.pestTiers);
  if (result?.results?.pest && typeof result.results.pest === 'object') rows.push(result.results.pest);
  const lineItemSources = [
    ...(Array.isArray(result?.lineItems) ? result.lineItems : []),
    ...(Array.isArray(estData?.engineResult?.lineItems) ? estData.engineResult.lineItems : []),
  ];
  for (const li of lineItemSources) {
    if ((li?.service || '') !== 'pest_control') continue;
    rows.push(li);
    if (Array.isArray(li.tiers)) rows.push(...li.tiers);
  }
  let armed = null;
  let perVisit = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const direct = Number(row.programFloorPerVisit);
    if (Number.isFinite(direct) && direct > 0) {
      armed = true;
      perVisit = Math.max(perVisit ?? 0, direct);
      continue;
    }
    const floorPa = Number(row.floorPa);
    if (Number.isFinite(floorPa) && floorPa > 0) {
      armed = true;
      const disc = CLIENT_PEST_CADENCE_DISC[Number(row.apps)] ?? null;
      if (disc) perVisit = Math.max(perVisit ?? 0, Math.round((floorPa / disc) * 100) / 100);
    } else if (Number(row.programFloorAnnual) > 0 || Number(row.floorAnn) > 0) {
      armed = true;
    }
  }
  return { armed, perVisit };
}

// ── the shared signal set ───────────────────────────────────────

// Every saved floor signal this estimate carries, as engine INPUT-level keys.
// Callers spread the result into the engine input; a key is present only when
// the estimate actually carries that signal.
//
// estimateLawnProgramMinimumSignal stays in estimate-converter and is required
// lazily — that module requires the pricing engine at load, and a top-level
// require here would close a cycle through the two replay callers. Same dodge
// commercial-floor-replay.js uses.
function savedFloorReplaySignals(estData) {
  // Precision is replay state too: the pre-fix palm annual was whole dollars.
  // Prefer the mapped snapshot, as the public/admin views do. Always overwrite
  // any input-claimed mode, even when there is no saved palm evidence.
  const saved = estData || {};
  const result = saved.result || saved;
  const palmRows = [result.lineItems, saved.engineResult?.lineItems].filter(Array.isArray).flat();
  const palm = result.results?.injection || palmRows.find((line) => line?.service === 'palm_injection');
  // Removal prunes the palm output. Its server-recorded event retains the
  // quote-time mode for restore; events predating the stamp used whole dollars.
  const palmRemoval = (Array.isArray(saved.serviceOptOut?.events) ? saved.serviceOptOut.events : [])
    .filter((event) => event?.serviceKey === 'palm_injection' && event.included === false).pop();
  const palmMode = palm ? palm.annualRounding : palmRemoval?.provenance?.floorSignals?.palmAnnualRounding;
  const signals = { palmAnnualRounding: palm || palmRemoval ? (palmMode === 'cents' ? 'cents' : 'whole') : undefined };
  const lawnArm = estimateLawnFloorArmed(estData);
  if (typeof lawnArm === 'boolean') signals.useLawnCostFloor = lawnArm;
  const minSignal = require('./estimate-converter').estimateLawnProgramMinimumSignal(estData);
  if (minSignal != null) signals.lawnProgramMinimumMonthly = minSignal;
  const pest = estimatePestFloorSignal(estData);
  if (typeof pest.armed === 'boolean') signals.pestProgramFloorArmed = pest.armed;
  if (pest.perVisit != null) signals.pestProgramFloorPerVisit = pest.perVisit;
  return signals;
}

module.exports = {
  rawEngineInputs,
  estimateLawnFloorArmed,
  lawnRowsShowFloorEnforcement,
  estimatePestFloorSignal,
  savedFloorReplaySignals,
};
