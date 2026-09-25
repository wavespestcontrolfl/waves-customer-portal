/**
 * Photo-triage opportunity gauge (owner ruling 2026-09-25).
 *
 * Photo-text auto-triage (photo-text-triage.js) used to close every
 * actionable finding with "Want us to come take a closer look and quote
 * treatment?" — pushing every lead toward an on-site visit. The owner wants
 * on-site visits minimized: gauge the upsell from what the photo/caption
 * actually show, offer a compute-only quote when the numbers support one,
 * and reserve an in-person ask for the cases that genuinely need eyes on
 * them (new lead, large/whole-property scope, or a prior treatment that
 * already failed).
 *
 * gaugeOpportunity({ type, analysis, customer, body, images }) is the one
 * export the triage draft-builder calls. It is pure except for the property-
 * facts read (customers.lot_sqft / property_sqft / bed_sqft — skipped
 * entirely when the caller's `customer` already carries those columns, as
 * the inbound-SMS lookup in twilio-webhook.js does) and, only on the quote
 * path, a read of the customer's own accepted estimates to avoid re-pitching
 * a service they already bought (see customerHasActiveService below — there
 * is no cheaper canonical "is this customer already on service X" helper
 * near this lane).
 *
 * Reference cases (owner, 2026-09-25):
 *   - Gretchen Dimartini: new lead, hibiscus hedges on BOTH sides of the
 *     house, she and her lawn company already tried treating it and failed
 *     → onsite (lead + large scope + prior treatment failed).
 *   - Shelley Chismer: existing lawn customer, one young tree with
 *     water/establishment stress → advice + a quote for the standard T&S
 *     program, no visit.
 *
 * teaserOutcome (lawn/pest customer-safe label) lives HERE, not in
 * photo-text-triage.js, so both modules can use it without a require cycle
 * (photo-text-triage.js calls gaugeOpportunity; gaugeOpportunity must not
 * call back into photo-text-triage.js).
 */

const db = require('../models/db');
const logger = require('./logger');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { buildPestTeaser, PEST_LIBRARY } = require('./pest-identification');
const { priceTreeShrub, priceLawnCare, pricePestControl } = require('./pricing-engine/service-pricing');

const LIBRARY_BY_SLUG = new Map(PEST_LIBRARY.map((entry) => [entry.slug, entry]));
const HEALTHY_LAWN_LABEL = 'no major visible stress';

// What the draft may say, from the pre-capture teaser allowlists only —
// lawn: buildTeaser's gated first finding (routes/public-lawn-assessment.js);
// pest: buildPestTeaser's library-generic label (services/pest-
// identification.js). Never raw model observations, never product names.
//   { kind: 'actionable', label } — a finding worth mentioning;
//   { kind: 'harmless', label }   — a clean lawn, or a not-a-pest ID;
//   { kind: 'none' }              — nothing we can name.
function teaserOutcome(type, analysis) {
  if (type === 'lawn') {
    // Lazy require: public-lawn-assessment.js is a router module (heavier,
    // and exports the router itself as module.exports) — pulled in only
    // when a lawn assessment is actually being scored.
    const { buildTeaser } = require('../routes/public-lawn-assessment');
    const teaser = buildTeaser(analysis);
    const label = teaser.first_finding?.name || null;
    if (label === HEALTHY_LAWN_LABEL || (!label && teaser.overall_status === 'Healthy')) {
      return { kind: 'harmless', label: 'a healthy lawn' };
    }
    return label ? { kind: 'actionable', label } : { kind: 'none' };
  }
  const contract = JSON.parse(analysis.report_contract || '{}');
  const teaser = buildPestTeaser(contract);
  const match = /^We identified (.+)\.$/.exec(teaser.identified_teaser || '');
  if (!match) return { kind: 'none' };
  const item = LIBRARY_BY_SLUG.get(contract.identification?.slug);
  const harmless = teaser.category === 'not_a_pest' || item?.category === 'not_a_pest';
  return { kind: harmless ? 'harmless' : 'actionable', label: match[1] };
}

// ── Caption metrics ─────────────────────────────────────────────────────

// "both sides", "all my hedges", "entire yard", "every shrub", "border(s)",
// "around the house/property" — the customer describing a whole-property (or
// whole-side-of-property) scope rather than one spot.
const LARGE_SCOPE_RE = /\b(both sides|all my|all of my|entire|whole|every|hedges?|borders?|around the (house|property))\b/i;

// "tried", "treated", "didn't/did not work", "won't go away", "can't get rid",
// "keeps coming back", "still there" — the customer (or their lawn company)
// already attempted treatment and it did not hold.
const PRIOR_TREATMENT_RE = /\b(tried|treated|didn.?t work|did not work|won.?t go away|can.?t get rid|keeps coming back|still there)\b/i;
// "our lawn guy/company ... couldn't [fix it]" — a wider gap between the
// subject and the verdict than PRIOR_TREATMENT_RE's tight phrases allow.
const LAWN_COMPANY_FAILED_RE = /\blawn (guy|company)\b[^.!?]{0,40}\b(couldn.?t|could not|didn.?t work|did not work|failed)\b/i;

function largeScope(body) {
  return LARGE_SCOPE_RE.test(body);
}

function priorTreatmentFailed(body) {
  return PRIOR_TREATMENT_RE.test(body) || LAWN_COMPANY_FAILED_RE.test(body);
}

// ── Photo-analysis outcome, per type ────────────────────────────────────

// Human-readable phrase for a tree/shrub worst_signal, sized for "it's
// {label}." — the five-category admin LABELS ("Water, Heat & Pruning
// Stress") read fine on a chart but not inline in a sentence.
const TREE_SHRUB_SIGNAL_PHRASE = {
  water_heat_mechanical_stress: 'water or heat stress',
  pest_activity: 'pest-pressure signals',
  disease_leaf_spot: 'leaf-spot signals',
  foliage_fullness: 'thin foliage',
  leaf_color_vigor: 'uneven leaf color',
};

// tree_shrub has no customer-safe teaser builder (no customer report page
// exists yet — photo-assessment-create.js#TYPES.tree_shrub.customerPreview
// is null); the admin assessment's own worst_signal + overall_score already
// carry everything the draft or the gauge needs.
function treeShrubOutcome(analysis) {
  const worstSignal = analysis?.worst_signal || null;
  const scoreRaw = Number(analysis?.overall_score);
  const score = Number.isFinite(scoreRaw) ? scoreRaw : null;
  const label = worstSignal ? (TREE_SHRUB_SIGNAL_PHRASE[worstSignal] || 'a few things worth a look') : HEALTHY_LAWN_LABEL;
  if (!worstSignal) return { kind: 'harmless', label, cultural: false, uncertain: false };
  if (worstSignal === 'water_heat_mechanical_stress') {
    return { kind: 'cultural', label, cultural: true, uncertain: false };
  }
  const attentionLevel = score !== null && score <= 50;
  const actionable = attentionLevel || worstSignal === 'pest_activity' || worstSignal === 'disease_leaf_spot';
  return {
    kind: actionable ? 'actionable' : 'watch',
    label,
    cultural: false,
    // disease_leaf_spot is actionable AND flagged uncertain (report-copy
    // guardrail: a leaf-spot pattern is a signal, never a confirmed
    // diagnosis — see tree-shrub-visual-categories.js).
    uncertain: worstSignal === 'disease_leaf_spot',
  };
}

// Normalizes every type's photo-analysis result into the four booleans the
// gauge rules read. lawn/pest reuse teaserOutcome (the same allowlisted
// label the draft copy uses); tree_shrub has its own outcome above.
function outcomeFor(type, analysis) {
  if (type === 'tree_shrub') return treeShrubOutcome(analysis);
  const teaser = teaserOutcome(type, analysis);
  return {
    kind: teaser.kind,
    label: teaser.label || null,
    cultural: false,
    // pest 'none' = we could not confidently identify anything — the
    // customer-facing equivalent of tree_shrub's disease_leaf_spot doubt.
    uncertain: type === 'pest' && teaser.kind === 'none',
  };
}

// ── Property facts + compute-only pricing ───────────────────────────────

function positiveNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// customers.property_sqft/lot_sqft/bed_sqft are the same primary-property
// columns the estimator context-builder reads (server/services/estimator-
// engine/context-builder.js). There is no home/building-footprint column on
// `customers` today, so `homeSqFt` is always null here — pest pricing (which
// needs it) is unavailable through this path until one exists; that is a
// schema gap, not a bug in this gauge.
async function loadPropertyFacts(customer) {
  if (!customer) return null;
  const hasColumns = ['lot_sqft', 'property_sqft', 'bed_sqft']
    .some((key) => Object.prototype.hasOwnProperty.call(customer, key));
  let row = customer;
  if (!hasColumns) {
    if (!customer.id) return null;
    try {
      row = await db('customers').where({ id: customer.id }).first('lot_sqft', 'property_sqft', 'bed_sqft');
    } catch (err) {
      logger.error(`[photo-triage-opportunity] property-facts read failed for customer ${customer.id}: ${err.message}`);
      return null;
    }
  }
  if (!row) return null;
  const lotSqFt = positiveNum(row.lot_sqft);
  const turfSf = positiveNum(row.property_sqft);
  const bedArea = positiveNum(row.bed_sqft);
  const homeSqFt = positiveNum(row.home_sqft); // no such column yet — see doc above
  if (!lotSqFt && !turfSf && !bedArea && !homeSqFt) return null;
  return { lotSqFt, turfSf, bedArea, homeSqFt };
}

const SERVICE_KEY = { tree_shrub: 'tree_shrub', lawn: 'lawn_care', pest: 'pest_control' };

// Best available "does this customer already have this service" signal.
// There is no cheap canonical helper for it near this lane — the closest,
// irrigation-weekly-email.js's lawn-cadence check, walks scheduled_services
// visit history and is scoped to lawn only. The cheapest TRUE signal already
// on hand is an ACCEPTED estimate whose priced line items name this service
// (estimates.estimate_data.lineItems[].service) — it can undercount a plan
// sold outside the estimator (phone/manual), never overcount, and this lane
// only ever drafts for owner review, so an occasional redundant offer is a
// minor annoyance, never a customer-facing mistake.
async function customerHasActiveService(customerId, serviceKey) {
  if (!customerId) return false;
  try {
    const rows = await db('estimates')
      .where({ customer_id: customerId, status: 'accepted' })
      .select('estimate_data');
    return rows.some((row) => {
      const lineItems = Array.isArray(row.estimate_data?.lineItems) ? row.estimate_data.lineItems : [];
      return lineItems.some((item) => item?.service === serviceKey);
    });
  } catch (err) {
    logger.error(`[photo-triage-opportunity] active-service check failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

// Compute-only pricing for one service — NEVER inserts an estimates row,
// NEVER sends anything. Returns { quote } on success or { reason } naming
// why not ('no_property_facts' | 'already_active').
async function priceForCustomer(type, customer, facts) {
  const serviceKey = SERVICE_KEY[type];
  if (!serviceKey) return { reason: 'no_property_facts' };

  if (type === 'tree_shrub') {
    if (!facts.lotSqFt && !facts.bedArea) return { reason: 'no_property_facts' };
    let result;
    try {
      result = priceTreeShrub({ lotSqFt: facts.lotSqFt, bedArea: facts.bedArea }, { tier: 'standard' });
    } catch (err) {
      logger.error(`[photo-triage-opportunity] tree_shrub pricing failed: ${err.message}`);
      return { reason: 'no_property_facts' };
    }
    // No real lot/bed measurement at all — priceTreeShrub's own fallback
    // (a bare 2,000 sqft guess) is exactly what "no facts" means here.
    if (result.bedAreaSource === 'fallback') return { reason: 'no_property_facts' };
    if (await customerHasActiveService(customer?.id, serviceKey)) return { reason: 'already_active' };
    return { quote: { service: serviceKey, tier: result.tier, monthly: result.monthly, annual: result.annual, frequency: result.frequency } };
  }

  if (type === 'lawn') {
    if (!facts.turfSf) return { reason: 'no_property_facts' };
    if (await customerHasActiveService(customer?.id, serviceKey)) return { reason: 'already_active' };
    let result;
    try {
      // No explicit tier: priceLawnCare's own default (currently 'enhanced',
      // 9x/yr — the 6x 'standard' tier is retired-hidden, owner directive
      // 2026-09-24) is "the standard lawn program the engine prices today".
      result = priceLawnCare({ turfSf: facts.turfSf, ...(customer?.lawn_type ? { track: customer.lawn_type } : {}) }, {});
    } catch (err) {
      logger.error(`[photo-triage-opportunity] lawn pricing failed: ${err.message}`);
      return { reason: 'no_property_facts' };
    }
    return { quote: { service: serviceKey, tier: result.tier, monthly: result.monthly, annual: result.annual, frequency: result.frequency } };
  }

  // pest: needs homeSqFt, which loadPropertyFacts can never supply today
  // (see its doc comment) — kept real so a future homeSqFt source lights
  // this path up without another change here.
  if (!facts.homeSqFt) return { reason: 'no_property_facts' };
  if (await customerHasActiveService(customer?.id, serviceKey)) return { reason: 'already_active' };
  let result;
  try {
    result = pricePestControl({ homeSqFt: facts.homeSqFt, lotSqFt: facts.lotSqFt }, {});
  } catch (err) {
    logger.error(`[photo-triage-opportunity] pest pricing failed: ${err.message}`);
    return { reason: 'no_property_facts' };
  }
  return { quote: { service: serviceKey, tier: result.frequency, monthly: result.monthly, annual: result.annual, frequency: result.visitsPerYear } };
}

// onsite when a new/non-customer lead's actionable finding comes with either
// scope signal, OR when BOTH scope signals fire regardless of lead status
// (owner ruling 2026-09-25 — Gretchen Dimartini: new lead, both sides of the
// house, already tried and failed).
function needsOnsite({ lead, actionable, scopeIsLarge, treatmentFailed }) {
  return (lead && actionable && (scopeIsLarge || treatmentFailed)) || (treatmentFailed && scopeIsLarge);
}

// ── The gauge ────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ mode: 'advise'|'quote'|'onsite', reasons: string[], quote: null | { service, tier, monthly, annual, frequency } }>}
 */
async function gaugeOpportunity({ type, analysis, customer, body, /* images reserved for a future visual-scope signal */ images: _images }) {
  const reasons = [];
  const text = typeof body === 'string' ? body : '';

  const lead = !customer || !CUSTOMER_STAGES.includes(customer.pipeline_stage);
  if (lead) reasons.push('lead');
  const scopeIsLarge = largeScope(text);
  if (scopeIsLarge) reasons.push('large_scope');
  const treatmentFailed = priorTreatmentFailed(text);
  if (treatmentFailed) reasons.push('prior_treatment_failed');

  const outcome = outcomeFor(type, analysis);
  const actionable = outcome.kind === 'actionable';
  const harmless = outcome.kind === 'harmless';
  if (actionable) reasons.push('actionable');
  if (harmless) reasons.push('harmless');
  if (outcome.cultural) reasons.push('cultural');
  if (outcome.uncertain) reasons.push('uncertain');

  // Harmless always advises — never onsite, never a pitch, regardless of
  // what the caption says.
  if (harmless) return { mode: 'advise', reasons, quote: null };

  if (needsOnsite({ lead, actionable, scopeIsLarge, treatmentFailed })) {
    reasons.push('onsite_scope');
    return { mode: 'onsite', reasons, quote: null };
  }

  if (actionable || outcome.cultural) {
    const facts = await loadPropertyFacts(customer);
    if (facts) {
      const priced = await priceForCustomer(type, customer, facts);
      if (priced.quote) {
        reasons.push('quoted');
        return { mode: 'quote', reasons, quote: priced.quote };
      }
      reasons.push(priced.reason || 'no_property_facts');
    } else {
      reasons.push('no_property_facts');
    }
  }

  return { mode: 'advise', reasons, quote: null };
}

module.exports = {
  gaugeOpportunity,
  teaserOutcome,
  _test: {
    outcomeFor,
    largeScope,
    priorTreatmentFailed,
    loadPropertyFacts,
    customerHasActiveService,
    priceForCustomer,
  },
};
