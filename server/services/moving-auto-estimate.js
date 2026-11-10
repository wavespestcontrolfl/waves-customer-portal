'use strict';

/**
 * The app-made new-home estimate (owner 2026-11-04, option A of the hands-off
 * moves page: "App looks up the new home, prices the plan he has now (same
 * services, his live cadence, no $99)"; dark behind GATE_MOVING_AUTO_ESTIMATE).
 *
 * A job every 15 minutes picks up each submitted move whose new address is in
 * our area and has no estimate yet, once, and saves the new-home estimate the
 * office would make from the Moving card: the same estimate save, with the
 * move's stamp and its $99 waiver, priced by the server. The estimate is a
 * draft: nothing goes to the customer from here (services/moving-auto-send.js
 * sends it, behind its own gate).
 *
 * Free checks run first, so a move the office must price costs nothing: the
 * old-house stop already ran, the
 * new-home estimate's own refusals (billing lane, address), a tenant account,
 * termite, misting or palm treatments on the plan, no earlier estimate to copy
 * the services from, a discount on that estimate, a plan that is not one pest
 * plan, a visit schedule or visit price it cannot read. Then one property
 * lookup of the new address (paid, cached 180 days; claimed before the call,
 * so a move gets at most one), and the office gets the move when the county
 * record does not confirm a single-family home and lot (the engine would price
 * a guessed size), the engine cannot price it cleanly, or the new visit price
 * is more than 10% below or 25% above the current one.
 *
 * Every hand-off writes the move's state and one ringing office item in the
 * same transaction. Logs carry ids and outcomes only, never an address.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { movingAutoEstimateLive } = require('../config/feature-gates');
const { raiseAdminAlert, cutAtWord, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');

const CANDIDATE_LIMIT = 10;
// A claim older than this with no outcome is a run that stopped mid-way.
const STALE_CLAIM_MS = 30 * 60 * 1000;
// The new visit price must stay inside this band of the current one.
const LOW_BAND = 0.9;
const HIGH_BAND = 1.25;
// The recurring services the new-home estimate copies (client moveEstimateForm.js MOVE_PROGRAM_KEYS).
const KEPT_SERVICE_FLAGS = ['svcLawn', 'svcPest', 'svcTs', 'svcMosquito', 'svcRodentBait'];
// A pest plan's visit schedule as the engine names it, and visits a year.
const PEST_CADENCES = {
  monthly: { frequency: 'monthly', visits: 12 },
  bimonthly: { frequency: 'bimonthly', visits: 6 },
  bi_monthly: { frequency: 'bimonthly', visits: 6 },
  every_other_month: { frequency: 'bimonthly', visits: 6 },
  quarterly: { frequency: 'quarterly', visits: 4 },
};
const PEST_PLAN = /pest/i;
const NOT_PEST_PLAN = /termite|mosquito|rodent|lawn|shrub|palm|mist|wdo/i;
const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];

const NOTES = {
  tenant: 'This is a tenant account, so the app did not price the new home.',
  left_out: 'The plan has termite, misting or palm treatments, which stay with the old house.',
  no_source: 'There is no earlier estimate to copy the services from.',
  discount: 'The earlier estimate had a discount. Decide whether it carries over, then price the new home.',
  not_pest_only: 'The app prices only a plan of one pest service for now.',
  stopped: 'The old-house visits already stopped, so the app cannot read the plan to copy. Price the new home by hand.',
  addon: 'The plan has an add-on service on its coming visits, which the new-home estimate would drop.',
  cadence: 'The app could not read the plan\'s visit schedule.',
  no_price: 'The app could not read the current visit price.',
  unit: 'The new address has a unit number, so the county record cannot size the home.',
  no_size: 'The county record does not confirm the new home\'s size, so the price would rest on a guess.',
  engine: 'The price engine could not price the new home cleanly.',
  stale: 'The automatic price for the new home did not finish.',
};
const errCode = (err) => String(err?.code || err?.name || 'error');
const parseJson = (value) => {
  if (!value || typeof value === 'object') return value || null;
  try { return JSON.parse(value); } catch { return null; }
};

// The same "had a discount" rule the office prefill reads (client moveEstimateForm.js hadDiscount).
function hadDiscount(inputs) {
  const type = inputs.manualDiscountType;
  return !!inputs.manualDiscountPreset
    || (!!type && type !== 'NONE')
    || (Array.isArray(inputs.serviceSpecificDiscountKeys) && inputs.serviceSpecificDiscountKeys.length > 0);
}

// The pest plan the move takes along: the account's live series, each read
// as its current template (a scoped service or price edit lives in
// recurring_template_overrides; the completed root stays historical). Null
// unless the account has exactly one live plan, and it is a pest plan, so a
// plan kept at another house makes two and the office prices the move.
async function movingPestPlan(move) {
  const { overlayRecurringTemplateOverrides } = require('./recurring-template-overrides');
  const cols = await db('scheduled_services').columnInfo().catch(() => ({}));
  const columns = ['id', 'service_type', 'recurring_pattern', 'estimated_price', 'is_callback',
    ...(cols.recurring_template_overrides ? ['recurring_template_overrides'] : [])];
  const live = await db('scheduled_services')
    .where({ customer_id: move.customer_id, recurring_ongoing: true })
    .whereNull('recurring_parent_id')
    .where(function notCallback() { this.whereNull('is_callback').orWhere('is_callback', false); })
    .whereNotNull('service_type')
    .select(columns);
  const current = live.map((root) => overlayRecurringTemplateOverrides(root, cols)).filter((root) => root.is_callback !== true);
  if (current.length !== 1) return null;
  const [root] = current;
  const name = String(root.service_type || '');
  return PEST_PLAN.test(name) && !NOT_PEST_PLAN.test(name) ? root : null;
}

// The pest service the office's estimate starts from: the builder's defaults
// with the live plan's visit schedule. The office prefill (client
// moveEstimateForm.js) copies only the schedule; the roach condition and every
// other setting describe the old house, so they start fresh here too.
function pestServiceFor(cadence) {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const v1 = translateV2CallToV1Input({}, ['PEST'], { pestFreq: String(cadence.visits) });
  return v1 && v1.services && v1.services.pest ? { ...v1.services.pest, frequency: cadence.frequency } : null;
}

// One ringing office item and the move's 'office' state, together, once.
// `note` replaces the code's fixed note (a refusal's own message, a price).
// Under the move's row lock, only while the move still shows this attempt's
// claim: a customer who sent another address meanwhile (a resubmit keeps an
// unfinished claim) gets the claim cleared instead, so the new address gets
// its own attempt.
async function leaveToOffice(move, code, { now, note: given = null }) {
  const note = given || NOTES[code] || NOTES.engine;
  const Moves = require('./customer-moves');
  const line = (row) => Moves._private.addressLine(parseJson(row.normalized_address));
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    if (!locked || locked.auto_estimate_state || !locked.auto_estimate_at
      || new Date(locked.auto_estimate_at).getTime() !== new Date(move.auto_estimate_at).getTime()) return 'skipped';
    if (line(locked) !== line(move)) {
      await trx('customer_moves').where({ id: move.id }).update({ auto_estimate_at: null, updated_at: now });
      return 'skipped';
    }
    await trx('customer_moves').where({ id: move.id })
      .update({ auto_estimate_state: 'office', auto_estimate_note: note.slice(0, 300), updated_at: now });
    await trx('activity_log').insert({
      customer_id: move.customer_id,
      action: 'moving_auto_estimate_office',
      description: `New-home estimate left to the office: ${note}`,
      metadata: JSON.stringify({ move_id: move.id, reason: code }),
    });
    const customer = await trx('customers').where({ id: move.customer_id }).first('first_name', 'last_name');
    const name = [customer && customer.first_name, customer && customer.last_name].filter(Boolean).join(' ').trim() || 'a customer';
    const notif = await raiseAdminAlert('service', {
      area: 'Customers',
      action: cutAtWord(`price ${name}'s new home by hand`, MAX_HEADLINE_CHARS - 'Customers — '.length),
      why: 'The app did not make their new-home estimate; the item says why.',
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(move.customer_id)}`,
      subject: { type: 'customer', id: move.customer_id },
      doneWhen: 'move_handled',
      who: 'person',
    }, {
      trx,
      detail: `${note} Make the estimate with Estimate for new home on the Moving card.`,
      icon: '🚚',
      bell: true,
      // One item per attempt (a new address gets a new attempt): the claim time names it.
      dedupeKey: `moving_auto_estimate_office:${move.id}:${new Date(move.auto_estimate_at || now).getTime()}`,
      metadata: { customerId: move.customer_id, moveId: move.id, kind: 'moving_auto_estimate_office', reason: code },
    });
    if (!notif || notif.suppressed) throw new Error('moving auto-estimate office item did not persist');
    return 'office';
  });
}

// Claims a move for its one automatic attempt, under its row lock, only while
// it is still a candidate and has no live new-home estimate (an estimate for
// an address the customer since replaced no longer counts). A move whose live
// estimate the office made is marked so the scan skips it from then on.
async function claimMove(moveId, now) {
  const Moves = require('./customer-moves');
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: moveId }).forUpdate().first();
    if (!locked || locked.status !== 'submitted' || locked.address_verdict !== 'in_area' || !locked.normalized_address
      || locked.auto_estimate_at || locked.auto_estimate_state) return null;
    const action = await Moves.newHomeAction(locked, trx);
    if (action && action.action === 'open') {
      await trx('customer_moves').where({ id: moveId })
        .update({ auto_estimate_state: 'office', auto_estimate_note: 'The office made the estimate.', updated_at: now });
      return null;
    }
    const [claimed] = await trx('customer_moves').where({ id: moveId })
      .update({ auto_estimate_at: now, updated_at: now }).returning('*');
    return claimed;
  });
}

// Any add-on (scheduled_service_addons) on the plan's visits from today on: a
// recurring add-on rides every coming visit, and the new-home estimate would
// drop it, so the office prices the move.
async function hasComingAddon(rootId, today) {
  const row = await db('scheduled_service_addons as a')
    .join('scheduled_services as s', 's.id', 'a.scheduled_service_id')
    .where((q) => q.where('s.id', rootId).orWhere('s.recurring_parent_id', rootId))
    .where('s.scheduled_date', '>=', today)
    .first('a.id');
  return !!row;
}

// The plan the move takes along, as the facts the price needs (its visit
// schedule and current visit price) and its catalog name for the customer's
// text (an older label read with its schedule, config/service-name-aliases.js),
// or a refusal code.
async function planFacts(move, today) {
  const plan = await movingPestPlan(move);
  if (!plan) return { code: 'not_pest_only' };
  if (await hasComingAddon(plan.id, today)) return { code: 'addon' };
  const cadence = PEST_CADENCES[String(plan.recurring_pattern || '').trim().toLowerCase()];
  if (!cadence) return { code: 'cadence' };
  const currentPrice = Number(plan.estimated_price);
  if (!(currentPrice > 0)) return { code: 'no_price' };
  const { legacyCatalogName } = require('../config/service-name-aliases');
  const planName = legacyCatalogName(plan.service_type, plan.recurring_pattern) || String(plan.service_type).trim();
  return { cadence, currentPrice, planName };
}

// The free checks, in order: a refusal code, or the facts the pricing needs.
async function freeChecks(move, today = require('../utils/datetime-et').etDateString()) {
  const Moves = require('./customer-moves');
  // Once the move job stopped (or started stopping) the old-house plans, the
  // plan to copy is no longer live: the office prices the move.
  if (move.pause_state || move.paused_at) return { code: 'stopped' };
  const customer = await db('customers').where({ id: move.customer_id }).first('contact_role');
  if (String((customer && customer.contact_role) || '').trim().toLowerCase() === 'tenant') return { code: 'tenant' };
  let source;
  try {
    source = await Moves.moveEstimateSource(move.customer_id, move.id);
  } catch (err) {
    if (!(err instanceof Moves.MoveError)) throw err;
    // Someone made an estimate meanwhile: nothing for the app to do.
    if (err.code === 'estimate_exists') return { code: 'exists' };
    return { code: 'refused', note: err.message };
  }
  if (source.leftOut.length) return { code: 'left_out' };
  if (!source.source || !source.source.inputs) return { code: 'no_source' };
  const inputs = source.source.inputs;
  if (hadDiscount(inputs)) return { code: 'discount' };
  const kept = KEPT_SERVICE_FLAGS.filter((flag) => inputs[flag] === true);
  if (kept.length !== 1 || kept[0] !== 'svcPest') return { code: 'not_pest_only' };
  const plan = await planFacts(move, today);
  if (plan.code) return plan;
  const { cadence, currentPrice, planName } = plan;
  const pest = pestServiceFor(cadence);
  if (!pest) return { code: 'engine' };
  const { _private: { wholeHomeAddress } } = require('./lead-draft-measurements');
  if (!wholeHomeAddress(source.move.address)) return { code: 'unit' };
  return { source, cadence, currentPrice, planName, pest };
}

// The estimate save's own body for this move: the customer, the new address,
// the move (its stamp and $99 waiver come from the save), and the engine input.
// `digest` is the dry run's engine result, recorded on the final save.
function estimateBody(move, facts, engineInputs, measured, digest = null) {
  const { source, cadence, currentPrice } = facts;
  // The estimator form's own keys (EstimateToolViewV2 buildDefaultEstimateForm),
  // so a reopened draft shows the facts it was priced on.
  const stories = Number(engineInputs.stories) > 0 ? String(engineInputs.stories) : '1';
  return {
    customerId: move.customer_id,
    address: source.move.address,
    customerName: source.customer.name,
    customerPhone: source.customer.phone,
    customerEmail: source.customer.email,
    moveId: move.id,
    showOneTimeOption: false,
    billByInvoice: false,
    estimateData: {
      engineInputs,
      // What the estimator reopens with if the office edits it.
      inputs: {
        customerId: move.customer_id,
        address: source.move.address,
        propertyType: 'Single Family',
        homeSqFt: String(measured.homeSqFt),
        lotSqFt: String(measured.lotSqFt),
        stories,
        svcPest: true,
        pestFreq: String(cadence.visits),
      },
      automation: {
        moveAutoEstimate: {
          moveId: move.id,
          sourceEstimateId: source.source.estimateId,
          cadence: cadence.frequency,
          currentVisitPrice: currentPrice,
          homeSqFt: measured.homeSqFt,
          lotSqFt: measured.lotSqFt,
          measurementSource: measured.source,
          planName: facts.planName,
          // The auto-send (services/moving-auto-send.js) sends the draft only
          // while it still holds this price.
          ...(digest ? { engineResultDigest: digest } : {}),
        },
      },
    },
  };
}

// The engine input for the new home, or null when the county record does not
// confirm it. The one paid call: the property lookup of the new address
// (cached 180 days). The call drafter's own mapping from the arbitrated facts
// (the county home and lot countyMeasurements checks, the record's stories)
// to the engine input: a fact the record lacks prices on a default the engine
// flags for review, and a flagged line goes to the office.
async function newHomeEngineInput(facts) {
  const { performPropertyLookup } = require('../routes/property-lookup-v2');
  const { lookupOptionsFor } = require('./property-lookup/lookup-callers');
  const lookup = await performPropertyLookup(facts.source.move.address, lookupOptionsFor('moving_auto_estimate', { prioritizeAccuracy: true }));
  const { _private: { countyMeasurements } } = require('./lead-draft-measurements');
  const measured = countyMeasurements(lookup);
  if (!measured) return null;
  const { buildEngineInput } = require('./estimator-engine/draft-builder');
  const { resolvePropertyFacts } = require('./estimator-engine/source-arbitration');
  const propertyFacts = resolvePropertyFacts({ extraction: null, propertyRecord: lookup.propertyRecord, customer: null, isCommercial: false });
  const engineInputs = buildEngineInput({
    intent: { services: { pest: facts.pest }, is_commercial: false, category: 'RESIDENTIAL' },
    propertyFacts: { ...propertyFacts, propertyType: propertyFacts.propertyType || 'single_family' },
    context: {},
    lookupEnriched: lookup && lookup.enriched,
  });
  return { engineInputs, measured };
}

// The estimate save. A refusal (the move or its address changed, a second
// estimate) comes back as { refused } for the office; a server error throws.
function saveEstimate(opts) {
  return require('./admin-estimate-persistence').createOrReuseAdminEstimate({
    database: db, requireLivePricing: true, moveAllowed: true, technicianId: null, technician: null, ...opts,
  }).catch((err) => {
    const status = Number(err.statusCode || err.status) || 500;
    if (status >= 500) throw err;
    return { refused: err };
  });
}

// The dry run's verdict: { tier, digest, visitPrice } when the engine priced
// the new home cleanly (server price, one pest line, nothing to review), else
// null.
function cleanPrice(prepared, facts) {
  const { lineRequiresReview, lineHasHeuristicTurf } = require('./estimator-engine/draft-builder');
  const data = parseJson(prepared.estimate.estimate_data) || {};
  const lines = (data.engineResult && data.engineResult.lineItems) || [];
  const tier = data.result && data.result.recurring && data.result.recurring.tier;
  const annual = Number(prepared.estimate.annual_total);
  const flagged = (line) => lineRequiresReview(line) || line.requiresQuote || lineHasHeuristicTurf(line)
    || String(line.pricingConfidence || '').toUpperCase() === 'LOW';
  if (prepared.estimate.pricing_authority !== 'SERVER' || lines.length !== 1 || !TIERS.includes(tier) || !(annual > 0) || lines.some(flagged)) return null;
  const { perApplicationChargeAmount } = require('./billing-cadence');
  const visitPrice = Number(perApplicationChargeAmount({ annualRate: annual, visitsPerYear: facts.cadence.visits }));
  if (!(visitPrice > 0)) return null;
  const { agentEngineResultDigest } = require('./agent-estimate-preview');
  return { tier, digest: agentEngineResultDigest(data.engineResult), visitPrice };
}

// The office note when the new visit price is outside the band, or null.
function bandNote(visitPrice, currentPrice) {
  if (visitPrice >= currentPrice * LOW_BAND && visitPrice <= currentPrice * HIGH_BAND) return null;
  const low = visitPrice < currentPrice;
  const money = (n) => `$${n.toFixed(2)}`;
  return `The new visit price (${money(visitPrice)}) is more than ${low ? '10% below' : '25% above'} the current one (${money(currentPrice)}). Check the new home's facts, then price it.`;
}

/**
 * The one automatic attempt for one move. Returns 'drafted', 'office' or
 * 'skipped'. A failure after the claim leaves the move to the stale-claim
 * pass, which hands it to the office: the paid lookup never runs twice.
 */
async function autoEstimateMove(moveId, { now }) {
  const move = await claimMove(moveId, now);
  if (!move) return 'skipped';
  const facts = await freeChecks(move, require('../utils/datetime-et').etDateString(now));
  if (facts.code === 'exists') {
    // Bound to this attempt's claim: a resubmit that cleared it (another
    // address) leaves the move for the new address's own attempt.
    await db('customer_moves').where({ id: move.id, auto_estimate_at: move.auto_estimate_at }).whereNull('auto_estimate_state')
      .update({ auto_estimate_state: 'office', auto_estimate_note: 'The office made the estimate.', updated_at: now });
    return 'skipped';
  }
  if (facts.code) return leaveToOffice(move, facts.code, { now, note: facts.note || null });
  const home = await newHomeEngineInput(facts);
  if (!home) return leaveToOffice(move, 'no_size', { now });
  const body = estimateBody(move, facts, home.engineInputs, home.measured);
  const prepared = await saveEstimate({ body, dryRun: true });
  if (prepared.refused) return leaveToOffice(move, 'refused', { now, note: prepared.refused.message });
  const price = cleanPrice(prepared, facts);
  if (!price) return leaveToOffice(move, 'engine', { now });
  const outside = bandNote(price.visitPrice, facts.currentPrice);
  if (outside) return leaveToOffice(move, price.visitPrice < facts.currentPrice ? 'band_low' : 'band_high', { now, note: outside });
  const saved = await saveEstimate({
    body: { ...estimateBody(move, facts, home.engineInputs, home.measured, price.digest), waveguardTier: price.tier, clientDraftId: crypto.randomUUID() },
    expectedEngineResultDigest: price.digest,
  });
  if (saved.refused) return leaveToOffice(move, 'refused', { now, note: saved.refused.message });
  const outcome = await finishDraft(move, facts, saved.estimate && saved.estimate.id, now);
  if (outcome === 'drafted') logger.info(`[moving-auto-estimate] drafted the new-home estimate for move ${move.id}`);
  return outcome;
}

// Marks the attempt drafted under the move's row lock, only while the move
// still shows this attempt's claim, this estimate and the address it priced.
// A customer who sent another address after the save committed has a draft
// for the old one (the resubmit already took it off their surfaces): the
// claim is cleared so the new address gets its own attempt.
async function finishDraft(move, facts, estimateId, now) {
  const Moves = require('./customer-moves');
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    const ours = locked && !locked.auto_estimate_state && locked.auto_estimate_at
      && new Date(locked.auto_estimate_at).getTime() === new Date(move.auto_estimate_at).getTime();
    if (!ours) return 'skipped';
    if (estimateId && String(locked.estimate_id || '') === String(estimateId) && Moves.addressMatchesMove(facts.source.move.address, locked)) {
      await trx('customer_moves').where({ id: move.id }).update({ auto_estimate_state: 'drafted', updated_at: now });
      return 'drafted';
    }
    await trx('customer_moves').where({ id: move.id }).update({ auto_estimate_at: null, updated_at: now });
    return 'skipped';
  });
}

/** The app-made new-home estimate job (scheduler, every 15 minutes). Off with GATE_MOVING_AUTO_ESTIMATE. */
async function runMoveAutoEstimateJob({ now = new Date() } = {}) {
  if (!movingAutoEstimateLive()) return { skipped: true };
  const out = { drafted: 0, office: 0, skipped: 0, failed: 0 };
  // A claimed attempt that never finished goes to the office, with no second lookup.
  const stale = await db('customer_moves')
    .where({ status: 'submitted' })
    .whereNull('auto_estimate_state')
    .where('auto_estimate_at', '<', new Date(now.getTime() - STALE_CLAIM_MS))
    .orderBy('id').limit(CANDIDATE_LIMIT).select('*');
  for (const move of stale) {
    try {
      if ((await leaveToOffice(move, 'stale', { now })) === 'office') out.office += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`[moving-auto-estimate] stale hand-off failed for move ${move.id} (${errCode(err)})`);
    }
  }
  // A move with an estimate id is a candidate too: claimMove skips a live
  // estimate, and one for a replaced address no longer counts.
  const candidates = await db('customer_moves')
    .where({ status: 'submitted', address_verdict: 'in_area' })
    .whereNotNull('normalized_address')
    .whereNull('auto_estimate_at')
    .whereNull('auto_estimate_state')
    .orderBy('submitted_at', 'asc').limit(CANDIDATE_LIMIT).pluck('id');
  for (const id of candidates) {
    try {
      const outcome = await autoEstimateMove(id, { now });
      if (outcome in out) out[outcome] += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`[moving-auto-estimate] move ${id} failed (${errCode(err)}); the stale-claim pass hands it to the office`);
    }
  }
  return out;
}

module.exports = { runMoveAutoEstimateJob, _private: { hadDiscount, pestServiceFor, movingPestPlan, freeChecks, NOTES } };
