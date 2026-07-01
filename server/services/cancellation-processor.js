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
 *   3. Mark the account churned / inactive AND wind down billing (disable
 *      autopay, clear the next charge, disarm any armed failed-payment retry)
 *      so a cancelled customer is never charged again.
 *
 * Best-effort and safe to call more than once: a visit already cancelled or a
 * customer already fully churned is skipped, so a retry is a no-op. Each step
 * is guarded and records into `errors` so a partial failure still lets the
 * others run and is surfaced to the caller (`ok === false`) for manual review —
 * the durable service_requests row and admin notification remain regardless.
 *
 * @returns {Promise<{cancelledCount:number, recurrenceStopped:number,
 *                    churned:boolean, ok:boolean, errors:string[]}>}
 */
async function processCancellationRequest({ customerId, reason, requestId } = {}) {
  if (!customerId) throw new Error('processCancellationRequest requires customerId');
  const cancelReason = String(reason || CHURN_REASON).slice(0, 500);
  const errors = [];

  // 1. Cancel all non-terminal scheduled visits for this customer.
  let services = [];
  try {
    services = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .whereNull('cancelled_at')
      .select('id');
  } catch (err) {
    errors.push('load_visits');
    logger.error(`[cancellation-processor] failed to load visits for ${customerId}: ${err.message}`);
  }

  let cancelledCount = 0;
  for (const svc of services) {
    try {
      // Fire the canonical cancel path for its side effects (customer socket
      // refresh + tech-status clear + token-expiry extension). It no-ops on a
      // genuinely-complete visit, so it can't un-complete anything.
      await trackTransitions.cancel(svc.id, { reason: cancelReason, actorId: null });
      // Authoritative pull: force the legacy `status` + track_state to cancelled
      // for this non-terminal visit — but never a finished one. `IS DISTINCT
      // FROM` excludes track_state='complete' while still matching NULL/legacy
      // track_state rows (a plain `!=` would drop NULLs). Count only real updates.
      const now = new Date();
      const updated = await db('scheduled_services')
        .where({ id: svc.id })
        .whereNotIn('status', TERMINAL_STATUSES)
        .whereRaw("track_state IS DISTINCT FROM 'complete'")
        .update({
          status: 'cancelled',
          track_state: 'cancelled',
          cancelled_at: now,
          cancellation_reason: cancelReason,
          updated_at: now,
        });
      if (updated > 0) cancelledCount += 1;
    } catch (err) {
      errors.push(`cancel_visit:${svc.id}`);
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
    errors.push('stop_recurrence');
    logger.error(`[cancellation-processor] failed to stop recurrence for ${customerId}: ${err.message}`);
  }

  // 3. Mark the customer churned / inactive and stop all billing.
  let churned = false;
  try {
    const customer = await db('customers')
      .where({ id: customerId })
      .first('pipeline_stage', 'active');
    if (customer) {
      const wasChurnedStage = customer.pipeline_stage === 'churned';
      const now = new Date();
      const update = {
        active: false,
        pipeline_stage: 'churned',
        // Wind down billing: the monthly charge loop skips active=false /
        // autopay_enabled=false, but the failed-payment retry ladder only skips
        // soft-deleted customers — so also disable autopay + clear the next
        // charge, and disarm any armed retry below.
        autopay_enabled: false,
        next_charge_date: null,
        updated_at: now,
      };
      // Preserve the original churn timestamp/reason if already churned.
      if (!wasChurnedStage) {
        update.pipeline_stage_changed_at = now;
        update.churned_at = now;
        update.churn_reason = CHURN_REASON;
      }
      await db('customers').where({ id: customerId }).update(update);

      // Disarm any pending failed-payment retry so the retry ladder can't
      // re-charge a cancelled customer (it does not check active/churn).
      await db('payments')
        .where({ customer_id: customerId, status: 'failed' })
        .whereNull('superseded_by_payment_id')
        .whereNotNull('next_retry_at')
        .update({ next_retry_at: null });

      churned = true;

      // Audit trail on the customer timeline — only the first time we churn.
      if (!wasChurnedStage) {
        try {
          await db('customer_interactions').insert({
            customer_id: customerId,
            interaction_type: 'note',
            subject: 'Cancellation processed — churned + upcoming visits pulled',
            body:
              `Portal cancellation request ${requestId || ''}`.trim() +
              `. Cancelled ${cancelledCount} upcoming visit(s), stopped recurrence, ` +
              'set pipeline_stage=churned + active=false, disabled autopay.',
          });
        } catch (noteErr) {
          logger.warn(`[cancellation-processor] audit note failed for ${customerId}: ${noteErr.message}`);
        }
      }
    }
  } catch (err) {
    errors.push('churn');
    logger.error(`[cancellation-processor] failed to churn customer ${customerId}: ${err.message}`);
  }

  const ok = errors.length === 0;
  logger.info(
    `[cancellation-processor] customer ${customerId}: cancelled ${cancelledCount} visit(s), ` +
      `recurrence stopped on ${recurrenceStopped} row(s), churned=${churned}, ok=${ok}` +
      (ok ? '' : ` (errors: ${errors.join(', ')})`)
  );

  return { cancelledCount, recurrenceStopped, churned, ok, errors };
}

module.exports = { processCancellationRequest, CHURN_REASON };
