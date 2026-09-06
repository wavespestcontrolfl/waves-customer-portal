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
 * Collection ordering is load-bearing:
 *   1. Invoice void — closes the service invoice collection rail before a
 *      cancellation fee is attempted, restores credit, and stops dunning.
 *   2. Card fee rails — the estimate card-hold, falling back to the /secure
 *      agreement when no hold exists. Unresolved outcomes alert the office.
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
const db = require('../models/db');
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
 * @param {Date} [opts.now] Explicit cancellation instant for callers that
 *   already retain it. Otherwise read the latest real cancellation transition;
 *   same-status retries must never evaluate fees against the retry clock.
 */
async function runVisitCancellationFollowThrough({
  targetIds = [],
  actorId = null,
  waiveFee = false,
  reason = null,
  source = 'cancellation',
  now,
} = {}) {
  const ids = targetIds.filter(Boolean);
  const CardHolds = require('./estimate-card-holds');
  const ApptCardRequests = require('./appointment-card-request');
  const InvoiceService = require('./invoice');

  for (const id of ids) {
    let feeOutcome;
    try {
      // Close service-invoice collection before starting a Stripe fee call.
      // A failed cleanup skips the fee and alerts, but tracker cleanup and
      // the other cancelled visits still proceed.
      await InvoiceService.voidOpenInvoicesForCancelledService(id);
      // The void sweep deliberately skips unsafe invoices without throwing.
      // Reuse its callers' resolved-status contract: paid/processing money,
      // an unverifiable PI, and still-collectible invoices all need review.
      const unresolvedInvoice = await db('invoices')
        .where({ scheduled_service_id: id })
        .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
        .first('id');
      if (unresolvedInvoice) {
        throw new Error('Service invoice still needs money handling; fee requires review');
      }

      // Explicit waivers need no history, including legacy cancelled visits.
      let cancelledAt = now || (waiveFee ? new Date() : null);
      if (!cancelledAt) {
        const transition = await db('job_status_history')
          .where({ job_id: id, to_status: 'cancelled' })
          .whereNot('from_status', 'cancelled')
          .orderBy('transitioned_at', 'desc')
          .first('transitioned_at');
        cancelledAt = transition?.transitioned_at;
      }
      const feeTime = new Date(cancelledAt || NaN);
      if (!Number.isFinite(feeTime.getTime())) {
        throw new Error('Cancellation time unavailable; fee requires review');
      }
      // Two clocks: original cancellation decides the cutoff; REAL elapsed
      // time prevents a stale retry from charging weeks after the event.
      const feeOptions = {
        scheduledServiceId: id,
        waiveFee: waiveFee || Date.now() - feeTime.getTime() > CardHolds.NO_SHOW_FEE_MAX_AGE_MS,
        now: feeTime,
      };
      const { reason: holdReason, charged, released, parked } = await CardHolds.handleCardHoldCancellation(feeOptions);
      feeOutcome = holdReason === 'no_hold'
        ? await ApptCardRequests.handleAppointmentCardCancellation(feeOptions)
        : {
          released: [charged, released, parked, holdReason === 'park_gate_off'].includes(true),
          reason: holdReason || 'hold_unresolved',
        };
    } catch (e) {
      logger.error(`[${source}] cancellation money handling failed (target ${id}): ${e.message}`);
      feeOutcome = { released: false, reason: 'fee_step_error' };
    }
    // One normalized outcome for BOTH rails and thrown failures. The alert
    // service ignores clean outcomes, so no duplicate decision tree here.
    await ApptCardRequests.alertUnresolvedCancellationFee({ scheduledServiceId: id, outcome: feeOutcome });

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
