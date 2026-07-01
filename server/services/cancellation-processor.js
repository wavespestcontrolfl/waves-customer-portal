const db = require('../models/db');
const logger = require('./logger');
const trackTransitions = require('./track-transitions');

// customers.churn_reason is varchar(30) — keep this at/under 30 chars.
const CHURN_REASON = 'Customer cancellation request';
const TERMINAL_STATUSES = ['completed', 'cancelled'];

/**
 * Process an accepted customer cancellation request:
 *   1. Pull every upcoming (non-terminal) visit off the calendar.
 *   2. Stop any recurring series so the scheduler doesn't regenerate visits.
 *   3. Mark the account churned / inactive.
 *
 * Best-effort and safe to call more than once: a visit already cancelled or a
 * customer already churned is skipped, so a retry is a no-op. Each step is
 * guarded so a partial failure still lets the others run — the durable
 * service_requests row and admin notification remain regardless.
 *
 * @returns {Promise<{cancelledCount:number, recurrenceStopped:number, churned:boolean}>}
 */
async function processCancellationRequest({ customerId, reason, requestId } = {}) {
  if (!customerId) throw new Error('processCancellationRequest requires customerId');
  const cancelReason = String(reason || CHURN_REASON).slice(0, 500);

  // 1. Cancel all non-terminal scheduled visits for this customer.
  let services = [];
  try {
    services = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .whereNull('cancelled_at')
      .select('id');
  } catch (err) {
    logger.error(`[cancellation-processor] failed to load visits for ${customerId}: ${err.message}`);
  }

  let cancelledCount = 0;
  for (const svc of services) {
    try {
      // Reuse the canonical cancel path (socket refresh + tech-status clear +
      // token-expiry extension), then keep the legacy `status` column and the
      // track_state in sync exactly as the admin cancel route does.
      await trackTransitions.cancel(svc.id, { reason: cancelReason, actorId: null });
      await db('scheduled_services')
        .where({ id: svc.id })
        .whereNot('status', 'completed')
        .update({
          status: 'cancelled',
          track_state: 'cancelled',
          cancelled_at: new Date(),
          cancellation_reason: cancelReason,
          updated_at: new Date(),
        });
      cancelledCount += 1;
    } catch (err) {
      logger.error(`[cancellation-processor] failed to cancel visit ${svc.id}: ${err.message}`);
    }
  }

  // 2. Stop any recurring series so no new occurrences are generated.
  let recurrenceStopped = 0;
  try {
    recurrenceStopped = await db('scheduled_services')
      .where({ customer_id: customerId, recurring_ongoing: true })
      .update({ recurring_ongoing: false, updated_at: new Date() });
  } catch (err) {
    logger.error(`[cancellation-processor] failed to stop recurrence for ${customerId}: ${err.message}`);
  }

  // 3. Mark the customer churned / inactive (skip if already churned).
  let churned = false;
  try {
    const customer = await db('customers').where({ id: customerId }).first('pipeline_stage');
    if (customer && customer.pipeline_stage !== 'churned') {
      const now = new Date();
      await db('customers').where({ id: customerId }).update({
        active: false,
        pipeline_stage: 'churned',
        pipeline_stage_changed_at: now,
        churned_at: now,
        churn_reason: CHURN_REASON,
        updated_at: now,
      });
      churned = true;

      // Audit trail on the customer timeline.
      try {
        await db('customer_interactions').insert({
          customer_id: customerId,
          interaction_type: 'note',
          subject: 'Cancellation processed — churned + upcoming visits pulled',
          body:
            `Portal cancellation request ${requestId || ''}`.trim() +
            `. Cancelled ${cancelledCount} upcoming visit(s), stopped recurrence, ` +
            'set pipeline_stage=churned + active=false.',
        });
      } catch (noteErr) {
        logger.warn(`[cancellation-processor] audit note failed for ${customerId}: ${noteErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[cancellation-processor] failed to churn customer ${customerId}: ${err.message}`);
  }

  logger.info(
    `[cancellation-processor] customer ${customerId}: cancelled ${cancelledCount} visit(s), ` +
      `recurrence stopped on ${recurrenceStopped} row(s), churned=${churned}`
  );

  return { cancelledCount, recurrenceStopped, churned };
}

module.exports = { processCancellationRequest, CHURN_REASON };
