/**
 * The ONE way a review reply reaches Google.
 *
 *   draft → verify → liveness recheck → publish → persist GBP result → audit
 *
 * Every writer — the admin ReviewsPage, the Intelligence Bar
 * submit_review_reply tool, and the auto-reply runner — calls
 * publishReviewReply(). No route or tool calls gbp.replyToReview or mutates
 * google_reviews.review_reply on its own any more (the Intelligence Bar path
 * used to write locally and claim the reply would "sync to Google"; it never
 * did — owner-flagged 2026-08-27).
 *
 * Liveness + concurrency: the external post and the local record run inside
 * publishWithReviewLivenessLock (per-location advisory lock + per-review
 * publish claim), so a review Google removed mid-publish, or two publishers
 * racing on one review, cannot leave an external reply with no local record
 * or a double post.
 */

const db = require('../../models/db');
const gbp = require('../google-business');
const logger = require('../logger');
const { WAVES_LOCATIONS } = require('../../config/locations');
const { hasRealReply } = require('./draft-prefix');

class ReviewReplyError extends Error {
  constructor(code, message, { status = 500, cause = null } = {}) {
    super(message);
    this.name = 'ReviewReplyError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const CODES = {
  NOT_FOUND: 'not_found',
  MISSING: 'review_missing',
  HAS_REPLY: 'already_replied',
  NO_RESOURCE: 'no_gbp_resource',
  LOCK_BUSY: 'lock_busy',
  NOT_CONFIGURED: 'gbp_not_configured',
  GOOGLE_FAILED: 'google_failed',
  RACE: 'removed_during_publish',
  EMPTY: 'empty_text',
  STALE: 'stale_claim',
  PERSIST_FAILED: 'persist_failed',
};

const MISSING_MSG = 'This review has been removed from Google — replies are disabled.';

/**
 * Resolve (and persist) the GBP review resource name when the row lacks one
 * — moved verbatim from the admin reply route: name + 24h time match against
 * the location's live feed.
 */
async function resolveGbpReviewName(review, { conn = db } = {}) {
  if (review.gbp_review_name) return review.gbp_review_name;
  if (!review.location_id) return null;
  try {
    const loc = WAVES_LOCATIONS.find((l) => l.id === review.location_id);
    if (!loc?.googleLocationResourceName) return null;
    const gbpReviews = await gbp.getAllLocationReviews(loc.googleLocationResourceName, review.location_id, 100);
    const rName = (review.reviewer_name || '').toLowerCase();
    const rTime = review.review_created_at ? new Date(review.review_created_at).getTime() : 0;
    const match = gbpReviews.find((g) => {
      const gName = (g.reviewer?.displayName || '').toLowerCase();
      const gTime = g.createTime ? new Date(g.createTime).getTime() : 0;
      return gName === rName && gTime && rTime && Math.abs(gTime - rTime) <= 24 * 60 * 60 * 1000;
    });
    if (match?.name) {
      await conn('google_reviews').where({ id: review.id }).update({ gbp_review_name: match.name });
      return match.name;
    }
  } catch (lookupErr) {
    logger.warn(`GBP resource name lookup failed: ${lookupErr.message}`);
  }
  return null;
}

function updatedCount(updated) {
  return Array.isArray(updated) ? updated.length : updated;
}

/**
 * Publish a reply.
 *
 * @param {object} p
 * @param {string} p.reviewId
 * @param {string} p.text            final reply text (already verified by the caller's path)
 * @param {{type:'admin'|'ib'|'auto', adminUserId?:string|null}} p.actor
 * @param {boolean} [p.allowOverwrite=false]  humans may replace an existing Google reply; auto never does
 * @param {object} [p.autoFields]    extra google_reviews columns to stamp in the SAME conditional write (runner)
 * @param {object} [p.auditMeta]     activity_log metadata
 * @param {boolean} [p.requireGoogle=false]  refuse the dev local-only save (callers that report "posted")
 * @param {(fresh: object) => (string|null)} [p.guard]  re-checked INSIDE the publish claim,
 *        immediately before the Google call, against a fresh row read: return a reason
 *        string to abort (e.g. the caller's auto claim was lost to a human skip/dismiss)
 * @returns {Promise<{googlePosted:boolean, reviewId:string, localOnly:boolean}>}
 */
async function publishReviewReply({ reviewId, text, actor, allowOverwrite = false, autoFields = null, auditMeta = null, guard = null, requireGoogle = false }) {
  const replyText = String(text || '').trim();
  if (!replyText) throw new ReviewReplyError(CODES.EMPTY, 'Reply text required', { status: 400 });
  if (!actor?.type) throw new Error('publishReviewReply: actor.type required');

  const review = await db('google_reviews').where({ id: reviewId }).first();
  if (!review || review.reviewer_name === '_stats') throw new ReviewReplyError(CODES.NOT_FOUND, 'Review not found', { status: 404 });
  if (review.missing_since) throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
  if (!allowOverwrite && hasRealReply(review.review_reply)) {
    throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has a posted reply', { status: 409 });
  }

  const isAuto = actor.type === 'auto';
  const action = isAuto ? 'review_auto_replied' : 'review_replied';
  // No reviewer name here: activity_log is a log surface (AGENTS.md PII rule) — the id resolves it.
  const description = `${isAuto ? 'Auto-replied' : 'Replied'} to ${review.star_rating}-star review ${reviewId} on ${review.location_id}`;
  const audit = async (extra = {}) => {
    try {
      await db('activity_log').insert({
        admin_user_id: actor.adminUserId || null,
        action,
        description,
        metadata: JSON.stringify({ source: actor.type, reviewId, ...(auditMeta || {}), ...extra }),
      });
    } catch (err) {
      logger.warn(`[review-reply] audit insert failed: ${err.message}`);
    }
  };

  // Dev/preview without any GBP credentials: keep the historical local-only
  // behavior for HUMAN writers so the page still works. Automation never
  // fakes a post.
  if (!gbp.configured) {
    if (isAuto || requireGoogle) throw new ReviewReplyError(CODES.NOT_CONFIGURED, 'Google Business Profile is not configured — the reply cannot be posted', { status: 503 });
    const updated = await db('google_reviews')
      .where({ id: reviewId })
      .whereNull('missing_since')
      .update({ review_reply: replyText, reply_updated_at: new Date() });
    if (updatedCount(updated) === 0) throw new ReviewReplyError(CODES.RACE, 'This review was removed from Google while replying — the reply was not recorded locally.', { status: 409 });
    await audit({ googlePosted: false, localOnly: true });
    return { googlePosted: false, localOnly: true, reviewId };
  }

  if (!(await gbp.isLocationConfigured(review.location_id))) {
    throw new ReviewReplyError(CODES.NOT_CONFIGURED, `Google Business Profile is not connected for ${review.location_id}`, { status: 503 });
  }

  const resourceName = await resolveGbpReviewName(review);
  if (!resourceName) {
    throw new ReviewReplyError(CODES.NO_RESOURCE, 'Could not match this review on Google — reply not posted.', { status: 502 });
  }

  const { publishWithReviewLivenessLock } = require('../social-content-studio');
  let outcome;
  let googleError = null;
  try {
    outcome = await publishWithReviewLivenessLock(reviewId, async () => {
      // Ownership recheck INSIDE the publish claim, on a fresh read: the
      // pre-checks above ran before the claim, and a human reply, an admin
      // skip, or a dismissal can land in that gap. A stale invocation must
      // abort here rather than overwrite what a person just posted.
      const fresh = await db('google_reviews').where({ id: reviewId }).first();
      if (!fresh || fresh.missing_since) throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
      if (!allowOverwrite && hasRealReply(fresh.review_reply)) {
        throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has a posted reply', { status: 409 });
      }
      const staleReason = guard ? await guard(fresh) : null;
      if (staleReason) throw new ReviewReplyError(CODES.STALE, `Reply not posted: ${staleReason}`, { status: 409 });
      await gbp.replyToReview(resourceName, replyText, review.location_id);
      return true;
    });
  } catch (e) {
    if (e instanceof ReviewReplyError) throw e;
    googleError = e;
    logger.error(`Google reply failed: ${e.message}`);
  }
  if (googleError) throw new ReviewReplyError(CODES.GOOGLE_FAILED, googleError.message || 'Could not post reply to Google.', { status: 502, cause: googleError });
  if (!outcome) throw new ReviewReplyError(CODES.GOOGLE_FAILED, 'Could not post reply to Google.', { status: 502 });
  if (outcome.blocked) {
    if (outcome.lockBusy) throw new ReviewReplyError(CODES.LOCK_BUSY, 'Review sync is in progress for this location — try again in a moment.', { status: 409 });
    throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
  }

  let persisted = false;
  let abandoned = false;
  try {
    const updated = await db('google_reviews')
      .where({ id: reviewId })
      .whereNull('missing_since')
      .update({
        review_reply: replyText,
        reply_updated_at: db.fn.now(),
        ...(autoFields || {}),
      });
    if (updatedCount(updated) === 0) {
      // Defensive only — unreachable while the claim defers stamping.
      throw new ReviewReplyError(CODES.RACE, 'This review was removed from Google while replying — the reply was not recorded locally.', { status: 409 });
    }
    persisted = true;
    await audit({ googlePosted: true });
    return { googlePosted: true, localOnly: false, reviewId };
  } catch (err) {
    if (persisted || err instanceof ReviewReplyError) throw err;
    // Google ACCEPTED the reply but the local record failed. Releasing the
    // claim here would let an automatic retry redraft and PUT a different
    // reply over the live one. Abandon instead: the claim stands until its
    // TTL expires, and the caller parks the row for a person to reconcile.
    outcome.abandonClaim();
    abandoned = true;
    logger.error(`[review-reply] Google accepted the reply for ${reviewId} but local persistence failed: ${err.message}`);
    throw new ReviewReplyError(CODES.PERSIST_FAILED, `Reply is live on Google but was not recorded locally (${err.message}) — reconcile by hand.`, { status: 500, cause: err });
  } finally {
    if (!abandoned) await outcome.releaseClaim();
  }
}

/**
 * Delete the owner reply on Google and clear it locally. Used by the admin
 * "Retract" action on auto-posted replies (and available to any human path).
 */
async function retractReviewReply({ reviewId, actor, autoFields = null, auditMeta = null }) {
  const review = await db('google_reviews').where({ id: reviewId }).first();
  if (!review || review.reviewer_name === '_stats') throw new ReviewReplyError(CODES.NOT_FOUND, 'Review not found', { status: 404 });
  if (!hasRealReply(review.review_reply)) throw new ReviewReplyError(CODES.HAS_REPLY, 'This review has no posted reply to retract', { status: 409 });
  if (!gbp.configured || !(await gbp.isLocationConfigured(review.location_id))) {
    throw new ReviewReplyError(CODES.NOT_CONFIGURED, `Google Business Profile is not connected for ${review.location_id}`, { status: 503 });
  }
  const resourceName = await resolveGbpReviewName(review);
  if (!resourceName) throw new ReviewReplyError(CODES.NO_RESOURCE, 'Could not match this review on Google — reply not retracted.', { status: 502 });

  const { publishWithReviewLivenessLock } = require('../social-content-studio');
  let outcome;
  try {
    outcome = await publishWithReviewLivenessLock(reviewId, async () => {
      // Re-read inside the claim: another admin may have posted an edited
      // replacement first. Only the reply the retracting admin actually saw
      // may be deleted.
      const fresh = await db('google_reviews').where({ id: reviewId }).first();
      if (!fresh || fresh.missing_since) throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
      if (String(fresh.review_reply || '') !== String(review.review_reply || '')) {
        throw new ReviewReplyError(CODES.STALE, 'The reply changed while you were retracting — reload and check the current reply.', { status: 409 });
      }
      await gbp.deleteReply(resourceName, review.location_id);
      return true;
    });
  } catch (e) {
    if (e instanceof ReviewReplyError) throw e;
    throw new ReviewReplyError(CODES.GOOGLE_FAILED, e.message || 'Could not delete the reply on Google.', { status: 502, cause: e });
  }
  if (outcome.blocked) {
    if (outcome.lockBusy) throw new ReviewReplyError(CODES.LOCK_BUSY, 'Review sync is in progress for this location — try again in a moment.', { status: 409 });
    // Stamped rows are retained as evidence for missing-review support
    // cases — the recorded reply stays as it was. Nothing to delete on Google.
    throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
  }
  try {
    await db('google_reviews').where({ id: reviewId }).update({ review_reply: null, reply_updated_at: null, ...(autoFields || {}) });
    try {
      await db('activity_log').insert({
        admin_user_id: actor?.adminUserId || null,
        action: 'review_reply_retracted',
        description: `Retracted the reply on ${review.star_rating}-star review ${reviewId} on ${review.location_id}`,
        metadata: JSON.stringify({ source: actor?.type || 'admin', reviewId, ...(auditMeta || {}) }),
      });
    } catch (err) {
      logger.warn(`[review-reply] audit insert failed: ${err.message}`);
    }
    return { googleDeleted: true, reviewId };
  } finally {
    await outcome.releaseClaim();
  }
}

module.exports = {
  CODES,
  ReviewReplyError,
  resolveGbpReviewName,
  publishReviewReply,
  retractReviewReply,
};
