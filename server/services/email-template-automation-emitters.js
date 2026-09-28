/**
 * Small event → email_template_automation trigger emitters.
 *
 * Each function is a thin, NEVER-THROWING adapter from a real product event
 * to AutomationExecutor.processTrigger — a no-op whenever the
 * emailTemplateAutomations gate is off, so a producer that calls one of
 * these pays nothing when the whole catalog is dark. Only ids and the
 * minimal fields each trigger's condition/exit rules and idempotency key
 * need are passed; recipient EMAIL resolution is centralized in the
 * executor (processTrigger's resolveEmailForTrigger), not duplicated here.
 *
 * visit.completed_first and customer.churned are intentionally NOT wired
 * here yet — see the PR body for why (deferred to a follow-up PR).
 *
 * sweepMissedLifecycleEvents (codex P2 x2) is the retry safety net for both
 * direct emitters above: if processTrigger fails before it durably inserts
 * a run (a transient DB outage, most likely), the direct call above returns
 * null and the triggering write (the estimate flipped to 'expired', the
 * review's customer_id set) is never replayed on its own — the entity's
 * OWN state IS the durable evidence a run is owed. No new table: the sweep
 * re-derives "missed" straight from the entities plus a NOT EXISTS against
 * email_template_automation_runs (idempotency_key already prevents a
 * double run if the direct emitter partially succeeded).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled, emailTemplateAutomationsMode } = require('../config/feature-gates');

async function emitTrigger(eventKey, args) {
  if (!isEnabled('emailTemplateAutomations')) return null;
  try {
    const AutomationExecutor = require('./email-template-automation-executor');
    return await AutomationExecutor.processTrigger({ triggerEventKey: eventKey, executeImmediately: true, ...args });
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] ${eventKey} emit failed: ${err.message}`);
    return null;
  }
}

// estimate.expired — fired once per row the daily expiration sweep flips
// (estimate-expiration.js Rule 1 aged-out / Rule 2 explicit expires_at).
async function emitEstimateExpired({ id, customer_id: customerId, customer_email: customerEmail, category, service_interest: serviceInterest, expires_at: expiresAt } = {}) {
  if (!id) return null;
  return emitTrigger('estimate.expired', {
    triggerEventId: `estimate_expired:${id}`,
    entityType: 'estimate',
    entityId: id,
    recipient: { type: customerId ? 'customer' : 'lead', id: customerId || '', email: customerEmail || '' },
    payload: {
      estimate_id: id,
      customer_id: customerId || '',
      customer_email: customerEmail || '',
      category: category || '',
      service_interest: serviceInterest || '',
      expires_at: expiresAt || null,
    },
  });
}

// review.linked_5star — fired at both google-business.js review-attribution
// sites (the hourly GBP feed sync and the Places fallback sync), 5-star
// only, on the same "just attributed to a customer" moment the shared
// enrollReviewThankYou thank-you sequence fires on.
async function emitReviewLinked5Star({ reviewId, customerId, locationId, starRating }) {
  if (!customerId || !reviewId || Number(starRating) !== 5) return null;
  return emitTrigger('review.linked_5star', {
    triggerEventId: `review_linked_5star:${reviewId}`,
    entityType: 'review',
    entityId: reviewId,
    recipient: { type: 'customer', id: customerId },
    payload: { review_id: reviewId, customer_id: customerId, location_id: locationId || '' },
  });
}

const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_ROW_LIMIT = 100;

// True only when at least one ACTIVE automation catalog row targets this
// trigger key — the sweep does zero work (no entity query at all) for a
// key nobody has configured yet.
async function hasActiveAutomation(triggerEventKey) {
  try {
    const row = await db('email_template_automations')
      .where({ trigger_event_key: triggerEventKey, status: 'active' })
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] active-automation check failed for ${triggerEventKey}: ${err.message}`);
    return false;
  }
}

// Estimates the direct emitter (estimate-expiration.js) may have missed:
// flipped to 'expired' within the window, no run recorded for THIS trigger
// key against this entity. Bound on updated_at, NOT expires_at (codex P1):
// expiredUpdate() stamps updated_at on EVERY flip, but only Rule 2's
// explicit-expires_at rows have a fresh expires_at — Rule 1's aged-out
// rows (sent/viewed past the inactivity threshold, no explicit deadline)
// never get expires_at touched at flip time, so bounding on it would
// silently exclude exactly the cohort most likely to need this safety
// net. updated_at is guaranteed fresh for both rules — again just a
// window, not the correctness check (the NOT EXISTS below is).
async function sweepMissedExpiredEstimates(since) {
  if (!(await hasActiveAutomation('estimate.expired'))) return 0;
  let rows;
  try {
    rows = await db('estimates as e')
      .where('e.status', 'expired')
      .where('e.updated_at', '>=', since)
      .whereNotExists(function notEmitted() {
        this.select(1).from('email_template_automation_runs as r')
          .whereRaw('r.entity_type = ? AND r.entity_id = e.id AND r.trigger_event_key = ?', ['estimate', 'estimate.expired']);
      })
      .select('e.id', 'e.customer_id', 'e.customer_email', 'e.category', 'e.service_interest', 'e.expires_at')
      .limit(SWEEP_ROW_LIMIT);
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] missed-estimate sweep query failed: ${err.message}`);
    return 0;
  }
  let emitted = 0;
  for (const row of rows) {
    try {
      const result = await emitEstimateExpired(row);
      if (result) emitted += 1;
    } catch (err) {
      logger.warn(`[email-template-automation-emitters] missed estimate.expired emit failed for ${row.id}: ${err.message}`);
    }
  }
  return emitted;
}

// Reviews google-business.js's two sync sites or review-incentives.js's
// manual-attribution branch may have missed: five-star, linked to a live
// customer, not dismissed, not removed from Google, touched within the
// window, no run recorded for THIS trigger key against this entity.
// google_reviews has no dedicated "linked_at" column (checked the table's
// migrations — auto_linked_at only covers the click-auto-link path);
// updated_at is bumped by every attribution path (ordinary sync, manual
// match, click-auto), so it is the sweep's bound — again just a window,
// not the correctness check (the NOT EXISTS is).
async function sweepMissedFiveStarReviews(since) {
  if (!(await hasActiveAutomation('review.linked_5star'))) return 0;
  let rows;
  try {
    rows = await db('google_reviews as g')
      .where('g.star_rating', 5)
      .whereNotNull('g.customer_id')
      .where('g.dismissed', false)
      .whereNull('g.missing_since')
      .where('g.updated_at', '>=', since)
      .whereNotExists(function notEmitted() {
        this.select(1).from('email_template_automation_runs as r')
          .whereRaw('r.entity_type = ? AND r.entity_id = g.id AND r.trigger_event_key = ?', ['review', 'review.linked_5star']);
      })
      .select('g.id', 'g.customer_id', 'g.location_id', 'g.star_rating')
      .limit(SWEEP_ROW_LIMIT);
  } catch (err) {
    logger.warn(`[email-template-automation-emitters] missed-review sweep query failed: ${err.message}`);
    return 0;
  }
  let emitted = 0;
  for (const row of rows) {
    try {
      const result = await emitReviewLinked5Star({
        reviewId: row.id, customerId: row.customer_id, locationId: row.location_id, starRating: row.star_rating,
      });
      if (result) emitted += 1;
    } catch (err) {
      logger.warn(`[email-template-automation-emitters] missed review.linked_5star emit failed for ${row.id}: ${err.message}`);
    }
  }
  return emitted;
}

// Scheduler entry point (every 15 min, runExclusive-wrapped by the caller
// or here — wrapped HERE so a direct test/manual call gets the same
// single-flight guarantee as the cron tick). No-op, no query at all, when
// the mode is 'off' — matches every other reader's off-mode contract.
async function sweepMissedLifecycleEvents() {
  if (emailTemplateAutomationsMode() === 'off') return { estimatesEmitted: 0, reviewsEmitted: 0 };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('email-template-automation-lifecycle-sweep', async () => {
    const since = new Date(Date.now() - SWEEP_WINDOW_MS);
    const estimatesEmitted = await sweepMissedExpiredEstimates(since);
    const reviewsEmitted = await sweepMissedFiveStarReviews(since);
    return { estimatesEmitted, reviewsEmitted };
  });
}

module.exports = {
  emitEstimateExpired,
  emitReviewLinked5Star,
  sweepMissedLifecycleEvents,
};
