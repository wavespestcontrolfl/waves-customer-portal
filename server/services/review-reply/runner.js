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
const { hasRealReply, isDraftReply, asDraft, stripDraftPrefix, removedOwnerReplyFields, whereNeedsRealReply } = require('./draft-prefix');
const { buildReplyGrounding, loadActiveTechFirstNames, loadAccountFacts, accountFingerprint, groundingCustomerId } = require('./grounding');
const { draftReviewReply, loadRecentPostedReplies, classifyReplyMode, verifyReplyText, REPLY_VERSION } = require('./drafter');
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
const IDENTITY_BACKOFF_MIN = 60;
// Deploy-forward is a property of the REVIEW: nothing older than this at
// first sight ever enters the lane, whichever insert path (GBP, Places, a
// fresh-sync rebuild that re-imports history) produced the row.
const DEFAULT_MAX_QUEUE_AGE_HOURS = 48;
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
    maxQueueAgeHours: intEnv('REVIEW_AUTO_REPLY_MAX_AGE_HOURS', DEFAULT_MAX_QUEUE_AGE_HOURS, { min: 1, max: 24 * 30 }),
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
  const created = review_created_at ? new Date(review_created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return {};
  if (now.getTime() - created.getTime() > cfg.maxQueueAgeHours * 3600000) return {};
  return {
    auto_reply_status: STATUS.QUEUED,
    auto_reply_due_at: computeDueAt(review_created_at, { now, cfg }).toISOString(),
  };
}

/**
 * Catch-up enqueue for rows the insert-time gate skipped: reviews synced
 * while the kill switch was off, or while their location was outside
 * REVIEW_AUTO_REPLY_LOCATIONS, stay auto_reply_status = NULL forever
 * otherwise (later syncs take the update path). Bounded by the same max
 * queue age as the insert path (deploy-forward: never re-import history),
 * so a switch that was off for longer than that simply drops the window —
 * the row stays a normal needs-reply item for a person. Runs every cron
 * tick while the mode is not off; compare-and-set on NULL state so a row
 * that was queued / replied meanwhile is left alone. Returns the count.
 */
// Durable rollout cutoff = the moment the auto-reply migration ran in THIS
// database. Rows inserted before it pre-date the enqueue hook and stay NULL
// forever (owner ruling 2026-08-27, deploy-forward only); rows inserted
// after it went through the hook and are the catch-up's only population.
// Cached after the first successful read; unknown ⇒ catch-up disabled.
let rolloutCutoffCache = undefined;
async function rolloutCutoff({ conn = db } = {}) {
  if (rolloutCutoffCache !== undefined) return rolloutCutoffCache;
  try {
    const m = await conn('knex_migrations').where('name', 'like', '20260828000001_review_auto_reply%').orderBy('id', 'asc').first('migration_time');
    rolloutCutoffCache = m?.migration_time ? new Date(m.migration_time) : null;
  } catch (err) {
    logger.warn(`[review-auto-reply] rollout cutoff unavailable: ${err.message}`);
    return null;
  }
  return rolloutCutoffCache;
}

async function enqueueMissedReviews({ now = new Date(), cfg = config(), limit = 200, rollout = undefined } = {}) {
  if (cfg.mode === 'off') return 0;
  const since = rollout !== undefined ? rollout : await rolloutCutoff();
  if (!since) return 0;
  const cutoff = new Date(now.getTime() - cfg.maxQueueAgeHours * 3600000).toISOString();
  // Every eligibility predicate is applied in SQL, and the batch is ordered
  // oldest-first, so a run of ineligible rows (replied / dismissed / out of
  // scope) can never occupy the batch and starve eligible rows behind it.
  const q = db('google_reviews')
    .whereNull('auto_reply_status')
    .whereNull('missing_since')
    .where('reviewer_name', '!=', '_stats')
    .whereRaw('COALESCE(dismissed, false) = false')
    .where('review_created_at', '>=', cutoff)
    // Row INSERT time (not the review's Google time) after the rollout: a
    // review that existed locally before the hook shipped is history.
    .where('created_at', '>=', new Date(since).toISOString())
    .modify(whereNeedsRealReply)
    .orderBy('review_created_at', 'asc')
    .limit(limit);
  if (cfg.locations.length) q.whereRaw('lower(location_id) = ANY(?)', [cfg.locations]);
  const candidates = await q.select('id', 'location_id', 'reviewer_name', 'review_reply', 'review_created_at', 'dismissed');
  let n = 0;
  for (const c of (candidates || [])) {
    const fields = autoReplyInsertFields({ ...c, owner_reply: c.review_reply }, { now, cfg });
    if (!Object.keys(fields).length) continue;
    const updated = await db('google_reviews').where({ id: c.id }).whereNull('auto_reply_status').update(fields);
    n += Array.isArray(updated) ? updated.length : (updated || 0);
  }
  if (n) logger.info(`[review-auto-reply] catch-up queued ${n} review(s) synced while the pipeline was off / out of scope`);
  return n;
}

/**
 * Atomically claim up to `limit` due rows. Postgres has no UPDATE … LIMIT, so
 * the candidate set is selected FOR UPDATE SKIP LOCKED and the claim stamp is
 * the ownership token (only the claimant's token releases it).
 */
async function claimDueRows({ limit = DEFAULT_BATCH, now = new Date(), force = null } = {}) {
  const token = new Date(now.getTime() + CLAIM_MS).toISOString();
  const nowIso = now.toISOString();
  const forceClause = force ? "AND id = ? AND auto_reply_status IS DISTINCT FROM 'skipped'" : `AND auto_reply_status IN ('queued','failed') AND auto_reply_due_at <= ?`;
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

// Token-matched release. Returns true only when OUR claim was still on the
// row — zero rows means a skip/dismiss cleared it meanwhile, and the caller
// must treat its own outcome as void (no bell, no "parked").
async function releaseClaim(row, patch = {}) {
  const n = await db('google_reviews')
    .where({ id: row.id, auto_reply_claimed_until: row._claimToken })
    .update({ auto_reply_claimed_until: null, ...patch });
  return (Array.isArray(n) ? n.length : n) > 0;
}

// Re-stamp OUR claim right before a row's provider work starts (codex r73).
// claimDueRows stamps every row of a batch at once, but the batch runs
// serially: behind a slow provider (45s draft deadlines + Google reads and
// writes per row) the later rows can outlive the 10-minute stamp before their
// turn, and an expired stamp lets Post now or another runner claim the row
// while this worker is about to draft it. Token-matched, so a claim lost
// meanwhile (skip/dismiss, or expiry + re-claim) is detected here — before
// any LLM work — instead of at the publisher's ownership check.
async function renewClaim(row, now = new Date()) {
  const token = new Date(now.getTime() + CLAIM_MS).toISOString();
  const n = await db('google_reviews')
    .where({ id: row.id, auto_reply_claimed_until: row._claimToken })
    .update({ auto_reply_claimed_until: token });
  if (!((Array.isArray(n) ? n.length : n) > 0)) return null;
  return { ...row, _claimToken: token };
}

// Ownership guard evaluated by the publisher INSIDE its publish claim, on a
// fresh row read: our claim token must still be on the row (an admin skip,
// a dismissal, or another worker clears/replaces it) and the row must not be
// dismissed. Any mismatch = this invocation is stale and must not post.
function claimGuard(row, { publishingText = null, accountFingerprint: expectedAccountFp = null } = {}) {
  return async (fresh) => {
    if (fresh.dismissed) return 'review was dismissed';
    const held = fresh.auto_reply_claimed_until ? new Date(fresh.auto_reply_claimed_until).toISOString() : null;
    if (held !== row._claimToken) return 'auto-reply claim was lost';
    // The draft was written for THIS rating and text. A reviewer edit the
    // sync applied meanwhile (a 5★ turned 2★, a rewritten body) makes the
    // draft stale — and may move the review under the human-only rule.
    if (Number(fresh.star_rating) !== Number(row.star_rating)
      || String(fresh.review_text || '').trim() !== String(row.review_text || '').trim()
      || String(fresh.reviewer_name || '').trim().toLowerCase() !== String(row.reviewer_name || '').trim().toLowerCase()
      || (fresh.customer_id || null) !== (row.customer_id || null)
      // A click auto-link confirmed (or cleared) mid-flight changes which
      // account facts the draft may carry.
      || (groundingCustomerId(fresh) || null) !== (groundingCustomerId(row) || null)) return REVIEW_CHANGED;
    // A "[DRAFT]" that is not ours (Agent Ops / operator saved one while we
    // were drafting) is a human intervention: never post over it.
    const human = humanDraftOn({ ...fresh, auto_reply_draft: row.auto_reply_draft || fresh.auto_reply_draft });
    if (human && human !== String(publishingText || '').trim()) return HUMAN_DRAFT;
    // The account facts the draft was written from (city, tenure,
    // categories, relationship) are re-derived now: a correction made while
    // the draft was in flight — same customer_id — makes it stale too.
    if (expectedAccountFp) {
      let current;
      try { current = accountFingerprint(await loadAccountFacts(groundingCustomerId(fresh))); } catch { return ACCOUNT_READ_FAILED; }
      if (current !== expectedAccountFp) return REVIEW_CHANGED;
    }
    return null;
  };
}
const REVIEW_CHANGED = 'review changed while drafting';
// A transient DB failure re-reading account facts inside the claim: retryable,
// never a reason to drop the row as "lost to a person".
const ACCOUNT_READ_FAILED = 'account facts could not be re-read';
const HUMAN_DRAFT = 'a human draft was saved while drafting';

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
  // notifyAdmin resolves null on an insert failure: retry, then stamp the
  // row (bell_failed:<reason>) so retryFailedBells re-rings it every cron
  // tick — a terminal park must never go unnoticed (codex r48).
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    ok = await bellOnce(row, { title, body, reason, action, extra, link });
    if (!ok && attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  if (ok) { await clearBellStamp(row.id).catch(() => {}); return true; }
  logger.error(`[review-auto-reply] bell FAILED for ${row.id} (${reason}) — stamped for the sweep`);
  await stampBellFailed(row.id, reason, { action }).catch(() => {});
  return false;
}
const BELL_STAMP_RE = /(?:^| \|\| )bell_failed:([^|]*)$/;
async function stampBellFailed(reviewId, reason, { action = true, conn = db } = {}) {
  const cur = await conn('google_reviews').where({ id: reviewId }).first('auto_reply_error');
  const prev = String(cur?.auto_reply_error || '').replace(BELL_STAMP_RE, '');
  const stamp = `bell_failed:${reason}:${action ? 1 : 0}`;
  await conn('google_reviews').where({ id: reviewId }).update({ auto_reply_error: prev ? `${prev} || ${stamp}` : stamp });
}
async function clearBellStamp(reviewId, { conn = db } = {}) {
  const cur = await conn('google_reviews').where({ id: reviewId }).first('auto_reply_error');
  const err = String(cur?.auto_reply_error || '');
  if (!BELL_STAMP_RE.test(err)) return;
  const rest = err.replace(BELL_STAMP_RE, '');
  await conn('google_reviews').where({ id: reviewId }).update({ auto_reply_error: rest || null });
}
async function bellOnce(row, { title, body, reason, action = false, extra = {}, link = null }) {
  try {
    const res = await NotificationService.notifyAdmin('review', title, body, {
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
    return !!res;
  } catch (err) {
    logger.warn(`[review-auto-reply] bell failed for ${row.id}: ${err.message}`);
    return false;
  }
}

// Google has the reply; only the local record is missing. Never republish —
// park for a person to reconcile (the publish claim was abandoned by the
// publisher and self-expires, blocking competitors meanwhile). Used by both
// the cron path and Post-now.
async function parkPersistFailed(row, draft, err, { snapshot = undefined } = {}) {
  await db('google_reviews').where({ id: row.id }).update({
    auto_reply_status: STATUS.PARKED, auto_reply_reason: 'persist_failed', auto_reply_error: err.message,
    ...(draft?.text ? {
      auto_reply_draft: draft.text, auto_reply_version: draft.version || null, auto_reply_mode: draft.mode || null,
      // The reply is LIVE: keep the draft's provenance so the sync that later
      // confirms it as posted leaves full metadata (codex r32).
      auto_reply_drafted_at: row.auto_reply_drafted_at || new Date().toISOString(),
      ...(snapshot !== undefined ? { auto_reply_grounding: JSON.stringify(snapshot || null) } : {}),
    } : {}),
    auto_reply_claimed_until: null,
  }).catch((e2) => logger.error(`[review-auto-reply] persist_failed bookkeeping also failed for ${row.id}: ${e2.message}`));
  // The next sync will record the live reply and the row leaves the default
  // needs-reply view — link a view that keeps replied rows.
  await bell(row, { title: 'Review reply needs reconciling', body: `${summarize(row)} — the reply is LIVE on Google but was not recorded here. Open Reviews and confirm it.`, reason: 'persist_failed', action: true, link: `/admin/reviews?responded=all&review=${encodeURIComponent(row.id)}` });
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
      auto_reply_drafted_at: (draft.reused && row.auto_reply_drafted_at) || new Date().toISOString(),
      auto_reply_version: draft.version || null,
      auto_reply_mode: draft.mode || null,
    } : {}),
    auto_reply_error: draft?.ok === false ? JSON.stringify({ reason: draft.reason, rejections: draft.rejections, error: draft.error }) : null,
    auto_reply_grounding: JSON.stringify(extra.grounding || null),
    auto_reply_claimed_until: null,
    ...(extra.fields || {}),
  };
  if (draft?.text) {
    const updated = await db('google_reviews')
      .where({ id: row.id, auto_reply_claimed_until: row._claimToken })
      .whereNull('missing_since')
      // The draft was written for THIS rating + text; a reviewer edit the
      // sync applied meanwhile must not get a stale draft saved against it.
      .where('star_rating', row.star_rating)
      .where('reviewer_name', row.reviewer_name)
      .where(function sameCustomer() {
        if (row.customer_id) this.where('customer_id', row.customer_id); else this.whereNull('customer_id');
      })
      .where(function sameText() {
        if (row.review_text == null || row.review_text === '') this.whereNull('review_text').orWhere('review_text', '');
        else this.where('review_text', row.review_text);
      })
      .where(function ownDraftOrEmpty() {
        // Never over a human's draft: only an empty reply or the pipeline's
        // OWN previous draft may be replaced.
        this.whereNull('review_reply');
        if (row.auto_reply_draft) this.orWhere('review_reply', asDraft(row.auto_reply_draft));
      })
      .update({ ...patch, review_reply: asDraft(draft.text), reply_updated_at: null });
    if ((Array.isArray(updated) ? updated.length : updated) > 0) return true;
    // Lost the race. If the REVIEW changed (rating/text edit), go back to the
    // queue for a fresh draft; otherwise (posted reply / stamped / claim
    // lost) record the closed state without the draft text.
    const fresh = await db('google_reviews').where({ id: row.id }).first();
    if (fresh && !fresh.missing_since && !hasRealReply(fresh.review_reply) && reviewFingerprint(fresh) !== reviewFingerprint(row)) {
      await releaseClaim(row, { auto_reply_status: STATUS.QUEUED, auto_reply_reason: 'review_changed', auto_reply_due_at: new Date().toISOString(), auto_reply_draft: null, auto_reply_drafted_at: null, auto_reply_grounding: null });
      return false;
    }
    await releaseClaim(row, { ...patch, auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'changed_during_draft' });
    return false;
  }
  // No draft text (verifier/provider failure): the state write is still
  // token-matched — a lost claim means an admin cancelled meanwhile.
  return releaseClaim(row, patch);
}

// What a draft was written FOR. A stored draft may only be reused when the
// review's rating + text still hash to this.
const { reviewFingerprint } = require('./fingerprint');

function groundingSnapshot(grounding) {
  // Everything the model saw, minus the review text itself (already on the row).
  return {
    version: grounding.version,
    accountFingerprint: accountFingerprint(grounding.account),
    // ONE identity mechanism: the canonical reviewFingerprint over the
    // fields the grounding saw (codex r43).
    fingerprint: reviewFingerprint({ star_rating: grounding.review.rating, review_text: grounding.review.text, reviewer_name: grounding.reviewerName, customer_id: grounding.customerId, link_source: grounding.linkSource }),
    review: { ...grounding.review, text: undefined },
    account: grounding.account,
    provenance: grounding.provenance,
  };
}

/**
 * Process ONE claimed row. `intent` = 'cron' (honor the gate mode) or
 * 'post_now' (an admin asked for it: always publish, ignoring shadow).
 */
async function processClaimedRow(row, { intent = 'cron', actor = null, cfg = config(), techFirstNames = null, surfaceOnly = false } = {}) {
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
  const rating = Number(merged.star_rating) || 0;
  // Hard invariant, independent of config: unrated and 1-3★ never auto-post.
  const humanOnly = rating === 0 || rating <= 3 || rating < cfg.minStars;

  // A publish retry reuses the verifier-approved draft it already produced —
  // redrafting would burn attempts on the model (and could park as
  // provider_down with a perfectly good reply on the row). Only rows that
  // never produced a draft, or whose stored draft came from a different
  // prompt version, go back to the model.
  const PUBLISH_RETRY_REASONS = new Set([CODES.GOOGLE_FAILED, CODES.LOCK_BUSY, CODES.NO_RESOURCE, 'gbp_not_configured', 'account_read_failed', 'google_uncertain_cleared', 'unexpected', 'runner_error']);
  const storedGrounding = merged.auto_reply_grounding && typeof merged.auto_reply_grounding === 'object' ? merged.auto_reply_grounding : null;
  const reusable = merged.auto_reply_status === STATUS.FAILED
    && PUBLISH_RETRY_REASONS.has(merged.auto_reply_reason)
    && merged.auto_reply_draft
    && merged.auto_reply_version === REPLY_VERSION
    // …and it was drafted for THIS rating + text (a reviewer edit since
    // then makes it stale: redraft)…
    && storedGrounding?.fingerprint === reviewFingerprint(merged)
    // …and for the SAME derived account facts (city / tenure / categories).
    && storedGrounding?.accountFingerprint === accountFingerprint(await loadAccountFacts(groundingCustomerId(merged)).catch(() => null));
  let draft;
  let snapshot;
  // A reused draft is re-verified against the CURRENT state (recent posted
  // replies changed since it was written — another review may have posted
  // the same opening); a failed re-verification falls through to a redraft.
  let reuseOk = false;
  if (reusable) {
    const groundingNow = await buildReplyGrounding(merged, { techFirstNames });
    const recentNow = await loadRecentPostedReplies(merged.location_id);
    const verdict = verifyReplyText(merged.auto_reply_draft, groundingNow, { recentReplies: recentNow, mode: merged.auto_reply_mode || undefined });
    if (!verdict) {
      reuseOk = true;
      draft = { ok: true, text: merged.auto_reply_draft, mode: merged.auto_reply_mode || 'service_quality', version: merged.auto_reply_version, attempts: 0, rejections: [], reused: true };
      snapshot = storedGrounding;
    } else {
      logger.info(`[review-auto-reply] stored draft for ${merged.id} no longer verifies (${verdict}) — redrafting`);
    }
  }
  if (!reuseOk) {
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
      if (!(await storeDraft(merged, draft, STATUS.PARKED, 'provider_down', { grounding: snapshot, fields: { auto_reply_attempts: attempts } }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
      await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — reply providers were down ${attempts} times. Draft one by hand.`, reason: 'provider_down', action: true });
      return { outcome: 'parked', reason: 'provider_down' };
    }
    if (!(await storeDraft(merged, draft, STATUS.PARKED, 'verifier_reject', { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — no draft passed the safety checks (${(draft.rejections || []).join(', ')}).`, reason: 'verifier_reject', action: true });
    return { outcome: 'parked', reason: 'verifier_reject' };
  }

  // Hard invariant: 1-3★ / unrated never publish an UNSEEN draft — not even
  // for Post now. postNow() publishes a previously surfaced draft itself;
  // reaching this point with intent 'post_now' means no such draft existed
  // (or it no longer verified), so the freshly generated text is parked for
  // the person to read. Their next Post now publishes it.
  if (humanOnly) {
    // low_rating / unrated = the hard 1-3★ safety lane; below_threshold = a
    // 4★ under a configured REVIEW_AUTO_REPLY_MIN_STARS=5 (codex r40).
    const reason = rating === 0 ? 'unrated' : rating <= 3 ? 'low_rating' : 'below_threshold';
    if (!(await storeDraft(merged, draft, STATUS.PARKED, reason, { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    if (intent !== 'post_now') {
      const title = reason === 'below_threshold' ? `${rating}-star review — draft ready (below the auto-post threshold)` : `${rating === 0 ? 'Unrated' : `${rating}-star`} review — draft ready`;
      await bell(merged, { title, body: `${summarize(merged)} — a reply is drafted and waiting for your review. Nothing was posted.`, reason, action: true });
    }
    return { outcome: 'parked', reason, mode: draft.mode, drafted: intent === 'post_now' };
  }

  if (cfg.mode !== 'auto' && intent !== 'post_now') {
    if (!(await storeDraft(merged, draft, STATUS.DRAFTED, 'shadow', { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    await bell(merged, { title: 'Shadow reply drafted', body: `${summarize(merged)} — auto-reply is in shadow mode; the draft is on the review, nothing was posted.`, reason: 'shadow', action: false, extra: { mode: draft.mode } });
    return { outcome: 'drafted', reason: 'shadow', mode: draft.mode };
  }

  // Post now whose DISPLAYED draft was discarded (stale account facts, or it
  // no longer verifies): the admin approved text A — Google must not receive
  // an unseen text B. Surface the replacement as a park; their next Post now
  // publishes what they have now read (codex r36).
  if (intent === 'post_now' && surfaceOnly) {
    if (!(await storeDraft(merged, draft, STATUS.PARKED, 'draft_replaced', { grounding: snapshot }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    return { outcome: 'parked', reason: 'draft_replaced', mode: draft.mode, drafted: true };
  }

  // Google write access is required only HERE: shadow drafts and the 1-3★
  // human-only parks above need no credentials (a Places-fallback location
  // still gets its drafts and action bells). Credentials can arrive (OAuth
  // connect, token-store recovery): retry on the identity backoff with the
  // draft kept for reuse, park after the ceiling. The authoritative GBP sync
  // also revives a parked row for that location (requeueFieldsOnIdentity).
  if (!(await gbp.isLocationConfigured(merged.location_id))) {
    const attempts = (merged.auto_reply_attempts || 0) + 1;
    const keep = { auto_reply_draft: draft.text, auto_reply_drafted_at: merged.auto_reply_drafted_at || new Date().toISOString(), auto_reply_version: draft.version, auto_reply_mode: draft.mode, auto_reply_grounding: JSON.stringify(snapshot) };
    if (attempts < MAX_ATTEMPTS) {
      await releaseClaim(row, { ...keep, auto_reply_status: STATUS.FAILED, auto_reply_reason: 'gbp_not_configured', auto_reply_attempts: attempts, auto_reply_due_at: new Date(Date.now() + IDENTITY_BACKOFF_MIN * attempts * 60000).toISOString() });
      return { outcome: 'retry', reason: 'gbp_not_configured' };
    }
    // Terminal park: a person takes over, so the draft goes into the
    // "[DRAFT]" reply slot (Use Draft + draftToken on the Reviews page),
    // the same way every other park stores it.
    if (!(await storeDraft(merged, draft, STATUS.PARKED, 'gbp_not_configured', { grounding: snapshot, fields: { auto_reply_attempts: attempts } }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
    // Parked rows are never claimed again until a sync revives them — and no
    // sync runs while the location is disconnected: a person must hear about
    // it (codex r45).
    await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — Google Business Profile is not connected for this location (${attempts} attempts). The draft is saved on the review; reconnect GBP or reply by hand.`, reason: 'gbp_not_configured', action: true });
    return { outcome: 'parked', reason: 'gbp_not_configured' };
  }

  // Publish.
  try {
    const publishedAt = new Date().toISOString();
    const published = await publishReviewReply({
      reviewId: merged.id,
      text: draft.text,
      actor: actor || { type: 'auto', adminUserId: null },
      autoFields: {
        auto_reply_status: STATUS.POSTED,
        auto_reply_reason: null,
        auto_reply_draft: draft.text,
        // A reused (retry) draft keeps the time it was PRODUCED: the audit
        // column and firstShadowDraftAt must not slide to the publish time.
        auto_reply_drafted_at: (draft.reused && merged.auto_reply_drafted_at) || publishedAt,
        auto_reply_published_at: publishedAt,
        auto_reply_version: draft.version,
        auto_reply_mode: draft.mode,
        auto_reply_error: null,
        auto_reply_grounding: JSON.stringify(snapshot),
        auto_reply_claimed_until: null,
      },
      auditMeta: { version: draft.version, mode: draft.mode, intent, reviewOnly: !!draft.reviewOnly },
      guard: claimGuard(row, { accountFingerprint: snapshot?.accountFingerprint || null }),
      // Both cron and Post-now report "posted" = live on Google; a local-only
      // save (no GBP creds) must surface as an error, never as posted.
      requireGoogle: true,
    });
    if (published?.editedDuringPut) {
      // The publisher recorded the reply parked/review_edited_after_post and
      // rang the action bell: no contradictory "posted" FYI (codex r57).
      return { outcome: 'parked', reason: 'review_edited_after_post', mode: draft.mode, live: true };
    }
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
    let code = err instanceof ReviewReplyError ? err.code : 'unexpected';
    if (code === CODES.PERSIST_FAILED) {
      await parkPersistFailed(merged, draft, err, { snapshot });
      return { outcome: 'parked', reason: 'persist_failed' };
    }
    if (code === CODES.GOOGLE_UNCERTAIN) {
      // The PUT timed out: it may have landed. Publisher already parked the
      // row; keep the draft for the reconciler and ring an action bell.
      await db('google_reviews').where({ id: merged.id }).update({
        auto_reply_draft: draft.text, auto_reply_version: draft.version, auto_reply_mode: draft.mode,
        // Nothing landed through autoFields (the PUT never returned): keep
        // the draft timestamp + grounding evidence so a sync that later
        // confirms the reply as posted has full metadata (shadow metrics,
        // Post-now reuse, audit).
        auto_reply_drafted_at: merged.auto_reply_drafted_at || new Date().toISOString(),
        auto_reply_grounding: JSON.stringify(snapshot),
      }).catch(() => {});
      await bell(merged, { title: 'Review reply needs reconciling', body: `${summarize(merged)} — Google did not answer in time; the reply MAY be live. Check the review after the next sync.`, reason: 'google_uncertain', action: true, link: `/admin/reviews?responded=all&review=${encodeURIComponent(merged.id)}` });
      return { outcome: 'parked', reason: 'google_uncertain' };
    }
    if (code === CODES.STALE && err.message.includes(HUMAN_DRAFT)) {
      await releaseClaim(row, { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'human_draft' });
      return { outcome: 'parked', reason: 'human_draft' };
    }
    if (code === CODES.REVIEW_CHANGED || (code === CODES.STALE && err.message.includes(REVIEW_CHANGED))) {
      // Not lost to a person — the review itself changed. Back to the queue
      // for a fresh draft against the current rating/text. A LIVE-side
      // change (Google differs from our row) waits for the next hourly sync
      // to land it locally — redrafting every tick against the stale row
      // would just repeat the mismatch.
      // Bounded (codex r56): while the authoritative sync stays degraded the
      // live mismatch would repeat every tick — after the shared ceiling the
      // row parks for a person instead of redrafting forever.
      const attemptsNow = (merged.auto_reply_attempts || 0) + 1;
      if (attemptsNow >= MAX_ATTEMPTS) {
        await releaseClaim(row, { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'review_changed_stale_sync', auto_reply_attempts: attemptsNow, auto_reply_draft: null, auto_reply_drafted_at: null, auto_reply_error: String(err.message || err).slice(0, 1000) });
        await bell(merged, { title: 'Review reply needs you', body: `${summarize(merged)} — the review changed on Google but the sync has not caught up after ${attemptsNow} attempts. Check the review and reply by hand.`, reason: 'review_changed_stale_sync', action: true });
        return { outcome: 'parked', reason: 'review_changed_stale_sync' };
      }
      const dueAt = code === CODES.REVIEW_CHANGED
        ? new Date(Date.now() + IDENTITY_BACKOFF_MIN * 60000).toISOString()
        : new Date().toISOString();
      await releaseClaim(row, { auto_reply_status: STATUS.QUEUED, auto_reply_reason: 'review_changed', auto_reply_due_at: dueAt, auto_reply_attempts: attemptsNow, auto_reply_draft: null, auto_reply_drafted_at: null });
      return { outcome: 'retry', reason: 'review_changed' };
    }
    // A transient account-facts read failure inside the claim is not a
    // person's action: retry it like a Google failure (codex r28).
    const transientStale = code === CODES.STALE && err.message.includes(ACCOUNT_READ_FAILED);
    // The live GET found our own earlier (uncertain) PUT and the publisher
    // recorded it as posted (codex r69): that IS the posted outcome — the
    // row already carries posted + our reply, the claim is cleared.
    if (code === CODES.HAS_REPLY && err.reconciled) return { outcome: 'posted', reconciled: true, mode: draft.mode };
    if (!transientStale && (code === CODES.HAS_REPLY || code === CODES.MISSING || code === CODES.RACE || code === CODES.STALE)) {
      // Not ours any more (a human replied / skipped / dismissed, or Google
      // removed it) — record and stop; never retry over a person's action.
      await releaseClaim(row, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: code, auto_reply_error: err.message });
      return { outcome: 'skipped', reason: code };
    }
    if (transientStale) code = 'account_read_failed';
    const attempts = (merged.auto_reply_attempts || 0) + 1;
    // Every transient class (lock contention, Google failure, unexpected)
    // shares ONE retry ceiling; after it the row parks for a person.
    // NO_RESOURCE is usually a Places-fallback row whose GBP identity the
    // next healthy sync will attach — retry on a longer backoff (and the
    // sync re-queues a parked row the moment it attaches the name).
    const backoffMin = code === CODES.NO_RESOURCE ? IDENTITY_BACKOFF_MIN : RETRY_BACKOFF_MIN;
    if ((code === CODES.LOCK_BUSY || code === CODES.GOOGLE_FAILED || code === CODES.NO_RESOURCE || code === 'account_read_failed' || code === 'unexpected') && attempts < MAX_ATTEMPTS) {
      const due = new Date(Date.now() + backoffMin * attempts * 60000).toISOString();
      await releaseClaim(row, { auto_reply_status: STATUS.FAILED, auto_reply_reason: code, auto_reply_attempts: attempts, auto_reply_due_at: due, auto_reply_error: err.message, auto_reply_draft: draft.text, auto_reply_drafted_at: (draft.reused && merged.auto_reply_drafted_at) || new Date().toISOString(), auto_reply_version: draft.version, auto_reply_mode: draft.mode, auto_reply_grounding: JSON.stringify(snapshot) });
      logger.warn(`[review-auto-reply] publish deferred for ${merged.id}: ${code} (${err.message})`);
      return { outcome: 'retry', reason: code };
    }
    const parkReason = code === CODES.NOT_CONFIGURED ? 'gbp_not_configured'
      : code === CODES.NO_RESOURCE ? 'no_gbp_resource'
        : code === CODES.LOCK_BUSY ? 'lock_busy'
          : code === 'account_read_failed' ? 'account_read_failed'
            : 'google_failed';
    if (!(await storeDraft(merged, draft, STATUS.PARKED, parkReason, { grounding: snapshot, fields: { auto_reply_attempts: attempts, auto_reply_error: String(err.message || err).slice(0, 1000) } }))) return { outcome: 'skipped', reason: 'changed_during_draft' };
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
  const stats = { mode: cfg.mode, enqueued: 0, bellsRetried: 0, claimed: 0, posted: 0, drafted: 0, parked: 0, skipped: 0, retry: 0, errors: 0 };
  // The failed-bell sweep runs regardless of the posting mode (codex r53):
  // a bell_failed stamp left while the lane was on must still be re-rung
  // after the gate is switched off.
  stats.bellsRetried = await retryFailedEditedBells().catch((err) => { logger.warn(`[review-auto-reply] bell retry sweep failed: ${err.message}`); return 0; });
  if (cfg.mode === 'off') return stats;
  stats.enqueued = await enqueueMissedReviews({ cfg }).catch((err) => { logger.warn(`[review-auto-reply] catch-up enqueue failed: ${err.message}`); return 0; });
  const rows = await claimDueRows({ limit });
  stats.claimed = rows.length;
  if (!rows.length) return stats;
  const techFirstNames = await loadActiveTechFirstNames();
  for (const claimed of rows) {
    let row = claimed;
    try {
      const renewed = await renewClaim(claimed);
      if (!renewed) {
        // Our stamp is gone: an admin skipped/dismissed the row, or the batch
        // outran the claim and someone else now owns it. Their outcome stands.
        stats.skipped++;
        logger.info(`[review-auto-reply] row ${claimed.id} claim lost before processing — skipped`);
        continue;
      }
      row = renewed;
      const r = await processClaimedRow(row, { cfg, techFirstNames });
      if (stats[r.outcome] != null) stats[r.outcome]++;
    } catch (err) {
      stats.errors++;
      logger.error(`[review-auto-reply] row ${row.id} failed: ${err.message}`);
      // Same retry ceiling as the handled paths: park + action bell after it.
      const attempts = (row.auto_reply_attempts || 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const owned = await releaseClaim(row, {
        auto_reply_status: exhausted ? STATUS.PARKED : STATUS.FAILED,
        auto_reply_reason: 'runner_error',
        auto_reply_attempts: attempts,
        ...(exhausted ? {} : { auto_reply_due_at: new Date(Date.now() + RETRY_BACKOFF_MIN * attempts * 60000).toISOString() }),
        auto_reply_error: String(err.message || err).slice(0, 1000),
      }).catch(() => false);
      // A skip/dismiss that cleared the claim meanwhile owns the outcome —
      // no "needs you" bell over a deliberate cancellation.
      if (exhausted && owned) {
        await bell(row, { title: 'Review reply needs you', body: `${summarize(row)} — the auto-reply runner failed ${attempts} times (${String(err.message || err).slice(0, 120)}). Reply by hand.`, reason: 'runner_error', action: true });
      }
    }
  }
  return stats;
}

/**
 * Admin "Post now": bypass the jitter (and shadow mode) for one review. A
 * human "[DRAFT]" is published as written; a stored auto draft is published
 * once it re-verifies against the current state; otherwise a fresh draft is
 * produced. Low-rating rows may be posted this way because a human
 * asked.
 */
async function postNow(reviewId, actor, { expectedDraft = undefined } = {}) {
  // Skip auto is authoritative (codex r57): a stale Post now must not publish
  // a draft a person took out of the pipeline. (Use Draft on the editor
  // route still works for a skipped draft — that is a human posting it.)
  const pre = await db('google_reviews').where({ id: reviewId }).first('auto_reply_status');
  if (pre?.auto_reply_status === STATUS.SKIPPED) {
    throw new ReviewReplyError(CODES.STALE, 'This review was taken out of the automatic pipeline (Skip auto) — post it from the editor with Use Draft, or reply by hand.', { status: 409 });
  }
  const [row] = await claimDueRows({ limit: 1, force: reviewId });
  if (!row) throw new ReviewReplyError(CODES.LOCK_BUSY, 'This review is being processed — try again in a moment.', { status: 409 });
  if (hasRealReply(row.review_reply)) {
    await releaseClaim(row);
    throw new ReviewReplyError(CODES.HAS_REPLY, 'This review already has a posted reply', { status: 409 });
  }
  // Bind the click to the draft the admin actually SAW (hook P1): another
  // admin or Agent Ops may have replaced the displayed draft before this
  // request; inside the claim the current draft slot must equal it.
  if (expectedDraft !== undefined) {
    const shown = humanDraftOn(row)
      || (row.auto_reply_draft && DRAFT_HOLDING_STATUSES.includes(row.auto_reply_status) ? row.auto_reply_draft : null);
    if (String(expectedDraft || '').trim() !== String(shown || '').trim()) {
      await releaseClaim(row);
      throw new ReviewReplyError(CODES.STALE, 'The draft on this review changed since the page was loaded — reload it and read the current draft first.', { status: 409 });
    }
  }
  // The draft the admin is looking at wins: a human-written "[DRAFT]" first,
  // then the pipeline's own verified draft, else draft fresh.
  const storedGrounding = row.auto_reply_grounding && typeof row.auto_reply_grounding === 'object' ? row.auto_reply_grounding : null;
  const storedFp = storedGrounding?.fingerprint || null;
  // A stored draft is only offered as-is when both the review fingerprint
  // AND the account-fact fingerprint still match; otherwise Post-now drafts
  // fresh (never a 409 the admin cannot get past).
  const accountFpNow = accountFingerprint(await loadAccountFacts(groundingCustomerId(row)).catch(() => null));
  const humanDraft = humanDraftOn(row);
  // An Agent Ops draft is MACHINE-authored (its text is mirrored into
  // auto_reply_draft, so it is not a human draft): it goes through the same
  // re-verification as a pipeline draft before Post now publishes it, and a
  // failing verdict surfaces a canonical replacement (codex r46).
  const agentDraft = row.auto_reply_reason === AGENT_OPS_DRAFT && row.auto_reply_draft
    && isDraftReply(row.review_reply) && stripDraftPrefix(row.review_reply).trim() === String(row.auto_reply_draft).trim()
    ? row.auto_reply_draft : null;
  const hadStoredDraft = !!row.auto_reply_draft && DRAFT_HOLDING_STATUSES.includes(row.auto_reply_status);
  if (humanDraft && row.auto_reply_reason === HUMAN_DRAFT_STALE) {
    await releaseClaim(row);
    throw new ReviewReplyError(CODES.STALE, 'This draft was written before the review changed — read the current review and edit the draft first.', { status: 409 });
  }
  let existing = humanDraft
    || agentDraft
    || (row.auto_reply_draft
      && DRAFT_HOLDING_STATUSES.includes(row.auto_reply_status)
      && storedFp === reviewFingerprint(row)
      && storedGrounding?.accountFingerprint === accountFpNow
      ? row.auto_reply_draft : null);
  // A stored AUTO draft was verified against the posted replies of its day;
  // another review may have posted the same opening since, or the verifier
  // may have tightened. Re-verify it against the current state (same rule as
  // the retry lane) and draft fresh when it no longer passes. A human
  // "[DRAFT]" is the admin's own text and is published as written.
  if (existing && !humanDraft) {
    try {
      const groundingNow = await buildReplyGrounding(row);
      const recentNow = await loadRecentPostedReplies(row.location_id);
      const verdict = verifyReplyText(existing, groundingNow, { recentReplies: recentNow, mode: row.auto_reply_mode || undefined });
      if (verdict) {
        logger.info(`[review-auto-reply] post-now: stored draft for ${row.id} no longer verifies (${verdict}) — drafting fresh`);
        existing = null;
      }
    } catch (err) {
      await releaseClaim(row, { auto_reply_error: String(err.message || err).slice(0, 1000) }).catch(() => {});
      throw err;
    }
  }
  if (existing) {
    const publishedAt = new Date().toISOString();
    try {
      const publishedExisting = await publishReviewReply({
        reviewId,
        text: existing,
        actor,
        autoFields: {
          auto_reply_status: STATUS.POSTED,
          auto_reply_reason: null,
          // The attempted text is the pipeline's record of what posted (a
          // human draft too), so reconciliation and Retract see it.
          auto_reply_draft: existing,
          // A human draft carries HUMAN provenance — never the earlier model
          // version / mode / grounding snapshot (codex r40).
          ...(humanDraft
            ? { auto_reply_version: 'human', auto_reply_mode: null, auto_reply_grounding: null, auto_reply_drafted_at: publishedAt }
            : { auto_reply_drafted_at: row.auto_reply_drafted_at || publishedAt, auto_reply_grounding: JSON.stringify(storedGrounding || null) }),
          auto_reply_published_at: publishedAt,
          auto_reply_error: null,
          auto_reply_claimed_until: null,
        },
        auditMeta: humanDraft ? { version: 'human', mode: null, intent: 'post_now' } : { version: row.auto_reply_version, mode: row.auto_reply_mode, intent: 'post_now' },
        // Post-now publishes the draft the admin is looking at — a human
        // draft on the row is the payload, not an intervention.
        guard: claimGuard(row, { publishingText: existing, accountFingerprint: humanDraft ? null : storedGrounding?.accountFingerprint || null }),
        // …and the same fingerprint for the publisher's transactional
        // post-PUT check (codex r42): facts that change while the PUT is in
        // flight park the reply instead of recording it cleanly posted.
        expectedAccountFingerprint: humanDraft ? undefined : (storedGrounding?.accountFingerprint || undefined),
        requireGoogle: true,
      });
      if (publishedExisting?.editedDuringPut) return { outcome: 'parked', reason: 'review_edited_after_post', mode: row.auto_reply_mode, live: true };
      return { outcome: 'posted', mode: row.auto_reply_mode };
    } catch (err) {
      if (err instanceof ReviewReplyError && err.code === CODES.PERSIST_FAILED) {
        // Live on Google, unrecorded locally: park, never back into the retry lane.
        await parkPersistFailed(row, { text: existing, version: row.auto_reply_version, mode: row.auto_reply_mode }, err);
        throw err;
      }
      if (err instanceof ReviewReplyError && err.code === CODES.GOOGLE_UNCERTAIN) {
        // Publisher parked it; never release back into the retry lane. Record
        // the ATTEMPTED text (a human draft has no auto_reply_draft of its
        // own) so the sync can recognise a landed PUT and close it as
        // posted instead of an unrelated owner reply (codex r34).
        await db('google_reviews').where({ id: reviewId }).update({
          auto_reply_draft: existing,
          ...(humanDraft
            ? { auto_reply_version: 'human', auto_reply_mode: null, auto_reply_grounding: null, auto_reply_drafted_at: new Date().toISOString() }
            : { auto_reply_version: row.auto_reply_version || null, auto_reply_mode: row.auto_reply_mode || null, auto_reply_drafted_at: row.auto_reply_drafted_at || new Date().toISOString(), auto_reply_grounding: JSON.stringify(storedGrounding || null) }),
        }).catch(() => {});
        throw err;
      }
      if (err instanceof ReviewReplyError && [CODES.HAS_REPLY, CODES.MISSING, CODES.RACE].includes(err.code)) {
        // Google (or a person) already answered / the review is gone — close
        // the saved-draft state so the card stops showing a stale draft.
        await releaseClaim(row, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: err.code, auto_reply_error: err.message });
        throw err;
      }
      await releaseClaim(row, { auto_reply_error: err.message });
      throw err;
    }
  }
  try {
    // A displayed pipeline draft that was discarded above must be replaced
    // by a SURFACED draft, never published unseen.
    return await processClaimedRow(row, { intent: 'post_now', actor: actor || { type: 'admin' }, surfaceOnly: hadStoredDraft && !humanDraft && !existing });
  } catch (err) {
    // Errors before processClaimedRow's own publish try/catch (grounding
    // read, GBP config check…) must not strand the claim for its TTL.
    await releaseClaim(row, { auto_reply_error: String(err.message || err).slice(0, 1000) }).catch(() => {});
    throw err;
  }
}

/**
 * Admin "Skip": take the review out of the automatic pipeline (stays a
 * manual task in the existing needs-reply queue).
 */
async function skipAutoReply(reviewId, { reason = 'admin_skip' } = {}) {
  const row = await db('google_reviews').where({ id: reviewId }).first();
  if (!row) return false;
  // A reconciliation park (google_uncertain / persist_failed) may have a
  // reply LIVE on Google that the next sync must recognise as ours; a skip
  // would rewrite the state that branch keys on and lose pipeline ownership
  // of a landed reply (codex r67). Retract / wait for the sync instead.
  if (row.auto_reply_status === STATUS.PARKED && RECONCILE_REASONS.has(row.auto_reply_reason)) return false;
  // A FAILED publish-retry row keeps its verified draft only in
  // auto_reply_draft (the slot stays empty while retrying): copy it into the
  // visible "[DRAFT]" slot on skip so the person still sees it (codex r51).
  const surface = row.auto_reply_status === STATUS.FAILED && row.auto_reply_draft && row.review_reply == null
    ? { review_reply: asDraft(row.auto_reply_draft), reply_updated_at: null }
    : {};
  const q = db('google_reviews')
    .where({ id: reviewId })
    .whereIn('auto_reply_status', [STATUS.QUEUED, STATUS.DRAFTED, STATUS.PARKED, STATUS.FAILED])
    // A publish in flight holds the per-review publish claim; refusing the
    // skip (409 to the admin, retry in a moment) is the honest answer — the
    // publisher's pre-PUT guard covers the rest of the window.
    .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()]);
  if (Object.keys(surface).length) q.whereNull('review_reply');
  const updated = await q.update({ auto_reply_status: STATUS.SKIPPED, auto_reply_reason: reason, auto_reply_claimed_until: null, ...surface });
  return (Array.isArray(updated) ? updated.length : updated) > 0;
}

/**
 * Merged into the dismiss routes' UPDATE so dismissal cancels any pending
 * auto-reply state in the same statement (and drops a live claim, which
 * makes the holder's in-lock guard fail).
 */
// Pipeline states whose stored draft is NOT a draft for the current review
// once the reviewer edits it. Reconciliation parks (google_uncertain /
// persist_failed: a PUT may be live) and human drafts are left alone.
const REDRAFT_ON_EDIT_STATUSES = new Set([STATUS.DRAFTED, STATUS.PARKED, STATUS.FAILED]);
// States whose stored pipeline draft is still offered to a person (Use Draft /
// Post now): an admin Skip leaves the pipeline but keeps the draft useful.
const DRAFT_HOLDING_STATUSES = [STATUS.DRAFTED, STATUS.PARKED, STATUS.FAILED, STATUS.SKIPPED];
// A human "[DRAFT]" the sync found written for an earlier version of the review.
const HUMAN_DRAFT_STALE = 'human_draft_stale';
// A draft Agent Ops (its own template writer) saved: machine-authored text
// that must pass the canonical verifier before it can reach Google.
const AGENT_OPS_DRAFT = 'agent_ops_draft';
// review_edited_after_post: a POSTED reply parked for a person after the
// reviewer's first edit keeps that park (and Retract) through later edits.
const KEEP_ON_EDIT_REASONS = new Set(['google_uncertain', 'persist_failed', 'review_edited_after_post']);
// Parks where the pipeline's own PUT may already be live on Google.
const RECONCILE_REASONS = new Set(['google_uncertain', 'persist_failed']);

/**
 * Fields the sync applies when the REVIEW itself changed (rating / text /
 * name — the sync just overwrote them). Returns {} when nothing changed.
 *   - A POSTED automatic reply is no longer known to fit: park for a person.
 *   - A pipeline-owned draft (drafted / parked / failed, its own "[DRAFT]"
 *     in the reply slot) was written for the OLD review: clear it and
 *     requeue, so neither Post now nor "Use Draft" can carry an upbeat
 *     draft onto a rewritten complaint. A human's "[DRAFT]" is theirs.
 */
function reviewEditFields(existing, normalized) {
  if (!existing) return {};
  const before = reviewFingerprint(existing);
  const after = reviewFingerprint({ ...existing, star_rating: normalized.star_rating, review_text: normalized.review_text, reviewer_name: normalized.reviewer_name, customer_id: normalized.customer_id !== undefined ? normalized.customer_id : existing.customer_id, link_source: normalized.link_source !== undefined ? normalized.link_source : existing.link_source });
  if (before === after) return {};
  if (existing.auto_reply_status === STATUS.POSTED) {
    return { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'review_edited_after_post' };
  }
  if (KEEP_ON_EDIT_REASONS.has(existing.auto_reply_reason)) return {};
  // A person's saved "[DRAFT]" was written for the OLD review: keep their
  // text (never destroy a human's work) but mark it stale — Use Draft and
  // Post now refuse it verbatim until it is edited or re-saved.
  if (humanDraftOn(existing)) {
    return { auto_reply_status: STATUS.PARKED, auto_reply_reason: 'human_draft_stale', auto_reply_claimed_until: null };
  }
  if (!REDRAFT_ON_EDIT_STATUSES.has(existing.auto_reply_status)) return {};
  if (!existing.auto_reply_draft) return {};
  return {
    auto_reply_status: STATUS.QUEUED,
    auto_reply_reason: 'review_changed',
    auto_reply_due_at: new Date().toISOString(),
    auto_reply_attempts: 0,
    auto_reply_draft: null,
    auto_reply_drafted_at: null,
    auto_reply_grounding: null,
    auto_reply_error: null,
    ...(isDraftReply(existing.review_reply) ? { review_reply: null, reply_updated_at: null } : {}),
  };
}

/**
 * Apply reviewEditFields as a compare-and-set on the state the sync
 * snapshot saw (status + reply slot): a publisher, skip, or human draft that
 * landed between the sync's read and this write wins. Returns the
 * affected-row count.
 */
async function applyReviewEditFields(reviewId, existing, normalized, { conn = db, now = new Date() } = {}) {
  const fields = reviewEditFields(existing, normalized);
  if (!Object.keys(fields).length) return 0;
  const q = conn('google_reviews').where({ id: reviewId });
  if (existing.auto_reply_status == null) q.whereNull('auto_reply_status'); else q.where('auto_reply_status', existing.auto_reply_status);
  if (existing.auto_reply_status !== STATUS.POSTED) {
    q.whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [now.toISOString()]);
    if (existing.review_reply == null) q.whereNull('review_reply'); else q.where('review_reply', existing.review_reply);
  }
  const n = await q.update(fields);
  return Array.isArray(n) ? n.length : n;
}

/**
 * Conditional write for requeueFieldsOnIdentity: only when the row is STILL
 * parked for the same reason the snapshot saw (an admin Skip in between
 * must win). Returns the affected-row count.
 */
async function applyRequeueOnIdentity(reviewId, existing, normalized, { conn = db } = {}) {
  const fields = requeueFieldsOnIdentity(existing, normalized);
  if (!Object.keys(fields).length) return 0;
  const n = await conn('google_reviews')
    .where({ id: reviewId, auto_reply_status: existing.auto_reply_status, auto_reply_reason: existing.auto_reply_reason })
    .update(fields);
  return Array.isArray(n) ? n.length : n;
}

/**
 * Reply fields the GBP sync writes onto an EXISTING row from a feed snapshot.
 *   - A live publish claim on the row means a publisher is mid-flight: the
 *     snapshot may predate its PUT, so provider reply fields are deferred to
 *     the next sync (never overwrite a just-persisted reply with "").
 *   - An owner reply present on Google REPLACES a local "[DRAFT]" (the draft
 *     preservation rule only protects a draft against an EMPTY feed) and
 *     closes any pending auto-reply state, so the row leaves the queue.
 *   - Otherwise the historical rule: a local draft survives an empty feed;
 *     anything else mirrors the feed.
 */
function syncReplyFields(existing, normalized, { now = new Date(), fnNow = null } = {}) {
  const ownerReply = String(normalized?.owner_reply || '').trim();
  const updatedAt = ownerReply ? (normalized.owner_reply_updated_at || fnNow || now.toISOString()) : null;
  const claimLive = existing?.publish_claimed_until && new Date(existing.publish_claimed_until) > now;
  if (claimLive) return {};
  if (ownerReply) {
    const fields = { review_reply: ownerReply, reply_updated_at: updatedAt };
    // A reconciliation park (google_uncertain: the PUT timed out; persist_
    // failed: the PUT landed but the row write failed) whose live reply IS
    // the pipeline's own draft: our reply landed. Close it as POSTED with
    // publication metadata so it stays pipeline-owned (Retract keeps
    // working) instead of being mistaken for an unrelated owner reply.
    if (existing?.auto_reply_status === STATUS.PARKED
      && RECONCILE_REASONS.has(existing.auto_reply_reason)
      && existing.auto_reply_draft && ownerReply === String(existing.auto_reply_draft).trim()) {
      // The landed reply was grounded on the review + attribution in its
      // snapshot; if either moved since (a re-attribution before this sync,
      // a reviewer edit) it lands as parked/review_edited_after_post for a
      // person, never a clean 'posted' (codex r44).
      const snap = (() => { const g = existing.auto_reply_grounding; if (!g) return null; if (typeof g === 'string') { try { return JSON.parse(g); } catch { return null; } } return g; })();
      const groundedOnCurrent = !snap?.fingerprint || snap.fingerprint === reviewFingerprint(existing);
      return {
        ...fields,
        auto_reply_status: groundedOnCurrent ? STATUS.POSTED : STATUS.PARKED,
        auto_reply_reason: groundedOnCurrent ? null : 'review_edited_after_post',
        auto_reply_published_at: existing.auto_reply_published_at || updatedAt,
        auto_reply_error: null,
        auto_reply_claimed_until: null,
      };
    }
    // A posted reply parked for a person after a reviewer edit: while Google
    // still shows OUR reply the park (and Retract) must survive every later
    // sync; only an owner edit on Google hands it over (edited_on_google).
    if (existing?.auto_reply_status === STATUS.PARKED
      && existing.auto_reply_reason === 'review_edited_after_post'
      && hasRealReply(existing.review_reply)) {
      if (ownerReply === String(existing.review_reply).trim()) return fields;
      return { ...fields, auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'edited_on_google' };
    }
    const pending = [STATUS.QUEUED, STATUS.DRAFTED, STATUS.PARKED, STATUS.FAILED];
    if (existing && pending.includes(existing.auto_reply_status)) {
      Object.assign(fields, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'owner_replied_on_google', auto_reply_claimed_until: null });
    } else if (existing?.auto_reply_status === STATUS.POSTED && ownerReply !== String(existing.review_reply || '').trim()) {
      // The owner edited our posted reply directly in Google: it is theirs
      // now — close the automatic state so Retract is no longer offered.
      Object.assign(fields, { auto_reply_status: STATUS.SKIPPED, auto_reply_reason: 'edited_on_google' });
    }
    return fields;
  }
  // An authoritative snapshot with NO owner reply resolves a google_uncertain
  // park: the timed-out PUT did not land. Back into the retry lane with the
  // attempted draft (reused, re-verified; the publisher's live GET still
  // yields to a late-landing reply) — codex r41. persist_failed (the PUT is
  // known to have landed) stays with a person.
  if (existing?.auto_reply_status === STATUS.PARKED && existing.auto_reply_reason === 'google_uncertain' && !hasRealReply(existing.review_reply)) {
    return { review_reply: null, reply_updated_at: null, auto_reply_status: STATUS.FAILED, auto_reply_reason: 'google_uncertain_cleared', auto_reply_due_at: now.toISOString(), auto_reply_claimed_until: null };
  }
  // No owner reply on Google: ours is gone (owner deleted it there).
  return removedOwnerReplyFields(existing);
}

/**
 * Apply sync-derived reply fields to an EXISTING row as a SEPARATE statement
 * conditioned on the publish claim AT WRITE TIME: syncReplyFields judged a
 * snapshot, and a publisher can acquire its claim (and persist a reply)
 * between that read and this write — a stale empty-feed snapshot must not
 * overwrite it. Returns the affected-row count.
 */
async function applySyncReplyFields(reviewId, fields, { conn = db, now = new Date(), expectedReply = undefined } = {}) {
  if (!fields || !Object.keys(fields).length) return 0;
  const q = conn('google_reviews')
    .where({ id: reviewId })
    .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [now.toISOString()]);
  // Compare-and-set on the reply the snapshot saw: a "[DRAFT]" (runner or
  // human) or a reply saved between the sync's read and this write means
  // the judgement is stale — leave the row for the next sync.
  if (expectedReply !== undefined) {
    if (expectedReply == null) q.whereNull('review_reply');
    else q.where('review_reply', expectedReply);
  }
  const n = await q.update(fields);
  return Array.isArray(n) ? n.length : n;
}

/**
 * Merged into the GBP sync's UPDATE of an existing row: a row that parked on
 * `no_gbp_resource` (first seen via the Places fallback) re-enters the queue
 * the moment the authoritative sync attaches its GBP identity.
 */
function requeueFieldsOnIdentity(existing, normalized) {
  if (!existing) return {};
  if (hasRealReply(normalized?.owner_reply) || existing.dismissed) return {};
  // A queued review the sync stamped missing (skipped/missing) that Google
  // has now reinstated — this authoritative sync proves it is live again.
  if (existing.auto_reply_status === STATUS.SKIPPED && ['missing', 'review_missing'].includes(existing.auto_reply_reason) && existing.missing_since) {
    return { auto_reply_status: STATUS.QUEUED, auto_reply_reason: 'reinstated', auto_reply_due_at: new Date().toISOString(), auto_reply_attempts: 0 };
  }
  if (existing.auto_reply_status !== STATUS.PARKED) return {};
  // Called only from the AUTHORITATIVE GBP sync, so the location's
  // credentials demonstrably work: a row parked on gbp_not_configured revives.
  if (existing.auto_reply_reason === 'gbp_not_configured') {
    return { auto_reply_status: STATUS.QUEUED, auto_reply_reason: 'gbp_connected', auto_reply_due_at: new Date().toISOString(), auto_reply_attempts: 0 };
  }
  if (existing.auto_reply_reason !== 'no_gbp_resource') return {};
  if (existing.gbp_review_name || !normalized?.gbp_review_name) return {};
  return { auto_reply_status: STATUS.QUEUED, auto_reply_reason: 'identity_attached', auto_reply_due_at: new Date().toISOString(), auto_reply_attempts: 0 };
}

// Dismissal must not land under an in-flight publish (same predicate as
// skipAutoReply): the dismiss routes add this to their WHERE.
function whereNoLivePublishClaim(qb) {
  qb.whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()]);
}

/**
 * Merged into a HUMAN reply publish (admin route, IB tool): close automatic
 * state only when the row actually had one (pending or posted); a
 * never-queued row keeps its documented NULL.
 */
function manualReplyCloseFields(conn = db) {
  const live = "('queued','drafted','parked','failed','posted')";
  return {
    auto_reply_status: conn.raw(`CASE WHEN auto_reply_status IN ${live} THEN 'skipped' ELSE auto_reply_status END`),
    auto_reply_reason: conn.raw(`CASE WHEN auto_reply_status IN ${live} THEN 'manual_reply' ELSE auto_reply_reason END`),
    auto_reply_claimed_until: null,
  };
}

// A reconciliation park (google_uncertain / persist_failed) may have OUR
// reply live on Google; the next sync recognises it only through that parked
// state. Dismiss must refuse such rows (codex r70) — the dismiss routes add
// this predicate — and the cancel CASE below never rewrites them either.
// NULL-safe (codex r71): pre-rollout rows keep auto_reply_status NULL, and
// NOT (NULL = 'parked' AND …) is NULL — COALESCE makes it a plain false.
const RECONCILE_PARK_SQL = "COALESCE((auto_reply_status = 'parked' AND auto_reply_reason IN ('google_uncertain','persist_failed')), false)";
function whereNoReconcilePark(qb) {
  qb.whereRaw(`NOT ${RECONCILE_PARK_SQL}`);
}

function dismissCancelFields(conn = db) {
  const pending = `(auto_reply_status IN ('queued','drafted','parked','failed') AND NOT ${RECONCILE_PARK_SQL})`;
  return {
    auto_reply_status: conn.raw(`CASE WHEN ${pending} THEN 'skipped' ELSE auto_reply_status END`),
    auto_reply_reason: conn.raw(`CASE WHEN ${pending} THEN 'dismissed' ELSE auto_reply_reason END`),
    auto_reply_claimed_until: null,
  };
}

/**
 * Guard for the HUMAN reply route: when the text being posted is the
 * pipeline's own stored draft ("Use Draft" on the Reviews page), it was
 * written against a review + account-facts snapshot; a re-attribution, a
 * city / tenure correction, or a review edit since then makes it a claim
 * about someone else. Runs inside the publish claim on the fresh row and
 * refuses (409 STALE) unless both fingerprints still match. Any other text
 * (a person's own words, an edited draft) passes untouched.
 */
function pipelineDraftGuard(text, { draftToken = null, groundingToken = null } = {}) {
  const submitted = String(text || '').trim();
  const token = draftToken ? String(draftToken) : null;
  // An editor AI draft (/ai-reply) is never stored on the row; its token
  // carries the review + account fingerprints it was grounded on.
  // A token that is present but malformed is NOT an unguarded submission
  // (codex r47): both halves must be well-formed fingerprints.
  const parsedToken = parseGroundingToken(groundingToken);
  const tokenInvalid = groundingToken != null && groundingToken !== '' && !parsedToken;
  const gReview = parsedToken?.review || null;
  const gAccount = parsedToken?.account || null;
  const gText = parsedToken?.text || null;
  return async (fresh) => {
    if (!fresh) return null;
    if (tokenInvalid) return 'the grounding token is malformed — draft again';
    // A text-bound token (Intelligence Bar) accepts ONLY the approved draft.
    if (gText && gText !== replyTextFingerprint(submitted)) return 'the reply text differs from the draft that was approved — draft again and submit it unchanged';
    // An Agent Ops draft has no grounding snapshot (its writer is not the
    // canonical drafter). Posting it VERBATIM through Use Draft runs the
    // canonical verifier here (codex r46/r58); text the admin edited is
    // their own and takes the ordinary human path.
    if (fresh.auto_reply_reason === AGENT_OPS_DRAFT && fresh.auto_reply_draft) {
      if (submitted !== String(fresh.auto_reply_draft).trim()) return null;
      try {
        const groundingNow = await buildReplyGrounding(fresh);
        const recentNow = await loadRecentPostedReplies(fresh.location_id);
        const verdict = verifyReplyText(submitted, groundingNow, { recentReplies: recentNow });
        return verdict ? `the Agent Ops draft does not pass the public-reply checks (${verdict}) — edit it before posting` : null;
      } catch (e) { return `the Agent Ops draft could not be verified (${e.message})`; }
    }
    const human = humanDraftOn(fresh);
    if (human && submitted === human && fresh.auto_reply_reason === HUMAN_DRAFT_STALE) {
      return 'this draft was written before the review changed — read the current review and edit the draft first';
    }
    if (gReview) {
      if (gReview !== reviewFingerprint(fresh)) return 'the review or its customer link changed since this draft was generated — reload and draft again';
      let current;
      try { current = accountFingerprint(await loadAccountFacts(groundingCustomerId(fresh))); } catch { return 'account facts could not be re-read'; }
      if (current !== (gAccount || '')) return 'the customer facts changed since this draft was generated — reload and draft again';
    }
    const holdsDraft = !!fresh.auto_reply_draft && DRAFT_HOLDING_STATUSES.includes(fresh.auto_reply_status);
    const isStoredDraft = holdsDraft && submitted === String(fresh.auto_reply_draft).trim();
    // Draft identity travels with the request ("Use Draft" stamps the
    // review fingerprint the draft was loaded under): the editor keeps its
    // copied text even after the sync cleared the draft for a reviewer edit
    // or re-attribution, and by then the row carries nothing to compare
    // against. A token is binding whether or not the text was edited.
    if (!token && !isStoredDraft) return null;
    if (token) {
      if (!holdsDraft) return 'this automatic draft was cleared since it was loaded (the review changed, or it was posted or skipped) — reload and draft again';
      if (token !== reviewFingerprint(fresh)) return 'the review or its customer link changed since this draft was loaded — reload and draft again';
    }
    const stored = fresh.auto_reply_grounding && typeof fresh.auto_reply_grounding === 'object' ? fresh.auto_reply_grounding : null;
    if (!stored?.fingerprint) return 'this automatic draft has no grounding record — write the reply yourself or use Post now';
    if (stored.fingerprint !== reviewFingerprint(fresh)) return 'the review or its customer link changed since this draft was written — reload and draft again';
    let current;
    try { current = accountFingerprint(await loadAccountFacts(groundingCustomerId(fresh))); } catch { return 'account facts could not be re-read'; }
    if (current !== stored.accountFingerprint) return 'the customer facts changed since this draft was written — reload and draft again';
    return null;
  };
}

/**
 * Fields an AGENT-authored draft writer (Agent Ops) merges into its
 * "[DRAFT]" write: the text is mirrored into auto_reply_draft with machine
 * provenance and the row parks agent_ops_draft, so Post now re-verifies it
 * like a pipeline draft (never publishes it as a person's own words) and a
 * pending automatic post is cancelled.
 */
function agentDraftSavedFields(text) {
  return {
    auto_reply_draft: String(text || '').trim(),
    auto_reply_status: STATUS.PARKED,
    auto_reply_reason: AGENT_OPS_DRAFT,
    auto_reply_version: 'agent_ops',
    auto_reply_mode: null,
    auto_reply_grounding: null,
    auto_reply_claimed_until: null,
  };
}

/**
 * Action bell for a POSTED automatic reply whose review changed underneath
 * it (reviewer edit via sync, or a manual re-attribution): the row is parked
 * review_edited_after_post; a person checks whether the reply still fits.
 */
async function notifyReviewEditedAfterPost(existing, { location_id, star_rating, cause = 'edit', conn = db } = {}) {
  const locName = locationName(location_id);
  const what = cause === 'attribution'
    ? `${star_rating}★ review on ${locName} was re-attributed to a different customer after our automatic reply posted — the reply used the previous customer's facts; check whether it still fits (edit or retract).`
    : `${star_rating}★ review on ${locName} was edited by the reviewer after our automatic reply posted — check whether the reply still fits (edit or retract).`;
  const send = () => NotificationService.notifyAdmin('review', cause === 'attribution' ? 'Review re-attributed after auto-reply' : 'Review edited after auto-reply', what, {
    link: `/admin/reviews?responded=all&review=${encodeURIComponent(existing.id)}`,
    bell: true,
    dedupeKey: `review-auto-reply:${existing.id}:review_edited_after_post`,
    metadata: { reason: 'review_edited_after_post', cause, reviewId: existing.id, locationId: location_id, needsAction: true },
  });
  // notifyAdmin resolves null on an insert failure (it never throws): treat
  // null as failure, retry briefly, and when it still fails stamp the row
  // so the cron's sweep re-rings it — the park must never go unnoticed
  // (codex r46).
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    try { ok = !!(await send()); } catch (e) { logger.warn(`[review-auto-reply] edited-after-post bell attempt ${attempt + 1} failed for ${existing.id}: ${e.message}`); }
    if (!ok && attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  if (ok) {
    await conn('google_reviews').where({ id: existing.id }).where('auto_reply_error', 'like', `${BELL_FAILED_PREFIX}%`).update({ auto_reply_error: null }).catch(() => {});
    return true;
  }
  logger.error(`[review-auto-reply] edited-after-post bell FAILED for ${existing.id} — stamped for the sweep`);
  await conn('google_reviews').where({ id: existing.id }).update({ auto_reply_error: `${BELL_FAILED_PREFIX}${cause}` }).catch(() => {});
  return false;
}
const BELL_FAILED_PREFIX = 'bell_failed:review_edited_after_post:';

/**
 * Cron sweep: re-ring edited-after-post bells whose insert failed (rows
 * stamped by notifyReviewEditedAfterPost). Bounded; a success clears the
 * stamp.
 */
async function retryFailedEditedBells({ limit = 20 } = {}) {
  const rows = await db('google_reviews')
    .where('auto_reply_error', 'like', `%bell_failed:%`)
    .limit(limit)
    .select('id', 'location_id', 'star_rating', 'reviewer_name', 'auto_reply_status', 'auto_reply_reason', 'auto_reply_error');
  let n = 0;
  for (const r of rows || []) {
    const err = String(r.auto_reply_error || '');
    if (err.startsWith(BELL_FAILED_PREFIX) && r.auto_reply_reason === 'review_edited_after_post') {
      const cause = err.slice(BELL_FAILED_PREFIX.length) || 'edit';
      if (await notifyReviewEditedAfterPost(r, { location_id: r.location_id, star_rating: r.star_rating, cause })) n++;
      continue;
    }
    const m = err.match(BELL_STAMP_RE);
    if (!m) continue;
    const [reason, actionFlag] = String(m[1]).split(':');
    const action = actionFlag !== '0';
    // Re-ring with a generic body: the original wording is not stored, the
    // row state is what the person needs.
    if (await bell(r, { title: action ? 'Review reply needs you' : 'Auto-reply update', body: `${summarize(r)} — auto-reply ${r.auto_reply_status || 'state'}${reason ? ` (${String(reason).replace(/_/g, ' ')})` : ''}. Open Reviews.`, reason: reason || r.auto_reply_reason || 'unknown', action })) n++;
  }
  return n;
}

/**
 * A landed uncertain write about to be promoted to POSTED by the sync (codex
 * r45): the draft's grounding snapshot carries the ACCOUNT fingerprint it was
 * written from; if the facts moved since (city / relationship / categories),
 * the promotion lands parked/review_edited_after_post for a person instead.
 * Returns the (possibly adjusted) fields. Read failures park (fail closed).
 */
async function validatePromotionAccountFacts(existing, fields, { conn = db } = {}) {
  if (!fields || fields.auto_reply_status !== STATUS.POSTED || existing?.auto_reply_status !== STATUS.PARKED || !RECONCILE_REASONS.has(existing?.auto_reply_reason)) return fields;
  const g = existing.auto_reply_grounding;
  const snap = !g ? null : (typeof g === 'string' ? (() => { try { return JSON.parse(g); } catch { return null; } })() : g);
  if (!snap?.accountFingerprint) return fields;
  let current;
  try {
    // Lock the rows the facts derive from (customer + their service rows)
    // inside the caller's transaction, so a concurrent correction cannot
    // commit between this read and applySyncReplyFields (codex r46).
    const customerId = groundingCustomerId(existing);
    if (customerId) {
      await conn('customers').where({ id: customerId }).forUpdate().first('id');
      await conn('scheduled_services').where({ customer_id: customerId }).forUpdate().select('id');
    }
    current = accountFingerprint(await loadAccountFacts(customerId, conn));
  } catch { current = null; }
  if (current === snap.accountFingerprint) return fields;
  return { ...fields, auto_reply_status: STATUS.PARKED, auto_reply_reason: 'review_edited_after_post' };
}

/**
 * Parse a grounding token ("<review sha1>|<account sha1>"). Returns
 * { review, account } or null when either half is missing / malformed.
 */
const FINGERPRINT_RE = /^[0-9a-f]{40}$/i;
function parseGroundingToken(token) {
  if (typeof token !== 'string') return null;
  // Optional trailing "#<sha1>" (codex r67): the exact draft text the
  // operator approved (Intelligence Bar conversational confirmation). The
  // account half is opaque and may itself contain '|', so the text segment
  // uses its own separator.
  let text = null;
  let rest = token;
  const h = token.indexOf('#');
  if (h >= 0) {
    text = token.slice(h + 1);
    rest = token.slice(0, h);
    if (!FINGERPRINT_RE.test(text)) return null;
  }
  const i = rest.indexOf('|');
  if (i <= 0) return null;
  const review = rest.slice(0, i);
  const account = rest.slice(i + 1);
  // The review half is a canonical sha1 (reviewFingerprint); the account
  // half is opaque (accountFingerprint) but must be present.
  if (!FINGERPRINT_RE.test(review) || !account.trim()) return null;
  return text ? { review, account, text } : { review, account };
}

/** sha1 of the trimmed reply text — the identity of an approved draft. */
function replyTextFingerprint(text) {
  return crypto.createHash('sha1').update(String(text || '').trim()).digest('hex');
}

/**
 * Token for an editor AI draft: the review + account fingerprints it saw.
 * With `text`, the token also binds the exact draft the operator approved
 * (the Intelligence Bar has no editor — the model's later tool call must
 * submit that text, not a fresh verifier-valid variant; codex r67).
 */
function groundingToken(review, grounding, text = null) {
  const base = `${reviewFingerprint(review)}|${accountFingerprint(grounding?.account || null)}`;
  return text == null ? base : `${base}#${replyTextFingerprint(text)}`;
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
  // Shadow-exit sample = every draft produced for a review the AUTO lane
  // would post (rated at/above the floor, never the 1-3★ human-only parks),
  // counted HISTORICALLY: reviewing a draft and using Post now / Skip / the
  // editor is the shadow workflow, and a row that left 'drafted' that way is
  // still a sample — filtering on current state would shrink the count as
  // admins do exactly what shadow asks of them.
  // Eligibility reads the DRAFT-TIME rating (the grounding snapshot the
  // draft was written from), not the row's current star_rating, which the
  // sync overwrites on a reviewer edit: a later rating change must not
  // rewrite rollout history in either direction.
  const eligible = () => db('google_reviews')
    .whereNotNull('auto_reply_drafted_at')
    // Only drafts the CANONICAL drafter produced count toward the shadow
    // sample (codex r61): a human or Agent Ops text posted via Post now
    // stamps drafted_at but never exercised the automation.
    .whereRaw("COALESCE(auto_reply_version, '') NOT IN ('human', 'agent_ops')")
    .whereRaw("COALESCE((auto_reply_grounding->'review'->>'rating')::int, star_rating) >= ?", [Math.max(cfg.minStars, 4)]);
  const shadowDrafts = await eligible().count('* as n').first();
  const firstShadow = await eligible().min('auto_reply_drafted_at as at').first();
  return {
    shadowDrafts: Number(shadowDrafts?.n || 0),
    firstShadowDraftAt: firstShadow?.at || null,
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
  enqueueMissedReviews,
  rolloutCutoff,
  _resetRolloutCutoffCache: () => { rolloutCutoffCache = undefined; },
  claimDueRows,
  renewClaim,
  processClaimedRow,
  processDueAutoReplies,
  postNow,
  skipAutoReply,
  dismissCancelFields,
  whereNoReconcilePark,
  manualReplyCloseFields,
  whereNoLivePublishClaim,
  requeueFieldsOnIdentity,
  applyRequeueOnIdentity,
  reviewEditFields,
  applyReviewEditFields,
  syncReplyFields,
  applySyncReplyFields,
  reviewFingerprint,
  autoReplyStatus,
  pipelineDraftGuard,
  groundingToken,
  replyTextFingerprint,
  parseGroundingToken,
  agentDraftSavedFields,
  HUMAN_DRAFT_STALE,
  AGENT_OPS_DRAFT,
  notifyReviewEditedAfterPost,
  retryFailedEditedBells,
  __bellForTest: bell,
  validatePromotionAccountFacts,
  classifyReplyMode,
  isDraftReply,
};
