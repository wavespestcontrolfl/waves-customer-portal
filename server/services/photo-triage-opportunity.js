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
 * Reference cases (owner ruling, 2026-09-25 — anonymized shapes, never real
 * customer names/records in code, tests, or commits):
 *   - New lead, hedges on BOTH sides of the house, caller and their lawn
 *     company already tried treating it and it failed
 *     → onsite (lead + large scope + prior treatment failed).
 *   - Existing lawn customer, one young tree with water/establishment
 *     stress → advice + a quote for the standard T&S program, no visit.
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
// generateEstimate (not priceTreeShrub/priceLawnCare directly): it runs the
// pricer through calculatePropertyProfile, which is what actually resolves
// bedArea/turfSf/track into the shape the pricer expects (a raw
// { lotSqFt, bedArea } object bypasses the profile and its review-worthy-
// default detection — codex review on this lane, 2026-09-25).
const { generateEstimate } = require('./pricing-engine/estimate-engine');
// The SAME review gate the admin/agent estimator draft path enforces before
// ever showing a customer a price (a zero-tree/zero-count line prices only
// fixed costs — an invisible underquote without this check).
const { lineRequiresReview } = require('./estimator-engine/draft-builder');
const { recurringServicesFromEstimateData, recurringServiceKey } = require('./estimate-converter');

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

// "both sides", "all my"/"all of my", "entire", "whole", "every",
// "around the house/property", "front and back" — the customer describing a
// whole-property (or whole-side-of-property) scope rather than one spot.
// "hedge(s)"/"border(s)" alone are NOT scope words (a single hedge or one
// border bed is one spot, same as "one shrub") — codex review 2026-09-25.
const LARGE_SCOPE_RE = /\b(both sides|all my|all of my|entire|whole|every|around the (house|property)|front and back)\b/i;

// Failure/recurrence language: the customer (or their lawn company) already
// attempted treatment AND it did not hold. "tried"/"treated" ALONE are not
// enough — a bare "we tried a home remedy" doesn't say it failed (codex
// review 2026-09-25); only these outcome phrases count.
const PRIOR_TREATMENT_RE = /\b(didn.?t work|did not work|won.?t go away|can.?t get rid|keeps coming back|still there|couldn.?t)\b/i;
// "our lawn guy/company ... failed [to fix it]" — a wider gap between the
// subject and the verdict, and the one failure word (failed) the plain list
// above doesn't already cover on its own.
const LAWN_COMPANY_FAILED_RE = /\blawn (guy|company)\b[^.!?]{0,40}\bfailed\b/i;

function largeScope(body) {
  return LARGE_SCOPE_RE.test(body);
}

function priorTreatmentFailed(body) {
  return PRIOR_TREATMENT_RE.test(body) || LAWN_COMPANY_FAILED_RE.test(body);
}

// ── Photo-analysis outcome, per type ────────────────────────────────────

// Human-readable phrase for a tree/shrub worst_signal, sized for "it's
// {label}." — the five-category admin LABELS ("Water, Heat & Pruning
// Stress") read fine on a chart but not inline in a sentence. Single source
// for this mapping — photo-text-triage.js reads the resolved label through
// outcomeFor()/gaugeOpportunity() rather than keeping its own copy.
const TREE_SHRUB_SIGNAL_PHRASE = {
  water_heat_mechanical_stress: 'water or heat stress',
  pest_activity: 'pest-pressure signals',
  disease_leaf_spot: 'leaf-spot signals',
  foliage_fullness: 'thin foliage',
  leaf_color_vigor: 'uneven leaf color',
};
// Customer-facing copy for "nothing flagged" — distinct from
// HEALTHY_LAWN_LABEL above, which is an internal sentinel string the lawn
// diagnostic module emits as a finding NAME, never customer copy itself.
const TREE_SHRUB_HEALTHY_LABEL = 'a healthy tree or shrub';

// tree_shrub has no customer-safe teaser builder (no customer report page
// exists yet — photo-assessment-create.js#TYPES.tree_shrub.customerPreview
// is null); the admin assessment's own worst_signal + overall_score already
// carry everything the draft or the gauge needs.
function treeShrubOutcome(analysis) {
  const worstSignal = analysis?.worst_signal || null;
  const scoreRaw = Number(analysis?.overall_score);
  const score = Number.isFinite(scoreRaw) ? scoreRaw : null;
  const label = worstSignal ? (TREE_SHRUB_SIGNAL_PHRASE[worstSignal] || 'a few things worth a look') : TREE_SHRUB_HEALTHY_LABEL;
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
// `customers` today, so pest pricing (which needs one) has no property-facts
// path at all — see priceForCustomer's pest guard below.
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
  if (!lotSqFt && !turfSf && !bedArea) return null;
  return { lotSqFt, turfSf, bedArea };
}

// tree_shrub/lawn only — pest has no property-facts path (see loadPropertyFacts).
const SERVICE_KEY = { tree_shrub: 'tree_shrub', lawn: 'lawn_care' };

// Best available "does this customer already have this service" signal.
// There is no cheap canonical helper for it near this lane — the closest,
// irrigation-weekly-email.js's lawn-cadence check, walks scheduled_services
// visit history and is scoped to lawn only. Reuses the SAME accepted-
// estimate line-item extractor the estimate converter/admin persistence use
// (recurringServicesFromEstimateData — reads recurring.services plus the
// engineResult/result lineItems containers a persisted estimate_data blob
// actually uses; a bare root lineItems array is NOT a persisted shape) +
// recurringServiceKey to normalize the raw service field against our
// canonical key. Can undercount a plan sold outside the
// estimator (phone/manual), never overcount — and this lane only ever
// drafts for owner review, so an occasional redundant offer is a minor
// annoyance, never a customer-facing mistake.
async function customerHasActiveService(customerId, serviceKey) {
  if (!customerId) return false;
  try {
    const rows = await db('estimates')
      .where({ customer_id: customerId, status: 'accepted' })
      .select('estimate_data');
    return rows.some((row) => recurringServicesFromEstimateData(row.estimate_data)
      .some((svc) => recurringServiceKey(svc) === serviceKey));
  } catch (err) {
    logger.error(`[photo-triage-opportunity] active-service check failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

// AGENTS.md P1 "per application price copy": customer-facing estimate copy
// must never state a combined plan total ($X/mo, $X/yr) — only a per-visit
// amount. The pricing engine already computes the per-visit figure
// (priceTreeShrub: internalPerVisitRevenue/perApp; priceLawnCare: perApp) —
// prefer that over deriving one, and fall back to annual/frequency only if a
// pricer result is ever missing both.
function perVisitFrom(result, frequency) {
  const preferred = Number(result.internalPerVisitRevenue ?? result.perApp);
  if (Number.isFinite(preferred) && preferred > 0) return Math.round(preferred);
  const freq = Number(frequency) || 1;
  return Math.round((Number(result.annual) || 0) / freq);
}

// Compute-only pricing for one service — NEVER inserts an estimates row,
// NEVER sends anything. Routes through generateEstimate (not priceTreeShrub/
// priceLawnCare directly) so the SAME property-profile resolution AND the
// SAME review gate (lineRequiresReview) a real drafted estimate goes through
// also gates this quote — a zero-tree/zero-count line that would silently
// underquote a real customer must not silently quote here either. Returns
// { quote } on success or { reason } naming why not ('no_property_facts' |
// 'quote_needs_review' | 'already_active'). quote.monthly/.annual are
// admin-audit context only (flags.quote, context_summary) — the customer-
// facing draft copy (photo-text-triage.js) uses quote.per_visit only, never
// a combined total.
async function priceForCustomer(type, customer, facts) {
  const serviceKey = SERVICE_KEY[type];
  // pest: no home-square-footage source exists anywhere in the schema
  // (customers/customer_properties carry treated-lawn/lot/bed area only) —
  // there is no property-facts path to reach this branch at all.
  if (!serviceKey) return { reason: 'no_property_facts' };

  if (type === 'tree_shrub') {
    if (!facts.lotSqFt && !facts.bedArea) return { reason: 'no_property_facts' };
    let line;
    try {
      const estimate = generateEstimate({
        lotSqFt: facts.lotSqFt,
        bedArea: facts.bedArea,
        services: { treeShrub: { tier: 'standard' } },
      });
      line = estimate.lineItems.find((item) => item.service === 'tree_shrub');
    } catch (err) {
      logger.error(`[photo-triage-opportunity] tree_shrub pricing failed: ${err.message}`);
      return { reason: 'no_property_facts' };
    }
    // No real lot/bed measurement at all — the pricer's own fallback (a bare
    // 2,000 sqft guess) is exactly what "no facts" means here.
    if (!line || line.bedAreaSource === 'fallback') return { reason: 'no_property_facts' };
    if (lineRequiresReview(line)) return { reason: 'quote_needs_review' };
    if (await customerHasActiveService(customer?.id, serviceKey)) return { reason: 'already_active' };
    return {
      quote: {
        service: serviceKey, tier: line.tier, monthly: line.monthly, annual: line.annual,
        frequency: line.frequency, per_visit: perVisitFrom(line, line.frequency),
      },
    };
  }

  // lawn
  if (!facts.turfSf) return { reason: 'no_property_facts' };
  if (await customerHasActiveService(customer?.id, serviceKey)) return { reason: 'already_active' };
  let line;
  try {
    // No explicit tier: priceLawnCare's own default (currently 'enhanced',
    // 9x/yr — the 6x 'standard' tier is retired-hidden, owner directive
    // 2026-09-24) is "the standard lawn program the engine prices today".
    // track rides in services.lawn (the pricer's OPTIONS arg) — a saved
    // lawn_type on the property object itself is never read.
    const estimate = generateEstimate({
      measuredTurfSf: facts.turfSf,
      services: { lawn: { track: customer?.lawn_type || undefined } },
    });
    line = estimate.lineItems.find((item) => item.service === 'lawn_care');
  } catch (err) {
    logger.error(`[photo-triage-opportunity] lawn pricing failed: ${err.message}`);
    return { reason: 'no_property_facts' };
  }
  if (!line) return { reason: 'no_property_facts' };
  if (lineRequiresReview(line)) return { reason: 'quote_needs_review' };
  return {
    quote: {
      service: serviceKey, tier: line.tier, monthly: line.monthly, annual: line.annual,
      frequency: line.frequency, per_visit: perVisitFrom(line, line.frequency),
    },
  };
}

// onsite when a new/non-customer lead's actionable finding comes with either
// scope signal, OR when BOTH scope signals fire regardless of lead status
// (owner ruling 2026-09-25 — reference shape: new lead, both sides of the
// house, already tried and failed).
function needsOnsite({ lead, actionable, scopeIsLarge, treatmentFailed }) {
  return (lead && actionable && (scopeIsLarge || treatmentFailed)) || (treatmentFailed && scopeIsLarge);
}

// ── The gauge ────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ mode: 'advise'|'quote'|'onsite', reasons: string[], quote: null | { service, tier, monthly, annual, frequency, per_visit } }>}
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
  // The resolved { kind, label, cultural, uncertain } for any type — the
  // single source photo-text-triage.js reads its draft-copy label from
  // (never a second lawn/pest/tree_shrub label map of its own).
  outcomeFor,
  _test: {
    outcomeFor,
    largeScope,
    priorTreatmentFailed,
    loadPropertyFacts,
    customerHasActiveService,
    priceForCustomer,
  },
};
