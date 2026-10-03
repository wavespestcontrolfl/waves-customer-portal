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
 * lane's activation boundary (`activationBoundary`: stored once in
 * system_settings at the start of the first gated sync, two hours back), so
 * turning the gate on never rings a backlog.
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
const { reviewLowRatingAlertLive, alertEpisodesLive } = require('../config/feature-gates');

// Error code / constraint only: a knex error's message renders the SQL, and a
// notification write carries the reviewer's name (AGENTS.md: no PII in logs).
const errorCode = (err) => require('./notification-service')._private.safeErrorSummary(err);

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
    return { ...composeAdminAlert(spec), spec };
  } catch {
    const generic = lowRatingAlertSpec({ ...args, reviewerName: null });
    return { ...composeAdminAlert(generic), spec: generic };
  }
}

// The lane's activation boundary: written once (insert-if-absent, the DATABASE
// clock, so racing pods agree and a restart never moves it) at the START of
// the first gated review sync, before it pulls anything (Codex #5659 r4), and
// set ACTIVATION_GRACE_HOURS earlier. The gate's flip redeploys the service
// and the first hourly sync can run up to an hour later, so the grace covers a
// review written between the flip and that first pull; at about two such
// reviews a year it admits no backlog worth the name.
const ACTIVATION_GRACE_HOURS = 2;
async function activationBoundary(conn = db) {
  const existing = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  if (existing?.value) return new Date(existing.value);
  const { rows } = await conn.raw(`SELECT now() - interval '${ACTIVATION_GRACE_HOURS} hours' AS now`);
  const now = rows[0].now;
  await conn('system_settings').insert({
    key: ACTIVATION_SETTINGS_KEY, value: new Date(now).toISOString(), category: 'reviews',
    description: 'First live run of GATE_REVIEW_ALERT; Google reviews written before it never ring the bad-review bell.',
  }).onConflict('key').ignore();
  const settled = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  return new Date(settled?.value || now);
}

// The reviews that need an answer now (see the header), on the Reviews page's
// own terms (Codex #5659 r6): its active locations only (a retired location is
// never synced again, so its review could never settle), and its own
// needs-a-real-reply rule (review-reply/draft-prefix.js whereNeedsRealReply).
function needsAnswerQuery(conn, since) {
  const { WAVES_LOCATIONS } = require('../config/locations');
  const { whereNeedsRealReply } = require('./review-reply/draft-prefix');
  return conn('google_reviews')
    .whereIn('location_id', WAVES_LOCATIONS.map((l) => l.id))
    .whereBetween('star_rating', [1, MAX_STARS])
    .where((q) => q.whereNull('reviewer_name').orWhereNot('reviewer_name', '_stats'))
    .where('review_created_at', '>=', since)
    .where((q) => q.where('dismissed', false).orWhereNull('dismissed'))
    .whereNull('missing_since')
    .modify((q) => whereNeedsRealReply(q))
    .select('id', 'google_review_id', 'star_rating', 'reviewer_name', 'customer_id');
}

// The open item's key for a review, matched on EITHER identity (Codex #5659
// r3): a fresh Places re-pull re-inserts the row under a new id but the same
// google_review_id, and a GBP sync adopts a Places row, keeping its id but
// rewriting google_review_id. A review with no open item gets a new key.
function keyIndex(openMetadata) {
  const byReviewId = new Map();
  const byGoogleId = new Map();
  for (const meta of openMetadata) {
    if (!meta?.dedupeKey) continue;
    if (meta.reviewId) byReviewId.set(String(meta.reviewId), meta.dedupeKey);
    if (meta.googleReviewId) byGoogleId.set(String(meta.googleReviewId), meta.dedupeKey);
  }
  return (review) => byReviewId.get(String(review.id))
    || (review.google_review_id ? byGoogleId.get(String(review.google_review_id)) : null)
    || keyFor(review.id);
}

// Called at the start of every review sync: fixes the boundary on the first
// gated one, before its pull. Gate off = nothing. Never throws.
async function recordActivation(conn = db) {
  if (!reviewLowRatingAlertLive()) return null;
  try {
    return await activationBoundary(conn);
  } catch (err) {
    logger.warn(`[review-alert] activation boundary not recorded: ${errorCode(err)}`);
    return null;
  }
}

/**
 * One pass: raise or reopen an item for every review that needs an answer,
 * close every open item whose review no longer does. Returns counts.
 */
async function syncLowRatingReviewAlerts({ conn = db, now = new Date() } = {}) {
  const out = { raised: 0, failed: 0, closed: 0 };
  if (!reviewLowRatingAlertLive()) return { ...out, skipped: 'gate_off' };
  // One pass at a time (pre-push audit P1): the close step judges open items
  // against THIS pass's snapshot, so an overlapping pass (a manual sync during
  // the hourly one) could close an item the other just raised. A pass that
  // finds the lock held does nothing; the holder or the next sync covers it.
  // The lock itself can fail (its advisory-lock query); a bell pass must never
  // fail the review sync that called it.
  try {
    const { runExclusive } = require('../utils/cron-lock');
    const ran = await runExclusive('review-low-rating-alert', () => reconcile(conn, now, out), { recordHealth: false });
    return ran && typeof ran === 'object' && 'raised' in ran ? ran : { ...out, skipped: 'busy' };
  } catch (err) {
    logger.warn(`[review-alert] low-rating pass could not take its lock: ${errorCode(err)}`);
    return { ...out, error: true };
  }
}

async function reconcile(conn, now, out) {
  try {
    const episodes = require('./admin-alert-episodes');
    const since = await activationBoundary(conn);
    const { isInternalTestCustomerId } = require('./internal-test-customers');
    // A review linked to an internal test account never needs an answer from
    // the office: left out of the live set, so an item it already has (raised
    // while it was still unlinked) is closed below (Codex #5659 r2).
    const eligible = (review) => !(review.customer_id && isInternalTestCustomerId(review.customer_id));
    // The owner silenced the category (Push settings): nothing rings, not
    // even a reopen (raiseAdminAlertWithReopen re-rings a cleared row, and the
    // category override is only read on a fresh insert), and standing items
    // close below (Codex #5659 r6).
    const bellPolicy = require('./notification-bell-policy');
    // Only while the bell policy itself is on, as NotificationService.create
    // reads it: with GATE_ADMIN_BELL_POLICY off a stale saved override never
    // silences anything (Codex #5659 r7).
    const silenced = bellPolicy.isBellPolicyEnabled() && !(await bellPolicy.bellAllowed({ category: CATEGORY }));
    const reviews = silenced ? [] : (await needsAnswerQuery(conn, since)).filter(eligible);
    // ALERT_EPISODES killed (Codex #5659 r5): the shared kill switch's contract
    // is no close pass and no reopen, the emitter's plain deduped raise. Each
    // review still rings once on its own key; nothing is auto-closed.
    const episodesOn = alertEpisodesLive();
    const keyOf = episodesOn ? keyIndex(await episodes.openAdminAlertMetadata(conn, KEY_PREFIX)) : (review) => keyFor(review.id);
    const live = new Set();
    for (const listed of reviews) {
      const key = keyOf(listed);
      try {
        // Re-read and share-lock the review in the raise's own transaction
        // (Codex #5659 r3): a reply or dismissal that committed after the
        // list was read never rings, and one arriving now waits for this.
        const result = await conn.transaction(async (trx) => {
          const [review] = await needsAnswerQuery(trx, since).where('id', listed.id).forShare();
          if (!review || !eligible(review)) return 'settled';
          live.add(key);
          const composed = composeForReview(review);
          if (!composed) return 'settled';
          if (!episodesOn) {
            const { raiseAdminAlert } = require('./admin-alert-compose');
            const plain = await raiseAdminAlert(CATEGORY, composed.spec, {
              trx,
              dedupeKey: key,
              metadata: {
                ...composed.metadata, reviewId: String(review.id), googleReviewId: review.google_review_id || null,
                customerId: review.customer_id || null, starRating: Number(review.star_rating),
              },
            });
            return plain ? { ...plain, rang: !plain.suppressed && !plain.deduped } : null;
          }
          return episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
            trx,
            link: composed.link,
            dedupeKey: key,
            // The linkage is the version: a review linked to a customer after
            // it rang quietly refreshes the standing item's subject (never
            // re-rings it).
            dedupeVersion: `customer:${review.customer_id || 'none'}`,
            refreshOnDedupe: true,
            // A function (notification-service resolveRingOnRefresh treats
            // anything else as "ring"): a linkage refresh never re-rings.
            ringOnRefresh: () => false,
            // customerId at the top level: notification-service's central
            // internal-test-customer suppression reads it there.
            metadata: {
              ...composed.metadata, reviewId: String(review.id), googleReviewId: review.google_review_id || null,
              customerId: review.customer_id || null, starRating: Number(review.star_rating),
            },
          });
        });
        // A null result is a failed write (notifyAdmin swallows errors); the
        // next sync sees the same review and tries again.
        if (result === 'settled') continue;
        if (!result) { live.add(key); out.failed += 1; } else if (result.rang) out.raised += 1;
      } catch (err) {
        live.add(key);
        out.failed += 1;
        logger.warn(`[review-alert] low-rating bell failed for review ${listed.id}: ${errorCode(err)}`);
      }
    }
    if (!episodesOn) return out;
    const settled = (await episodes.openAdminAlertKeys(conn, KEY_PREFIX)).filter((key) => !live.has(key));
    if (settled.length) {
      out.closed = Number(await episodes.closeAdminAlertKeys(conn, settled, 'review answered', { now, resolution: 'The review no longer needs an answer' })) || 0;
    }
  } catch (err) {
    logger.warn(`[review-alert] low-rating pass failed: ${errorCode(err)}`);
    return { ...out, error: true };
  }
  return out;
}

module.exports = { lowRatingAlertSpec, composeForReview, syncLowRatingReviewAlerts, activationBoundary, recordActivation, ACTIVATION_GRACE_HOURS, needsAnswerQuery, CATEGORY, KEY_PREFIX, MAX_STARS };
