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

// Lawn cost-plus list mode (GATE_LAWN_COST_PLUS_LIST). Server-written evidence
// only: the engine's own pricingMetadata stamp (the mode plus the knob snapshot
// it priced with). A browser-posted option or stored input is never evidence.
// An estimate that priced a lawn line (or had one opted out) and carries no
// stamp was priced before the mode existed: it pins OFF. An estimate that
// never priced a lawn pins nothing, so a lawn added later follows the live gate.
function savedLawnCostPlusSignal(estData) {
  const roots = [estData?.result, estData?.engineResult, estData].filter(Boolean);
  const pricedLawn = roots.some((r) => [].concat(r.lineItems || []).some((li) => li?.service === 'lawn_care')
    || [].concat(r.results?.lawn || []).length > 0)
    || [].concat(estData?.serviceOptOut?.events || []).some((e) => e?.serviceKey === 'lawn_care');
  if (!pricedLawn) return {};
  const stamp = roots.flatMap((r) => [r.pricingMetadata, r.routingMetadata])
    .find((m) => typeof m?.lawnCostPlusList === 'boolean');
  const on = stamp?.lawnCostPlusList === true;
  return { lawnCostPlusList: on, ...(on && stamp.lawnCostPlusListBasis ? { lawnCostPlusListBasis: stamp.lawnCostPlusListBasis } : {}) };
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

// ── lawn minimum per visit after discounts ──────────────────────

// The lawn minimum (owner 2026-11-06) a saved quote was priced with, from the
// engine's pricingMetadata stamp. Same shape as savedLawnCostPlusSignal: an
// estimate that priced a lawn line (or had one opted out) with no stamp was
// priced before the rule and pins 0, so a quote already sent never moves; an
// estimate that never priced lawn pins nothing, so a lawn added later takes
// the live minimum (new quotes only).
function savedLawnMinimumAfterDiscountSignal(estData) {
  const roots = [estData?.result, estData?.engineResult, estData].filter(Boolean);
  const pricedLawn = roots.some((r) => [].concat(r.lineItems || []).some((li) => li?.service === 'lawn_care')
    || [].concat(r.results?.lawn || []).length > 0)
    || [].concat(estData?.serviceOptOut?.events || []).some((e) => e?.serviceKey === 'lawn_care');
  if (!pricedLawn) return {};
  const stamped = roots.flatMap((r) => [r.pricingMetadata, r.routingMetadata])
    .map((m) => Number(m?.lawnMinimumPerVisitAfterDiscount))
    .find((n) => Number.isFinite(n) && n >= 0);
  return { lawnMinimumPerVisitAfterDiscount: stamped ?? 0 };
}

// ── price rules fixed 2026-11-26 ────────────────────────────────

// Which price rules a saved quote was priced with (owner 2026-11-26, "fix all seven": palm credit minimum, one-time
// lawn flat-stretch rise, barrel hold, commercial interior area, urgent removal). The engine stamps pricingMetadata.legacyPricingRules on every run: false = priced under the fixes, true
// = replayed on the rules before them. An estimate with priced lines and no stamp was priced before the fixes and pins
// the old rules, so a quote already sent never moves; an estimate with no priced lines pins nothing, so a service
// added later takes the current rules (new quotes only). Same shape as savedLawnMinimumAfterDiscountSignal.
// A line that carries a price. A quote-required placeholder (null prices) is not evidence the quote was priced.
const lineCarriesPrice = (line) => !!line && typeof line === 'object'
  && ['price', 'amount', 'annual', 'monthly', 'total', 'perApp', 'annualAfterDiscount', 'monthlyAfterDiscount', 'priceAfterDiscount',
    'oneTimeTotal', 'anchorOneTimePrice', 'monthlyTotal', 'annualTotal']
    .some((key) => Number(line[key]) > 0);

// One reader for every "which rules priced this estimate" stamp (legacyPricingRules, legacyTwoStoryRoof): the stamp lives
// at pricingMetadata[key] (or routingMetadata), on the lines the rule touches, or on the frozen send snapshot, and a priced estimate with
// none of them predates the rule. Returns { container, flag } where flag is the stamped
// boolean, true for a priced estimate with no stamp, or undefined for an estimate with nothing priced.
// A stored estimate arrives as an object or as JSON text: read both the same way (every lookup below sees the parsed object).
function normalizeStored(estData) {
  if (typeof estData !== 'string') return estData;
  try { const parsed = JSON.parse(estData); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

function readRuleStamp(rawEstData, key) {
  const estData = normalizeStored(rawEstData);
  // The authoritative stored container only (a revision can keep a stale engineResult beside the current result).
  const container = require('./estimate-result-container').storedEstimateContainer(estData) || estData || {};
  const metadataFlag = [container.pricingMetadata, container.routingMetadata]
    .map((m) => m?.[key])
    .find((flag) => typeof flag === 'boolean');
  if (metadataFlag !== undefined) return { container, flag: metadataFlag, from: 'metadata' };
  // A save path that keeps the lines but drops pricingMetadata: the lines the rule touches carry the same stamp.
  const lineFlag = [].concat(container.lineItems || [])
    .map((line) => line?.[key])
    .find((flag) => typeof flag === 'boolean');
  if (lineFlag !== undefined) return { container, flag: lineFlag, from: 'lines' };
  // A sent estimate can hold its prices only in the frozen send snapshot (stamped when the snapshot was built).
  const snapshot = estData?.sendSnapshot && typeof estData.sendSnapshot === 'object' ? estData.sendSnapshot : null;
  if (typeof snapshot?.[key] === 'boolean') return { container, flag: snapshot[key], from: 'snapshot' };
  // Priced in any saved shape: engine lines, the keyed v1 results, the older one-time / recurring containers, the
  // specialty rows (oneTime.specItems, specItems) or the frozen pricing bundle of a sent estimate.
  const bundle = snapshot?.pricingBundle && typeof snapshot.pricingBundle === 'object' ? snapshot.pricingBundle : null;
  // The audit's own priced-line detector; a failing detector never blocks a send, the shape checks below still run.
  let auditedPriced = false;
  try { auditedPriced = require('./estimate-pricing-audit').hasPricedLines(container) === true; } catch { auditedPriced = false; }
  const priced = auditedPriced
    || [].concat(container.lineItems || [], container.specItems || [], container.oneTime?.items || [],
      container.oneTime?.specItems || [], container.recurring?.services || []).some(lineCarriesPrice)
    || Object.values(container.results || {}).some((v) => v && (Array.isArray(v) ? v.length > 0 : true))
    || (!!bundle && [].concat(bundle, bundle.oneTimeBreakdown?.items || [], bundle.services || [], bundle.frequencies || [])
      .some(lineCarriesPrice));
  return { container, flag: priced ? true : undefined, from: 'priced' };
}

function savedLegacyPricingRulesSignal(estData) {
  const { container, flag, from } = readRuleStamp(estData, 'legacyPricingRules');
  if (from === 'metadata') {
    // The services a legacy estimate priced under the CURRENT rules (added after the fixes): they keep them across revisions.
    const current = [container.pricingMetadata, container.routingMetadata]
      .map((m) => m?.currentRulesServices).find((list) => Array.isArray(list));
    return { legacyPricingRules: flag, currentRulesServices: current };
  }
  // No evidence: the key is explicitly undefined so a value left in the stored engineInputs never selects the old
  // rules (the public replay spreads these over the inputs).
  return flag === undefined ? { legacyPricingRules: undefined } : { legacyPricingRules: flag };
}

// Two-story roof points (owner 2026-11-26 "fix this": rodent exclusion roof/high points on a home of two or more stories).
// Its own stamp, because an estimate priced after the seven fixes above and before this rule carries legacyPricingRules false
// yet was sold without the factor: true = no two-story factor. An estimate with priced lines and no stamp predates the rule
// and keeps its price; one with no priced lines pins nothing.
//
// An estimate that kept only its inputs (no priced rows, no stamp, no snapshot bundle) but still asks for an exclusion was saved
// before the rule, and a replay never raises a saved price, so it reads legacy: on a first send, a resend and every replay.
function storedRequestsExclusion(estData) {
  const data = normalizeStored(estData);
  if (!data || typeof data !== 'object') return false;
  const request = data.engineRequest && typeof data.engineRequest === 'object' ? data.engineRequest : null;
  if (request && Array.isArray(request.selectedServices)
    && request.selectedServices.some((key) => String(key || '').toUpperCase() === 'EXCLUSION')) return true;
  const container = require('./estimate-result-container').storedEstimateContainer(data) || null;
  return [data.engineInputs, data.inputs, data.engineInput, container && container.inputs, request && request.inputs]
    .some((carrier) => carrier && typeof carrier === 'object' && carrier.services && typeof carrier.services === 'object'
      && !!(carrier.services.exclusion || carrier.services.rodentExclusion));
}

function savedLegacyTwoStoryRoofSignal(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { flag } = readRuleStamp(estData, 'legacyTwoStoryRoof');
  if (flag === undefined && storedRequestsExclusion(estData)) return { legacyTwoStoryRoof: true };
  return { legacyTwoStoryRoof: flag };
}

// Specialty prices for NEW quotes (owner 2026-11-26 evening: bed bug chemical $349 per added room, a mosquito lot above 2 acres
// priced instead of held, the wasp / hornet / yellow jacket second level $275). ONE stamp for the three, read by the same reader:
// true = priced before them (old room curve, the hand-price hold, the $250 level), false = priced under them. An estimate with
// priced lines and no stamp predates the rule; one with no priced lines pins nothing. An estimate that kept only its inputs but
// asks for bed bug, mosquito or a stinging insect was saved before the rule too: it reads legacy on a first send, a resend and every
// replay (a replay never raises a sold price); a fresh draft the engine priced carries its stamp, false.
function storedRequestsSpecialty1126(estData) {
  const data = normalizeStored(estData);
  if (!data || typeof data !== 'object') return false;
  const container = require('./estimate-result-container').storedEstimateContainer(data) || null;
  const request = data.engineRequest && typeof data.engineRequest === 'object' ? data.engineRequest : null;
  // The builder request names its services as tokens (BEDBUG, MOSQUITO, STING), as it names EXCLUSION and PEST.
  if (request && Array.isArray(request.selectedServices)
    && request.selectedServices.some((key) => ['BEDBUG', 'MOSQUITO', 'STING'].includes(String(key || '').toUpperCase()))) return true;
  return [data.engineInputs, data.inputs, data.engineInput, container && container.inputs, request && request.inputs]
    .some((carrier) => carrier && typeof carrier === 'object' && carrier.services && typeof carrier.services === 'object'
      && !!(carrier.services.bedBug || carrier.services.mosquito || carrier.services.stinging));
}

// The services of the three priced under the specialty rule on an estimate that is otherwise old: a revision added them, and the
// engine stamped the line legacySpecialty1126=false (or listed them in pricingMetadata.specialty1126CurrentServices, or the send
// snapshot froze the list when its bundle went). That is the only evidence: the flat currentRulesServices list predates the rule.
const SPECIALTY_1126_SERVICE_KEYS = ['bed_bug', 'mosquito', 'stinging_insect'];
function savedSpecialty1126CurrentServices(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { container } = readRuleStamp(estData, 'legacySpecialty1126');
  const snapshot = estData?.sendSnapshot && typeof estData.sendSnapshot === 'object' ? estData.sendSnapshot : null;
  const listed = [container.pricingMetadata, container.routingMetadata, snapshot, snapshot?.pricingBundle]
    .flatMap((holder) => (Array.isArray(holder?.specialty1126CurrentServices) ? holder.specialty1126CurrentServices : []));
  const stamped = [].concat(container.lineItems || [])
    .filter((line) => line && line.legacySpecialty1126 === false).map((line) => line.service);
  return [...new Set([...listed, ...stamped])].filter((key) => SPECIALTY_1126_SERVICE_KEYS.includes(key));
}

function savedLegacySpecialty1126Signal(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { container, flag, from } = readRuleStamp(estData, 'legacySpecialty1126');
  // Only the lines carry the evidence (no metadata, no snapshot stamp): readRuleStamp took the FIRST stamped line, so the order of
  // a mixed estimate decided the answer. For this rule ANY retained specialty line that is legacy (stamped true or unstamped) makes
  // the estimate read legacy; which services are on the new prices comes only from the per-service list below (added by a revision, or
  // a line stamped false), never from the estimate-wide flag.
  if (from === 'lines' && [].concat(container.lineItems || [])
    .some((line) => line && SPECIALTY_1126_SERVICE_KEYS.includes(line.service) && line.legacySpecialty1126 !== false)) {
    return { legacySpecialty1126: true };
  }
  if (flag === undefined && storedRequestsSpecialty1126(estData)) return { legacySpecialty1126: true };
  return { legacySpecialty1126: flag };
}

// One-time pest for NEW quotes (owner 2026-11-26, "only new estimtes": 1.8x, a 10% minimum over the first visit of a plan, no
// home-age step). Its own stamp, read by the same reader: true = priced before the rule (the 2.2 multiple and the plan's age step,
// the existing code path), false = priced under it. An estimate with priced lines and no stamp predates the rule; one with no priced
// lines pins nothing. An estimate that kept only its inputs but asks for pest or one-time pest was saved before the rule too: it
// reads legacy on a first send, a resend and every replay (a fresh draft the engine priced carries its stamp, false).
function storedRequestsPest(estData) {
  const data = normalizeStored(estData);
  if (!data || typeof data !== 'object') return false;
  const container = require('./estimate-result-container').storedEstimateContainer(data) || null;
  const request = data.engineRequest && typeof data.engineRequest === 'object' ? data.engineRequest : null;
  // The builder request names its services as tokens (PEST = the plan, OT_PEST = the one-time visit), as it names EXCLUSION.
  if (request && Array.isArray(request.selectedServices)
    && request.selectedServices.some((key) => ['PEST', 'OT_PEST'].includes(String(key || '').toUpperCase()))) return true;
  return [data.engineInputs, data.inputs, data.engineInput, container && container.inputs, request && request.inputs]
    .some((carrier) => carrier && typeof carrier === 'object' && carrier.services && typeof carrier.services === 'object'
      && !!(carrier.services.pest || carrier.services.oneTimePest));
}

// Pest above the 5,500 sq ft footprint table (owner 2026-11-26: +$8 per visit at quarterly for each 1,000 sq ft above it, no cap),
// new quotes only. Its own stamp, read by the same reader: true = priced before the rule (flat at the last bracket, the existing
// code), false = priced under it. An estimate with priced lines and no stamp predates the rule; one with no priced lines pins
// nothing. An estimate that kept only its inputs but asks for pest or one-time pest was saved before the rule too, on a first
// send, a resend and every replay (a fresh draft the engine priced carries its stamp, false). Plan-wide, no per-service marker:
// a pest service a revision adds to a legacy estimate stays on the old rule, so a replay never raises a sold price.
function savedLegacyPestAboveTableSignal(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { flag } = readRuleStamp(estData, 'legacyPestAboveTable');
  if (flag === undefined && (storedRequestsPest(estData) || storedPestServices(estData).size > 0)) return { legacyPestAboveTable: true };
  return { legacyPestAboveTable: flag };
}

// Whole-home sizing (owner 2026-11-26 "whole home": the cockroach treatment, the bed bug treatment and the yearly rodent guarantee
// size on the home's TOTAL living area, as flea does), new quotes only. Its own stamp, read by the same reader: true = priced before
// the rule (the ground-floor footprint, the existing code), false = priced under it. An estimate with priced lines and no stamp
// predates the rule; one with no priced lines pins nothing. An estimate that kept only its inputs but asks for one of the three
// was saved before the rule too, on a first send, a resend and every replay (a fresh draft the engine priced carries its stamp,
// false). Plan-wide, no per-service marker: a service a revision adds to a legacy estimate stays on the old rule, so a replay
// never raises a sold price (the whole home is never smaller than its ground floor).
const roachRequested = (value) => !['', 'none', 'no', 'false', 'null', 'undefined'].includes(String(value ?? '').trim().toLowerCase());
function storedRequestsWholeHomeSizing(estData) {
  const data = normalizeStored(estData);
  if (!data || typeof data !== 'object') return false;
  const container = require('./estimate-result-container').storedEstimateContainer(data) || null;
  const request = data.engineRequest && typeof data.engineRequest === 'object' ? data.engineRequest : null;
  // The builder request names its services as tokens: ROACH (the standalone treatment), BEDBUG, RODENT_GUARANTEE, and PEST, whose
  // plan adds the cockroach treatment when its roach option is set (recurringRoachType / roachModifier).
  const tokens = request && Array.isArray(request.selectedServices)
    ? request.selectedServices.map((key) => String(key || '').toUpperCase())
    : [];
  if (tokens.some((key) => ['ROACH', 'BEDBUG', 'RODENT_GUARANTEE'].includes(key))) return true;
  const options = request && request.options && typeof request.options === 'object' ? request.options : {};
  if (options.standaloneRoachTreatment) return true;
  if (tokens.includes('PEST') && roachRequested(options.recurringRoachType ?? options.roachModifier)) return true;
  return [data.engineInputs, data.inputs, data.engineInput, container && container.inputs, request && request.inputs]
    .some((carrier) => carrier && typeof carrier === 'object' && carrier.services && typeof carrier.services === 'object'
      && !!(carrier.services.pestInitialRoach || carrier.services.bedBug || carrier.services.rodentGuarantee
        || (carrier.services.pest && roachRequested(carrier.services.pest.roachType))));
}

function savedLegacyWholeHomeSizingSignal(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { flag } = readRuleStamp(estData, 'legacyWholeHomeSizing');
  if (flag === undefined && storedRequestsWholeHomeSizing(estData)) return { legacyWholeHomeSizing: true };
  return { legacyWholeHomeSizing: flag };
}

// Which pest services a stored estimate priced (or asked for), from EVERY shape the estimate page's choice and breakdown readers read
// (routes/estimate-public.js: oneTimePestChoiceAmountFromResultStats / FromRecurringServices / FromBreakdown, normalizeOneTimeBreakdown,
// recurringServicesWithSupplements). One list of shapes, kept here so the stamp reader and the page cannot drift (a table test names each).
// Returns a Set of 'pest_control' (the plan) and 'one_time_pest' (the visit).
const hasNumber = (row, keys) => !!row && typeof row === 'object' && keys.some((k) => Number(row[k]) > 0);
const PLAN_PRICE_KEYS = ['pa', 'perApp', 'perVisit', 'perTreatment', 'basePrice', 'mo', 'monthly', 'monthlyBase', 'ann', 'annual', 'annualTotal', 'annualAfterDiscount'];
const PEST_NAME = /pest/i;
const NOT_PEST_PLAN = /termite|mosquito|rodent|lawn|shrub|palm|mist|wdo|exclusion|flea|roach|bed ?bug/i;
function storedPestServices(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const out = new Set();
  const container = require('./estimate-result-container').storedEstimateContainer(estData) || {};
  // A bare estimate_data (the priced rows at its top level, neither result nor engineResult) is its own container, as the page's readers take it.
  const sources = [container, estData?.result && typeof estData.result === 'object' ? estData.result : null,
    estData?.engineResult && typeof estData.engineResult === 'object' ? estData.engineResult : null,
    !estData?.result && !estData?.engineResult && estData && typeof estData === 'object' ? estData : null].filter(Boolean);
  for (const src of sources) {
    // The plan: result.pestTiers, results.pestTiers / results.pest, recurring.services pest rows, raw lines.
    if ([].concat(src.pestTiers || []).some((t) => hasNumber(t, PLAN_PRICE_KEYS))) out.add('pest_control');
    if ([].concat(src.results?.pestTiers || []).some((t) => hasNumber(t, PLAN_PRICE_KEYS))) out.add('pest_control');
    if (hasNumber(src.results?.pest, PLAN_PRICE_KEYS)) out.add('pest_control');
    if ([].concat(src.recurring?.services || []).some((r) => PEST_NAME.test(String(r?.name || r?.label || r?.service || ''))
      && !NOT_PEST_PLAN.test(String(r?.name || r?.label || r?.service || '')) && hasNumber(r, PLAN_PRICE_KEYS))) out.add('pest_control');
    if ([].concat(src.lineItems || []).some((l) => l?.service === 'pest_control' && hasNumber(l, [...PLAN_PRICE_KEYS, 'annualAfterDiscount']))) out.add('pest_control');
    // The one-time visit: its line, the mapped one-time rows (items, specItems, nested results.oneTime as a list or with items/specItems).
    const nested = src.results?.oneTime;
    const oneTimeRows = [].concat(src.lineItems || [], src.oneTime?.items || [], src.oneTime?.specItems || [],
      Array.isArray(nested) ? nested : [].concat(nested?.items || [], nested?.specItems || []));
    if (oneTimeRows.some((r) => r?.service === 'one_time_pest' && !r.quoteRequired && hasNumber(r, ['price', 'amount', 'priceAfterDiscount']))) out.add('one_time_pest');
  }
  // The frozen send snapshot's bundle: frequencies rows and the one-time breakdown.
  const bundle = estData?.sendSnapshot?.pricingBundle;
  if (bundle && typeof bundle === 'object') {
    // A frequency row carries every plan in the cart: it counts only when it names the pest plan.
    if ([].concat(bundle.frequencies || []).some((f) => hasNumber(f, ['monthly', 'annual', 'perVisit', 'pa']) && /pest[_ ]control/i.test(JSON.stringify(f)))) out.add('pest_control');
    if ([].concat(bundle.oneTimeBreakdown?.items || []).some((r) => r?.service === 'one_time_pest' && hasNumber(r, ['amount', 'price']))) out.add('one_time_pest');
  }
  return out;
}

function savedLegacyOneTimePestBufferSignal(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { flag } = readRuleStamp(estData, 'legacyOneTimePestBuffer');
  // No stamp: a priced pest row in ANY shape the page reads, or inputs that request pest, predates the rule.
  if (flag === undefined && (storedRequestsPest(estData) || storedPestServices(estData).size > 0)) return { legacyOneTimePestBuffer: true };
  return { legacyOneTimePestBuffer: flag };
}

// On a legacy estimate, the pest services priced under the NEW rule: those whose saved line carries legacyOneTimePestBuffer=false
// (a revision added them; the engine stamped the line). That is the only evidence for this rule: the flat currentRulesServices
// history predates it, so an older revision's entry never turns the rule on.
function savedOneTimePestCurrentServices(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { container } = readRuleStamp(estData, 'legacyOneTimePestBuffer');
  return [...new Set([
    ...pestRuleRows(container).filter((r) => r.flag === false).map((r) => r.service),
    ...frozenPestCurrentServices(estData),
  ])];
}

// The per-service rule a send snapshot froze when its rows could no longer say (the bundle's marker, or the snapshot's own copy
// left when the bundle was dropped): services priced under the new rule on an estimate that is otherwise old.
function frozenPestCurrentServices(estData) {
  const snapshot = estData?.sendSnapshot && typeof estData.sendSnapshot === 'object' ? estData.sendSnapshot : null;
  const list = snapshot?.oneTimePestCurrentServices ?? snapshot?.pricingBundle?.oneTimePestCurrentServices;
  return Array.isArray(list) ? list.filter((k) => ['pest_control', 'one_time_pest'].includes(k)) : [];
}

// The per-service stamp wherever a saved shape keeps it: the engine's raw lines, or the mapped result (which drops the lines): the
// plan row (results.pest) and the one-time pest rows (oneTime.items / specItems, results.oneTime as an array or with items).
function pestRuleRows(container) {
  const rows = [];
  const add = (service, row) => { if (row && typeof row === 'object' && typeof row.legacyOneTimePestBuffer === 'boolean') rows.push({ service, flag: row.legacyOneTimePestBuffer }); };
  for (const l of [].concat(container.lineItems || [])) if (l && ['pest_control', 'one_time_pest'].includes(l.service)) add(l.service, l);
  add('pest_control', container.results?.pest);
  const nested = container.results?.oneTime;
  for (const list of [container.oneTime?.items, container.oneTime?.specItems, Array.isArray(nested) ? nested : nested?.items, nested?.specItems]) {
    for (const row of [].concat(list || [])) if (row && row.service === 'one_time_pest') add('one_time_pest', row);
  }
  return rows;
}

// Is the one-time pest rule still the OLD one for this saved estimate (the estimate page's "both choices" amount asks)? The
// estimate-wide stamp says it predates the rule; a pest line carrying its own stamp, or the flat list of services a revision added
// under the current rules, says that service was priced on the new one.
function savedOneTimePestRuleLegacy(rawEstData) {
  const estData = normalizeStored(rawEstData);
  const { container } = readRuleStamp(estData, 'legacyOneTimePestBuffer');
  const flag = savedLegacyOneTimePestBufferSignal(estData).legacyOneTimePestBuffer;
  if (flag !== true) return false;
  // The one-time visit's own stamp decides the page's one-time choice when that line exists; the plan's stamp only for a plan-only offer
  // (a retained legacy plan beside a one-time visit a revision added shows the visit's rule).
  const rows = pestRuleRows(container);
  const row = rows.find((r) => r.service === 'one_time_pest') || rows[0];
  if (row) return row.flag;
  // No row to read (snapshot-only): the per-service marker the snapshot froze. The visit's own entry decides first, then the plan's.
  const frozen = frozenPestCurrentServices(estData);
  return !(frozen.includes('one_time_pest') || frozen.includes('pest_control'));
}

// Every rule stamp a send snapshot's pricing bundle can be the only evidence for, each read from its OWN evidence (a priced,
// unstamped snapshot is evidence for several rules at once). A later branch that adds a "which rules priced this estimate" stamp
// adds its key here.
const FROZEN_RULE_STAMPS = [
  ['legacyPricingRules', (data) => readRuleStamp(data, 'legacyPricingRules').flag],
  ['legacyTwoStoryRoof', (data) => savedLegacyTwoStoryRoofSignal(data).legacyTwoStoryRoof],
  ['legacyOneTimePestBuffer', (data) => savedLegacyOneTimePestBufferSignal(data).legacyOneTimePestBuffer],
  ['legacyPestAboveTable', (data) => savedLegacyPestAboveTableSignal(data).legacyPestAboveTable],
  ['legacyWholeHomeSizing', (data) => savedLegacyWholeHomeSizingSignal(data).legacyWholeHomeSizing],
  ['legacySpecialty1126', (data) => savedLegacySpecialty1126Signal(data).legacySpecialty1126],
];

// Before a send snapshot's pricing bundle is dropped (a tier change, a relabel), freeze the rule stamps its prices were read
// under onto the snapshot: the bundle is the only evidence of a snapshot-only quote's prices, and without a stamp the reader
// would find nothing priced and replay it on today's rules. Each missing stamp is resolved on its own, before the bundle goes.
// Mutates estData.sendSnapshot (a copy of it); a stamp the snapshot already carries, or one with no evidence, is left alone.
function freezeSnapshotRuleStamps(estData) {
  if (!estData || typeof estData !== 'object' || !estData.sendSnapshot || typeof estData.sendSnapshot !== 'object') return;
  const frozen = {};
  for (const [key, read] of FROZEN_RULE_STAMPS) {
    if (typeof estData.sendSnapshot[key] === 'boolean') continue;
    const flag = read(estData);
    if (typeof flag === 'boolean') frozen[key] = flag;
  }
  // The per-service one-time pest rule rides the bundle; keep it on the snapshot itself when the bundle goes.
  // The services of the specialty rule that a revision priced under it: the list rides the snapshot itself once the bundle goes.
  if (estData.sendSnapshot.pricingBundle && !Array.isArray(estData.sendSnapshot.specialty1126CurrentServices)) {
    const currentSpecialty = savedSpecialty1126CurrentServices(estData);
    if (currentSpecialty.length) frozen.specialty1126CurrentServices = currentSpecialty;
  }
  const bundledChoice = estData.sendSnapshot.pricingBundle?.oneTimePestChoice;
  if (bundledChoice && !estData.sendSnapshot.oneTimePestChoice) frozen.oneTimePestChoice = bundledChoice;
  // The bedroom-band verdict rides the bundle the same way.
  if (estData.sendSnapshot.pricingBundle?.bandPricedPest === true && estData.sendSnapshot.bandPricedPest !== true) frozen.bandPricedPest = true;
  if (estData.sendSnapshot.pricingBundle && !Array.isArray(estData.sendSnapshot.oneTimePestCurrentServices)) {
    const current = savedOneTimePestCurrentServices(estData);
    if (current.length) frozen.oneTimePestCurrentServices = current;
  }
  if (Object.keys(frozen).length) estData.sendSnapshot = { ...estData.sendSnapshot, ...frozen };
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
  const savedMinimum = Number(palm ? palm.minPerVisit : palmRemoval?.provenance?.floorSignals?.palmMinPerVisitReplay);
  const signals = { palmAnnualRounding: palm || palmRemoval ? (palmMode === 'cents' ? 'cents' : 'whole') : undefined };
  // The per-visit palm minimum the saved quote was priced with (a replay never takes a later Settings edit).
  // A removed palm line keeps it in the removal event, so a restore prices under the same minimum.
  signals.palmMinPerVisitReplay = savedMinimum > 0 ? savedMinimum : undefined;
  const lawnArm = estimateLawnFloorArmed(estData);
  if (typeof lawnArm === 'boolean') signals.useLawnCostFloor = lawnArm;
  Object.assign(signals, savedLawnCostPlusSignal(estData));
  const minSignal = require('./estimate-converter').estimateLawnProgramMinimumSignal(estData);
  if (minSignal != null) signals.lawnProgramMinimumMonthly = minSignal;
  Object.assign(signals, savedLawnMinimumAfterDiscountSignal(estData));
  Object.assign(signals, savedLegacyPricingRulesSignal(estData));
  Object.assign(signals, savedLegacyTwoStoryRoofSignal(estData));
  Object.assign(signals, savedLegacyOneTimePestBufferSignal(estData));
  Object.assign(signals, savedLegacyPestAboveTableSignal(estData));
  Object.assign(signals, savedLegacyWholeHomeSizingSignal(estData));
  Object.assign(signals, savedLegacySpecialty1126Signal(estData));
  const currentSpecialty = savedSpecialty1126CurrentServices(estData);
  if (currentSpecialty.length) signals.specialty1126CurrentServices = currentSpecialty;
  // Only when a saved line carries the evidence; a posted copy in the stored inputs is stripped by the identity fields.
  // A removal prunes the plan's rows (and the line stamp with them); its server-recorded event kept the per-service stamp the
  // opt-out captured (provenance.floorSignals), so a restore prices the plan under the rule it was added on.
  const removedPest = (Array.isArray(saved.serviceOptOut?.events) ? saved.serviceOptOut.events : [])
    .filter((event) => event?.included === false)
    .flatMap((event) => [].concat(event?.provenance?.floorSignals?.oneTimePestCurrentServices || []));
  const currentPest = [...new Set([...savedOneTimePestCurrentServices(estData), ...removedPest])];
  if (currentPest.length) signals.oneTimePestCurrentServices = currentPest;
  const pest = estimatePestFloorSignal(estData);
  if (typeof pest.armed === 'boolean') signals.pestProgramFloorArmed = pest.armed;
  if (pest.perVisit != null) signals.pestProgramFloorPerVisit = pest.perVisit;
  return signals;
}

module.exports = {
  rawEngineInputs,
  estimateLawnFloorArmed,
  savedLawnCostPlusSignal,
  lawnRowsShowFloorEnforcement,
  estimatePestFloorSignal,
  savedLawnMinimumAfterDiscountSignal,
  savedLegacyPricingRulesSignal,
  savedLegacyTwoStoryRoofSignal,
  savedLegacyOneTimePestBufferSignal,
  savedLegacyPestAboveTableSignal,
  savedLegacyWholeHomeSizingSignal,
  readRuleStamp,
  savedLegacySpecialty1126Signal,
  savedSpecialty1126CurrentServices,
  savedOneTimePestRuleLegacy,
  savedOneTimePestCurrentServices,
  storedPestServices,
  freezeSnapshotRuleStamps,
  savedFloorReplaySignals,
};
