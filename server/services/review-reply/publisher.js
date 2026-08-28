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
 * Resolve (and persist) the GBP review resource name when the row lacks one.
 * Two reviewers can share a display name, so a match must be UNAMBIGUOUS:
 * exactly one live review with the same display name within 24h of the
 * stored time whose rating and comment text also match. Anything else
 * resolves to null (NO_RESOURCE) — a reply must never land on the wrong
 * review. (The original admin-route fallback accepted the first same-name
 * review; that lenience is gone for every caller.)
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
    const rRating = Number(review.star_rating) || 0;
    const rText = String(review.review_text || '').trim();
    const ratingOf = (g) => ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[String(g.starRating || '').toUpperCase()] || Number(g.starRating) || 0);
    const candidates = gbpReviews.filter((g) => {
      const gName = (g.reviewer?.displayName || '').toLowerCase();
      const gTime = g.createTime ? new Date(g.createTime).getTime() : 0;
      return gName === rName && gTime && rTime && Math.abs(gTime - rTime) <= 24 * 60 * 60 * 1000
        && ratingOf(g) === rRating
        && String(g.comment || '').trim() === rText;
    });
    if (candidates.length === 1 && candidates[0].name) {
      await conn('google_reviews').where({ id: review.id }).update({ gbp_review_name: candidates[0].name });
      return candidates[0].name;
    }
    if (candidates.length > 1) logger.warn(`GBP resource name lookup ambiguous for review ${review.id} (${candidates.length} candidates) — not resolved`);
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
      if (!allowOverwrite) {
        // Non-overwriting callers (automation) also check Google's LIVE
        // resource: an owner reply written in Google after the last sync is
        // invisible locally, and the PUT would replace it. Fail closed on a
        // read error — the row retries later.
        let live;
        try {
          live = await gbp.getReview(resourceName, review.location_id);
        } catch (e) {
          throw new ReviewReplyError(CODES.GOOGLE_FAILED, `Could not read the live review before posting: ${e.message}`, { status: 502, cause: e });
        }
        const liveReply = String(live?.reviewReply?.comment || '').trim();
        if (liveReply) {
          // Record what Google has so the row leaves the needs-reply queue.
          await db('google_reviews').where({ id: reviewId }).whereNull('missing_since')
            .update({ review_reply: liveReply, reply_updated_at: live.reviewReply?.updateTime || new Date().toISOString() })
            .catch((e) => logger.warn(`[review-reply] live owner reply record failed for ${reviewId}: ${e.message}`));
          throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has an owner reply on Google', { status: 409 });
        }
        // The live GET is a network round-trip; an admin skip/dismiss can
        // land during it. Re-run the ownership guard on a fresh read
        // IMMEDIATELY before the PUT so that window cannot post over a
        // cancellation.
        if (guard) {
          const again = await db('google_reviews').where({ id: reviewId }).first();
          if (!again || again.missing_since) throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
          if (hasRealReply(again.review_reply)) throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has a posted reply', { status: 409 });
          const lateReason = await guard(again);
          if (lateReason) throw new ReviewReplyError(CODES.STALE, `Reply not posted: ${lateReason}`, { status: 409 });
        }
      }
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
    // Best effort for EVERY caller (manual route, IB, runner): take the row
    // out of the automatic lane so an expired claim cannot let the cron
    // reclaim it and replace the live reply. The runner adds its bell.
    await db('google_reviews').where({ id: reviewId })
      .update({ auto_reply_status: 'parked', auto_reply_reason: 'persist_failed', auto_reply_error: String(err.message || '').slice(0, 1000), auto_reply_claimed_until: null })
      .catch((e2) => logger.error(`[review-reply] persist_failed park also failed for ${reviewId}: ${e2.message}`));
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
      // And Google's LIVE reply must be the one the admin confirmed: an owner
      // edit made directly in GBP after the last sync is invisible locally,
      // and deleting blind would destroy it. Fail closed on a read error.
      let live;
      try {
        live = await gbp.getReview(resourceName, review.location_id);
      } catch (e) {
        throw new ReviewReplyError(CODES.GOOGLE_FAILED, `Could not read the live review before retracting: ${e.message}`, { status: 502, cause: e });
      }
      const liveReply = String(live?.reviewReply?.comment || '').trim();
      if (liveReply !== String(review.review_reply || '').trim()) {
        if (liveReply) {
          await db('google_reviews').where({ id: reviewId }).whereNull('missing_since')
            .update({ review_reply: liveReply, reply_updated_at: live.reviewReply?.updateTime || new Date().toISOString() })
            .catch((e) => logger.warn(`[review-reply] live owner reply record failed for ${reviewId}: ${e.message}`));
        }
        throw new ReviewReplyError(CODES.STALE, liveReply
          ? 'The reply on Google differs from the one shown here (edited in Google) — reload and check the current reply.'
          : 'There is no reply on Google to retract — reload.', { status: 409 });
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
  let abandoned = false;
  try {
    try {
      await db('google_reviews').where({ id: reviewId }).update({ review_reply: null, reply_updated_at: null, ...(autoFields || {}) });
    } catch (err) {
      // Google already deleted the reply; the local row still shows it as
      // live. Mirror publishReviewReply: abandon the claim (self-expires) and
      // surface a reconciliation error rather than a clean failure that
      // invites a repeat DELETE.
      outcome.abandonClaim();
      abandoned = true;
      logger.error(`[review-reply] reply deleted on Google for ${reviewId} but local clear failed: ${err.message}`);
      throw new ReviewReplyError(CODES.PERSIST_FAILED, `The reply was deleted on Google but the local record was not updated (${err.message}) — reload and reconcile by hand.`, { status: 500, cause: err });
    }
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
    if (!abandoned) await outcome.releaseClaim();
  }
}

module.exports = {
  CODES,
  ReviewReplyError,
  resolveGbpReviewName,
  publishReviewReply,
  retractReviewReply,
};
