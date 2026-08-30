'use strict';

/**
 * Deterministic resolution: reason + facts + context → exactly one of
 *   { kind: 'hard_stop', reviewType }   cancel completes, office task opens
 *   { kind: 'card', card }              one retention card, chosen by rule
 *   { kind: 'none', why }               clean cancel, nothing shown
 *
 * Pure — no I/O, no model calls. Selection rules (rebuttals scope §5 + §8):
 *   1. hard stops first (code-level and situational);
 *   2. a data-backed card outranks the generic card for the same reason;
 *   3. a fix / configuration card outranks money;
 *   4. money only for price | diy and only when offerEligibility passes;
 *   5. never the same template to the same customer twice in 12 months;
 *   6. nothing qualifies → clean cancel.
 * A template whose slots fail validation is skipped, never phrased around.
 */

const { reasonCodeMeta } = require('./reason-codes');
const { getTemplate, renderTemplate } = require('./templates');
const { offerEligibility } = require('./retention-offer');

const OWNER_TEXT_MIN_TENURE_DAYS = 365;

// Owner ruling 2026-08-30 (default list): who may get the "our owner will
// text you" card.
function ownerTextAudience(facts, context = {}) {
  return !!(
    facts.prepay ||
    facts.termiteRental ||
    facts.multiProperty ||
    context.hasCompetitorQuote ||
    (facts.tenureDays >= OWNER_TEXT_MIN_TENURE_DAYS && context.reasonCode === 'financial_hardship')
  );
}

function pick(candidates, { shown12mo = [] } = {}) {
  const shown = new Set(shown12mo);
  for (const c of candidates) {
    if (!c) continue;
    const template = getTemplate(c.id);
    if (!template || shown.has(template.id)) continue;
    const rendered = renderTemplate(template, c.values || {});
    if (!rendered) continue;
    if (c.action) rendered.action = { ...rendered.action, ...c.action };
    return rendered;
  }
  return null;
}

function receiptValues(facts) {
  return { visits: facts.visits12mo, callbacks: facts.callbacks12mo, savings: facts.savings12mo };
}

function scopeFamilies(facts, families) {
  const owned = (facts.families || []).filter(Boolean);
  if (!Array.isArray(families) || !families.length) return { scope: owned, invalid: false };
  // The requested scope is caller input — only families the account actually
  // holds count. A non-empty request that intersects to NOTHING is invalid
  // (stale or forged): it must not silently widen to account scope and mint
  // a card for an unrelated plan.
  const requested = families.filter((f) => owned.includes(f));
  if (!requested.length) return { scope: [], invalid: true };
  return { scope: requested, invalid: false };
}

function resolveCancellation({ facts = {}, reasonCode = null, families = [], context = {}, now = new Date() } = {}) {
  const normalized = scopeFamilies(facts, families);
  const scope = normalized.scope;
  const reason = String(reasonCode || '').trim();
  if (!reason) return { kind: 'none', reasonCode: null, scope, why: 'reason_skipped' };
  const meta = reasonCodeMeta(reason);
  if (!meta) return { kind: 'none', reasonCode: reason, scope, why: 'unknown_reason' };
  if (meta.hardStop) return { kind: 'hard_stop', reasonCode: reason, scope, reviewType: meta.reviewType };
  if (normalized.invalid) return { kind: 'none', reasonCode: reason, scope, why: 'invalid_scope' };
  const ctx = { ...context, reasonCode: reason };
  const hasPest = scope.includes('pest_control');
  const holdable = scope.some((f) => f === 'lawn_care' || f === 'mosquito' || f === 'tree_shrub');
  // A callback-lookup FAILURE ('unknown' sentinel) blocks BOTH lanes: the
  // engine cannot promise a free re-service without proving one is not
  // already on the calendar (fail closed, like the money facts).
  const lanes = facts.openCallbackLanes || [];
  const lanesUnknown = lanes.includes('unknown');
  const pestLane = lanesUnknown || lanes.includes('pest');
  const lawnLane = lanesUnknown || lanes.includes('lawn');
  const opts = { shown12mo: facts.cardsShown12mo || [] };
  const offer = offerEligibility(facts, { reasonCode: reason, families: scope, now });
  const offerAction = offer.eligible ? { familyKey: offer.familyKey } : null;
  const offerValues = offer.eligible ? { family: offer.familyKey } : {};

  let candidates = [];
  switch (reason) {
    case 'price':
      candidates = offer.eligible
        ? [
          { id: 'price_receipt_offer', values: { ...receiptValues(facts), ...offerValues }, action: offerAction },
          { id: 'price_offer', values: offerValues, action: offerAction },
        ]
        : [{ id: 'price_receipt', values: receiptValues(facts) }];
      break;

    case 'diy':
      candidates = offer.eligible
        ? [{ id: 'diy_offer', values: offerValues, action: offerAction }]
        : [{ id: 'diy_nonrepellent' }];
      break;

    case 'results_pest':
      if (pestLane) break; // a free callback is already on the calendar
      candidates = [
        facts.callbacks12mo >= 2 ? { id: 'results_pest_program_change', values: { callbacks: facts.callbacks12mo } } : null,
        facts.lastFinding && facts.lastFinding.lane === 'pest'
          ? { id: 'results_pest_fix_finding', values: { finding: facts.lastFinding.text } }
          : null,
        { id: 'results_pest_fix' },
      ];
      break;

    case 'results_lawn':
      if (lawnLane) break;
      candidates = [
        facts.lastFinding && facts.lastFinding.lane === 'lawn'
          ? { id: 'results_lawn_agronomy', values: { finding: facts.lastFinding.text } }
          : null,
        facts.tenureDays < 540 ? { id: 'results_lawn_two_seasons', values: { visits: facts.completedVisits } } : null,
        { id: 'results_lawn_fix' },
      ];
      break;

    case 'service_experience':
      if (ctx.safetyComplaint) return { kind: 'hard_stop', reasonCode: reason, reviewType: 'incident' };
      candidates = [
        facts.lastComplaint
          ? { id: 'service_experience_known', values: { date: facts.lastComplaint.date, quote: facts.lastComplaint.quote } }
          : null,
        { id: 'service_experience_owner_call' },
      ];
      break;

    case 'away':
      candidates = [
        hasPest && holdable ? { id: 'away_pairing' } : null,
        hasPest ? { id: 'away_mode_pest' } : null,
        holdable ? { id: 'away_hold' } : null,
      ];
      break;

    case 'scheduling_access_communication':
      candidates = [
        facts.reschedules12mo >= 2 ? { id: 'scheduling_we_noticed', values: { reschedules: facts.reschedules12mo } } : null,
        { id: 'scheduling_set_once' },
      ];
      break;

    case 'moving_or_property_change':
      if (ctx.newAddressInServiceArea === false) return { kind: 'hard_stop', reasonCode: reason, reviewType: 'none' };
      // Unverified address → no transfer promise. The card only appears once
      // the new address is confirmed inside the service area.
      if (ctx.newAddressInServiceArea === true) candidates = [{ id: 'moving_transfer' }];
      break;

    case 'no_longer_needed':
      candidates = [
        facts.firstFinding ? { id: 'no_longer_needed_history', values: { finding: facts.firstFinding.text } } : null,
        { id: 'no_longer_needed_note' },
      ];
      break;

    case 'service_mix':
      if ((facts.families || []).length >= 2) candidates = [{ id: 'service_mix_configure' }];
      break;

    case 'competitor':
      candidates = [
        ctx.hasCompetitorQuote ? { id: 'competitor_quote' } : null,
        facts.completedVisits >= 4
          ? { id: 'competitor_history', values: { visits: facts.completedVisits }, action: ownerTextAudience(facts, ctx) ? null : { type: 'none' } }
          : null,
      ];
      break;

    case 'hoa_or_landlord':
      candidates = [{ id: 'hoa_check_coverage' }];
      break;

    case 'financial_hardship':
      candidates = [
        ownerTextAudience(facts, ctx) ? { id: 'hardship_owner_text', values: { years: Math.floor((facts.tenureDays || 0) / 365) } } : null,
        (facts.families || []).length >= 2 ? { id: 'hardship_reduce' } : null,
      ];
      break;

    case 'health_or_chemicals':
      if (ctx.adverseEvent) return { kind: 'hard_stop', reasonCode: reason, reviewType: 'incident' };
      if (hasPest) candidates = [{ id: 'health_exterior_baits' }];
      break;

    case 'other':
      candidates = [
        ownerTextAudience(facts, ctx) ? { id: 'other_owner_text' } : null,
        { id: 'other_receipt', values: receiptValues(facts) },
      ];
      break;

    default:
      break;
  }

  const card = pick(candidates, opts);
  if (!card) {
    return { kind: 'none', reasonCode: reason, scope, why: candidates.filter(Boolean).length ? 'no_candidate_validated' : 'no_candidate', offerBlockers: offer.blockers };
  }
  return { kind: 'card', reasonCode: reason, scope, card, offerBlockers: offer.blockers };
}

/**
 * Situational hard-stop verdict derivable from reason + context ALONE (no
 * facts) — used by retry repair to reconstruct incident/out-of-area
 * verdicts when the original case writes were lost post-churn.
 */
function situationalHardStop(reasonCode, context = {}) {
  if (reasonCode === 'health_or_chemicals' && context.adverseEvent) return { kind: 'hard_stop', reasonCode, reviewType: 'incident' };
  if (reasonCode === 'service_experience' && context.safetyComplaint) return { kind: 'hard_stop', reasonCode, reviewType: 'incident' };
  if (reasonCode === 'moving_or_property_change' && context.newAddressInServiceArea === false) return { kind: 'hard_stop', reasonCode, reviewType: 'none' };
  return null;
}

module.exports = { resolveCancellation, ownerTextAudience, situationalHardStop };
