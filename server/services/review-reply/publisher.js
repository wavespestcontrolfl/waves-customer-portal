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
const { hasRealReply, asDraft, isDraftReply, stripDraftPrefix, removedOwnerReplyFields } = require('./draft-prefix');
const { reviewFingerprint } = require('./fingerprint');

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
  REVIEW_CHANGED: 'review_changed',
  GOOGLE_UNCERTAIN: 'google_uncertain',
};

const MISSING_MSG = 'This review has been removed from Google — replies are disabled.';
// Total deadline for each Google call. The runner processes rows serially
// under a fleet-wide cron lease; a request that connects but never completes
// must fail (retryable) instead of holding every later row and tick.
const GOOGLE_CALL_TIMEOUT_MS = Math.max(5000, parseInt(process.env.REVIEW_REPLY_GOOGLE_TIMEOUT_MS, 10) || 30000);
// The call is given an AbortSignal and ABORTED at the deadline — the socket
// is closed, so a late completion cannot land after the claim TTL. (Google
// may still have applied a mutation whose request body was fully received;
// that residual uncertainty is why timed-out writes park for reconciliation.)
function withDeadline(call, label, ms = GOOGLE_CALL_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.timedOut = true;
      controller.abort(e);
      reject(e);
    }, ms);
  });
  timer.unref?.();
  return Promise.race([call(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

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
    // GBP caps pageSize at 50; the helper pages until exhausted.
    const gbpReviews = await withDeadline(() => gbp.getAllLocationReviews(loc.googleLocationResourceName, review.location_id, 50), 'GBP getAllLocationReviews', GOOGLE_CALL_TIMEOUT_MS * 2);
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

// Record the owner reply Google currently shows so the row leaves the
// needs-reply queue, and close any pending pipeline state (a drafted/parked
// row would otherwise sit labeled "Shadow draft / Needs you" beside the real
// reply forever — the cron never reclaims those statuses).
/**
 * True when the LIVE Google review (rating / text / reviewer) differs from
 * the synced row. Rating compares only when Google returned one.
 */
function liveReviewChanged(live, row) {
  const liveRating = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[String(live?.starRating || '').toUpperCase()] || Number(live?.starRating) || 0;
  const liveText = String(live?.comment || '').trim();
  const liveName = String(live?.reviewer?.displayName || '').trim().toLowerCase();
  return (live?.starRating != null && liveRating !== (Number(row.star_rating) || 0))
    || liveText !== String(row.review_text || '').trim()
    || (!!liveName && liveName !== String(row.reviewer_name || '').trim().toLowerCase());
}

async function recordLiveOwnerReply(reviewId, live, fresh) {
  const liveReply = String(live?.reviewReply?.comment || '').trim();
  if (!liveReply) return;
  // ONE status writer for "Google shows an owner reply" (codex r37): the
  // sync's syncReplyFields — pending states close as owner_replied_on_google,
  // a POSTED automatic reply the owner edited on Google closes as
  // skipped/edited_on_google (Retract must not delete their edit), a
  // reconciliation park whose live text is our draft closes as posted. The
  // publish claim we hold is ours, so the snapshot is judged without it.
  const { syncReplyFields } = require('./runner');
  const fields = syncReplyFields({ ...(fresh || {}), publish_claimed_until: null }, { owner_reply: liveReply, owner_reply_updated_at: live.reviewReply?.updateTime || new Date().toISOString() });
  await db('google_reviews').where({ id: reviewId }).whereNull('missing_since')
    .update({ ...fields, auto_reply_claimed_until: null })
    .catch((e) => logger.warn(`[review-reply] live owner reply record failed for ${reviewId}: ${e.message}`));
}

async function recordLiveOwnerReplyRemoved(reviewId, fresh) {
  const fields = removedOwnerReplyFields(fresh);
  if (!Object.keys(fields).length) return;
  // Compare-and-set on the reply this call observed (we hold the publish
  // claim, so no sync writes concurrently; a "[DRAFT]" is never touched).
  await db('google_reviews').where({ id: reviewId, review_reply: fresh.review_reply }).whereNull('missing_since')
    .update(fields)
    .catch((e) => logger.warn(`[review-reply] live owner reply removal record failed for ${reviewId}: ${e.message}`));
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
async function publishReviewReply({ reviewId, text, actor, allowOverwrite = false, autoFields = null, auditMeta = null, guard = null, requireGoogle = false, expectedReply = undefined, expectedDraft = undefined, expectedReview = undefined }) {
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

  // Review content identity as seen INSIDE the claim before the PUT; the
  // post-PUT persist compares against it (a sync can record a reviewer
  // edit while the PUT is in flight — applyReviewEditFields defers under a
  // live claim, so this write is the only place that can notice).
  let prePutFingerprint = null;
  let prePutContent = null;
  // Predicate: the row's review CONTENT still equals the pre-check snapshot
  // (rating / text / reviewer / attribution). Used to make the persist a
  // compare-and-set on the review the reply was written for.
  const whereSameContent = (qb, snap) => {
    if (snap.star_rating == null) qb.whereNull('star_rating'); else qb.where('star_rating', snap.star_rating);
    if (snap.review_text == null) qb.whereNull('review_text'); else qb.where('review_text', snap.review_text);
    if (snap.reviewer_name == null) qb.whereNull('reviewer_name'); else qb.where('reviewer_name', snap.reviewer_name);
    if (snap.customer_id == null) qb.whereNull('customer_id'); else qb.where('customer_id', snap.customer_id);
  };
  // Row-state checks shared by the Google path (run INSIDE the publish
  // claim on a fresh read) and the dev/preview local-only path below: the
  // browser-observed reply / draft / review tokens, overwrite rules, the
  // foreign-draft rule and the caller's guard apply to BOTH writes.
  const inClaimChecks = async (fresh) => {
    if (!fresh || fresh.missing_since) throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
    prePutFingerprint = reviewFingerprint(fresh);
    prePutContent = { star_rating: fresh.star_rating, review_text: fresh.review_text, reviewer_name: fresh.reviewer_name, customer_id: fresh.customer_id };
    // The review CONTENT the browser displayed (codex r33): manually
    // written text carries no draft token, so the editor sends the review
    // token from the list API; a reviewer rewrite the sync recorded since
    // the page loaded must not receive text written for the old review.
    if (expectedReview !== undefined && String(expectedReview || '') !== prePutFingerprint) {
      throw new ReviewReplyError(CODES.REVIEW_CHANGED, 'The review changed since this page was loaded — reload it and read the current review first.', { status: 409 });
    }
    if (!allowOverwrite && hasRealReply(fresh.review_reply)) {
      throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has a posted reply', { status: 409 });
    }
    // A "[DRAFT]" that is not the pipeline's own is a person's saved draft:
    // a non-overwriting caller never posts over it (fail BEFORE the PUT).
    if (!allowOverwrite && isDraftReply(fresh.review_reply)) {
      const own = new Set([review.auto_reply_draft, autoFields?.auto_reply_draft, replyText].filter(Boolean).map((t) => String(t).trim()));
      if (!own.has(stripDraftPrefix(fresh.review_reply))) {
        throw new ReviewReplyError(CODES.STALE, 'A saved draft is on this review — post it from the editor or clear it first.', { status: 409 });
      }
    }
    // The reply the BROWSER observed (codex r27): the row read at request
    // start may already carry an owner edit the hourly sync recorded after
    // the page loaded, which the live GET would then agree with. A caller
    // that says what it saw is held to it; a mismatch means reload.
    if (expectedReply !== undefined) {
      const observed = String(expectedReply || '').trim();
      const current = hasRealReply(fresh.review_reply) ? String(fresh.review_reply).trim() : '';
      if (observed !== current) {
        throw new ReviewReplyError(CODES.STALE, 'The reply changed since this page was loaded — reload it and try again.', { status: 409 });
      }
    }
    // …and the DRAFT slot it observed (codex r30): a human "[DRAFT]" the
    // editor was seeded from may have been replaced meanwhile (Agent Ops,
    // another admin); the stale editor must not post over the newer one.
    if (expectedDraft !== undefined) {
      const observedDraft = String(expectedDraft || '').trim();
      const currentDraft = isDraftReply(fresh.review_reply) ? stripDraftPrefix(fresh.review_reply).trim() : '';
      if (observedDraft !== currentDraft) {
        throw new ReviewReplyError(CODES.STALE, 'The saved draft on this review changed since this page was loaded — reload it and try again.', { status: 409 });
      }
    }
    const staleReason = guard ? await guard(fresh) : null;
    if (staleReason) throw new ReviewReplyError(CODES.STALE, `Reply not posted: ${staleReason}`, { status: 409 });
  };

  // Dev/preview without any GBP credentials: keep the historical local-only
  // behavior for HUMAN writers so the page still works. Automation never
  // fakes a post. The SAME row checks apply (hook P1): a stale editor or IB
  // request must not overwrite a newer local reply or post text grounded on
  // an earlier review here either; the write is a CAS on the observed slot.
  if (!gbp.configured) {
    if (isAuto || requireGoogle) throw new ReviewReplyError(CODES.NOT_CONFIGURED, 'Google Business Profile is not configured — the reply cannot be posted', { status: 503 });
    const fresh = await db('google_reviews').where({ id: reviewId }).first();
    await inClaimChecks(fresh);
    const updated = await db('google_reviews')
      .where({ id: reviewId })
      .whereNull('missing_since')
      .modify((qb) => { if (fresh.review_reply == null) qb.whereNull('review_reply'); else qb.where('review_reply', fresh.review_reply); })
      // …and on the review content the checks ran against (codex r36).
      .modify((qb) => whereSameContent(qb, prePutContent))
      // Pipeline state closes here too (a shadow draft posted from the editor
      // in a dev/preview env must not stay 'drafted' beside a real reply).
      .update({ review_reply: replyText, reply_updated_at: new Date(), ...(autoFields || {}) });
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
      await inClaimChecks(fresh);
      if (!allowOverwrite) {
        // Non-overwriting callers (automation) also check Google's LIVE
        // resource: an owner reply written in Google after the last sync is
        // invisible locally, and the PUT would replace it. Fail closed on a
        // read error — the row retries later.
        let live;
        try {
          live = await withDeadline((signal) => gbp.getReview(resourceName, review.location_id, { signal }), 'GBP getReview');
        } catch (e) {
          throw new ReviewReplyError(CODES.GOOGLE_FAILED, `Could not read the live review before posting: ${e.message}`, { status: 502, cause: e });
        }
        const liveReply = String(live?.reviewReply?.comment || '').trim();
        if (liveReply) {
          await recordLiveOwnerReply(reviewId, live, fresh);
          throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has an owner reply on Google', { status: 409 });
        }
        // The LIVE review itself must still be the one the reply was drafted
        // for: a reviewer edit after the last sync (5★ praise → 1★ complaint,
        // rewritten text, renamed account) is invisible locally.
        if (liveReviewChanged(live, fresh)) {
          throw new ReviewReplyError(CODES.REVIEW_CHANGED, 'The review changed on Google since it was synced — reply not posted.', { status: 409 });
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
      if (allowOverwrite) {
        // Overwriting (human / IB) callers work from the row as it was
        // synced: a reply the owner wrote or edited directly in Google since
        // then is invisible locally and this PUT would replace it unseen.
        // The live reply must match what this call observed locally; on a
        // mismatch record Google's text and make the person reload.
        let live;
        try {
          live = await withDeadline((signal) => gbp.getReview(resourceName, review.location_id, { signal }), 'GBP getReview');
        } catch (e) {
          throw new ReviewReplyError(CODES.GOOGLE_FAILED, `Could not read the live review before posting: ${e.message}`, { status: 502, cause: e });
        }
        const liveReply = String(live?.reviewReply?.comment || '').trim();
        const seenReply = expectedReply !== undefined
          ? String(expectedReply || '').trim()
          : (hasRealReply(review.review_reply) ? String(review.review_reply).trim() : '');
        if (liveReply !== seenReply) {
          if (liveReply) {
            await recordLiveOwnerReply(reviewId, live, fresh);
            throw new ReviewReplyError(CODES.STALE, 'The reply on Google changed since this review was loaded — reload it and try again.', { status: 409 });
          }
          // The owner deleted the reply directly in Google: a stale editor
          // must not recreate what they deliberately removed. Record the
          // removal (same fields the sync writes) and make them reload.
          await recordLiveOwnerReplyRemoved(reviewId, fresh);
          throw new ReviewReplyError(CODES.STALE, 'The reply on Google was removed since this review was loaded — reload it and try again.', { status: 409 });
        }
        // The review itself must also still be the one the person wrote
        // for: a reviewer rewrite on Google after the page loaded (praise →
        // complaint) is invisible locally, and the wording would attach to
        // the new text. Same comparison as the automation branch.
        if (liveReviewChanged(live, fresh)) {
          throw new ReviewReplyError(CODES.REVIEW_CHANGED, 'The review changed on Google since it was synced — reload it and try again.', { status: 409 });
        }
        // The live GET is a network round-trip (up to the Google deadline);
        // a re-attribution or a grounded-fact correction can land during it
        // and the pipelineDraftGuard verdict above is then stale. Re-read
        // the row and run the guard again IMMEDIATELY before the PUT, as
        // the non-overwrite branch does.
        if (guard) {
          const again = await db('google_reviews').where({ id: reviewId }).first();
          if (!again || again.missing_since) throw new ReviewReplyError(CODES.MISSING, MISSING_MSG, { status: 409 });
          const lateReason = await guard(again);
          if (lateReason) throw new ReviewReplyError(CODES.STALE, `Reply not posted: ${lateReason}`, { status: 409 });
        }
      }
      try {
        await withDeadline((signal) => gbp.replyToReview(resourceName, replyText, review.location_id, { signal }), 'GBP replyToReview');
      } catch (e) {
        // A timed-out PUT is still IN FLIGHT and may land later. Throwing
        // here would make the lock helper release the publish claim (and a
        // human could publish a replacement the late PUT then overwrites).
        // Return a disposition instead; the claim is abandoned OUTSIDE the
        // callback, where `outcome` exists.
        if (e.timedOut) return { timedOut: true, error: e };
        throw e;
      }
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
  if (outcome.result && outcome.result.timedOut) {
    // The write may still land. Neither "posted" nor "failed" is provable:
    // ABANDON the claim (it stands until its TTL, so nothing else can
    // publish over the in-flight PUT), never retry blindly, and hand the
    // row to a person — the next sync shows the truth. Compare-and-set
    // against the state THIS attempt owned.
    const e = outcome.result.error;
    outcome.abandonClaim();
    const uncertain = { auto_reply_status: 'parked', auto_reply_reason: 'google_uncertain', auto_reply_error: String(e.message).slice(0, 1000) };
    const q = db('google_reviews').where({ id: reviewId });
    if (allowOverwrite) {
      // Human / IB-edit publishers: the row may be never-queued (NULL) or
      // skipped/manual_reply with a real prior reply — CAS on the reply
      // slot exactly as this attempt observed it, so a sync that already
      // reconciled a newer reply is left alone.
      if (review.review_reply == null) q.whereNull('review_reply'); else q.where('review_reply', review.review_reply);
    } else {
      // NULL (never queued — e.g. an IB submission) must match too: SQL
      // NOT IN never matches NULL.
      q.where(function stateOwned() { this.whereNull('auto_reply_status').orWhereNotIn('auto_reply_status', ['posted', 'skipped', 'retracted']); })
        .where(function ownSlot() {
          this.whereNull('review_reply');
          if (review.auto_reply_draft) this.orWhere('review_reply', asDraft(review.auto_reply_draft));
          if (autoFields?.auto_reply_draft) this.orWhere('review_reply', asDraft(autoFields.auto_reply_draft));
          this.orWhere('review_reply', asDraft(replyText));
        });
    }
    await q.update(uncertain)
      .catch((e2) => logger.error(`[review-reply] google_uncertain park failed for ${reviewId}: ${e2.message}`));
    logger.error(`[review-reply] Google PUT timed out for ${reviewId} — outcome unknown, claim abandoned, parked for reconciliation`);
    throw new ReviewReplyError(CODES.GOOGLE_UNCERTAIN, `${e.message} — the reply may be live on Google; reconcile after the next sync.`, { status: 502, cause: e });
  }

  let persisted = false;
  let abandoned = false;
  let editedDuringPut = false;
  try {
    // The persist is a compare-and-set on the review CONTENT the reply was
    // written for (codex r36): the clean 'posted' write applies only while
    // rating / text / reviewer / attribution still equal the pre-PUT
    // snapshot. Zero rows with the row still live means a sync recorded a
    // reviewer edit while the PUT was in flight (its own reconciliation
    // defers under our claim): record the reply as parked/
    // review_edited_after_post instead (never a clean 'posted') and ring
    // the same action bell the sync would have.
    const base = () => db('google_reviews')
      .where({ id: reviewId })
      .whereNull('missing_since')
      // Non-overwriting callers: the reply slot must still be empty or the
      // pipeline's own draft — a human "[DRAFT]" saved while the PUT was in
      // flight is not overwritten (zero rows → PERSIST_FAILED → reconcile).
      .modify((qb) => {
        if (allowOverwrite) return;
        qb.where(function ownSlot() {
          this.whereNull('review_reply');
          if (review.auto_reply_draft) this.orWhere('review_reply', asDraft(review.auto_reply_draft));
          if (autoFields?.auto_reply_draft) this.orWhere('review_reply', asDraft(autoFields.auto_reply_draft));
          this.orWhere('review_reply', asDraft(replyText));
        });
      });
    const clean = { review_reply: replyText, reply_updated_at: db.fn.now(), ...(autoFields || {}) };
    let current = null;
    // Account-derived facts the draft was grounded on (city, relationship,
    // categories) can change without the review fingerprint moving (codex
    // r38): compare the current account fingerprint with the snapshot the
    // pipeline stamped; a mismatch — or a failed read — parks instead of
    // recording a clean 'posted'. Only pipeline drafts carry a snapshot.
    let accountStale = false;
    let accountCause = null;
    const snapshot = (() => { try { return autoFields?.auto_reply_grounding ? JSON.parse(autoFields.auto_reply_grounding) : null; } catch { return null; } })();
    if (snapshot?.accountFingerprint) {
      try {
        const { accountFingerprint, loadAccountFacts, groundingCustomerId } = require('./grounding');
        const row = await db('google_reviews').where({ id: reviewId }).first();
        const nowFp = accountFingerprint(await loadAccountFacts(groundingCustomerId(row)));
        if (nowFp !== snapshot.accountFingerprint) { accountStale = true; accountCause = 'account facts changed'; }
      } catch (e) {
        accountStale = true; accountCause = `account facts could not be re-read (${e.message})`;
      }
    }
    let updated = accountStale ? 0 : await base().modify((qb) => whereSameContent(qb, prePutContent)).update(clean);
    if (updatedCount(updated) === 0) {
      current = await db('google_reviews').where({ id: reviewId }).first();
      if (current && !current.missing_since && (accountStale || reviewFingerprint(current) !== prePutFingerprint)) {
        editedDuringPut = true;
        if (accountStale) logger.warn(`[review-reply] ${reviewId}: ${accountCause} while the reply posted — parked for a person`);
        // Only a PIPELINE-owned reply (automation, or Post now stamping
        // 'posted') takes the automatic park — a human's reply keeps the
        // caller's own close fields so the UI never offers auto-reply
        // Retract for it (hook P1). The bell rings for both.
        const pipelineOwned = isAuto || autoFields?.auto_reply_status === 'posted';
        const stamp = pipelineOwned ? { auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', auto_reply_claimed_until: null } : {};
        updated = await base().update({ ...clean, ...stamp });
      }
    }
    if (updatedCount(updated) === 0) {
      // Defensive only — unreachable while the claim defers stamping.
      throw new ReviewReplyError(CODES.RACE, 'This review was removed from Google while replying — the reply was not recorded locally.', { status: 409 });
    }
    persisted = true;
    await audit({ googlePosted: true, editedDuringPut });
    if (editedDuringPut) {
      const locName = (WAVES_LOCATIONS.find((l) => l.id === review.location_id) || {}).name || review.location_id;
      const NotificationService = require('../notification-service');
      await NotificationService.notifyAdmin('review', 'Review edited while the reply posted', `${current.star_rating}★ review on ${locName} was edited by the reviewer while our reply was being posted — check whether the reply still fits (edit or retract).`, {
        link: `/admin/reviews?responded=all&review=${encodeURIComponent(reviewId)}`,
        bell: true,
        dedupeKey: `review-auto-reply:${reviewId}:review_edited_after_post`,
        metadata: { reason: 'review_edited_after_post', reviewId, locationId: review.location_id, needsAction: true },
      }).catch((e) => logger.warn(`[review-reply] edited-during-put bell failed for ${reviewId}: ${e.message}`));
    }
    return { googlePosted: true, localOnly: false, reviewId, editedDuringPut };
  } catch (err) {
    if (persisted) throw err;
    // Google ACCEPTED the reply but the local record failed (a thrown DB
    // error OR the zero-row RACE — either way the reply is live and
    // unrecorded). Releasing the
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
  // Retract exists for replies the PIPELINE posted. A human's reply (or one
  // the owner edited in Google, which closes the posted state) is edited or
  // deleted through the editor, never through this shortcut.
  // Still the pipeline's reply: posted, or parked because the REVIEW was
  // edited after we posted (the reply itself is untouched and retracting it
  // is exactly the remedy that bell asks for).
  const pipelinesReply = review.auto_reply_status === 'posted'
    || (review.auto_reply_status === 'parked' && review.auto_reply_reason === 'review_edited_after_post');
  if (!pipelinesReply) {
    throw new ReviewReplyError(CODES.STALE, 'Only an automatically posted reply can be retracted here — this reply is not (or no longer) the pipeline\'s.', { status: 409 });
  }
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
        live = await withDeadline((signal) => gbp.getReview(resourceName, review.location_id, { signal }), 'GBP getReview');
      } catch (e) {
        throw new ReviewReplyError(CODES.GOOGLE_FAILED, `Could not read the live review before retracting: ${e.message}`, { status: 502, cause: e });
      }
      const liveReply = String(live?.reviewReply?.comment || '').trim();
      if (liveReply !== String(review.review_reply || '').trim()) {
        // Record what Google has AND close the posted state: the owner
        // edited (or removed) the reply in Google, so it is no longer the
        // pipeline's — a repeat Retract must not delete the human edit.
        await db('google_reviews').where({ id: reviewId }).whereNull('missing_since')
          .update(liveReply
            ? { review_reply: liveReply, reply_updated_at: live.reviewReply?.updateTime || new Date().toISOString(), auto_reply_status: 'skipped', auto_reply_reason: 'edited_on_google' }
            : { review_reply: null, reply_updated_at: null, auto_reply_status: 'retracted', auto_reply_reason: 'removed_on_google' })
          .catch((e) => logger.warn(`[review-reply] live owner reply record failed for ${reviewId}: ${e.message}`));
        throw new ReviewReplyError(CODES.STALE, liveReply
          ? 'The reply on Google differs from the one shown here (edited in Google) — reload and check the current reply.'
          : 'There is no reply on Google to retract — reload.', { status: 409 });
      }
      try {
        await withDeadline((signal) => gbp.deleteReply(resourceName, review.location_id, { signal }), 'GBP deleteReply');
      } catch (e) {
        if (e.timedOut) return { timedOut: true, error: e };
        throw e;
      }
      return true;
    });
  } catch (e) {
    if (e instanceof ReviewReplyError) throw e;
    throw new ReviewReplyError(CODES.GOOGLE_FAILED, e.message || 'Could not delete the reply on Google.', { status: 502, cause: e });
  }
  if (!outcome.blocked && outcome.result && outcome.result.timedOut) {
    // The DELETE may still land: abandon the claim (nothing publishes a
    // replacement it could later erase) and surface the uncertainty.
    const e = outcome.result.error;
    outcome.abandonClaim();
    throw new ReviewReplyError(CODES.GOOGLE_UNCERTAIN, `${e.message} — the deletion may have landed; reload after the next sync before retrying.`, { status: 502, cause: e });
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
