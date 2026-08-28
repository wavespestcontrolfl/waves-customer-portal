/**
 * Auto-reply runner — queues newly synced Google reviews and, once their
 * jittered due time passes, drafts (grounding.js + drafter.js) and either
 * parks the draft for a human, stores it as a shadow draft, or publishes it
 * through publisher.js.
 *
 * Gate: GATE_REVIEW_AUTO_REPLY = off (default) | shadow | auto
 *   off    — nothing is queued or drafted (kill switch; queued rows wait)
 *   shadow — drafts land as "[DRAFT] …" in review_reply (existing needs-reply
 *            queue + Agent Ops card + "Use Draft" button), nothing posts
 *   auto   — 4-5★ replies post to Google; 1-3★ and unrated always park
 *
 * Owner rulings 2026-08-27:
 *   - 1-3★ (and unrated) never auto-post: draft + park + bell.
 *   - Jitter anchored on Google's review creation time; already-overdue
 *     reviews (hourly sync lag) get a short clamped delay instead.
 *   - Unlinked 4-5★ reviews auto-reply from review-only context.
 *   - Deploy-forward only: only rows inserted by the sync AFTER this ships
 *     are queued; nothing historical is touched.
 *
 * Concurrency: rows are claimed with one atomic UPDATE … WHERE (status due,
 * claim expired) so two runner instances can never draft or publish the same
 * review; the publisher's liveness lock covers the Google side.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const gbp = require('../google-business');
const NotificationService = require('../notification-service');
const { WAVES_LOCATIONS } = require('../../config/locations');
const { hasRealReply, isDraftReply, asDraft, stripDraftPrefix } = require('./draft-prefix');
const { buildReplyGrounding, loadActiveTechFirstNames } = require('./grounding');
const { draftReviewReply, loadRecentPostedReplies, classifyReplyMode, REPLY_VERSION } = require('./drafter');
const { publishReviewReply, ReviewReplyError, CODES } = require('./publisher');

const STATUS = {
  QUEUED: 'queued',
  DRAFTED: 'drafted', // shadow draft written, nothing posted
  POSTED: 'posted',
  PARKED: 'parked', // needs a human (low rating, unrated, verifier, provider)
  SKIPPED: 'skipped', // nothing to do (already replied, removed, admin skip)
  FAILED: 'failed', // transient — will retry until MAX_ATTEMPTS
  RETRACTED: 'retracted',
};

const MAX_ATTEMPTS = 3;
const CLAIM_MS = 10 * 60 * 1000;
const RETRY_BACKOFF_MIN = 10;
// Clamp for reviews already past their jitter window at detection time.
const OVERDUE_DELAY_MIN = 5;
const OVERDUE_DELAY_MAX = 20;
const DEFAULT_BATCH = 10;

function mode() {
  const raw = String(process.env.GATE_REVIEW_AUTO_REPLY || '').trim().toLowerCase();
  if (raw === 'auto' || raw === 'shadow') return raw;
  return 'off';
}

function intEnv(name, fallback, { min = 0, max = 100000 } = {}) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function config() {
  const delayMin = intEnv('REVIEW_AUTO_REPLY_DELAY_MIN_MINUTES', 15, { min: 1, max: 24 * 60 });
  const delayMax = Math.max(delayMin, intEnv('REVIEW_AUTO_REPLY_DELAY_MAX_MINUTES', 180, { min: 1, max: 24 * 60 }));
  const locations = String(process.env.REVIEW_AUTO_REPLY_LOCATIONS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    mode: mode(),
    // Floor is 4: 1-3★ are human-only by owner ruling and cannot be
    // configured into auto-posting; the setting can only RAISE the bar to 5.
    minStars: intEnv('REVIEW_AUTO_REPLY_MIN_STARS', 4, { min: 4, max: 5 }),
    delayMin,
    delayMax,
    // Empty = every location with GBP credentials.
    locations,
  };
}

function randBetween(min, max, rand = Math.random) {
  return min + (max - min) * rand();
}

/**
 * Due time = review creation + rand(delayMin, delayMax) minutes; when that is
 * already in the past (the hourly sync found it late) clamp to a short delay
 * from now so the reply still lands soon, not instantly.
 */
function computeDueAt(reviewCreatedAt, { now = new Date(), cfg = config(), rand = Math.random } = {}) {
  const created = reviewCreatedAt ? new Date(reviewCreatedAt) : null;
  const anchor = created && !Number.isNaN(created.getTime()) ? created : now;
  const jittered = new Date(anchor.getTime() + randBetween(cfg.delayMin, cfg.delayMax, rand) * 60000);
  if (jittered.getTime() > now.getTime()) return jittered;
  return new Date(now.getTime() + randBetween(OVERDUE_DELAY_MIN, OVERDUE_DELAY_MAX, rand) * 60000);
}

function locationAllowed(locationId, cfg = config()) {
  if (!cfg.locations.length) return true;
  return cfg.locations.includes(String(locationId || '').toLowerCase());
}

/**
 * Columns the GBP sync merges INTO the insert of a brand-new review row, so
 * queueing is atomic with the insert (a post-insert hook that failed would
 * leave the row permanently unqueued — later syncs take the update path and
 * never retry). Returns {} when the review must not be queued. Deploy-forward
 * by construction: only inserts carry these fields.
 */
function autoReplyInsertFields({ location_id, reviewer_name, owner_reply, review_created_at, dismissed } = {}, { now = new Date(), cfg = config() } = {}) {
  if (cfg.mode === 'off') return {};
  if (!reviewer_name || reviewer_name === '_stats') return {};
  if (dismissed) return {};
  if (hasRealReply(owner_reply)) return {};
  if (!locationAllowed(location_id, cfg)) return {};
  return {
    auto_reply_status: STATUS.QUEUED,
    auto_reply_due_at: computeDueAt(review_created_at, { now, cfg }).toISOString(),
  };
}

/**
 * Atomically claim up to `limit` due rows. Postgres has no UPDATE … LIMIT, so
 * the candidate set is selected FOR UPDATE SKIP LOCKED and the claim stamp is
 * the ownership token (only the claimant's token releases it).
 */
async function claimDueRows({ limit = DEFAULT_BATCH, now = new Date(), force = null } = {}) {
  const token = new Date(now.getTime() + CLAIM_MS).toISOString();
  const nowIso = now.toISOString();
  const forceClause = force ? 'AND id = ?' : `AND auto_reply_status IN ('queued','failed') AND auto_reply_due_at <= ?`;
  // Rollout scope is re-applied at claim time (not only at enqueue) so
  // narrowing REVIEW_AUTO_REPLY_LOCATIONS immediately stops already-queued
  // rows outside it. Post-now (force) is an explicit admin action and ignores it.
  const cfg = config();
  const locClause = !force && cfg.locations.length ? 'AND lower(location_id) = ANY(?)' : '';
  const params = force ? [token, force, nowIso, limit] : [token, nowIso, ...(locClause ? [cfg.locations] : []), nowIso, limit];
  const res = await db.raw(
    `UPDATE google_reviews SET auto_reply_claimed_until = ?
     WHERE id IN (
       SELECT id FROM google_reviews
       WHERE reviewer_name <> '_stats'
         AND missing_since IS NULL
         AND COALESCE(dismissed, false) = false
         ${forceClause}
         ${locClause}
         AND (auto_reply_claimed_until IS NULL OR auto_reply_claimed_until < ?)
       ORDER BY auto_reply_due_at ASC NULLS LAST
       LIMIT ?
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    params,
  );
  return (res?.rows || []).map((r) => ({ ...r, _claimToken: token }));
}

async function releaseClaim(row, patch = {}) {
  await db('google_reviews')
    .where({ id: row.id, auto_reply_claimed_until: row._claimToken })
    .update({ auto_reply_claimed_until: null, ...patch });
}

// Ownership guard evaluated by the publisher INSIDE its publish claim, on a
// fresh row read: our claim token must still be on the row (an admin skip,
// a dismissal, or another worker clears/replaces it) and the row must not be
// dismissed. Any mismatch = this invocation is stale and must not post.
function claimGuard(row) {
  return (fresh) => {
    if (fresh.dismissed) return 'review was dismissed';
    const held = fresh.auto_reply_claimed_until ? new Date(fresh.auto_reply_claimed_until).toISOString() : null;
    if (held !== row._claimToken) return 'auto-reply claim was lost';
    // The draft was written for THIS rating and text. A reviewer edit the
    // sync applied meanwhile (a 5★ turned 2★, a rewritten body) makes the
    // draft stale — and may move the review under the human-only rule.
    if (Number(fresh.star_rating) !== Number(row.star_rating)
      || String(fresh.review_text || '').trim() !== String(row.review_text || '').trim()) return REVIEW_CHANGED;
    return null;
  };
}
const REVIEW_CHANGED = 'review changed while drafting';

// A "[DRAFT]" on review_reply that the pipeline did NOT write (Agent Ops
// template, an operator's saved draft) is a human intervention: the cron
// leaves it alone and Post-now publishes THAT text, never a fresh model draft.
function humanDraftOn(row) {
  if (!isDraftReply(row.review_reply)) return null;
  const text = stripDraftPrefix(row.review_reply);
  if (row.auto_reply_draft && text === String(row.auto_reply_draft).trim()) return null;
  return text || null;
}

function locationName(locationId) {
  return (WAVES_LOCATIONS.find((l) => l.id === locationId) || {}).name || locationId;
}

async function bell(row, { title, body, reason, action = false, extra = {}, link = null }) {
  try {
    await NotificationService.notifyAdmin('review', title, body, {
      // Parked/drafted rows live in the default needs-reply view; a posted
      // reply has left it, so those bells deep-link to the responded view
      // and the specific review.
      link: link || `/admin/reviews?review=${encodeURIComponent(row.id)}`,
      bell: true,
      dedupeKey: `review-auto-reply:${row.id}:${reason}`,
      metadata: {
        reason,
        reviewId: row.id,
        locationId: row.location_id,
        starRating: row.star_rating,
        needsAction: action,
        ...extra,
      },
    });
  } catch (err) {
    logger.warn(`[review-auto-reply] bell failed for ${row.id}: ${err.message}`);
  }
}

// Google has the reply; only the local record is missing. Never republish —
// park for a person to reconcile (the publish claim was abandoned by the
// publisher and self-expires, blocking competitors meanwhile). Used by both
// the cron path and Post-now.
async function parkPersistFailed(row, draft, err) {
  await db('google_reviews').where({ id: row.id }).update({
    auto_reply_status: STATUS.PARKED, auto_reply_reason: 'persist_failed', auto_reply_error: err.message,
    ...(draft?.text ? { auto_reply_draft: draft.text, auto_reply_version: draft.version || null, auto_reply_mode: draft.mode || null } : {}),
    auto_reply_claimed_until: null,
  }).catch((e2) => logger.error(`[review-auto-reply] persist_failed bookkeeping also failed for ${row.id}: ${e2.message}`));
  await bell(row, { title: 'Review reply needs reconciling', body: `${summarize(row)} — the reply is LIVE on Google but was not recorded here. Open Reviews and confirm it.`, reason: 'persist_failed', action: true });
}

function summarize(row) {
  return `${row.star_rating}★ from ${row.reviewer_name || 'a Google reviewer'} (${locationName(row.location_id)})`;
}

/**
 * Write the draft into review_reply as a local "[DRAFT]" when the row still
 * needs a real reply (never over a posted one), plus the auto_reply_* audit
 * columns. Conditional: the sync can stamp missing_since or pull a real
 * Google reply between our read and this write.
 */
async function storeDraft(row, draft, status, reason, extra = {}) {
  const patch = {
    auto_reply_status: status,
    auto_reply_reason: reason || null,
    // A failed attempt never erases an earlier verified draft on the row.
    ...(draft?.text ? {
      auto_reply_draft: draft.text,
      auto_reply_drafted_at: new Date().toISOString(),
      auto_reply_version: draft.version || null,
      auto_reply_mode: draft.mode || null,
    } : {}),
    auto_reply_error: draft?.ok === false ? JSON.stringify({ reason: draft.reason, rejections: draft.rejections, error: draft.error }) : null,
    auto_reply_grounding: JSON.stringify(extra.grounding || null),
    auto_reply_claimed_until: null,
  };
  if (draft?.text) {
    const updated = await db('google_reviews')
      .where({ id: row.id, auto_reply_claimed_until: row._claimToken })
      .whereNull('missing_since')
      .where(function ownDraftOrEmpty() {
        // Never over a human's draft: only an empty reply or the pipeline's
        // OWN previous draft may be replaced.
        this.whereNull('review_reply');
        if (row.auto_reply_draft) this.orWhere('review_reply', asDraft(row.auto_reply_draft));
      })
      .update({ ...patch, review_reply: asDraft(draft.text), reply_updated_at: null });
    if ((Array.isArray(updated) ? updated.length : updated) > 0) return true;
    // Lost the race (posted reply / stamped) — record state without the draft text.
    await releaseClaim(row, { ...patch, auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'changed_during_draft' });
    return false;
  }
  await releaseClaim(row, patch);
  return true;
}

// What a draft was written FOR. A stored draft may only be reused when the
// review's rating + text still hash to this.
function reviewFingerprint(row) {
  return crypto.createHash('sha1').update(`${Number(row.star_rating) || 0}|${String(row.review_text || '').trim()}`).digest('hex');
}

function groundingSnapshot(grounding) {
  // Everything the model saw, minus the review text itself (already on the row).
  return {
    version: grounding.version,
    fingerprint: crypto.createHash('sha1').update(`${Number(grounding.review.rating) || 0}|${String(grounding.review.text || '').trim()}`).digest('hex'),
    review: { ...grounding.review, text: undefined },
    account: grounding.account,
    provenance: grounding.provenance,
  };
}

/**
 * Process ONE claimed row. `intent` = 'cron' (honor the gate mode) or
 * 'post_now' (an admin asked for it: always publish, ignoring shadow).
 */
async function processClaimedRow(row, { intent = 'cron', actor = null, cfg = config(), techFirstNames = null } = {}) {
  const fresh = await db('google_reviews').where({ id: row.id }).first();
  if (!fresh || fresh.missing_since) {
    await releaseClaim(row, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'missing' });
    return { outcome: 'skipped', reason: 'missing' };
  }
  if (hasRealReply(fresh.review_reply)) {
    await releaseClaim(row, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'already_replied' });
    return { outcome: 'skipped', reason: 'already_replied' };
  }
  // Dismissed = "we are deliberately not replying to this one" (admin
  // action). The dismiss routes cancel pending auto state atomically; this
  // is the belt for a row dismissed while claimed.
  if (fresh.dismissed) {
    await releaseClaim(row, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'dismissed' });
    return { outcome: 'skipped', reason: 'dismissed' };
  }
  const merged = { ...fresh, _claimToken: row._claimToken };
  const humanDraft = humanDraftOn(fresh);
  if (humanDraft && intent !== 'post_now') {
    // Someone already wrote a draft for this review — it is in the
    // needs-reply queue with "Use Draft"; the pipeline must not replace it.
    await releaseClaim(row, { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'human_draft' });
    return { outcome: 'parked', reason: 'human_draft' };
  }

  if (intent !== 'post_now' && !locationAllowed(merged.location_id, cfg)) {
    await releaseClaim(row, { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'location_disabled' });
    return { outcome: 'parked', reason: 'location_disabled' };
  }
  if (!(await gbp.isLocationConfigured(merged.location_id))) {
    await releaseClaim(row, { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'gbp_not_configured' });
    return { outcome: 'parked', reason: 'gbp_not_configured' };
  }

  const rating = Number(merged.star_rating) || 0;
  // Hard invariant, independent of config: unrated and 1-3★ never auto-post.
  const humanOnly = rating === 0 || rating <= 3 || rating < cfg.minStars;

  // A publish retry reuses the verifier-approved draft it already produced —
  // redrafting would burn attempts on the model (and could park as
  // provider_down with a perfectly good reply on the row). Only rows that
  // never produced a draft, or whose stored draft came from a different
  // prompt version, go back to the model.
  const PUBLISH_RETRY_REASONS = new Set([CODES.GOOGLE_FAILED, CODES.LOCK_BUSY, 'unexpected', 'runner_error']);
  const storedGrounding = merged.auto_reply_grounding && typeof merged.auto_reply_grounding === 'object' ? merged.auto_reply_grounding : null;
  const reusable = merged.auto_reply_status === STATUS.FAILED
    && PUBLISH_RETRY_REASONS.has(merged.auto_reply_reason)
    && merged.auto_reply_draft
    && merged.auto_reply_version === REPLY_VERSION
    // …and it was drafted for THIS rating + text (a reviewer edit since
    // then makes it stale: redraft).
    && storedGrounding?.fingerprint === reviewFingerprint(merged);
  let draft;
  let snapshot;
  if (reusable) {
    draft = { ok: true, text: merged.auto_reply_draft, mode: merged.auto_reply_mode || 'service_quality', version: merged.auto_reply_version, attempts: 0, rejections: [], reused: true };
    snapshot = storedGrounding;
  } else {
    // Draft (grounding is public-safe by construction).
    const grounding = await buildReplyGrounding(merged, { techFirstNames });
    const recentReplies = await loadRecentPostedReplies(merged.location_id);
    draft = await draftReviewReply({ grounding, recentReplies });
    snapshot = groundingSnapshot(grounding);
  }

  if (!draft.ok) {
    if (draft.reason === 'provider_unavailable') {
      const attempts = (merged.auto_reply_attempts || 0) + 1;
      if (attempts < MAX_ATTEMPTS) {
        const due = new Date(Date.now() + RETRY_BACKOFF_MIN * attempts * 60000).toISOString();
        await releaseClaim(row, { auto_reply_status: STATUS.FAILED, auto_reply_reason: 'provider_unavailable', auto_reply_attempts: attempts, auto_reply_due_at: due, auto_reply_error: String(draft.error || '') });
        return { outcome: 'retry', reason: 'provider_unavailable' };
      }
      if (!(await storeDraft(merged, draft, STATUS.PARKED, 'provider_down', { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
      await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — reply providers were down ${attempts} times. Draft one by hand.`, reason: 'provider_down', action: true });
      return { outcome: 'parked', reason: 'provider_down' };
    }
    if (!(await storeDraft(merged, draft, STATUS.PARKED, 'verifier_reject', { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — no draft passed the safety checks (${(draft.rejections || []).join(', ')}).`, reason: 'verifier_reject', action: true });
    return { outcome: 'parked', reason: 'verifier_reject' };
  }

  if (humanOnly && intent !== 'post_now') {
    const reason = rating === 0 ? 'unrated' : 'low_rating';
    if (!(await storeDraft(merged, draft, STATUS.PARKED, reason, { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    await bell(merged, { title: `${rating === 0 ? 'Unrated' : `${rating}-star`} review — draft ready`, body: `${summarize(merged)} — a reply is drafted and waiting for your review. Nothing was posted.`, reason, action: true });
    return { outcome: 'parked', reason, mode: draft.mode };
  }

  if (cfg.mode !== 'auto' && intent !== 'post_now') {
    if (!(await storeDraft(merged, draft, STATUS.DRAFTED, 'shadow', { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    await bell(merged, { title: 'Shadow reply drafted', body: `${summarize(merged)} — auto-reply is in shadow mode; the draft is on the review, nothing was posted.`, reason: 'shadow', action: false, extra: { mode: draft.mode } });
    return { outcome: 'drafted', reason: 'shadow', mode: draft.mode };
  }

  // Publish.
  try {
    const publishedAt = new Date().toISOString();
    await publishReviewReply({
      reviewId: merged.id,
      text: draft.text,
      actor: actor || { type: 'auto', adminUserId: null },
      autoFields: {
        auto_reply_status: STATUS.POSTED,
        auto_reply_reason: null,
        auto_reply_draft: draft.text,
        auto_reply_drafted_at: publishedAt,
        auto_reply_published_at: publishedAt,
        auto_reply_version: draft.version,
        auto_reply_mode: draft.mode,
        auto_reply_error: null,
        auto_reply_grounding: JSON.stringify(snapshot),
        auto_reply_claimed_until: null,
      },
      auditMeta: { version: draft.version, mode: draft.mode, intent, reviewOnly: !!draft.reviewOnly },
      guard: claimGuard(row),
      // Both cron and Post-now report "posted" = live on Google; a local-only
      // save (no GBP creds) must surface as an error, never as posted.
      requireGoogle: true,
    });
    await bell(merged, {
      title: intent === 'post_now' ? 'Review reply posted' : 'Auto-replied to a review',
      body: `${summarize(merged)} — ${draft.mode.replace('_', ' ')} reply is live on Google. Open Reviews to read or retract it.`,
      reason: intent === 'post_now' ? 'posted_now' : 'auto_posted',
      action: false,
      extra: { mode: draft.mode },
      link: `/admin/reviews?responded=responded&review=${encodeURIComponent(merged.id)}`,
    });
    return { outcome: 'posted', mode: draft.mode };
  } catch (err) {
    const code = err instanceof ReviewReplyError ? err.code : 'unexpected';
    if (code === CODES.PERSIST_FAILED) {
      await parkPersistFailed(merged, draft, err);
      return { outcome: 'parked', reason: 'persist_failed' };
    }
    if (code === CODES.STALE && err.message.includes(REVIEW_CHANGED)) {
      // Not lost to a person — the review itself changed. Back to the queue
      // for a fresh draft against the current rating/text.
      await releaseClaim(row, { auto_reply_status: STATUS.QUEUED, auto_reply_reason: 'review_changed', auto_reply_due_at: new Date().toISOString(), auto_reply_draft: null, auto_reply_drafted_at: null });
      return { outcome: 'retry', reason: 'review_changed' };
    }
    if (code === CODES.HAS_REPLY || code === CODES.MISSING || code === CODES.RACE || code === CODES.STALE) {
      // Not ours any more (a human replied / skipped / dismissed, or Google
      // removed it) — record and stop; never retry over a person's action.
      await releaseClaim(row, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: code, auto_reply_error: err.message });
      return { outcome: 'skipped', reason: code };
    }
    const attempts = (merged.auto_reply_attempts || 0) + 1;
    // Every transient class (lock contention, Google failure, unexpected)
    // shares ONE retry ceiling; after it the row parks for a person.
    if ((code === CODES.LOCK_BUSY || code === CODES.GOOGLE_FAILED || code === 'unexpected') && attempts < MAX_ATTEMPTS) {
      const due = new Date(Date.now() + RETRY_BACKOFF_MIN * attempts * 60000).toISOString();
      await releaseClaim(row, { auto_reply_status: STATUS.FAILED, auto_reply_reason: code, auto_reply_attempts: attempts, auto_reply_due_at: due, auto_reply_error: err.message, auto_reply_draft: draft.text, auto_reply_drafted_at: new Date().toISOString(), auto_reply_version: draft.version, auto_reply_mode: draft.mode });
      logger.warn(`[review-auto-reply] publish deferred for ${merged.id}: ${code} (${err.message})`);
      return { outcome: 'retry', reason: code };
    }
    const parkReason = code === CODES.NOT_CONFIGURED ? 'gbp_not_configured'
      : code === CODES.NO_RESOURCE ? 'no_gbp_resource'
        : code === CODES.LOCK_BUSY ? 'lock_busy'
          : 'google_failed';
    if (!(await storeDraft(merged, draft, STATUS.PARKED, parkReason, { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — Google did not accept the reply (${err.message}). The draft is saved on the review.`, reason: 'google_failed', action: true });
    logger.error(`[review-auto-reply] publish failed for ${merged.id}: ${code} (${err.message})`);
    return { outcome: 'parked', reason: code };
  }
}

/**
 * Cron entry — processes due rows serially. Call under runExclusive.
 */
async function processDueAutoReplies({ limit = DEFAULT_BATCH } = {}) {
  const cfg = config();
  const stats = { mode: cfg.mode, claimed: 0, posted: 0, drafted: 0, parked: 0, skipped: 0, retry: 0, errors: 0 };
  if (cfg.mode === 'off') return stats;
  const rows = await claimDueRows({ limit });
  stats.claimed = rows.length;
  if (!rows.length) return stats;
  const techFirstNames = await loadActiveTechFirstNames();
  for (const row of rows) {
    try {

      const r = await processClaimedRow(row, { cfg, techFirstNames });
      if (stats[r.outcome] != null) stats[r.outcome]++;
    } catch (err) {
      stats.errors++;
      logger.error(`[review-auto-reply] row ${row.id} failed: ${err.message}`);
      // Same retry ceiling as the handled paths: park + action bell after it.
      const attempts = (row.auto_reply_attempts || 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await releaseClaim(row, {
        auto_reply_status: exhausted ? STATUS.PARKED : STATUS.FAILED,
        auto_reply_reason: 'runner_error',
        auto_reply_attempts: attempts,
        ...(exhausted ? {} : { auto_reply_due_at: new Date(Date.now() + RETRY_BACKOFF_MIN * attempts * 60000).toISOString() }),
        auto_reply_error: String(err.message || err).slice(0, 1000),
      }).catch(() => {});
      if (exhausted) {
        await bell(row, { title: 'Review reply needs you', body: `${summarize(row)} — the auto-reply runner failed ${attempts} times (${String(err.message || err).slice(0, 120)}). Reply by hand.`, reason: 'runner_error', action: true });
      }
    }
  }
  return stats;
}

/**
 * Admin "Post now": bypass the jitter (and shadow mode) for one review. If a
 * verified auto draft already exists it is published as-is; otherwise a fresh
 * draft is produced. Low-rating rows may be posted this way because a human
 * asked.
 */
async function postNow(reviewId, actor) {
  const [row] = await claimDueRows({ limit: 1, force: reviewId });
  if (!row) throw new ReviewReplyError(CODES.LOCK_BUSY, 'This review is being processed — try again in a moment.', { status: 409 });
  if (hasRealReply(row.review_reply)) {
    await releaseClaim(row);
    throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has a posted reply', { status: 409 });
  }
  // The draft the admin is looking at wins: a human-written "[DRAFT]" first,
  // then the pipeline's own verified draft, else draft fresh.
  const storedFp = row.auto_reply_grounding && typeof row.auto_reply_grounding === 'object' ? row.auto_reply_grounding.fingerprint : null;
  const existing = humanDraftOn(row)
    || (row.auto_reply_draft
      && [STATUS.DRAFTED, STATUS.PARKED, STATUS.FAILED].includes(row.auto_reply_status)
      && storedFp === reviewFingerprint(row)
      ? row.auto_reply_draft : null);
  if (existing) {
    const publishedAt = new Date().toISOString();
    try {
      await publishReviewReply({
        reviewId,
        text: existing,
        actor,
        autoFields: {
          auto_reply_status: STATUS.POSTED,
          auto_reply_reason: null,
          auto_reply_published_at: publishedAt,
          auto_reply_error: null,
          auto_reply_claimed_until: null,
        },
        auditMeta: { version: row.auto_reply_version, mode: row.auto_reply_mode, intent: 'post_now' },
        guard: claimGuard(row),
        requireGoogle: true,
      });
      return { outcome: 'posted', mode: row.auto_reply_mode };
    } catch (err) {
      if (err instanceof ReviewReplyError && err.code === CODES.PERSIST_FAILED) {
        // Live on Google, unrecorded locally: park, never back into the retry lane.
        await parkPersistFailed(row, { text: existing, version: row.auto_reply_version, mode: row.auto_reply_mode }, err);
        throw err;
      }
      await releaseClaim(row, { auto_reply_error: err.message });
      throw err;
    }
  }
  return processClaimedRow(row, { intent: 'post_now', actor: actor || { type: 'admin' } });
}

/**
 * Admin "Skip": take the review out of the automatic pipeline (stays a
 * manual task in the existing needs-reply queue).
 */
async function skipAutoReply(reviewId, { reason = 'admin_skip' } = {}) {
  const updated = await db('google_reviews')
    .where({ id: reviewId })
    .whereIn('auto_reply_status', [STATUS.QUEUED, STATUS.DRAFTED, STATUS.PARKED, STATUS.FAILED])
    // A publish in flight holds the per-review publish claim; refusing the
    // skip (409 to the admin, retry in a moment) is the honest answer — the
    // publisher's pre-PUT guard covers the rest of the window.
    .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()])
    .update({ auto_reply_status: STATUS.SKIPPED, auto_reply_reason: reason, auto_reply_claimed_until: null });
  return (Array.isArray(updated) ? updated.length : updated) > 0;
}

/**
 * Merged into the dismiss routes' UPDATE so dismissal cancels any pending
 * auto-reply state in the same statement (and drops a live claim, which
 * makes the holder's in-lock guard fail).
 */
// Dismissal must not land under an in-flight publish (same predicate as
// skipAutoReply): the dismiss routes add this to their WHERE.
function whereNoLivePublishClaim(qb) {
  qb.whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()]);
}

function dismissCancelFields(conn = db) {
  const pending = "('queued','drafted','parked','failed')";
  return {
    auto_reply_status: conn.raw(`CASE WHEN auto_reply_status IN ${pending} THEN 'skipped' ELSE auto_reply_status END`),
    auto_reply_reason: conn.raw(`CASE WHEN auto_reply_status IN ${pending} THEN 'dismissed' ELSE auto_reply_reason END`),
    auto_reply_claimed_until: null,
  };
}

/**
 * Status for the admin page / shadow exit criteria (7 days AND ≥20 drafts).
 */
async function autoReplyStatus() {
  const cfg = config();
  const counts = await db('google_reviews')
    .whereNotNull('auto_reply_status')
    .select('auto_reply_status')
    .count('* as n')
    .groupBy('auto_reply_status');
  const byStatus = {};
  for (const c of counts) byStatus[c.auto_reply_status] = Number(c.n);
  const firstDraft = await db('google_reviews').whereNotNull('auto_reply_drafted_at').min('auto_reply_drafted_at as at').first();
  const drafts = await db('google_reviews').whereNotNull('auto_reply_drafted_at').count('* as n').first();
  return {
    mode: cfg.mode,
    minStars: cfg.minStars,
    delayMinutes: [cfg.delayMin, cfg.delayMax],
    locations: cfg.locations,
    byStatus,
    draftsTotal: Number(drafts?.n || 0),
    firstDraftAt: firstDraft?.at || null,
  };
}

module.exports = {
  STATUS,
  MAX_ATTEMPTS,
  mode,
  config,
  computeDueAt,
  autoReplyInsertFields,
  claimDueRows,
  processClaimedRow,
  processDueAutoReplies,
  postNow,
  skipAutoReply,
  dismissCancelFields,
  whereNoLivePublishClaim,
  reviewFingerprint,
  autoReplyStatus,
  classifyReplyMode,
  isDraftReply,
};
