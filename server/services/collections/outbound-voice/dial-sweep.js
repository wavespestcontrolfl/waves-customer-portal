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
const { withCaseLock } = require('../case-lock');

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
  // Under the customer case lock (codex gh-r5): promotion is a
  // customer-level decision — with another case already live/held for the
  // customer, promoting this one would run two pipelines (or bypass a
  // dispute hold). The shadow sweep's rotation takes the same lock.
  return withCaseLock(caseRow.customer_id, async (trx) => {
    // Owner re-read IN the lock (codex gh-r8): a customer merge committed
    // between the candidate read and this lock can have repointed the row —
    // the snapshot's lock and sibling check would then govern the WRONG
    // customer. A moved row stands down; it re-enters next run under its
    // real owner. The update also fences customer_id as the belt.
    const current = await trx('collection_cases')
      .where({ id: caseRow.id })
      .first('customer_id', 'hold_reason');
    if (!current || String(current.customer_id) !== String(caseRow.customer_id)) return false;
    // The candidate ITSELF can be the freshly parked row (codex gh-r11): an
    // admin promote + definitive provider rejection between the snapshot
    // and this lock returns the row to 'proposed' at the SAME version with
    // hold_reason 'dial_failed' — the state+version fence below would pass
    // and clear the park. Supervised parks release only through the admin
    // endpoint; a parked candidate stands down.
    if (['dial_failed', 'reclaimed_orphaned_approval'].includes(current.hold_reason)) return false;
    const liveElsewhere = await trx('collection_cases')
      .where({ customer_id: caseRow.customer_id })
      .whereNot('id', caseRow.id)
      // Live states AND supervised-park markers (codex gh-r10): a sibling
      // parked dial_failed AFTER the candidate snapshot must block this
      // promotion — the in-lock predicate is the authoritative fence.
      .where(function blocked() {
        this.whereIn('current_state', ['approved', 'dialing', 'held'])
          .orWhereIn('hold_reason', ['dial_failed', 'reclaimed_orphaned_approval']);
      })
      .first('id');
    if (liveElsewhere) return false;
    const updated = await trx('collection_cases')
      .where({ id: caseRow.id, customer_id: caseRow.customer_id, current_state: caseRow.current_state, case_version: caseRow.case_version })
      .update({
        current_state: 'approved',
        approved_by: 'system:autodial',
        approved_at: now,
        approval_expires_at: new Date(now.getTime() + APPROVAL_TTL_MS),
        hold_reason: null,
        updated_at: trx.fn.now(),
      });
    return updated > 0;
  });
}

/**
 * Guarded revert of OUR promotion (codex gh-r2): fenced on state, version,
 * and the autodial actor — rows origination moved, and admin approvals,
 * are never touched. `toState` is 'proposed' for transient refusals (retry
 * next run) and 'lapsed' for already_dialed (this version consumed its one
 * call — the shadow sweep rotates it at the next tier; leaving it
 * 'proposed' made the sweep re-promote the same row daily until it starved
 * fresh candidates out of the query window).
 */
async function revertAutoPromotion(caseRow, toState) {
  await db('collection_cases')
    .where({
      id: caseRow.id,
      current_state: 'approved',
      case_version: caseRow.case_version,
      approved_by: 'system:autodial',
    })
    .update({
      current_state: toState,
      approved_by: null,
      approved_at: null,
      approval_expires_at: null,
      // Restore the pre-promotion hold_reason (codex gh-r8): promotion
      // nulls it, and losing a 'dial_failed' park through promote+revert
      // would silently re-admit the case to the automatic queue.
      hold_reason: caseRow.hold_reason ?? null,
      updated_at: db.fn.now(),
    })
    .catch((err) => logger.warn(`[collections-autodial] revert failed for case ${caseRow.id}: ${err.message} — approval expiry (24h) is the backstop`));
}

/**
 * A promoted case is no longer a proposal (codex gh-r2): its shadow card
 * says "no call will be placed", which stops being true the moment the
 * promotion holds. Same read_at mechanism the shadow sweep uses for
 * lapsed/superseded cards; best-effort.
 */
async function retireProposalCard(idempotencyKey) {
  if (!idempotencyKey) return;
  await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereNull('read_at')
    .whereRaw("metadata->>'dedupeKey' = ?", [idempotencyKey])
    .update({ read_at: db.fn.now() })
    .catch((err) => logger.warn(`[collections-autodial] proposal-card retirement failed: ${err.message}`));
}

/**
 * Reclaim orphaned approvals (codex gh-r6/gh-r7): a crash after promotion
 * or a failed revert leaves a row in 'approved' that NOTHING revisits —
 * origination's expiry check only runs when something dials the case, and
 * neither sweep selects 'approved'. Runs from the full sweep AND from the
 * scheduler's master-gated maintenance path (the supervised shakedown
 * keeps the autodial gate off — exactly the mode that creates admin
 * orphans). The expiry predicate is the fence: origination's claim
 * requires approval_expires_at > now, this requires < now — disjoint, no
 * race with a live dial.
 */
async function reclaimExpiredApprovals({ now = new Date() } = {}) {
  try {
    const reclaimed = await db('collection_cases')
      .where({ current_state: 'approved' })
      .where('approval_expires_at', '<', now)
      .update({
        current_state: 'proposed',
        approved_by: null,
        approved_at: null,
        approval_expires_at: null,
        // Supervised-only on return (codex gh-r9): promotion nulled the
        // original hold_reason, so a dial_failed park orphaned mid-flight
        // would otherwise re-enter the automatic queue. An orphan means
        // something went wrong — a human look is the right bar, and the
        // candidate query excludes this marker.
        hold_reason: 'reclaimed_orphaned_approval',
        updated_at: db.fn.now(),
      });
    if (reclaimed) logger.info(`[collections-autodial] reclaimed ${reclaimed} expired orphaned approval(s)`);
    return reclaimed;
  } catch (err) {
    logger.warn(`[collections-autodial] orphan reclamation failed: ${err.message}`);
    return 0;
  }
}

async function runCollectionsDialSweep({ now = new Date() } = {}) {
  // Gate FIRST — zero reads while dark (pinned).
  if (!isAutoDialEnabled()) return { skipped: true, reason: 'autodial_gate_off' };

  const cap = maxDialsPerRun();
  const reclaimed = await reclaimExpiredApprovals({ now });

  const candidates = await db('collection_cases')
    .whereIn('current_state', ['shadow', 'proposed'])
    // Supervised-park markers require HUMAN release (codex gh-r4/gh-r9):
    // dial_failed (origination: a failed dial is never silently retried)
    // and reclaimed_orphaned_approval (something went wrong mid-flight).
    // The admin endpoint remains their release path.
    .whereRaw("(hold_reason IS NULL OR hold_reason NOT IN ('dial_failed', 'reclaimed_orphaned_approval'))")
    // Customers with a live/held sibling — or a supervised-parked sibling
    // (codex gh-r9: a merge can leave a shadow row beside a dial_failed
    // park; dialing the sibling would bypass the required review) — are
    // excluded at SELECT time (codex gh-r7), so such rows never occupy the
    // cap*5 window; the in-lock checks remain the authoritative fences.
    .whereNotExists(function blockedSibling() {
      this.select(db.raw('1'))
        .from('collection_cases as sib')
        .whereRaw('sib.customer_id = collection_cases.customer_id')
        .whereRaw('sib.id <> collection_cases.id')
        .where(function anyBlock() {
          this.whereIn('sib.current_state', ['approved', 'dialing', 'held'])
            .orWhereIn('sib.hold_reason', ['dial_failed', 'reclaimed_orphaned_approval']);
        });
    })
    .where(function nextEligible() {
      this.whereNull('next_eligible_at').orWhere('next_eligible_at', '<=', now);
    })
    .orderBy('created_at', 'asc')
    // Read a few more than the cap: policy refusals shouldn't starve a run.
    .limit(cap * 5)
    .select('id', 'customer_id', 'current_state', 'case_version', 'idempotency_key', 'hold_reason');

  let dialed = 0;
  let refused = 0;
  let promoted = 0;
  const { originateCollectionCall } = require('./origination');
  for (const caseRow of candidates) {
    if (dialed >= cap) break;
    // The advertised sweep-only kill switch must bite MID-RUN (codex
    // gh-r7): origination checks the master gate but not this sub-gate,
    // so an operator flipping GATE_VOICE_LATE_PAYMENT_AUTODIAL during an
    // incident stops the very next promotion, not just the next tick.
    if (!isAutoDialEnabled()) break;
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
        // Retire the proposal card only once a call actually went out
        // (codex gh-r8): dial_failed parks the case for SUPERVISED
        // reapproval, and the card is the operator's retry surface.
        if (result.dialed) await retireProposalCard(caseRow.idempotency_key);
      } else {
        // Refusal — the cap is untouched. Origination moves the case
        // itself for terminal refusals (cancelled/expired/proposed), but
        // pre-dial refusals return with the row still 'approved' — which
        // this sweep never selects, so the candidate would be stranded
        // outside the automatic queue forever (codex gh-r1). already_dialed
        // means THIS version's one call already happened (post-call rows
        // come back 'proposed' at the same version): it goes to 'lapsed'
        // so the sweep stops re-selecting it and the shadow sweep rotates
        // it at the next tier; every other refusal is transient and goes
        // back to 'proposed' for the next run (codex gh-r2).
        refused++;
        await revertAutoPromotion(caseRow, result.reason === 'already_dialed' ? 'lapsed' : 'proposed');
      }
    } catch (err) {
      // originateCollectionCall throws only for genuinely unexpected
      // errors; treat as an attempt (conservative pace) and log loudly.
      // The guarded revert applies here too (codex gh-r2): a throw before
      // the provider dial can leave the row on OUR approval — without the
      // revert a transient infrastructure failure would strand it outside
      // the automatic queue. Rows the claim/release ladder already moved
      // are untouched by the fence.
      logger.error(`[collections-autodial] originate threw for case ${caseRow.id}: ${err.message}`);
      dialed++;
      await revertAutoPromotion(caseRow, 'proposed');
    }
  }
  if (candidates.length) {
    logger.info(`[collections-autodial] sweep: ${candidates.length} candidates, ${promoted} promoted, ${dialed} dial attempts, ${refused} policy refusals (cap ${cap})`);
  }
  return { skipped: false, candidates: candidates.length, promoted, dialed, refused, reclaimed, cap };
}

module.exports = { runCollectionsDialSweep, reclaimExpiredApprovals, promoteForAutoDial, retireProposalCard, DEFAULT_MAX_PER_RUN };
