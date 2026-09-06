/**
 * opportunity-queue.js — consumer-side API over opportunity_queue.
 *
 * Step 1's gsc-opportunity-miner produces rows; this module is how
 * the autonomous runner (later step) and brief-builder pull work
 * off the queue safely.
 *
 * State machine (matches the migration):
 *   pending → claimed → done
 *                    \→ skipped
 *                    \→ pending_review
 *   pending → expired (via expireStale)
 *   pending → skipped/attempts_exhausted (via sweepExhaustedAttempts)
 *
 * Claim takes a stale-claim timeout — if a runner crashes mid-work,
 * its claimed row falls back to pending after the timeout so another
 * runner can pick it up. Same pattern as scheduled_sms_claim_limit in
 * the existing scheduler.js. Every claim also increments attempt_count
 * (a lifetime budget — see maxClaimAttempts), so a row that keeps
 * bouncing back to pending eventually stops burning runner dispatches.
 */

const db = require('../../models/db');
const logger = require('../logger');
const effectiveActionSql = require('./opportunity-action-sql');

// Keep read-only catch-up probes and atomic claims on the same eligibility.
// A failed status write may leave a published run's row pending. Fence every
// blog claim, not just legacy approval holds. Only a verified closed PR with
// its branch removed can cease blocking; published URLs never do.
const claimableStatusSql = `((status = 'pending' OR (
           ${effectiveActionSql} = 'new_supporting_blog' AND status = 'pending_review'
           AND (skip_reason IN ('named_competitor_review', 'affiliate_review')
             OR skip_reason ~ '^trust_build_[0-9]+_of_[0-9]+$')
         )) AND (${effectiveActionSql} <> 'new_supporting_blog' OR NOT EXISTS (
           SELECT 1 FROM autonomous_runs r WHERE r.opportunity_id = opportunity_queue.id
             AND (r.published_url IS NOT NULL
               OR (r.astro_pr_url IS NOT NULL AND r.astro_pr_retired_at IS NULL))
         )))`;

const { THRESHOLDS, minScoreToActFor } = require('./scoring-config');

const STALE_CLAIM_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_FETCH_LIMIT = 20;

// Kill-switch contract for the listicle_family lane: rows are claimable
// ONLY while BOTH lane gates are on. Turning either off must stop queued
// rows from being consumed at all — they sit pending and age out via
// expireStale (≤14d) — rather than leaking through as plain supporting
// blogs (brief overlay off) or continuing to publish listicles after the
// kill switch. Fail CLOSED: unreadable gates = lane shut.
function listicleFamilyLaneOpen() {
  try {
    const { isEnabled } = require('../../config/feature-gates');
    return isEnabled('listicleFamilyMining') === true && isEnabled('listicleBriefs') === true;
  } catch (_) {
    return false;
  }
}

// Lifetime claim budget per opportunity. A row that keeps failing returns
// to pending (release / stale-claim recovery) and, as the top-scored row,
// gets re-claimed by the daily batch forever — one wasted LLM dispatch per
// day with no exit. Every claim increments attempt_count; claimNext skips
// rows at/over budget and sweepExhaustedAttempts() converts them to a
// visible skipped/attempts_exhausted instead of leaving invisible zombies.
// An operator requeue resets the counter (fresh explicit signal).
function maxClaimAttempts() {
  const n = Number(process.env.AUTONOMOUS_OPP_MAX_ATTEMPTS);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * The blog floor applies ONLY when the caller runs at the global default —
 * an explicit minScore override (run-autonomous-next --min-score, the admin
 * run-now route) wins for every action type, in BOTH directions: 0 opens
 * the queue fully, 90 restricts a high-confidence run to >=90 including
 * blogs. (An explicit override equal to the default is indistinguishable
 * from the default and gets the blog floor — acceptable: it asks for
 * exactly the standing policy.)
 */
function blogMinScoreFor(minScore) {
  return minScore === THRESHOLDS.minScoreToAct
    ? minScoreToActFor('new_supporting_blog')
    : minScore;
}

// Same override semantics for the rewrite floor (AUTONOMOUS_REWRITE_MIN_SCORE,
// default = the global floor so unset env changes nothing). Without this
// claim-side twin, a lowered persist floor would admit rewrite rows that sit
// forever unclaimable at the global CASE floor — the exact
// persisted-but-unclaimable trap the listicle_family blog-floor ride fixed.
function rewriteMinScoreFor(minScore) {
  return minScore === THRESHOLDS.minScoreToAct
    ? minScoreToActFor('rewrite_title_meta')
    : minScore;
}

class OpportunityQueue {
  /**
   * Read top-N pending opportunities, sorted by score desc. No claim.
   * Used by the preview/dashboard surfaces.
   */
  async peek({ limit = DEFAULT_FETCH_LIMIT, minScore = null, bucket = null, actionType = null } = {}) {
    try {
      let q = db('opportunity_queue')
        .whereRaw(claimableStatusSql)
        // Same availability window as claimNext, so previews show exactly
        // what the runner could claim (operator-seeded rows may carry a
        // future available_at — see migration 20260611000016).
        .whereRaw('(available_at IS NULL OR available_at <= now())')
        // Same lifetime claim budget as claimNext — peek is consumed as
        // "what the runner can claim" (_queueHasClaimable drives the 1pm
        // catch-up; previewTop drives dashboards), so an exhausted pending
        // row awaiting the janitor sweep must not trigger a catch-up batch
        // that claimNext will immediately return empty from.
        .whereRaw("(attempt_count < ?::int OR status = 'pending_review')", [maxClaimAttempts()])
        .orderBy('score', 'desc')
        .limit(limit);
      // Same lane fence as claimNext (peek is consumed as "what the runner
      // can claim" — see listicleFamilyLaneOpen).
      if (!listicleFamilyLaneOpen()) q = q.whereNot('bucket', 'listicle_family');
      if (minScore != null) {
        // Same action-aware floor as claimNext (including the
        // listicle_family blog-floor ride), so previews show exactly what
        // the runner would claim.
        q = q.whereRaw(
          `score >= CASE WHEN ${effectiveActionSql} = 'new_supporting_blog' OR (bucket = 'listicle_family' AND ${effectiveActionSql} = 'refresh_existing_page') OR (bucket IN ('no_content_yet', 'local_gap') AND ${effectiveActionSql} = 'create_or_refresh_city_service_page') THEN ?::numeric WHEN ${effectiveActionSql} = 'rewrite_title_meta' OR (bucket = 'link_boost' AND signal_metadata->>'source_bucket' = 'ctr_rewrite') THEN ?::numeric ELSE ?::numeric END`,
          [blogMinScoreFor(minScore), rewriteMinScoreFor(minScore), minScore],
        );
      }
      if (bucket) q = q.where('bucket', bucket);
      if (actionType) q = q.whereRaw(`${effectiveActionSql} = ?`, [actionType]);
      const rows = await q.select('*');
      return rows.map(parseRow);
    } catch (err) {
      if (err.code === '42P01') {
        // Table missing — opportunity_queue migration not applied yet.
        // Surface a one-time warning, then return empty so the preview
        // CLI / dashboards degrade cleanly instead of crashing.
        logger.warn(`[opportunity-queue] opportunity_queue table missing — apply migration 20260521000007 first`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Atomically claim ONE top opportunity for processing. Returns null
   * if nothing's available. Caller is responsible for calling complete()
   * or skip() (or letting the stale-claim timeout recover it).
   */
  async claimNext({ minScore = THRESHOLDS.minScoreToAct, actionType = null, claimedBy = 'autonomous-runner', excludeIds = [] } = {}) {
    // First, recover stale claims so they're eligible again.
    await this.recoverStaleClaims();

    // Atomic claim via UPDATE ... RETURNING. The earlier iteration
    // appended a `notes` audit string, but opportunity_queue has no
    // `notes` column (the migration in #1021 only defines status /
    // skip_reason / timestamps). Audit lives in the logger instead.
    const whereActionType = actionType ? `AND ${effectiveActionSql} = ?` : '';
    // excludeIds lets the daily batch skip opportunities that already failed
    // this run. A failed runNext() releases its claim back to 'pending', so
    // without this the highest-scored failing row would just be re-claimed
    // every iteration instead of letting the rest of the queue advance.
    const exclude = Array.isArray(excludeIds) ? excludeIds.filter((id) => id != null) : [];
    const whereExclude = exclude.length ? `AND NOT (id = ANY(?))` : '';
    // See listicleFamilyLaneOpen — gate-off family rows are unclaimable.
    const whereFamilyGate = listicleFamilyLaneOpen() ? '' : `AND bucket <> 'listicle_family'`;

    const result = await db.raw(
      `UPDATE opportunity_queue
         SET status = 'claimed',
             claimed_at = ?,
             claim_id = gen_random_uuid(),
             attempt_count = CASE WHEN status = 'pending_review' THEN 1 ELSE attempt_count + 1 END,
             updated_at = now()
       WHERE id = (
         SELECT id FROM opportunity_queue
         WHERE ${claimableStatusSql}
           -- Availability window: operator-seeded rows (intercept briefs) may
           -- carry a future available_at; they stay invisible to the claim
           -- until their window opens. NULL = available immediately (every
           -- miner row).
           AND (available_at IS NULL OR available_at <= now())
           -- New policy gives a former approval hold one fresh attempt budget.
           -- New runs cannot enter those approval states, so this resets once.
           -- Ordinary retries keep the existing lifetime budget.
           AND (attempt_count < ?::int OR status = 'pending_review')
           -- ::numeric casts are load-bearing: inside a CASE, Postgres types
           -- bare parameters as text (no comparison context), and
           -- integer >= text has no operator — this exact line failed in
           -- prod on 2026-06-11. Mocked-db tests cannot catch this class.
           -- listicle_family REFRESHES ride the blog floor (persistAll's
           -- family exception admits them at it — claiming at the global
           -- floor would leave 45-74-point refreshes persisted-but-
           -- unclaimable). Bounded to that one action: a demoted family
           -- row must not ride the blog floor into a claim.
           -- rewrite_title_meta rides its own env-tunable floor for the
           -- same reason (AUTONOMOUS_REWRITE_MIN_SCORE; default = global,
           -- so unset env leaves this branch equal to the ELSE), and a
           -- link_boost companion DERIVED from a ctr_rewrite parent rides
           -- it too — the companion inherits the parent's score, so a
           -- separate floor would strand it persisted-but-unclaimable.
           AND score >= CASE WHEN ${effectiveActionSql} = 'new_supporting_blog' OR (bucket = 'listicle_family' AND ${effectiveActionSql} = 'refresh_existing_page') OR (bucket IN ('no_content_yet', 'local_gap') AND ${effectiveActionSql} = 'create_or_refresh_city_service_page') THEN ?::numeric WHEN ${effectiveActionSql} = 'rewrite_title_meta' OR (bucket = 'link_boost' AND signal_metadata->>'source_bucket' = 'ctr_rewrite') THEN ?::numeric ELSE ?::numeric END
           ${whereActionType}
           ${whereExclude}
           ${whereFamilyGate}
         ORDER BY score DESC, mined_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *, ${effectiveActionSql} AS effective_action_type`,
      [new Date(), maxClaimAttempts(), blogMinScoreFor(minScore), rewriteMinScoreFor(minScore), minScore]
        .concat(actionType ? [actionType] : [])
        .concat(exclude.length ? [exclude] : [])
    );
    const row = result.rows?.[0];
    if (row) logger.info(`[opportunity-queue] claimed ${row.id} (${row.bucket}/${row.action_type}, score ${row.score}) by ${claimedBy}`);
    return row ? parseRow(row) : null;
  }

  /**
   * Mark a claimed opportunity as completed. notes is optional context
   * about what the runner did (e.g. "drafted brief abc-123, sent for
   * human review").
   */
  async complete(opportunityId, { notes, claimToken } = {}) {
    if (!claimToken) {
      throw new Error('opportunity-queue.complete: claimToken required (pass the claimed_at value returned by claimNext)');
    }
    const updates = {
      status: 'done',
      completed_at: new Date(),
      updated_at: new Date(),
    };
    if (notes) logger.info(`[opportunity-queue] done ${opportunityId}: ${notes}`);
    // Two-step guard:
    //   - status='claimed' prevents finalizing a pending / done row.
    //   - claimed_at = claimToken binds the transition to the SAME
    //     claim acquired by claimNext. If a stale claim was recovered
    //     and the row was re-claimed by another worker, claimed_at
    //     has shifted and this update affects 0 rows — the late
    //     first worker can't overwrite the active attempt.
    //
    // claimToken is REQUIRED on purpose: making it optional means
    // callers can forget it and silently regress to a no-guarantee
    // transition, which would silently lose or misattribute work
    // under stale-claim recovery.
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .where('status', 'claimed')
      .where('claimed_at', claimToken)
      .update(updates);
    return updated > 0;
  }

  /**
   * Mark a claimed opportunity as skipped (won't be retried). reason
   * is required — surfaced in dashboards.
   */
  async skip(opportunityId, reason, { claimToken } = {}) {
    if (!reason) throw new Error('opportunity-queue: skip requires a reason');
    if (!claimToken) {
      throw new Error('opportunity-queue.skip: claimToken required (pass the claimed_at value returned by claimNext)');
    }
    // Same claimed-only + claim-token guard as complete().
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .where('status', 'claimed')
      .where('claimed_at', claimToken)
      .update({
        status: 'skipped',
        skip_reason: reason,
        completed_at: new Date(),
        updated_at: new Date(),
      });
    return updated > 0;
  }

  /**
   * Move a claimed opportunity into an explicit review queue. Unlike
   * release(), this does not make the row eligible for claimNext()
   * again, so trust-build/gate-fail cases cannot starve lower-score
   * opportunities by re-running every cron tick.
   */
  async pendingReview(opportunityId, reason, { claimToken } = {}) {
    if (!reason) throw new Error('opportunity-queue: pendingReview requires a reason');
    if (!claimToken) {
      throw new Error('opportunity-queue.pendingReview: claimToken required (pass the claimed_at value returned by claimNext)');
    }
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .where('status', 'claimed')
      .where('claimed_at', claimToken)
      .update({
        status: 'pending_review',
        skip_reason: reason,
        completed_at: new Date(),
        updated_at: new Date(),
      });
    return updated > 0;
  }

  /**
   * Release a claim WITHOUT skipping — used when a runner crashes
   * gracefully or wants to defer. Row returns to pending. claimToken
   * is required so a worker that has lost the active claim (via
   * stale-claim recovery + re-claim by another worker) can't bounce
   * the row back to pending and disrupt the active attempt.
   */
  async release(opportunityId, { claimToken } = {}) {
    if (!claimToken) {
      throw new Error('opportunity-queue.release: claimToken required (pass the claimed_at value returned by claimNext)');
    }
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .where('status', 'claimed')
      .where('claimed_at', claimToken)
      .update({
        status: 'pending',
        claimed_at: null,
        updated_at: new Date(),
      });
    return updated > 0;
  }

  /**
   * Defer a claimed opportunity: back to 'pending' with a future
   * available_at, invisible to claimNext() until the window opens. Used for
   * publish-cap deferrals (nothing is wrong with the item — the cap is
   * full) and single-retry gate redrafts, so neither lands in the human
   * review queue. skip_reason stays NULL — 'pending' rows must look pending;
   * the deferral reason lives on the autonomous_runs row. expires_at is
   * pushed past the defer window (GREATEST keeps a later miner-set expiry)
   * so expireStale() can't expire the row before it ever becomes claimable.
   */
  async defer(opportunityId, availableAt, { claimToken } = {}) {
    if (!(availableAt instanceof Date) || Number.isNaN(availableAt.getTime())) {
      throw new Error('opportunity-queue: defer requires a valid availableAt Date');
    }
    if (!claimToken) {
      throw new Error('opportunity-queue.defer: claimToken required (pass the claimed_at value returned by claimNext)');
    }
    const expiresFloor = new Date(availableAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .where('status', 'claimed')
      .where('claimed_at', claimToken)
      .update({
        status: 'pending',
        claimed_at: null,
        skip_reason: null,
        available_at: availableAt,
        expires_at: db.raw('GREATEST(COALESCE(expires_at, ?::timestamptz), ?::timestamptz)', [expiresFloor, expiresFloor]),
        // A deferral is not a failure — refund the attempt claimNext just
        // consumed, or repeated cap-window deferrals would exhaust the
        // lifetime attempt budget and land the row in the
        // attempts_exhausted review path this method exists to avoid.
        attempt_count: db.raw('GREATEST(attempt_count - 1, 0)'),
        updated_at: new Date(),
      });
    return updated > 0;
  }

  /**
   * Recover claims that have been held longer than STALE_CLAIM_MS by
   * returning them to pending. Called inline by claimNext(); also safe
   * to call from a janitor cron. Operates on rows whose claim is
   * stale by definition, so no claimToken applies.
   */
  async recoverStaleClaims() {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
    const recovered = await db('opportunity_queue')
      .where('status', 'claimed')
      .where('claimed_at', '<', cutoff)
      // A named-competitor APPROVAL claim is not crash-recoverable by
      // rerun: the publish may already have opened a PR / gone live, so
      // bouncing the row to 'pending' invites a duplicate draft of content
      // that already exists. The runner's own janitor
      // (recoverStuckNamedCompetitorPublishes) parks these for human
      // reconciliation instead. IS DISTINCT FROM, not <>: runner claims
      // carry a NULL skip_reason and NULL <> 'x' is NULL, which would
      // silently exclude every normal claim from recovery.
      .whereRaw(`skip_reason IS DISTINCT FROM 'named_competitor_publishing'`)
      .update({
        status: 'pending',
        claimed_at: null,
        updated_at: new Date(),
      });
    if (recovered > 0) logger.info(`[opportunity-queue] recovered ${recovered} stale claim(s) (cutoff ${cutoff.toISOString()})`);
    return recovered;
  }

  /**
   * Mark pending opportunities past their expires_at as 'expired'.
   * Janitor cron task (wired into the daily mine tick, which runs it
   * BEFORE mining so a still-live signal immediately re-pends with a
   * fresh expires_at — 'expired' only sticks for disappeared signals).
   */
  async expireStale() {
    const result = await db('opportunity_queue')
      .where('status', 'pending')
      .where('expires_at', '<', new Date())
      .update({ status: 'expired', updated_at: new Date() });
    if (result > 0) logger.info(`[opportunity-queue] expired ${result} stale pending opportunit${result === 1 ? 'y' : 'ies'}`);
    return result;
  }

  // Repair only bookkeeping failures with durable final-run evidence. Never
  // reclaim/redraft an external publish or overwrite a newer lifecycle.
  async reconcilePublishedClaims() {
    await db.raw(`UPDATE opportunity_queue q
      SET status = CASE WHEN r.outcome = 'completed_published' THEN 'done' ELSE 'pending_review' END,
          skip_reason = CASE WHEN r.outcome = 'completed_published' THEN NULL ELSE 'astro_pr_pending_merge' END,
          completed_at = CASE WHEN r.outcome = 'completed_published' THEN now() ELSE NULL END,
          updated_at = now()
      FROM autonomous_runs r
      WHERE (q.status IN ('claimed', 'pending', 'expired') AND q.claim_id = r.queue_claim_id
          OR q.status = 'pending_review' AND q.skip_reason IN ('astro_pr_pending_merge', 'astro_pr_queue_transition_failed', 'published_queue_complete_failed') AND (
            q.claim_id = r.queue_claim_id OR q.claim_id IS NULL AND r.queue_claim_id IS NULL))
        AND r.id = (SELECT latest.id FROM autonomous_runs latest
          WHERE latest.opportunity_id = q.id ORDER BY latest.claimed_at DESC, latest.id DESC LIMIT 1)
        AND r.action_type = 'new_supporting_blog'
        AND (q.status IS DISTINCT FROM CASE WHEN r.outcome = 'completed_published' THEN 'done' ELSE 'pending_review' END
          OR q.skip_reason IS DISTINCT FROM CASE WHEN r.outcome = 'completed_published' THEN NULL ELSE 'astro_pr_pending_merge' END)
        AND (((q.claim_id = r.queue_claim_id OR q.skip_reason = 'astro_pr_queue_transition_failed')
          AND r.outcome = 'completed_pending_review' AND r.skip_reason = 'astro_pr_pending_merge'
          AND r.astro_pr_url IS NOT NULL AND r.astro_pr_retired_at IS NULL)
        OR ((q.claim_id = r.queue_claim_id OR q.skip_reason = 'published_queue_complete_failed')
          AND r.outcome = 'completed_published' AND r.published_url IS NOT NULL))`);
  }

  /**
   * Finish exhausted retries and legacy unpublished blog holds automatically. Other content lanes retain
   * their existing review/requeue workflow. Paired with expireStale().
   */
  async sweepExhaustedAttempts() {
    await this.reconcilePublishedClaims();
    const result = await db('opportunity_queue')
      .whereRaw(`(status = 'pending' AND attempt_count >= ?) OR (
        ${effectiveActionSql} = 'new_supporting_blog' AND status = 'pending_review'
        -- A failed audit insert can leave no run evidence despite an external publish.
        -- Reconciliation holds must survive until that external state is resolved.
        AND COALESCE(skip_reason, '') NOT IN ('named_competitor_review', 'affiliate_review',
          'astro_pr_audit_failed', 'published_audit_failed',
          'astro_pr_queue_transition_failed', 'published_queue_complete_failed')
        AND COALESCE(skip_reason, '') !~ '^trust_build_[0-9]+_of_[0-9]+$'
        AND NOT EXISTS (SELECT 1 FROM autonomous_runs r
          WHERE r.opportunity_id = opportunity_queue.id
            AND (r.astro_pr_url IS NOT NULL OR r.published_url IS NOT NULL))
      )`, [maxClaimAttempts()])
      .update({
        status: db.raw(`CASE WHEN ${effectiveActionSql} = 'new_supporting_blog' THEN 'skipped' ELSE 'pending_review' END`),
        skip_reason: db.raw("CASE WHEN status = 'pending_review' THEN COALESCE(skip_reason, 'legacy_review_retired') ELSE 'attempts_exhausted' END"),
        completed_at: new Date(),
        updated_at: new Date(),
      });
    if (result > 0) logger.warn(`[opportunity-queue] parked ${result} opportunit${result === 1 ? 'y' : 'ies'} with attempts_exhausted (blogs skipped; other lanes available for review)`);
    return result;
  }

  async getById(opportunityId) {
    const row = await db('opportunity_queue').where('id', opportunityId).first();
    return row ? parseRow(row) : null;
  }

  /**
   * Counts by status — used by dashboards / digest.
   */
  async counts() {
    const rows = await db('opportunity_queue')
      .select('status')
      .count('* as c')
      .groupBy('status');
    return Object.fromEntries(rows.map((r) => [r.status, parseInt(r.c, 10)]));
  }
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    score_breakdown: typeof row.score_breakdown === 'string'
      ? JSON.parse(row.score_breakdown)
      : (row.score_breakdown || {}),
    signal_metadata: typeof row.signal_metadata === 'string'
      ? JSON.parse(row.signal_metadata)
      : (row.signal_metadata || {}),
  };
}

module.exports = new OpportunityQueue();
module.exports.OpportunityQueue = OpportunityQueue;
module.exports._internals = { parseRow, STALE_CLAIM_MS, maxClaimAttempts };
