/**
 * Post-commit follow-through for CANCELLED visits — the money and tracker
 * obligations a cancellation carries beyond flipping `status`.
 *
 * Extracted verbatim from the series-scope branch of
 * PUT /api/admin/dispatch/:serviceId/status (admin-dispatch.js) so a second
 * surface that cancels visits — the Edit-appointment plan-length trim in
 * admin-schedule.js — runs the SAME obligations instead of reimplementing a
 * subset of them. Codex #3337 found three of those obligations missing from
 * the trim across three review rounds (the /secure card-request rail, the
 * invoice void, tracker state); the answer to the third one was to stop
 * growing a parallel path and share this one (AGENTS.md: find the existing
 * mechanism and extend its coverage).
 *
 * Ordering matches the original and is load-bearing:
 *   1. Card fee rails — the estimate card-hold, falling back to the /secure
 *      appointment-card agreement when the visit has no hold row. An
 *      unresolved outcome ALERTS the office; it is never a silent cancel.
 *   2. Invoice void — restores applied account credit and the estimate
 *      deposit ledger, and stops dunning chasing a cancelled visit. Inspection
 *      -credit reversal runs INSIDE it, after the voids.
 *   3. Tracker cancel — moves track_state off scheduled/en_route and stamps
 *      cancelled_at + the 24h receipt window, recording failures for the ops
 *      alert rail.
 *
 * Every step is best-effort and PER TARGET: the cancels are already committed,
 * so one target's thrown fee step must alert on that visit and let the loop
 * continue — aborting would leave later already-cancelled targets with neither
 * a terminal fee stamp nor an alert, and a retry would never revisit them.
 *
 * MUST be called AFTER the cancelling transaction commits: every step reads
 * the visit's committed state on its own connection.
 */
const logger = require('./logger');
const trackTransitions = require('./track-transitions');
const {
  recordTrackTransitionFailure,
  recordTrackTransitionResultFailure,
} = require('./track-transition-alerts');

/**
 * @param {object}   opts
 * @param {string[]} opts.targetIds  Committed-cancelled scheduled_service ids.
 * @param {string}   [opts.actorId]  Admin/tech id for tracker + alert records.
 * @param {boolean}  [opts.waiveFee] Release the late-cancel fee instead of
 *   charging it. ADMIN-GATED at the call site — this module does not check
 *   the role, it honors what it is told (same contract as the dispatch path).
 * @param {string}   [opts.reason]   Cancellation reason for the tracker stamp.
 * @param {string}   [opts.source]   Log prefix, e.g. 'admin-dispatch'.
 * @param {Date}     [opts.now]      The CANCELLATION instant the fee rails
 *   judge their windows against. Defaults to the wall clock — correct for
 *   the immediate post-commit call — but a REPLAY (retrying a follow-through
 *   that failed after the cancel committed) MUST pass the committed
 *   transition time (job_status_history.transitioned_at): a retry clock
 *   would re-decide the fee window at a different instant than the cancel
 *   actually happened (PR pre-push r7 P0).
 */
async function runVisitCancellationFollowThrough({
  targetIds,
  actorId = null,
  waiveFee = false,
  reason = null,
  source = 'cancellation',
  now = new Date(),
} = {}) {
  const ids = (Array.isArray(targetIds) ? targetIds : []).filter(Boolean);
  if (ids.length === 0) return { settled: 0 };

  // ——— 1. Card fee rails ———
  {
    const CardHolds = require('./estimate-card-holds');
    const ApptCardRequests = require('./appointment-card-request');
    for (const id of ids) {
      try {
        const holdResult = await CardHolds.handleCardHoldCancellation({
          scheduledServiceId: id,
          waiveFee,
          now,
        });
        // Non-clean hold outcomes must ALERT, not just return (pre-push
        // r16 P1): the rail reports charge_failed / charge_review /
        // lane_check_failed / competing_consent_review as values, and a
        // caller that only checks thrown errors would report a successful
        // cancellation while the fee sits unresolved. Clean = charged,
        // released, parked, or nothing to do.
        const holdClean = holdResult?.charged === true
          || holdResult?.released === true
          || holdResult?.parked === true
          || ['no_hold', 'park_gate_off'].includes(holdResult?.reason);
        if (!holdClean) {
          // Normalized shape (uncapped r17 P1): the alert helper keys on
          // released === false, which the hold rail's failure returns omit.
          await ApptCardRequests.alertUnresolvedCancellationFee({
            scheduledServiceId: id,
            outcome: { released: false, reason: holdResult?.reason || 'hold_unresolved' },
          });
        }
        // Visits with no hold row may still carry the /secure lane's agreed
        // fee (mutually exclusive rails — the rail itself re-checks).
        if (holdResult?.reason === 'no_hold') {
          const apptFeeOutcome = await ApptCardRequests.handleAppointmentCardCancellation({
            scheduledServiceId: id,
            waiveFee,
            now,
          });
          await ApptCardRequests.alertUnresolvedCancellationFee({ scheduledServiceId: id, outcome: apptFeeOutcome });
        }
      } catch (e) {
        // A thrown fee step = unresolved lane ownership; alert, then continue.
        logger.error(`[${source}] cancellation card-hold handling failed (target ${id}): ${e.message}`);
        try {
          await ApptCardRequests.alertUnresolvedCancellationFee({ scheduledServiceId: id, outcome: { released: false, reason: 'fee_step_error' } });
        } catch (alertErr) {
          logger.error(`[${source}] cancellation fee alert failed (target ${id}): ${alertErr.message}`);
        }
      }
    }
  }

  // ——— 2. Invoice void (idempotent; also reverses inspection credit) ———
  // Per-target isolation (uncapped r18 P1): one failing void must not
  // strand every LATER target's invoice/credit/dunning state — the same
  // isolation contract the fee step above keeps.
  {
    const InvoiceService = require('./invoice');
    for (const id of ids) {
      try {
        await InvoiceService.voidOpenInvoicesForCancelledService(id);
      } catch (e) {
        logger.error(`[${source}] cancellation invoice void failed (target ${id}): ${e.message}`);
      }
    }
  }

  // ——— 3. Tracker state ———
  for (const id of ids) {
    try {
      const result = await trackTransitions.cancel(id, { reason, actorId });
      await recordTrackTransitionResultFailure({ jobId: id, action: 'cancel', actorId, result });
    } catch (e) {
      logger.error(`[${source}] cancel track transition failed for ${id}: ${e.message}`);
      await recordTrackTransitionFailure({ jobId: id, action: 'cancel', actorId, error: e });
    }
  }

  return { settled: ids.length };
}

module.exports = { runVisitCancellationFollowThrough };
