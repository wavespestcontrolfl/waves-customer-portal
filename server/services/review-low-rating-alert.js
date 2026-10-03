/**
 * Bad-review bell (Clef second wave idea 7; owner CW-D4 2026-10-02 "yes").
 *
 * Nothing alerted on a negative Google review: reviews under 4 stars are
 * neither drafted nor belled (the 08-29 ruling was about drafts), and the
 * unlinked-review bell is silent by default under the bell policy. This
 * rings one needs-you bell for a NEW review of 1 to 3 stars, from either
 * insert path in google-business.js (the GBP feed's post-write side effects
 * and the Places fallback insert), so the owner reads it the day it lands.
 *
 * Rules only (the Clef replay found about two such reviews a year, too few
 * to justify a model). Internal bell only: nothing is sent to the reviewer.
 * The bell names the reviewer and the stars and never quotes the review: a
 * customer's own words carry dates and exclamation marks the alert rules
 * forbid, and the Reviews page shows the text.
 *
 * Fires only on the insert itself (each review rings once) and only for a
 * review written in the last 7 days, so a first sync of an older profile
 * cannot ring a backlog. Gate: GATE_REVIEW_ALERT (off unless 'true').
 * Never throws: a failed bell must not fail the review sync.
 */
const logger = require('./logger');
const { reviewLowRatingAlertLive } = require('../config/feature-gates');

const CATEGORY = 'review_low_rating';
const MAX_STARS = 3;
const RECENT_DAYS = 7;

// Pure: what the bell says, or null when this review should not ring.
function lowRatingAlertSpec({ reviewId, starRating, reviewerName, customerId, reviewCreatedAt, now = new Date() } = {}) {
  const stars = Number(starRating);
  if (!reviewId || !Number.isInteger(stars) || stars < 1 || stars > MAX_STARS) return null;
  const written = reviewCreatedAt ? new Date(reviewCreatedAt) : null;
  if (!written || Number.isNaN(written.getTime())) return null;
  if (now.getTime() - written.getTime() > RECENT_DAYS * 24 * 60 * 60 * 1000) return null;
  const starWord = stars === 1 ? 'star' : 'stars';
  const who = String(reviewerName || '').replace(/\s+/g, ' ').trim() || 'A reviewer';
  return {
    area: 'Customers',
    action: `read a ${stars}-star Google review`,
    why: `${who} left ${stars} ${starWord} on Google; reply to it or dismiss it on the Reviews page.`,
    severity: 'needs-you',
    link: '/admin/reviews',
    // A linked review is about that customer; an unlinked one is a check on the review itself.
    subject: customerId ? { type: 'customer', id: String(customerId) } : { type: 'check', id: String(reviewId) },
    doneWhen: 'review_replied_or_dismissed',
    who: 'person',
  };
}

async function notifyLowRatingReview(review = {}) {
  try {
    if (!reviewLowRatingAlertLive()) return { rang: false, reason: 'gate_off' };
    const spec = lowRatingAlertSpec(review);
    if (!spec) return { rang: false, reason: 'not_low_or_not_recent' };
    const { raiseAdminAlert } = require('./admin-alert-compose');
    // The category rings by default and the owner can silence it
    // (notification-bell-policy DEFAULT_ON_CATEGORIES + OVERRIDABLE_CATEGORIES).
    // dedupeKey: the GBP feed and the Places fallback can both see one review;
    // a review rings once whichever path inserts it.
    await raiseAdminAlert(CATEGORY, spec, {
      dedupeKey: `review-low-rating:${review.reviewId}`,
      metadata: { reviewId: String(review.reviewId), starRating: Number(review.starRating) },
    });
    return { rang: true };
  } catch (err) {
    logger.warn(`[review-alert] low-rating bell failed for review ${review.reviewId || '?'}: ${err.message}`);
    return { rang: false, reason: 'error' };
  }
}

module.exports = { lowRatingAlertSpec, notifyLowRatingReview, CATEGORY, MAX_STARS, RECENT_DAYS };
