'use strict';

/**
 * Portal Home Recommendations (portal roadmap bet 2, owner rulings 2026-08-13)
 *
 * Composes the "Recommended for your property" stack the portal Dashboard
 * renders under the Property Score card. Owner-ruled contract:
 *   - Cards auto-publish (no per-card approval queue): everything that can
 *     render is either fixed-wording advice derived from the customer's own
 *     service data, or the single offer the approved 16-row ownership matrix
 *     picks (cross-sell.js pickOfferTarget) at an engine-checked price.
 *   - The stack may hold multiple cards ("it can be a pile"), but at most
 *     ONE is an offer; the rest are advice or quote-only notes.
 *   - Never a service the customer already owns (buildPortalOffer's
 *     ownership authority, fail-closed), and NEVER one-time services —
 *     recurring programs only. One-time treatments stay ask-only via the
 *     pricing panel.
 * Every advice loader is best-effort: a failed read skips that card and the
 * rest of the stack still renders. The offer itself fails closed inside
 * buildPortalOffer (an unknowable ownership picture renders no offer).
 */

const db = require('../models/db');
const logger = require('./logger');
const { buildPortalOffer } = require('./service-report/cross-sell');
const { loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
const { dateOnlyString } = require('../utils/date-only');

// Advice copy per lawn-water interpretation (the snapshot engine's judgment;
// this is display copy only — same interpretation vocabulary property-score
// renders as status chips, worded here as the action the customer can take).
// Deliberately non-numeric: quoting rain figures carries the partial-window
// honesty rules, and the advice stands without them.
const IRRIGATION_ADVICE = {
  wet_condition_watch: {
    title: 'Ease up on irrigation',
    body: 'Your recent lawn visits show more combined rain and irrigation than your lawn needs. Cutting back a watering cycle this week helps prevent fungus.',
    priority: 'high',
  },
  water_deficit_likely: {
    title: 'Your lawn may need more water',
    body: 'Your recent lawn visits show less combined rain and irrigation than your lawn needs. Adding a watering cycle this week helps it recover.',
    priority: 'high',
  },
  coverage_issue_possible: {
    title: 'Check your sprinkler coverage',
    body: 'Watering across your lawn looks uneven. A quick check of your irrigation zones can catch a clogged or misaimed head.',
    priority: 'medium',
  },
};

// Months whose seasonal mosquito baseline (pest-forecast/pests.js, 0-10
// scale) sits at 6+ — the note only renders when the season actually
// supports the claim. Read from the forecast module so the two can't drift.
function mosquitoSeasonElevated(monthIndex) {
  try {
    const { PESTS } = require('./pest-forecast/pests');
    const mosquito = (PESTS || []).find((p) => p.key === 'mosquitoes');
    const baseline = mosquito?.baseline?.[monthIndex];
    return Number(baseline) >= 6;
  } catch {
    return false;
  }
}

async function irrigationAdviceCard(customerId, knex) {
  // service_date first — a backfilled old snapshot must not read as the
  // current picture (same order discipline as property-score).
  const snap = await knex('lawn_water_intake_snapshots')
    .where({ customer_id: customerId })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('status', 'interpretation', 'service_date')
    .catch(() => null);
  const advice = snap && IRRIGATION_ADVICE[snap.interpretation];
  if (!advice) return null;
  return {
    id: 'irrigation_advice',
    kind: 'advice',
    priority: advice.priority,
    title: advice.title,
    body: advice.body,
    asOf: dateOnlyString(snap.service_date),
  };
}

// Quote-only seasonal note — never priced, never the matrix target (mosquito
// moves the price tier, never the ladder — owner matrix 2026-08-13). Renders
// only when BOTH facts hold: the season is elevated AND the account provably
// has no mosquito program. An unreadable ownership picture skips the note
// (we may not claim a coverage gap we cannot prove).
async function mosquitoNoteCard(customerId, knex, monthIndex) {
  if (!mosquitoSeasonElevated(monthIndex)) return null;
  let ownedKeys;
  try {
    ownedKeys = await loadOwnedRecurringServiceKeys(knex, customerId);
  } catch {
    return null;
  }
  if (ownedKeys.includes('mosquito')) return null;
  return {
    id: 'mosquito_note',
    kind: 'ask',
    priority: 'low',
    title: 'Mosquito coverage',
    body: 'Mosquito season is at its peak in Southwest Florida, and your plan does not include mosquito protection. Ask us for a quote if you would like it added.',
    serviceKey: 'mosquito',
    ctaLabel: 'Ask about mosquito coverage',
  };
}

function offerCard(offer) {
  if (!offer) return null;
  return {
    id: 'plan_offer',
    kind: 'offer',
    priority: 'medium',
    title: offer.label,
    body: offer.mode === 'priced'
      ? 'Your plan does not include this yet. The price is based on the property details already on file — no inspection needed.'
      : 'Your plan does not include this yet. Ask for a quote and we will confirm the details with you first.',
    serviceKey: offer.serviceKey,
    mode: offer.mode,
    relationship: offer.relationship,
    option: offer.option,
    fingerprint: offer.fingerprint,
    ctaLabel: offer.mode === 'priced' ? `Add ${offer.label}` : 'Request a quote',
  };
}

// monthIndex is injectable for tests; defaults to the current month. Month
// granularity makes the ET/UTC boundary question immaterial (both agree
// except a few hours at month edges, and the note is seasonal copy).
async function buildPropertyRecommendations(customerId, {
  knex = db,
  monthIndex = new Date().getMonth(),
} = {}) {
  const cards = [];

  const [irrigation, offer, mosquito] = await Promise.all([
    irrigationAdviceCard(customerId, knex).catch((err) => {
      logger.warn(`[property-recommendations] irrigation card skipped (${err.message})`);
      return null;
    }),
    // buildPortalOffer never throws by contract, but the stack must not
    // depend on that contract to keep the advice cards alive.
    Promise.resolve().then(() => buildPortalOffer(customerId, knex)).catch((err) => {
      logger.warn(`[property-recommendations] offer skipped (${err.message})`);
      return null;
    }),
    mosquitoNoteCard(customerId, knex, monthIndex).catch((err) => {
      logger.warn(`[property-recommendations] mosquito note skipped (${err.message})`);
      return null;
    }),
  ]);

  if (irrigation) cards.push(irrigation);
  const offerAsCard = offerCard(offer);
  if (offerAsCard) cards.push(offerAsCard);
  if (mosquito) cards.push(mosquito);

  return { cards };
}

module.exports = {
  buildPropertyRecommendations,
  _test: { irrigationAdviceCard, mosquitoNoteCard, offerCard, mosquitoSeasonElevated, IRRIGATION_ADVICE },
};
