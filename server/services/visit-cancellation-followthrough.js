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
const logger = require('../utils/logger');
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
 */
async function runVisitCancellationFollowThrough({
  targetIds,
  actorId = null,
  waiveFee = false,
  reason = null,
  source = 'cancellation',
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
        });
        // Visits with no hold row may still carry the /secure lane's agreed
        // fee (mutually exclusive rails — the rail itself re-checks).
        if (holdResult?.reason === 'no_hold') {
          const apptFeeOutcome = await ApptCardRequests.handleAppointmentCardCancellation({
            scheduledServiceId: id,
            waiveFee,
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
  try {
    const InvoiceService = require('./invoice');
    for (const id of ids) {
      await InvoiceService.voidOpenInvoicesForCancelledService(id);
    }
  } catch (e) {
    logger.error(`[${source}] cancellation invoice void sweep failed: ${e.message}`);
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
