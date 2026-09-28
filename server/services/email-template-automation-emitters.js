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
 */
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

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

module.exports = {
  emitEstimateExpired,
  emitReviewLinked5Star,
};
