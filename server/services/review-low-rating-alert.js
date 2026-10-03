/**
 * Bad-review bell (Clef second wave idea 7; owner CW-D4 2026-10-02 "yes").
 *
 * Nothing alerted on a negative Google review: reviews under 4 stars are
 * neither drafted nor belled (the 08-29 ruling was about drafts), and the
 * unlinked-review bell is silent by default under the bell policy. This keeps
 * ONE needs-you item open for every unanswered Google review of 1 to 3 stars,
 * so the owner reads it the day it lands.
 *
 * Level-triggered, not fired at insert (Codex #5659 r1): after every review
 * sync, `syncLowRatingReviewAlerts` reads the reviews that need an answer now
 * and the items that are open, then raises what is missing and closes what is
 * settled, through the shared alert episodes (admin-alert-episodes.js). So a
 * failed bell write is retried on the next sync, a review stored already
 * answered never rings, and a reply removed later (at any age) rings again.
 * "Needs an answer": 1 to 3 stars, no published reply (an unpublished
 * '[DRAFT] …' reply does not count, review-reply/draft-prefix.js), not
 * dismissed, still on Google (no missing_since), and written at or after this
 * lane's first live run (`activationBoundary`, stored once in system_settings),
 * so turning the gate on never rings a backlog.
 *
 * Rules only (the Clef replay found about two such reviews a year, too few to
 * justify a model). Internal only: nothing is sent to the reviewer. The item
 * names the reviewer and the stars and never quotes the review: a customer's
 * own words carry dates and exclamation marks the alert rules forbid, and the
 * Reviews page shows the text. Gate: GATE_REVIEW_ALERT, read at call time
 * (reviewLowRatingAlertLive). Never throws: a failed pass must not fail the
 * review sync.
 */
const db = require('../models/db');
const logger = require('./logger');
const { reviewLowRatingAlertLive } = require('../config/feature-gates');

const CATEGORY = 'review_low_rating';
const KEY_PREFIX = 'review-low-rating:';
const MAX_STARS = 3;
const ACTIVATION_SETTINGS_KEY = 'review_low_rating_alert_activated_at';

const keyFor = (reviewId) => `${KEY_PREFIX}${reviewId}`;

// Pure: the alert spec for one review that needs an answer. `reviewerName`
// is a Google display name (free text); composeForReview falls back to the
// generic wording when the name breaks the alert rules.
function lowRatingAlertSpec({ reviewId, starRating, reviewerName, customerId } = {}) {
  const stars = Number(starRating);
  if (!reviewId || !Number.isInteger(stars) || stars < 1 || stars > MAX_STARS) return null;
  const starWord = stars === 1 ? 'star' : 'stars';
  const who = String(reviewerName || '').replace(/\s+/g, ' ').trim() || 'A reviewer';
  return {
    area: 'Customers',
    action: `read a ${stars}-star Google review`,
    why: `${who} left ${stars} ${starWord} on Google; reply to it or dismiss it on the Reviews page.`,
    severity: 'needs-you',
    // The Reviews page's own deep link (ReviewsPage.jsx): pins and scrolls to
    // the card, under every response state so a reply landing first never
    // filters it out.
    link: `/admin/reviews?responded=all&review=${encodeURIComponent(String(reviewId))}`,
    // A linked review is about that customer; an unlinked one is a check on the review itself.
    subject: customerId ? { type: 'customer', id: String(customerId) } : { type: 'check', id: String(reviewId) },
    doneWhen: 'review_replied_or_dismissed',
    who: 'person',
  };
}

// The composed item for one review. A display name with an emoji, an
// exclamation mark, an underscore, initials that read as a sentence end, or
// too many characters breaks the alert rules (composeAdminAlert throws), and
// the same review would then fail every sync and never ring (pre-push audit
// P1): such a name falls back to "A reviewer". Same key, same metadata.
function composeForReview(review) {
  const { composeAdminAlert } = require('./admin-alert-compose');
  const args = { reviewId: review.id, starRating: review.star_rating, reviewerName: review.reviewer_name, customerId: review.customer_id };
  const spec = lowRatingAlertSpec(args);
  if (!spec) return null;
  try {
    return composeAdminAlert(spec);
  } catch {
    return composeAdminAlert(lowRatingAlertSpec({ ...args, reviewerName: null }));
  }
}

// The first instant this lane ran live: read once, written once (the DATABASE
// clock, insert-if-absent, so racing pods agree and a restart never moves it).
async function activationBoundary(conn = db) {
  const existing = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  if (existing?.value) return new Date(existing.value);
  const { rows } = await conn.raw('SELECT now() AS now');
  const now = rows[0].now;
  await conn('system_settings').insert({
    key: ACTIVATION_SETTINGS_KEY, value: new Date(now).toISOString(), category: 'reviews',
    description: 'First live run of GATE_REVIEW_ALERT; Google reviews written before it never ring the bad-review bell.',
  }).onConflict('key').ignore();
  const settled = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  return new Date(settled?.value || now);
}

// The reviews that need an answer now (see the header).
function needsAnswerQuery(conn, since) {
  return conn('google_reviews')
    .whereBetween('star_rating', [1, MAX_STARS])
    .where((q) => q.whereNull('reviewer_name').orWhereNot('reviewer_name', '_stats'))
    .where('review_created_at', '>=', since)
    .where((q) => q.where('dismissed', false).orWhereNull('dismissed'))
    .whereNull('missing_since')
    // No published reply: blank, or our own unpublished '[DRAFT] …' text.
    .whereRaw("(TRIM(COALESCE(review_reply, '')) = '' OR LEFT(TRIM(review_reply), 7) = '[DRAFT]')")
    .select('id', 'star_rating', 'reviewer_name', 'customer_id');
}

/**
 * One pass: raise or reopen an item for every review that needs an answer,
 * close every open item whose review no longer does. Returns counts.
 */
async function syncLowRatingReviewAlerts({ conn = db, now = new Date() } = {}) {
  const out = { raised: 0, failed: 0, closed: 0 };
  if (!reviewLowRatingAlertLive()) return { ...out, skipped: 'gate_off' };
  try {
    const episodes = require('./admin-alert-episodes');
    const since = await activationBoundary(conn);
    const reviews = await needsAnswerQuery(conn, since);
    const live = new Set();
    for (const review of reviews) {
      const key = keyFor(review.id);
      live.add(key);
      try {
        const composed = composeForReview(review);
        if (!composed) continue;
        const result = await episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
          link: composed.link,
          dedupeKey: key,
          // customerId at the top level: notification-service's central
          // internal-test-customer suppression reads it there.
          metadata: { ...composed.metadata, reviewId: String(review.id), customerId: review.customer_id || null, starRating: Number(review.star_rating) },
        });
        // A null result is a failed write (notifyAdmin swallows errors); the
        // next sync sees the same review and tries again.
        if (!result) out.failed += 1; else if (result.rang) out.raised += 1;
      } catch (err) {
        out.failed += 1;
        logger.warn(`[review-alert] low-rating bell failed for review ${review.id}: ${err.message}`);
      }
    }
    const settled = (await episodes.openAdminAlertKeys(conn, KEY_PREFIX)).filter((key) => !live.has(key));
    if (settled.length) {
      out.closed = Number(await episodes.closeAdminAlertKeys(conn, settled, 'review answered', { now, resolution: 'The review was answered, dismissed or left Google' })) || 0;
    }
  } catch (err) {
    logger.warn(`[review-alert] low-rating pass failed: ${err.message}`);
    return { ...out, error: true };
  }
  return out;
}

module.exports = { lowRatingAlertSpec, composeForReview, syncLowRatingReviewAlerts, activationBoundary, needsAnswerQuery, CATEGORY, KEY_PREFIX, MAX_STARS };
