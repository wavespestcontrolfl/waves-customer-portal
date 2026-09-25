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
 * export the triage draft-builder calls. It is pure except for the quote
 * path, which asks the shared existing-customer offer core
 * (service-report/cross-sell.js#buildOfferForFamily) whether this family
 * may be offered to this customer and at what per-application price — the
 * same ownership authority, never-re-price rule, plan baseline and
 * demotions the report/portal cards use, so this lane can never quote what
 * those surfaces would refuse.
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
// The ONE existing-customer offer mechanism (service-report/cross-sell.js,
// shared by the report card, the portal-home card, and the one-tap
// purchase): ownership authority with fail-closed catalog joins, the
// never-re-price-an-owned-family rule, the member/WaveGuard baseline, and
// every seed/correction/baseline demotion — priced per application only.
// AGENTS.md "estimator engine authority": existing customers are blocked
// from raw engine drafting, so this lane never calls generateEstimate
// itself (codex #4810 r1 P1 ×2).
const { buildOfferForFamily } = require('./service-report/cross-sell');

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

// "both sides", "all my"/"all of my", "around the house/property", "front
// and back", or entire/whole/every modifying a property noun (yard, beds,
// hedges, shrubs, trees, plants, sides...) — the customer describing a
// whole-property (or whole-side-of-property) scope rather than one spot.
// "hedge(s)"/"border(s)" alone are NOT scope words (a single hedge or one
// border bed is one spot), and bare entire/whole/every are NOT either —
// "this one patch keeps coming back every year" is one spot (codex #4810
// r1). The quantifier has to land on a property subject.
const SCOPE_SUBJECT = '(?:yard|lawn|property|house|home|landscape|landscaping|bed|beds|hedge|hedges|hedgerow|shrub|shrubs|bush|bushes|tree|trees|palm|palms|plant|plants|border|borders|side|sides|perimeter|fence ?line)';
const LARGE_SCOPE_RE = new RegExp(`\\b(both sides|all (?:of )?my|around the (?:house|property)|front and back|(?:entire|whole|every) (?:\\w+ )?${SCOPE_SUBJECT})\\b`, 'i');

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

// ── Compute-only pricing ────────────────────────────────────────────────

// Offer family per assessment type. No pest entry: the only sanctioned
// existing-customer pricer is the offer machinery, and pest control is its
// anchor family — a pest-photo customer with no plan is a lead-shaped
// conversation ("Reply if you'd like a quote"), not an engine quote.
const SERVICE_KEY = { tree_shrub: 'tree_shrub', lawn: 'lawn_care' };

function applicationsPerYearFrom(option) {
  const m = /(\d+)/.exec(String(option?.cadence || ''));
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Compute-only pricing for one service — NEVER inserts an estimates row,
// NEVER sends anything. Existing customers go through buildOfferForFamily
// (the portal-offer core with the family fixed to what the photo shows):
// the customer's ownership, plan baseline and every demotion rule apply,
// and only a PRICED offer becomes a quote. Returns { quote } on success or
// { reason } naming why not:
//   'no_customer_record'  — a lead with no customer row has nothing to
//                           price against (and leads never get engine
//                           quotes anyway)
//   'no_offer'            — the offer core declined: family already owned,
//                           ownership unknown (fail closed), no recurring
//                           plan, unprovable premises, commercial, or a
//                           live plan rate on the family
//   'quote_needs_review'  — offer composed but demoted to the unpriced CTA
//                           (review-worthy facts, verified correction on
//                           file, baseline mismatch, ambiguous tree count)
// quote.per_visit is the per-application amount — the only price field
// the offer payload carries, and the only one the draft copy may state.
async function priceForCustomer(type, customer) {
  const serviceKey = SERVICE_KEY[type];
  if (!serviceKey) return { reason: 'no_offer' };
  if (!customer?.id) return { reason: 'no_customer_record' };
  const offer = await buildOfferForFamily(customer.id, db, serviceKey);
  if (!offer || offer.serviceKey !== serviceKey) return { reason: 'no_offer' };
  if (offer.mode !== 'priced' || !offer.option) return { reason: 'quote_needs_review' };
  const perApplication = Math.round(Number(offer.option.perVisit) || 0);
  if (!(perApplication > 0)) return { reason: 'quote_needs_review' };
  return {
    quote: {
      service: serviceKey,
      label: offer.option.label || null,
      option_id: offer.option.id || null,
      applications_per_year: applicationsPerYearFrom(offer.option),
      per_visit: perApplication,
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
 * @returns {Promise<{ mode: 'advise'|'quote'|'onsite', reasons: string[], quote: null | { service, label, option_id, applications_per_year, per_visit } }>}
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
    let priced;
    try {
      priced = await priceForCustomer(type, customer);
    } catch (err) {
      logger.error(`[photo-triage-opportunity] pricing failed for customer ${customer?.id || 'none'}: ${err.message}`);
      priced = { reason: 'no_offer' };
    }
    if (priced.quote) {
      reasons.push('quoted');
      return { mode: 'quote', reasons, quote: priced.quote };
    }
    reasons.push(priced.reason || 'no_offer');
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
    priceForCustomer,
  },
};
