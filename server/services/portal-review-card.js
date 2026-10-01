/**
 * The link behind the portal's one-tap Google review card (owner ruling
 * 2026-09-29). Nothing is sent from here.
 *
 * TRACKED LINKS ONLY: the card shows the customer's live delivered review
 * token in its /api/rate/<token>/go form, and nothing else. A bare office
 * Google URL is untracked — the tap would stamp nothing, so an ask enrolled a
 * moment later (the completion enrolls after the service record is visible; a
 * paid-invoice enrollment can follow) would still text a customer who had
 * already reviewed. Every portal tap through /go stamps redirected_at, runs the
 * best-effort stop, and the send-time click guard suppresses every later ask
 * for that visit. No live token -> no card.
 *
 * The customer's review opt-out (notification_prefs.review_request = false),
 * a soft-deleted customer and the CSR already-reviewed flag hide the card,
 * through the same live-consent reader the composer uses. An SMS-off or
 * email-only preference does not: the card is a button, not a text. A read
 * failure hides the card (fail closed).
 */
const ReviewService = require('./review-request');
const { publicPortalUrl } = require('../utils/portal-url');

const HIDES_CARD = new Set(['review_off', 'customer_deleted', 'already_reviewed', 'prefs_unavailable']);

async function reviewCardLinkFor(customerId) {
  const consent = await ReviewService.reviewSmsAllowedNow(customerId);
  if (!consent.allowed && HIDES_CARD.has(consent.reason)) return null;
  const token = await ReviewService._liveReviewToken(customerId);
  return token ? `${publicPortalUrl()}/api/rate/${token}/go` : null;
}

module.exports = { reviewCardLinkFor };
