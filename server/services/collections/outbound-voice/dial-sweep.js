/**
 * Collections AUTO-DIAL sweep (PR C) — the ruled fully-automatic trigger.
 *
 * Adam ruled 2026-08-14 that the lane is NOT owner-gated per call: after the
 * supervised 5-call shakedown it runs fully automatic, with env kill
 * switches still shipping dark. This sweep is that automation, behind
 * GATE_VOICE_LATE_PAYMENT_AUTODIAL (which itself requires the master gate
 * AND the PR A policy gate — see gates.js).
 *
 * What a run does, bounded and fail-closed:
 *   1. Gate check FIRST — gate off means ZERO reads (provable no-op,
 *      pinned; byte-identical dark).
 *   2. Candidates: collection_cases in 'shadow' (never dialed) or
 *      'proposed' (returned to the queue after a prior call), whose
 *      next_eligible_at is null or past. Oldest first, small batch.
 *   3. Per candidate: a GUARDED promote (state + case_version fence) to
 *      'approved' with approved_by 'system:autodial' and a 24h expiry —
 *      the loser of a concurrent promote stands down; then
 *      originateCollectionCall(), which re-runs the FULL contact policy at
 *      dial time and fails closed on every leg (window, caps, flags,
 *      frequency, snapshot drift, phone binding, relay availability).
 *   4. At most COLLECTIONS_AUTODIAL_MAX_PER_RUN dials per run (default 2 —
 *      pilot pace, not a volume dialer). Refusals don't consume the cap;
 *      dial attempts (success or dial_failed) do.
 *
 * This module deliberately makes NO eligibility judgments of its own: the
 * policy engine at origination is the single authorization boundary. A case
 * promoted here that the policy refuses is cancelled/re-queued by
 * origination exactly as a stale human approval would be.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const { isAutoDialEnabled } = require('./gates');

const DEFAULT_MAX_PER_RUN = 2;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function maxDialsPerRun() {
  const raw = Number(process.env.COLLECTIONS_AUTODIAL_MAX_PER_RUN);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PER_RUN;
  return Math.min(Math.floor(raw), 10); // hard ceiling — never a volume dialer
}

/**
 * Promote one case to 'approved' for the automatic path. Guarded on the
 * state AND case_version it was read at — a concurrent promote/approval
 * loses cleanly. Returns true when THIS caller holds the approval.
 */
async function promoteForAutoDial(caseRow, now) {
  const updated = await db('collection_cases')
    .where({ id: caseRow.id, current_state: caseRow.current_state, case_version: caseRow.case_version })
    .update({
      current_state: 'approved',
      approved_by: 'system:autodial',
      approved_at: now,
      approval_expires_at: new Date(now.getTime() + APPROVAL_TTL_MS),
      hold_reason: null,
      updated_at: db.fn.now(),
    });
  return updated > 0;
}

async function runCollectionsDialSweep({ now = new Date() } = {}) {
  // Gate FIRST — zero reads while dark (pinned).
  if (!isAutoDialEnabled()) return { skipped: true, reason: 'autodial_gate_off' };

  const cap = maxDialsPerRun();
  const candidates = await db('collection_cases')
    .whereIn('current_state', ['shadow', 'proposed'])
    .where(function nextEligible() {
      this.whereNull('next_eligible_at').orWhere('next_eligible_at', '<=', now);
    })
    .orderBy('created_at', 'asc')
    // Read a few more than the cap: policy refusals shouldn't starve a run.
    .limit(cap * 5)
    .select('id', 'current_state', 'case_version');

  let dialed = 0;
  let refused = 0;
  let promoted = 0;
  const { originateCollectionCall } = require('./origination');
  for (const caseRow of candidates) {
    if (dialed >= cap) break;
    let holds = false;
    try {
      holds = await promoteForAutoDial(caseRow, now);
    } catch (err) {
      logger.warn(`[collections-autodial] promote failed for case ${caseRow.id}: ${err.message}`);
      continue;
    }
    if (!holds) continue; // someone else moved it — stand down
    promoted++;
    try {
      const result = await originateCollectionCall(caseRow.id, { now });
      if (result.dialed || result.reason === 'dial_failed') {
        // A real dial attempt (even a failed one) consumes pilot pace.
        dialed++;
      } else {
        // Refusal — the cap is untouched. Origination moves the case
        // itself for terminal refusals (cancelled/expired/proposed), but
        // TRANSIENT pre-dial refusals (relay_unavailable, a feature gate,
        // suppressed_until_next_eligible, a lost claim) return with the
        // row still 'approved' — which this sweep never selects, so the
        // candidate would be stranded outside the automatic queue forever
        // (codex gh-r1). The guarded revert below fires ONLY when the row
        // still carries OUR promotion (state, version, and the autodial
        // actor); anything origination moved is untouched by the fence.
        refused++;
        await db('collection_cases')
          .where({
            id: caseRow.id,
            current_state: 'approved',
            case_version: caseRow.case_version,
            approved_by: 'system:autodial',
          })
          .update({
            current_state: 'proposed',
            approved_by: null,
            approved_at: null,
            approval_expires_at: null,
            updated_at: db.fn.now(),
          })
          .catch((err) => logger.warn(`[collections-autodial] revert failed for case ${caseRow.id}: ${err.message} — approval expiry (24h) is the backstop`));
      }
    } catch (err) {
      // originateCollectionCall throws only for genuinely unexpected
      // errors; treat as an attempt (conservative pace) and log loudly.
      logger.error(`[collections-autodial] originate threw for case ${caseRow.id}: ${err.message}`);
      dialed++;
    }
  }
  if (candidates.length) {
    logger.info(`[collections-autodial] sweep: ${candidates.length} candidates, ${promoted} promoted, ${dialed} dial attempts, ${refused} policy refusals (cap ${cap})`);
  }
  return { skipped: false, candidates: candidates.length, promoted, dialed, refused, cap };
}

module.exports = { runCollectionsDialSweep, promoteForAutoDial, DEFAULT_MAX_PER_RUN };
