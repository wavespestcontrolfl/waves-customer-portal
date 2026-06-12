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
 *
 * Claim takes a stale-claim timeout — if a runner crashes mid-work,
 * its claimed row falls back to pending after the timeout so another
 * runner can pick it up. Same pattern as scheduled_sms_claim_limit in
 * the existing scheduler.js.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { THRESHOLDS, minScoreToActFor } = require('./scoring-config');

const STALE_CLAIM_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_FETCH_LIMIT = 20;

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

class OpportunityQueue {
  /**
   * Read top-N pending opportunities, sorted by score desc. No claim.
   * Used by the preview/dashboard surfaces.
   */
  async peek({ limit = DEFAULT_FETCH_LIMIT, minScore = null, bucket = null, actionType = null } = {}) {
    try {
      let q = db('opportunity_queue')
        .where('status', 'pending')
        // Same availability window as claimNext, so previews show exactly
        // what the runner could claim (operator-seeded rows may carry a
        // future available_at — see migration 20260611000016).
        .whereRaw('(available_at IS NULL OR available_at <= now())')
        .orderBy('score', 'desc')
        .limit(limit);
      if (minScore != null) {
        // Same action-aware floor as claimNext, so previews show exactly
        // what the runner would claim.
        q = q.whereRaw(
          `score >= CASE WHEN action_type = 'new_supporting_blog' THEN ?::numeric ELSE ?::numeric END`,
          [blogMinScoreFor(minScore), minScore],
        );
      }
      if (bucket) q = q.where('bucket', bucket);
      if (actionType) q = q.where('action_type', actionType);
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
    const whereActionType = actionType ? `AND action_type = ?` : '';
    // excludeIds lets the daily batch skip opportunities that already failed
    // this run. A failed runNext() releases its claim back to 'pending', so
    // without this the highest-scored failing row would just be re-claimed
    // every iteration instead of letting the rest of the queue advance.
    const exclude = Array.isArray(excludeIds) ? excludeIds.filter((id) => id != null) : [];
    const whereExclude = exclude.length ? `AND NOT (id = ANY(?))` : '';

    const result = await db.raw(
      `UPDATE opportunity_queue
         SET status = 'claimed',
             claimed_at = ?,
             updated_at = now()
       WHERE id = (
         SELECT id FROM opportunity_queue
         WHERE status = 'pending'
           -- Availability window: operator-seeded rows (intercept briefs) may
           -- carry a future available_at; they stay invisible to the claim
           -- until their window opens. NULL = available immediately (every
           -- miner row).
           AND (available_at IS NULL OR available_at <= now())
           -- ::numeric casts are load-bearing: inside a CASE, Postgres types
           -- bare parameters as text (no comparison context), and
           -- integer >= text has no operator — this exact line failed in
           -- prod on 2026-06-11. Mocked-db tests cannot catch this class.
           AND score >= CASE WHEN action_type = 'new_supporting_blog' THEN ?::numeric ELSE ?::numeric END
           ${whereActionType}
           ${whereExclude}
         ORDER BY score DESC, mined_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [new Date(), blogMinScoreFor(minScore), minScore]
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
   * Janitor cron task.
   */
  async expireStale() {
    const result = await db('opportunity_queue')
      .where('status', 'pending')
      .where('expires_at', '<', new Date())
      .update({ status: 'expired', updated_at: new Date() });
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
module.exports._internals = { parseRow, STALE_CLAIM_MS };
