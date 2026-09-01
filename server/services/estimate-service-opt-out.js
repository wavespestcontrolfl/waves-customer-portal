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
  // termite_bait: estimate-add-service-request writes the snake_case alias
  // into inputs.services and the engine consumes it (estimate-engine.js
  // `services.termite || services.termiteBait || services.termite_bait`) —
  // omitting it left those revised estimates un-removable (codex #3684 r3 P1).
  termite_bait: { engine: ['termite', 'termiteBait', 'termite_bait'], selected: ['TERMITE_BAIT'], label: 'Termite Bait Stations' },
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
  // Presence must come from a carrier the canonical recompute can actually
  // REPLAY — engineRequest or engineInputs (admin-estimate-persistence
  // accepts nothing else). A legacy { inputs, result } estimate would be
  // advertised removable and then 409 `reprice_unavailable` on every preview
  // (pre-push codex P1 on 15ca6d3). `inputs` is still pruned and restored by
  // the surgery below; it just cannot be the eligibility evidence.
  const engineInputs = parsedData?.engineInputs;
  if (isPlainObject(engineInputs) && isPlainObject(engineInputs.services)
    && spec.engine.some((k) => engineInputs.services[k] != null)) return true;
  // engineRequest counts only when it is actually replayable — the recompute
  // translates it only when req.profile exists, so a legacy request carrying
  // selectedServices without a profile would advertise a control whose every
  // dry-run 409s (codex #3684 r4 P1).
  const req = parsedData?.engineRequest;
  if (isPlainObject(req) && isPlainObject(req.profile) && Array.isArray(req.selectedServices)) {
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
// never nest a blob inside a blob. The baseline is stored as a JSON STRING,
// not an object: it carries the complete pre-removal rows and inputs, and
// recursive detectors that walk every object in estimate_data (fresh
// evidence: collectTermiteFacts in termite-program-agreement.js) would read
// the removed service back out of it — accepting a reduced estimate would
// still look like a termite-program acceptance (codex #3684 r3 P1). A string
// is opaque to every walker; it is audit-only and never replayed.
function recordServiceOptOutEvent(parsedData, event, baselineSource) {
  if (!isPlainObject(parsedData.serviceOptOut)) {
    const baseline = { ...baselineSource };
    delete baseline.serviceOptOut;
    parsedData.serviceOptOut = {
      baseline: JSON.stringify(baseline),
      baselineCapturedAt: event.at,
      events: [],
    };
  }
  // Same opacity rule for the event's removedInputs — it is the complete
  // deleted input subtree (a termite removal carries the full bait-program
  // config), and a recursive detector would read the removed service back out
  // of it exactly like the baseline. Stored as a string; the route parses it
  // back for a restore (readRemovedInputs below).
  if (event && isPlainObject(event.removedInputs)) {
    event.removedInputs = JSON.stringify(event.removedInputs);
  }
  parsedData.serviceOptOut.events.push(event);
  return parsedData.serviceOptOut;
}

// The restore-side reader for an event's removedInputs — tolerant of both the
// serialized shape written by recordServiceOptOutEvent and a plain object.
function readRemovedInputs(event) {
  const raw = event?.removedInputs ?? null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return isPlainObject(raw) ? raw : null;
}

// ── Priced add (GATE_ESTIMATE_SERVICE_ADD) ─────────────────────────────
//
// The mirror of a removal: a service that was NEVER on the quote joins it
// through the same dryRun-preview → confirm rail, priced by the same canonical
// recompute. Only the three residential lines the engine can price from the
// stored property profile alone; termite/rodent need measurements the profile
// may not carry and are left to the office (bundle inquiry).
const SERVICE_ADD_KEYS = ['pest_control', 'lawn_care', 'mosquito'];

function replayableCarrier(estData) {
  const req = estData?.engineRequest;
  if (isPlainObject(req) && isPlainObject(req.profile) && Array.isArray(req.selectedServices)) return 'engineRequest';
  if (isPlainObject(estData?.engineInputs) && isPlainObject(estData.engineInputs.services)) return 'engineInputs';
  return null;
}

// Whether the engine can price `serviceKey` from what the estimate already
// stores. Lawn needs a turf basis; the v2 profile derives treatable turf from
// lot/home footprint (or a measured figure), the v1 inputs need lawnSqFt or
// lotSqFt top-level (same rule addRequestedServiceToInputs applies).
function serviceAddBuildable(estData, serviceKey) {
  const carrier = replayableCarrier(estData);
  if (!carrier) return false;
  if (serviceKey !== 'lawn_care') return true;
  if (carrier === 'engineRequest') {
    const p = estData.engineRequest.profile;
    return Number(p.measuredTurfSf) > 0 || Number(p.lawnSqFt) > 0 || Number(p.lotSqFt) > 0;
  }
  const ei = estData.engineInputs;
  return Number(ei.lawnSqFt) > 0 || Number(ei.lotSqFt) > 0;
}

// `category` is the estimates.category column — the authoritative scope, not
// the rendered section keys (a commercial or legacy row can carry generic
// keys). Fails CLOSED unless RESIDENTIAL (pre-push codex P1).
function serviceOptOutAddableKeys(estData = {}, sections = [], rowTier = null, { category } = {}) {
  const empty = new Set();
  if (!isPlainObject(estData)) return empty;
  if (String(category || '').toUpperCase() !== 'RESIDENTIAL') return empty;
  if (serviceOptOutBlockedByProposal(estData)) return empty;
  if (serviceOptOutTierSelectionActive(estData, rowTier)) return empty;
  // Existing members never self-serve a priced add: their offers are the
  // seasonal / member ladder (a different program than the fresh-quote
  // default this rail would plant — pre-push codex P0), and their combined
  // tier is the office's to extend. The mirror inquiry stays for them.
  if (estData.membershipSnapshot?.isExistingCustomer === true) return empty;
  for (const carrier of [estData, estData.engineInputs, estData.inputs, estData.engineRequest?.options]) {
    if (isPlainObject(carrier) && Array.isArray(carrier.priorQualifyingServices) && carrier.priorQualifyingServices.length) return empty;
  }
  const list = Array.isArray(sections) ? sections : [];
  // Residential, engine-priced recurring plans only: a commercial line or a
  // quote-required section takes the whole page out of self-serve adds.
  if (list.some((s) => s && (String(s.key || '').startsWith('commercial_') || s.quoteRequired === true))) return empty;
  const recurring = list.filter((s) => s && s.isRecurring === true);
  if (!recurring.length) return empty;
  const present = new Set(recurring.map((s) => String(s.key || '')));
  const removed = new Set(currentlyOptedOutKeys(estData));
  const addable = new Set();
  for (const key of SERVICE_ADD_KEYS) {
    if (present.has(key)) continue;
    // A removed line comes back through the restore path, never as an add.
    if (removed.has(key)) continue;
    if (serviceIsPresentInInputs(estData, key)) continue;
    if (!serviceAddBuildable(estData, key)) continue;
    addable.add(key);
  }
  return addable;
}

// The synthetic "removedInputs" for an add — the same shape a restore
// re-plants, so applyServiceOptOutToEstimateData({ included: true }) is the one
// surgery for both. engineRequest carriers get the selectedServices token
// (translateV2CallToV1Input derives the service block from the profile +
// options, exactly as a fresh admin quote would); engineInputs carriers get
// the add-service flow's default block (estimate-add-service-request), so a
// customer add and an office add price identically.
function buildServiceAddInputs(estData = {}, serviceKey) {
  const spec = SERVICE_OPT_OUT_KEYS[serviceKey];
  if (!spec || !SERVICE_ADD_KEYS.includes(serviceKey)) return { ok: false, reason: 'service_not_addable' };
  const carrier = replayableCarrier(estData);
  if (!carrier) return { ok: false, reason: 'service_not_addable' };
  const captured = { engineInputs: null, inputs: null, selected: [] };
  if (carrier === 'engineRequest') {
    captured.selected = [spec.selected[0]];
  }
  if (isPlainObject(estData.engineInputs) && isPlainObject(estData.engineInputs.services)) {
    const { addRequestedServiceToInputs } = require('./estimate-add-service-request');
    const { added, updatedInputs, reason } = addRequestedServiceToInputs(estData.engineInputs, estData, serviceKey);
    if (!added) return { ok: false, reason: reason || 'service_not_addable' };
    const engineKey = spec.engine.find((k) => updatedInputs.services[k] != null);
    if (!engineKey) return { ok: false, reason: 'service_not_addable' };
    captured.engineInputs = { [engineKey]: updatedInputs.services[engineKey] };
    // Keep the display carrier in step with the replay carrier.
    if (isPlainObject(estData.inputs)) captured.inputs = { [engineKey]: updatedInputs.services[engineKey] };
  }
  return { ok: true, removedInputs: captured };
}

// Keys whose CURRENT state is "removed by staff at send time" — the page words
// these as an offer ("Also available"), not as something the customer took
// off ("removed · Add it back").
// Whether `serviceKey`'s CURRENT state is a staff-parked offer (its latest
// event is an actor:'staff' removal). A staff offer only ever re-enters the
// plan under the add gate — the lane that created it — so the rail and the
// /data stamp both consult this with the gate.
function latestOptOutEventIsStaff(parsedData = {}, serviceKey) {
  return staffOfferedKeys(parsedData).includes(serviceKey);
}

function staffOfferedKeys(parsedData = {}) {
  const events = parsedData?.serviceOptOut?.events;
  if (!Array.isArray(events)) return [];
  const latest = new Map();
  for (const e of events) {
    if (e && e.serviceKey) latest.set(e.serviceKey, e);
  }
  return Array.from(latest.values())
    .filter((e) => e.included === false && e.actor === 'staff')
    .map((e) => e.serviceKey);
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
  readRemovedInputs,
  currentlyOptedOutKeys,
  serviceOptOutLabel,
  SERVICE_ADD_KEYS,
  serviceOptOutAddableKeys,
  buildServiceAddInputs,
  staffOfferedKeys,
  latestOptOutEventIsStaff,
};
