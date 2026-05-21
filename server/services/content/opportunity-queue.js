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
 *   pending → expired (via expireStale)
 *
 * Claim takes a stale-claim timeout — if a runner crashes mid-work,
 * its claimed row falls back to pending after the timeout so another
 * runner can pick it up. Same pattern as scheduled_sms_claim_limit in
 * the existing scheduler.js.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { THRESHOLDS } = require('./scoring-config');

const STALE_CLAIM_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_FETCH_LIMIT = 20;

class OpportunityQueue {
  /**
   * Read top-N pending opportunities, sorted by score desc. No claim.
   * Used by the preview/dashboard surfaces.
   */
  async peek({ limit = DEFAULT_FETCH_LIMIT, minScore = null, bucket = null, actionType = null } = {}) {
    try {
      let q = db('opportunity_queue')
        .where('status', 'pending')
        .orderBy('score', 'desc')
        .limit(limit);
      if (minScore != null) q = q.where('score', '>=', minScore);
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
  async claimNext({ minScore = THRESHOLDS.minScoreToAct, actionType = null, claimedBy = 'autonomous-runner' } = {}) {
    // First, recover stale claims so they're eligible again.
    await this.recoverStaleClaims();

    // Atomic claim via UPDATE ... RETURNING.
    const whereActionType = actionType ? `AND action_type = ?` : '';
    const params = [claimedBy, new Date(), minScore];
    if (actionType) params.push(actionType);

    const result = await db.raw(
      `UPDATE opportunity_queue
         SET status = 'claimed',
             claimed_at = ?,
             notes = COALESCE(notes, '') || '\n[claimed by ' || ? || ' at ' || now() || ']',
             updated_at = now()
       WHERE id = (
         SELECT id FROM opportunity_queue
         WHERE status = 'pending'
           AND score >= ?
           ${whereActionType}
         ORDER BY score DESC, mined_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [new Date(), claimedBy, minScore].concat(actionType ? [actionType] : [])
    );
    const row = result.rows?.[0];
    return row ? parseRow(row) : null;
  }

  /**
   * Mark a claimed opportunity as completed. notes is optional context
   * about what the runner did (e.g. "drafted brief abc-123, sent for
   * human review").
   */
  async complete(opportunityId, { notes } = {}) {
    const updates = {
      status: 'done',
      completed_at: new Date(),
      updated_at: new Date(),
    };
    if (notes) updates.notes = db.raw('COALESCE(notes, \'\') || ?', [`\n[done] ${notes}`]);
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .update(updates);
    return updated > 0;
  }

  /**
   * Mark a claimed opportunity as skipped (won't be retried). reason
   * is required — surfaced in dashboards.
   */
  async skip(opportunityId, reason) {
    if (!reason) throw new Error('opportunity-queue: skip requires a reason');
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .update({
        status: 'skipped',
        skip_reason: reason,
        completed_at: new Date(),
        updated_at: new Date(),
      });
    return updated > 0;
  }

  /**
   * Release a claim WITHOUT skipping — used when a runner crashes
   * gracefully or wants to defer. Row returns to pending.
   */
  async release(opportunityId) {
    const updated = await db('opportunity_queue')
      .where('id', opportunityId)
      .where('status', 'claimed')
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
   * to call from a janitor cron.
   */
  async recoverStaleClaims() {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
    const recovered = await db('opportunity_queue')
      .where('status', 'claimed')
      .where('claimed_at', '<', cutoff)
      .update({
        status: 'pending',
        claimed_at: null,
        notes: db.raw('COALESCE(notes, \'\') || ?', [`\n[stale claim recovered at ${new Date().toISOString()}]`]),
        updated_at: new Date(),
      });
    if (recovered > 0) logger.info(`[opportunity-queue] recovered ${recovered} stale claim(s)`);
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
