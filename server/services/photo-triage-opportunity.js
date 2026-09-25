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
// "all my" binds to a property subject too — "I used all my spray on this
// one shrub" is one shrub (codex #4810 r2).
// "both sides" / "front and back" bind to a property-sized subject too —
// "both sides of this one leaf" is one leaf (codex #4810 r6).
const PROPERTY_SIZED = '(?:house|home|property|yard|lot|driveway|street|building|lawn)';
const LARGE_SCOPE_RE = new RegExp(`\\b(both sides of (?:the |my |our )?${PROPERTY_SIZED}|around the (?:house|property)|front and back (?:of (?:the |my |our )?${PROPERTY_SIZED}|yards?)|(?:all (?:of )?my|entire|whole|every) (?:\\w+ )?${SCOPE_SUBJECT})\\b`, 'i');

// Failure/recurrence language: the customer (or their lawn company) already
// attempted treatment AND it did not hold. "tried"/"treated" ALONE are not
// enough — a bare "we tried a home remedy" doesn't say it failed (codex
// review 2026-09-25); only these outcome phrases count.
// "couldn't"/"still there" need their object too — "couldn't get a better
// photo" and "the nest is still there" describe no treatment (pre-push audit).
// "didn't work" needs a treatment/remedy subject nearby — "my sprinkler
// didn't work and this shrub has spots" is an equipment failure, not a
// failed treatment (codex #4810 r3).
const TREATMENT_SUBJECT = '(?:spray\\w*|treat\\w*|product|remedy|application|pesticide|fungicide|insecticide|granules?|fertiliz\\w*|sevin|neem|soap|put down|used|tried|visits?)';
// Recurrence phrases ("keeps coming back", "won't go away", "can't get
// rid") say nothing about a TREATMENT on their own — "this patch keeps
// coming back every year" attempted nothing — so they need the treatment
// subject in the same sentence, on either side (codex #4810 r9).
const RECURRENCE = '(?:won.?t go away|(?:can.?t|couldn.?t) get rid|keeps coming back|still (?:there|here) after)';
const PRIOR_TREATMENT_RE = new RegExp(`\\b(?:${TREATMENT_SUBJECT}\\b[^.!?]{0,40}\\b(?:(?:didn.?t|did not) work|${RECURRENCE})|${RECURRENCE}\\b[^.!?]{0,40}\\b${TREATMENT_SUBJECT}|couldn.?t (?:fix|kill|stop|control|treat|clear))\\b`, 'i');
// "our lawn guy/company ... failed [to fix it]" — a wider gap between the
// subject and the verdict, and the one failure word (failed) the plain list
// above doesn't already cover on its own.
// "failed" must govern a treatment outcome — "my lawn company failed to
// show up" attempted nothing (codex #4810 r7).
const LAWN_COMPANY_FAILED_RE = /\blawn (guy|company)\b[^.!?]{0,40}\bfailed (?:to )?(?:fix|treat|control|stop|kill|clear|get rid)/i;

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
// Attention level reads the WORST CATEGORY's own status/score from the
// report contract (photo-assessment-create.js#worstTreeShrubSignal stores
// { key, label, score, status }), not the five-category average — one
// needs_attention category can hide behind four healthy ones in
// overall_score (codex #4810 r4). overall_score is the fallback only when
// the contract carries no category (older rows).
function treeShrubAttention(analysis, worstSignal) {
  let contract = null;
  try {
    contract = typeof analysis?.report_contract === 'string' ? JSON.parse(analysis.report_contract) : (analysis?.report_contract || null);
  } catch { contract = null; }
  const worst = contract?.worst_signal;
  if (worst && typeof worst === 'object' && worst.key === worstSignal) {
    if (worst.status === 'needs_attention') return true;
    const catScore = Number(worst.score);
    if (Number.isFinite(catScore)) return catScore <= 50;
  }
  const scoreRaw = Number(analysis?.overall_score);
  return Number.isFinite(scoreRaw) && scoreRaw <= 50;
}

function treeShrubOutcome(analysis) {
  const worstSignal = analysis?.worst_signal || null;
  const label = worstSignal ? (TREE_SHRUB_SIGNAL_PHRASE[worstSignal] || 'a few things worth a look') : TREE_SHRUB_HEALTHY_LABEL;
  if (!worstSignal) return { kind: 'harmless', label, cultural: false, uncertain: false };
  if (worstSignal === 'water_heat_mechanical_stress') {
    return { kind: 'cultural', label, cultural: true, uncertain: false };
  }
  const attentionLevel = treeShrubAttention(analysis, worstSignal);
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

// Offer family per assessment type. pest → pest_control so an active pest
// customer's bug photo runs the SAME ownership check (owned → no pitch)
// instead of closing with "Reply if you'd like a quote" for the plan they
// already have (pre-push audit r4); a customer with no plan gets null from
// the offer core → the manual-quote ask, never an engine quote.
const SERVICE_KEY = { tree_shrub: 'tree_shrub', lawn: 'lawn_care', pest: 'pest_control' };

// Palms are their own assessment-first family (injections), never the
// standard tree & shrub program — same palm-first veto the offer ladder
// applies (cross-sell.js#startFamilyForIdentity). A palm caption stays on
// advice + manual quoting (codex #4810 r4).
const PALM_RE = /\bpalms?\b/i;

// Compute-only pricing for one service — NEVER inserts an estimates row,
// NEVER sends anything. Existing customers go through buildOfferForFamily
// (the portal-offer core with the family fixed to what the photo shows):
// the customer's ownership, plan baseline and every demotion rule apply,
// and only a PRICED offer becomes a quote. Returns { quote } on success or
// { reason } naming why not:
//   'no_customer_record'  — a lead with no customer row has nothing to
//                           price against
//   'lead_not_priced'     — a customer row still in a lead stage (or
//                           inactive): leads never get engine quotes, so
//                           the offer core is not even asked (codex #4810
//                           r5) — the manual-quote ask is the reply
//   'palm_assessment_first' — a palm photo: never the T&S program offer
//   'already_owned'       — the family is on the customer's plan (never
//                           re-priced; the draft carries no quote CTA)
//   'offer_unavailable'   — fail closed: ownership lookup failed or a live
//                           plan rate sits on the family — the customer may
//                           already pay for it, so no quote CTA either
//   'no_offer'            — the offer core declined: no recurring plan,
//                           inactive row, unprovable premises, commercial —
//                           a manual-quote ask is fine
//   'quote_needs_review'  — offer composed but demoted to the unpriced CTA
//                           (review-worthy facts, verified correction on
//                           file, baseline mismatch, ambiguous tree count)
// quote.per_visit is the per-application amount to the cent, exactly as
// the offer core derived it (owner-only metadata — the draft text carries
// no price; rounding it here would hand the owner a wrong figure, codex
// #4810 r4).
async function priceForCustomer(type, customer, body, { lead = false } = {}) {
  const serviceKey = SERVICE_KEY[type];
  if (!serviceKey) return { reason: 'no_offer' };
  if (type === 'tree_shrub' && PALM_RE.test(body || '')) return { reason: 'palm_assessment_first' };
  if (!customer?.id) return { reason: 'no_customer_record' };
  if (lead) return { reason: 'lead_not_priced' };
  const offer = await buildOfferForFamily(customer.id, db, serviceKey);
  if (!offer || offer.serviceKey !== serviceKey) return { reason: 'no_offer' };
  // The family is already on the customer's plan: the draft must not pitch
  // it (codex #4810 r2 P1) — photo-text-triage.js drops the quote CTA on
  // this reason, and on the fail-closed one below (r4).
  if (offer.mode === 'owned') return { reason: 'already_owned' };
  if (offer.mode === 'unavailable') return { reason: 'offer_unavailable' };
  if (offer.mode !== 'priced' || !offer.option) return { reason: 'quote_needs_review' };
  const perApplication = Math.round((Number(offer.option.perVisit) || 0) * 100) / 100;
  if (!(perApplication > 0)) return { reason: 'quote_needs_review' };
  return {
    quote: {
      service: serviceKey,
      label: offer.option.label || null,
      option_id: offer.option.id || null,
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
 * @returns {Promise<{ mode: 'advise'|'quote'|'onsite', reasons: string[], quote: null | { service, label, option_id, per_visit } }>}
 */
async function gaugeOpportunity({ type, analysis, customer, body, /* images reserved for a future visual-scope signal */ images: _images }) {
  const reasons = [];
  const text = typeof body === 'string' ? body : '';

  // Same live-customer predicate as customer-stages.js#scopeLiveCustomers
  // (active + not deleted + a customer stage): an inactive row that still
  // carries 'active_customer' is a former customer and follows the lead
  // path (codex #4810 r4).
  const lead = !customer || customer.active !== true || !!customer.deleted_at || !CUSTOMER_STAGES.includes(customer.pipeline_stage);
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

  // The ownership/offer check runs for EVERY non-harmless outcome (watch
  // and uncertain included, pre-push audit r4): the advise close must know
  // whether the customer already owns this family before it asks "Reply if
  // you'd like a quote". Only an actionable/cultural finding may promote a
  // priced offer to quote mode; a watch-level finding keeps advice.
  let priced;
  try {
    priced = await priceForCustomer(type, customer, text, { lead });
  } catch (err) {
    logger.error(`[photo-triage-opportunity] pricing failed for customer ${customer?.id || 'none'}: ${err.message}`);
    priced = { reason: 'no_offer' };
  }
  if (priced.quote) {
    if (actionable || outcome.cultural) {
      reasons.push('quoted');
      return { mode: 'quote', reasons, quote: priced.quote };
    }
    reasons.push('quote_withheld');
  } else {
    reasons.push(priced.reason || 'no_offer');
  }

  return { mode: 'advise', reasons, quote: null };
}

// ── Dispatch-time recheck ────────────────────────────────────────────────

const NO_PITCH_REASONS = new Set(['harmless', 'already_owned', 'offer_unavailable']);

// Re-run the offer check immediately before a photo-triage draft is SENT
// (admin-drafts approve/revise — codex #4810 r6): the creation-time check
// is stale the moment the customer enrolls in the family, a plan rate
// lands, or pricing facts change while the draft sits pending. Returns
//   { ok: true }                                  — send as-is
//   { blocked: 'owned'|'unavailable'|'no_longer_priced', family }
//   { repriced: <per_visit>, family }             — owner-only figure drifted
//   { blocked: 'price_in_text', family: null }   — the outgoing text states a dollar amount
// Throws on a lookup failure — the caller fails closed (draft left pending).
// outgoingText (codex #4810 r7): the body that will actually be sent — an
// owner revision can ADD a quote ask to a draft whose stored verdict says
// no-pitch, so any quote language in the outgoing text forces the check.
// Any price/estimate wording counts as a pitch, not just "quote" — an
// owner revision saying "want pricing?" or "we can prepare an estimate"
// must be rechecked too (codex #4810 r8).
// The dollar alternative sits OUTSIDE the \b wrapper: "$" is a non-word
// character, so "\b\$" never matches at the start of a string or after a
// space — "We can do this for $80" read as no pitch (codex #4810 r9).
const PITCH_LANGUAGE_RE = /\b(?:quot(?:e|es|ed|ing)|pric(?:e|es|ed|ing)|estimate[sd]?|cost[s]?|rate[s]?|add it|sign(?: you)? up)\b|\$\s?\d/i;
// Service families a pitch sentence can NAME (codex #4810 r9): a revision
// that asks about a different service than the photo's family must be
// rechecked against the family it names, not the stored one. Families the
// offer core cannot check (mosquito, rodent, palm) fail closed.
const NAMED_FAMILY = [
  // Any standalone "pest"/"pests" in a pitch sentence ("Want a pest
  // quote?", codex #4810 r10); the hyphenated finding label "pest-pressure
  // signals" is not a service name.
  ['pest_control', /\bpests?\b(?!-)/i],
  ['lawn_care', /\blawns?\b/i],
  ['tree_shrub', /\btrees?\b|\bshrubs?\b/i],
  ['termite', /\btermites?\b/i],
  [null, /\bmosquito(?:es)?\b|\brodents?\b|\bpalms?\b/i],
];
function familiesNamedInPitch(text) {
  const named = new Set();
  let unchecked = false;
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+/)) {
    if (!PITCH_LANGUAGE_RE.test(sentence)) continue;
    for (const [family, re] of NAMED_FAMILY) {
      if (!re.test(sentence)) continue;
      if (family) named.add(family);
      else unchecked = true;
    }
  }
  return { named, unchecked };
}
// Owner ruling 2026-09-25 ("no price as of right now"): a photo-triage
// text never states a dollar amount. A revision that adds one cannot be
// validated against the engine (the owner-only figure is per application
// and may drift), so it is held outright rather than parsed and compared
// (codex #4810 r10 P1, AGENTS.md estimator engine authority).
const DOLLAR_AMOUNT_RE = /\$\s?\d/;
async function recheckDraftOffer({ customerId, flags, outgoingText = null }) {
  if (!flags || flags.origin !== 'photo_triage') return { ok: true };
  if (typeof outgoingText === 'string' && DOLLAR_AMOUNT_RE.test(outgoingText)) return { blocked: 'price_in_text', family: null };
  const mode = flags.opportunity_mode;
  const reasons = Array.isArray(flags.opportunity_reasons) ? flags.opportunity_reasons : [];
  const textPitches = typeof outgoingText === 'string' && PITCH_LANGUAGE_RE.test(outgoingText);
  const pitches = textPitches || mode === 'quote' || (mode === 'advise' && !reasons.some((r) => NO_PITCH_REASONS.has(r)));
  if (!pitches || !customerId) return { ok: true };
  const family = flags.quote?.service || SERVICE_KEY[flags.assessment_type] || null;
  // Every family the outgoing pitch NAMES is rechecked too — a tree & shrub
  // draft revised to ask about pest control must not pass on the tree
  // check alone (codex #4810 r9). An uncheckable named family fails closed.
  const { named, unchecked } = textPitches ? familiesNamedInPitch(outgoingText) : { named: new Set(), unchecked: false };
  if (unchecked) return { blocked: 'unavailable', family: family || 'the named service' };
  const families = [...new Set([family, ...named].filter(Boolean))];
  if (!families.length) return { ok: true };
  // throwOnError: an outage here must surface as a 503 (draft left pending
  // for retry), never as confirmed staleness.
  let offer = null;
  for (const key of families) {
    const answer = await buildOfferForFamily(customerId, db, key, { throwOnError: true });
    if (answer?.mode === 'owned') return { blocked: 'owned', family: key };
    if (answer?.mode === 'unavailable') return { blocked: 'unavailable', family: key };
    if (key === family) offer = answer;
  }
  if (mode === 'quote') {
    if (!offer || offer.mode !== 'priced' || !offer.option) return { blocked: 'no_longer_priced', family };
    const perApplication = Math.round((Number(offer.option.perVisit) || 0) * 100) / 100;
    if (!(perApplication > 0)) return { blocked: 'no_longer_priced', family };
    if (perApplication !== Number(flags.quote?.per_visit)) return { repriced: perApplication, family };
  }
  return { ok: true };
}

// The two fixed pitch closers photo-text-triage.js can write. A held draft
// (recheckDraftOffer blocked it) gets its pitch replaced so a plain second
// Approve cannot send the stale ask (pre-push audit r6) — the rest of the
// text (label, advice) is kept verbatim.
const QUOTE_PITCH_RE = /\s*(?:Want a quote for our [^?]+\? Just reply yes\.|Reply if you'd like a quote\.)\s*$/;
const NO_PITCH_CLOSE = 'Reply if you have questions.';
function stripQuotePitch(text) {
  const base = String(text || '').replace(QUOTE_PITCH_RE, '').trim();
  if (!base) return NO_PITCH_CLOSE;
  return base.endsWith(NO_PITCH_CLOSE) ? base : `${base} ${NO_PITCH_CLOSE}`;
}

// context_summary companion: the owner-only price sentence photo-text-
// triage writes at creation, removed on a dispatch-time hold/reprice so the
// owner never reads a stale figure (pre-push audit r6).
const PRICE_CONTEXT_RE = /\s*Offer core priced \S+ at \$[\d.]+ per application — owner-only; the draft text carries no price\./g;
function priceContextSentence(service, perApplication) {
  return `Offer core priced ${service} at $${Number(perApplication).toFixed(2)} per application — owner-only; the draft text carries no price.`;
}
function replacePriceContext(contextSummary, sentence) {
  const base = String(contextSummary || '').replace(PRICE_CONTEXT_RE, '').trim();
  return sentence ? `${base} ${sentence}`.trim() : base;
}

module.exports = {
  gaugeOpportunity,
  recheckDraftOffer,
  stripQuotePitch,
  priceContextSentence,
  replacePriceContext,
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
