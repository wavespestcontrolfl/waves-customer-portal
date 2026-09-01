/**
 * Customer service opt-out — pure estimate_data surgery.
 *
 * The customer drops ONE recurring service line from a sent estimate. This
 * module owns the blob half: deciding which sections may be dropped, pruning
 * the service out of every replayable engine-input carrier, capturing what it
 * takes to put it back exactly, and building the audit record. It does NO
 * pricing math and touches NO stored result rows — the canonical engine replay
 * (serverRecomputeFromEstimateData) is the sole dollar authority, and the route
 * owns the recompute, the guarded write and the response.
 *
 * Three service-key vocabularies meet here and none of them are
 * interchangeable, so the map below is explicit rather than derived:
 *   - SECTION key   (pest_control, lawn_care, …) — what the customer page
 *     renders, from recurringServiceKey (estimate-converter)
 *   - ENGINE key    (services.pest, services.lawn, …) — generateEstimate input
 *   - SELECTED token (PEST, LAWN, …) — engineRequest.selectedServices, read by
 *     translateV2CallToV1Input
 *
 * tree_shrub and every commercial_* key are deliberately absent from the map.
 * See NON_REMOVABLE_BY_POLICY below — one mechanical reason, one owner ruling.
 */

const SERVICE_OPT_OUT_KEYS = {
  pest_control: { engine: ['pest'], selected: ['PEST'], label: 'Pest Control' },
  lawn_care: { engine: ['lawn'], selected: ['LAWN'], label: 'Lawn Care' },
  mosquito: { engine: ['mosquito'], selected: ['MOSQUITO'], label: 'Mosquito' },
  termite_bait: { engine: ['termite', 'termiteBait'], selected: ['TERMITE_BAIT'], label: 'Termite Bait Stations' },
  rodent_bait: { engine: ['rodentBait'], selected: ['RODENT_BAIT'], label: 'Rodent Bait Stations' },
  palm_injection: { engine: ['palmInjection', 'palm'], selected: ['PALM_INJECTION'], label: 'Palm Injection' },
};

// Why the two families above are excluded, recorded so the answer does not
// quietly change when the code does:
//
//   tree_shrub — MECHANICAL. sanitizeClientIdentityFields strips
//   treeShrubPricingKnobs from v1Input on every serverRecomputeFromEstimateData
//   call and re-derives them via treeShrubKnobSignalForReplay, which keys on the
//   stored T&S RESULT ROW that a removal deletes. There is no input-level home
//   to re-plant the quote-time knobs into, so a restore would silently reprice
//   the line off whatever knobs are live today. Making it removable means adding
//   an explicit provenance dep to the canonical recompute — a change to a
//   function the admin save path also uses, and a decision, not a default.
//
//   commercial_* — OWNER RULING (2026-08-31): a commercial customer never
//   self-serves a line removal on an auto-priced commercial quote; it comes to
//   the office. commercialFloorBoundServices has the same stored-row provenance
//   problem, but the policy stands independently of it.
const NON_REMOVABLE_BY_POLICY = ['tree_shrub'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Every carrier a replay can read the service back out of. engineInputs and
// inputs are the two flat shapes; engineRequest is the v2 saved call, which
// serverRecomputeFromEstimateData PREFERS over engineInputs — pruning only the
// flat shapes would let the replay resurrect the removed line, displaying the
// reduced price while accept locks and bills the full one.
function inputCarriers(parsedData) {
  return [parsedData?.engineInputs, parsedData?.inputs].filter(isPlainObject);
}

/**
 * Which rendered sections this customer may drop.
 *
 * Called by BOTH the /data projection and the write handler, so the payload can
 * never advertise an action the write refuses.
 *
 * @param {object} estData   parsed estimate_data
 * @param {Array}  sections  the pricing bundle's services[] array
 * @returns {Set<string>} section keys
 */
// Authored proposals are the authoritative quote and the engine rows are
// retained-but-superseded. Refuse on ITEMIZATION PRESENCE, not on
// proposal.enabled — normalizeProposal (estimate-proposal.js) returns a
// stored proposal verbatim whenever it carries buildings/programs/
// correctiveWork, so a scaffold with enabled:false and $0 program lines
// still overrides the engine rows on every renderer, in the margin audit,
// and in buildProposalFirstInvoice, which BILLS from it at mark-won.
// Deliberately stricter than PUT /:token/interior-service, which checks
// enabled and would let that scaffold through. One guard for removals,
// RESTORES and the /data add-back projection — a row that gains an
// itemization after a removal must refuse the restore too, or the route
// would persist engine totals under a proposal that stays the authoritative
// billed quote (pre-push codex P0 on b6236b5).
function serviceOptOutBlockedByProposal(estData = {}) {
  const proposal = isPlainObject(estData) ? estData.proposal : null;
  return isPlainObject(proposal)
    && !!(proposal.buildings || proposal.programs || proposal.correctiveWork);
}

// A standing /select-tier override — the row's waveguard_tier differing from
// the engine's own tier for the current mix — takes the estimate out of
// self-serve mix changes entirely (office lane). An opt-out reprice persists
// the engine's tier and totals, and honoring a hand-picked tier through that
// rewrite would either silently discard the choice or persist totals that
// disagree with the stored result rows every renderer and accept reads
// (pre-push codex P0 x2 on 9389704). Refusing is the smallest coherent cut;
// the tier/mix interplay is an owner ruling, not a route default. The engine
// reference is the last opt-out commit's stamp when one exists, else the
// stored result's tier; unknown or missing tiers never block.
function serviceOptOutTierSelectionActive(estData = {}, rowTier = null) {
  const rank = (t) => ['bronze', 'silver', 'gold', 'platinum'].indexOf(String(t || '').toLowerCase());
  if (rank(rowTier) < 0) return false;
  const engineRef = estData?.serviceOptOut?.engineTier
    || estData?.result?.recurring?.waveGuardTier
    || estData?.result?.recurring?.tier
    // Engine-only estimates store the tier in the raw carrier — without this
    // a select-tier override on one is not recognized, /data advertises the
    // controls, and the PUT overwrites the selection (codex #3684 r2 P1).
    || estData?.engineResult?.waveGuard?.tier
    || null;
  if (rank(engineRef) < 0) return false;
  return rank(rowTier) !== rank(engineRef);
}

function serviceOptOutRemovableKeys(estData = {}, sections = [], rowTier = null) {
  const empty = new Set();
  if (!isPlainObject(estData)) return empty;

  if (serviceOptOutBlockedByProposal(estData)) {
    return empty;
  }

  if (serviceOptOutTierSelectionActive(estData, rowTier)) {
    return empty;
  }

  const list = Array.isArray(sections) ? sections : [];
  const recurring = list.filter((s) => s && s.isRecurring === true);
  // Removing the last recurring line is a decline, not a removal — it has its
  // own terminal, disposition-stamping action and must stay a deliberate click.
  if (recurring.length < 2) return empty;

  const removable = new Set();
  for (const section of recurring) {
    const key = String(section.key || '');
    // Also what excludes the synthetic `bundle` card the server emits when the
    // ladder cannot be split, and every commercial_* and tree_shrub key.
    if (!SERVICE_OPT_OUT_KEYS[key]) continue;
    // A real key that still fronts several services (memberKeys) is one card
    // for many lines — there is no single service to point the control at.
    if (Array.isArray(section.memberKeys) && section.memberKeys.length > 1) continue;
    if (section.quoteRequired === true) continue;
    // The service must actually be present in a carrier the replay reads,
    // or the prune would be a no-op and the recompute would return the same
    // price — an opt-out that silently does nothing.
    if (!serviceIsPresentInInputs(estData, key)) continue;
    removable.add(key);
  }
  return removable;
}

function serviceIsPresentInInputs(parsedData, sectionKey) {
  const spec = SERVICE_OPT_OUT_KEYS[sectionKey];
  if (!spec) return false;
  for (const carrier of inputCarriers(parsedData)) {
    if (isPlainObject(carrier.services)
      && spec.engine.some((k) => carrier.services[k] != null)) return true;
  }
  const req = parsedData?.engineRequest;
  if (isPlainObject(req) && Array.isArray(req.selectedServices)) {
    if (req.selectedServices.some((t) => spec.selected.includes(String(t).toUpperCase()))) return true;
  }
  return false;
}

/**
 * Quote-time pricing provenance that a removal would erase.
 *
 * Some knobs are resolved from the stored RESULT ROWS, not the inputs, and the
 * write-back overwrites result wholesale. resolveStoredPestPricingVersion says
 * it outright: "No stored pest line = pest was just added: genuinely new,
 * caller keeps the live default." So restoring pest on an estimate whose stored
 * inputs never carried an explicit version would reprice it on the live v2
 * curve instead of the v1 curve the customer was quoted. Capture before the
 * prune; re-plant on restore.
 *
 * The lawn floor signals are captured for the audit record only — the engine
 * re-stamps them into result.pricingMetadata on every run, and the recompute
 * now threads them (savedFloorReplaySignals), so they carry themselves.
 */
function captureServiceOptOutProvenance(parsedData = {}, sectionKey) {
  const provenance = {};
  if (sectionKey === 'pest_control') {
    try {
      const version = require('./estimate-pricing-bundle-utils')
        .resolveStoredPestPricingVersion(parsedData);
      if (version) provenance.pestPricingVersion = version;
    } catch (_) { /* provenance is best-effort; never block the opt-out */ }
  }
  try {
    const signals = require('./estimate-floor-signal-replay').savedFloorReplaySignals(parsedData);
    if (signals && Object.keys(signals).length) provenance.floorSignals = signals;
  } catch (_) { /* same */ }
  return provenance;
}

/**
 * Prune (or restore) one service across every replayable input carrier.
 *
 * Returns { ok, reason?, removedInputs } — removedInputs is the deleted subtree
 * per carrier, which is what makes "Add it back" the customer's OWN quote-time
 * configuration rather than a defaulted guess.
 *
 * Deliberately does NOT touch options.*: translateV2CallToV1Input only builds
 * services.<key> when the selectedServices token is present, so leftover
 * per-service options are inert once the token is gone — and leaving them is
 * both the smaller change and what makes a restore exact. Two option keys are
 * estimate-WIDE and would be actively wrong to clear on a service removal
 * (options.useLawnCostFloor, options.commercialInteriorService); not clearing
 * anything keeps that guarantee structural rather than a maintained exception.
 */
function applyServiceOptOutToEstimateData(parsedData = {}, {
  serviceKey,
  included,
  removedInputs = null,
  provenance = null,
} = {}) {
  const spec = SERVICE_OPT_OUT_KEYS[serviceKey];
  if (!spec) return { ok: false, reason: 'service_not_removable' };
  if (!isPlainObject(parsedData)) return { ok: false, reason: 'service_not_removable' };

  if (included === false) {
    const captured = { engineInputs: null, inputs: null, selected: [] };
    let touched = false;

    for (const [name, carrier] of [['engineInputs', parsedData.engineInputs], ['inputs', parsedData.inputs]]) {
      if (!isPlainObject(carrier) || !isPlainObject(carrier.services)) continue;
      for (const engineKey of spec.engine) {
        if (carrier.services[engineKey] == null) continue;
        captured[name] = { ...(captured[name] || {}), [engineKey]: carrier.services[engineKey] };
        delete carrier.services[engineKey];
        touched = true;
      }
    }

    const req = parsedData.engineRequest;
    if (isPlainObject(req) && Array.isArray(req.selectedServices)) {
      const before = req.selectedServices;
      const kept = before.filter((t) => !spec.selected.includes(String(t).toUpperCase()));
      if (kept.length !== before.length) {
        captured.selected = before.filter((t) => spec.selected.includes(String(t).toUpperCase()));
        req.selectedServices = kept;
        touched = true;
      }
    }

    if (!touched) return { ok: false, reason: 'service_not_removable' };
    return { ok: true, removedInputs: captured };
  }

  // Restore. Re-plant the customer's own quote-time subtrees, then the
  // provenance that the stored result no longer carries.
  if (!isPlainObject(removedInputs)) return { ok: false, reason: 'nothing_to_restore' };
  for (const name of ['engineInputs', 'inputs']) {
    const subtree = removedInputs[name];
    if (!isPlainObject(subtree)) continue;
    if (!isPlainObject(parsedData[name])) parsedData[name] = {};
    if (!isPlainObject(parsedData[name].services)) parsedData[name].services = {};
    for (const [engineKey, value] of Object.entries(subtree)) {
      parsedData[name].services[engineKey] = value;
    }
  }
  const req = parsedData.engineRequest;
  if (isPlainObject(req) && Array.isArray(removedInputs.selected) && removedInputs.selected.length) {
    if (!Array.isArray(req.selectedServices)) req.selectedServices = [];
    for (const token of removedInputs.selected) {
      if (!req.selectedServices.includes(token)) req.selectedServices.push(token);
    }
  }
  // An explicit version stamp WINS in the recompute — it derives one only when
  // the input has none (admin-estimate-persistence). This is the whole reason
  // provenance is captured.
  const pestVersion = provenance?.pestPricingVersion;
  if (pestVersion && serviceKey === 'pest_control') {
    for (const carrier of inputCarriers(parsedData)) {
      if (isPlainObject(carrier.services?.pest) && !carrier.services.pest.version) {
        carrier.services.pest.version = pestVersion;
      }
    }
  }
  return { ok: true, removedInputs: null };
}

// Runtime-added blob key, same class as preferences / customerSelection /
// membershipSnapshot / operatorPriceAdjustment. baseline is captured ONCE, on
// the first scope change, with serviceOptOut stripped so a second removal can
// never nest a blob inside a blob.
function recordServiceOptOutEvent(parsedData, event, baselineSource) {
  if (!isPlainObject(parsedData.serviceOptOut)) {
    const baseline = { ...baselineSource };
    delete baseline.serviceOptOut;
    parsedData.serviceOptOut = {
      baseline,
      baselineCapturedAt: event.at,
      events: [],
    };
  }
  parsedData.serviceOptOut.events.push(event);
  return parsedData.serviceOptOut;
}

// Section keys currently opted out, for the /data payload and the add-offer
// suppression (answering "remove lawn" with "add lawn and save more" in three
// places is the failure this prevents).
function currentlyOptedOutKeys(parsedData = {}) {
  const events = parsedData?.serviceOptOut?.events;
  if (!Array.isArray(events)) return [];
  const state = new Map();
  for (const e of events) {
    if (e && e.serviceKey) state.set(e.serviceKey, e.included === true);
  }
  return Array.from(state.entries()).filter(([, included]) => !included).map(([key]) => key);
}

function serviceOptOutLabel(sectionKey) {
  return SERVICE_OPT_OUT_KEYS[sectionKey]?.label || sectionKey;
}

module.exports = {
  SERVICE_OPT_OUT_KEYS,
  NON_REMOVABLE_BY_POLICY,
  serviceOptOutBlockedByProposal,
  serviceOptOutTierSelectionActive,
  serviceOptOutRemovableKeys,
  serviceIsPresentInInputs,
  captureServiceOptOutProvenance,
  applyServiceOptOutToEstimateData,
  recordServiceOptOutEvent,
  currentlyOptedOutKeys,
  serviceOptOutLabel,
};
