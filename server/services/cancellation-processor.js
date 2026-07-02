const db = require('../models/db');
const logger = require('./logger');
const trackTransitions = require('./track-transitions');
const { transitionJobStatus } = require('./job-status');
const { etDateString } = require('../utils/datetime-et');

// customers.churn_reason is varchar(30) — keep this at/under 30 chars.
const CHURN_REASON = 'Customer cancellation request';
// The same "still cancellable" allowlist the admin series-cancel path and the
// customer portal's upcoming-visits query use. Deliberately excludes terminal
// history (completed / cancelled / skipped / no_show — never rewritten) and
// in-progress work (en_route / on_site — a tech already rolling is an office
// decision; the admin alert flags the account for follow-up either way).
const CANCELLABLE_STATUSES = ['pending', 'confirmed', 'rescheduled'];
// track_state values that mean a tech is actively working the visit right now.
// The tracker can LEAD the legacy status: track-transitions flips track_state
// first and syncs `status` best-effort (a sync failure only logs), so a live
// visit can still read status=pending/confirmed.
const LIVE_TRACK_STATES = ['en_route', 'on_property'];
// Card-hold outcomes that leave money unresolved: the fee path never throws
// into the host flow — a decline / ambiguous Stripe outcome / post-charge
// write failure comes back as a reason code with the hold parked for review.
const CARD_HOLD_REVIEW_REASONS = new Set(['charge_failed', 'charge_review', 'charge_review_write_failed']);

/**
 * Process an accepted customer cancellation request:
 *   1. Pull every upcoming cancellable visit off the calendar via the SAME
 *      composed path the admin cancel action uses: transitionJobStatus (status
 *      flip + job_status_history + overdue-alert auto-resolve + dispatch/customer
 *      broadcasts), reminder-record cancellation (suppressing the per-visit SMS —
 *      this flow sends one dedicated confirmation), open-invoice void, one-time
 *      card-hold resolution, and the customer-visible track-layer cancel.
 *      A visit already in progress (en_route / on_site) is never auto-cancelled
 *      — it's flagged into `errors` for manual handling, as is any money the
 *      helpers couldn't safely resolve (unvoidable invoice, failed/ambiguous
 *      late-cancel fee), so the admin alert never claims full auto-processing
 *      while something still needs office eyes.
 *   2. Stop any recurring series so the scheduler doesn't regenerate visits.
 *   3. Mark the account churned / inactive AND wind down billing (disable
 *      autopay, clear the next charge, disarm any armed failed-payment retry)
 *      so a cancelled customer is never charged again.
 *
 * Best-effort and safe to call more than once: a retry is not just a no-op —
 * visits a prior attempt of the SAME request already flipped (identified via
 * the request-scoped job_status_history note) get their idempotent side
 * effects re-run, so a partial first attempt is REPAIRED rather than skipped.
 * An already-churned customer is re-inactivated without restamping. Each step
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

  // Live in-progress work (tech en route / on property) is never auto-cancelled
  // — but it must not be silently ignored either. Flag each such visit so the
  // admin alert says "review manually" instead of claiming full auto-processing
  // while a tech is rolling; the rest of the wind-down still runs (owner
  // directive: churn immediately on submit). Checked on BOTH layers: the
  // legacy status AND a leading track_state whose status sync lagged (the two
  // queries are disjoint — the second excludes statuses the first matched;
  // terminal statuses there are stale-drift history, not live work).
  try {
    const inProgressByStatus = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', ['en_route', 'on_site'])
      .select('id');
    const inProgressByTrack = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('track_state', LIVE_TRACK_STATES)
      .whereNotIn('status', ['en_route', 'on_site', 'completed', 'cancelled', 'skipped', 'no_show'])
      .select('id');
    for (const row of [...inProgressByStatus, ...inProgressByTrack]) {
      errors.push(`in_progress_visit:${row.id}`);
      logger.warn(`[cancellation-processor] visit ${row.id} is in progress — left for manual handling`);
    }
  } catch (err) {
    errors.push('load_in_progress');
    logger.error(`[cancellation-processor] failed to check in-progress visits for ${customerId}: ${err.message}`);
  }

  // 1. Cancel the customer's upcoming cancellable visits.
  let services = [];
  try {
    services = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', CANCELLABLE_STATUSES)
      .where(function () {
        // Upcoming = on/after the ET business date (scheduled_date is a DATE
        // column; same bound as the portal's upcoming query) so historical
        // stale rows keep their status. EXCEPT 'rescheduled': those phantom
        // rows keep their ORIGINAL — often past — date until SmartRebooker
        // actions them back onto the calendar, so an open rebook intent is
        // pulled regardless of date (else a churned customer could be rebooked).
        this.where('scheduled_date', '>=', etDateString()).orWhere('status', 'rescheduled');
      })
      // Never touch a row whose customer-visible track layer says the work is
      // DONE or LIVE — track_state can lead the legacy status (the tracker
      // flips first; the status sync is best-effort), so a status-only filter
      // would sweep a visit a tech is actively working. NULL-safe for legacy
      // rows with no track_state.
      .whereRaw("(track_state IS NULL OR track_state NOT IN ('complete', 'en_route', 'on_property'))")
      .select('id', 'status');
  } catch (err) {
    errors.push('load_visits');
    logger.error(`[cancellation-processor] failed to load visits for ${customerId}: ${err.message}`);
  }

  // Visits a PRIOR attempt of this same request already flipped to cancelled:
  // the sweep above only selects still-live statuses, so without this a retry
  // (the route re-runs the processor on a deduped resubmit) would skip a visit
  // whose status flip committed but whose side effects (invoice void, card
  // hold, reminders, track layer) failed — leaving them broken forever. The
  // flip stamps the request-scoped reason into job_status_history.notes, which
  // identifies exactly the visits this request cancelled; re-confirm each is
  // STILL cancelled so a visit an admin has since revived is left alone.
  let repairs = [];
  try {
    const history = await db('job_status_history')
      .where({ to_status: 'cancelled', notes: cancelReason })
      .select('job_id');
    const freshIds = new Set(services.map((s) => s.id));
    const priorIds = [...new Set(history.map((h) => h.job_id))].filter((id) => !freshIds.has(id));
    if (priorIds.length) {
      repairs = await db('scheduled_services')
        .whereIn('id', priorIds)
        .where({ status: 'cancelled' })
        .select('id', 'status');
    }
  } catch (err) {
    errors.push('load_prior_cancelled');
    logger.error(`[cancellation-processor] failed to load prior-cancelled visits for ${customerId}: ${err.message}`);
  }

  let cancelledCount = 0;
  const toProcess = [
    ...services.map((s) => ({ ...s, alreadyCancelled: false })),
    ...repairs.map((s) => ({ ...s, alreadyCancelled: true })),
  ];
  for (const svc of toProcess) {
    if (!svc.alreadyCancelled) {
      // Canonical status flip: writes the job_status_history audit row,
      // auto-resolves open tech_late / unassigned_overdue alerts, and broadcasts
      // dispatch + customer job updates — the sole-writer the admin cancel path
      // uses. The atomic guard on fromStatus makes a racing transition throw
      // instead of clobbering it.
      let flipped = false;
      try {
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus: svc.status,
          toStatus: 'cancelled',
          transitionedBy: null,
          notes: cancelReason,
        });
        flipped = true;
      } catch (err) {
        // Guard-mismatch race: another path moved the row first. A concurrent
        // duplicate that already CANCELLED it falls through to the (idempotent)
        // side effects below so a half-processed racer still gets repaired;
        // other terminal history is a benign skip; anything else (a tech went
        // en_route mid-request, or a real failure) needs office eyes.
        let freshStatus = null;
        try {
          const fresh = await db('scheduled_services').where({ id: svc.id }).first('status');
          freshStatus = fresh ? fresh.status : null;
        } catch (recheckErr) {
          logger.error(`[cancellation-processor] status re-check failed for ${svc.id}: ${recheckErr.message}`);
        }
        if (freshStatus !== 'cancelled') {
          const benign = !!freshStatus
            && !CANCELLABLE_STATUSES.includes(freshStatus)
            && freshStatus !== 'en_route' && freshStatus !== 'on_site';
          if (!benign) {
            errors.push(`cancel_visit:${svc.id}`);
            logger.error(`[cancellation-processor] failed to cancel visit ${svc.id}: ${err.message}`);
          }
          continue;
        }
      }

      if (flipped) {
        // The flip's atomic guard covers only `status` — the tracker can go
        // LIVE between our sweep SELECT and the flip while its best-effort
        // status sync fails, in which case we just cancelled a visit a tech is
        // actively working. Re-read the track layer and compensate: revert the
        // flip (with its own audit row) and flag for manual handling instead.
        let wentLive = false;
        try {
          const freshTrack = await db('scheduled_services').where({ id: svc.id }).first('track_state');
          wentLive = !!freshTrack && LIVE_TRACK_STATES.includes(freshTrack.track_state);
        } catch (trackCheckErr) {
          logger.error(`[cancellation-processor] track-state re-check failed for ${svc.id}: ${trackCheckErr.message}`);
        }
        if (wentLive) {
          try {
            await transitionJobStatus({
              jobId: svc.id,
              fromStatus: 'cancelled',
              toStatus: svc.status,
              transitionedBy: null,
              notes: 'Auto-cancel reverted — tech went live mid-request',
            });
            errors.push(`in_progress_visit:${svc.id}`);
            logger.warn(`[cancellation-processor] visit ${svc.id} went live mid-request — cancel reverted, left for manual handling`);
          } catch (revertErr) {
            // The revert lost its own race (the visit advanced again). Leave
            // the row as-is and flag it — office review decides the end state.
            errors.push(`cancel_visit:${svc.id}`);
            logger.error(`[cancellation-processor] failed to revert live-visit cancel for ${svc.id}: ${revertErr.message}`);
          }
          continue;
        }
        cancelledCount += 1;
      }
    }

    // Mirror the admin cancel path's side effects for the committed flip.
    // Each is best-effort so one failure never strands the rest of the sweep;
    // money-path failures are recorded so the admin alert says "review manually".

    // Reminder record → cancelled, so a deferred "appointment confirmed" send
    // can't fire for a pulled visit. Per-visit cancellation SMS suppressed —
    // the route sends one dedicated cancellation-confirmation SMS instead.
    // The helper catches its own failures and returns null (which is ALSO its
    // no-reminder-row signal), so re-check the row: one left uncancelled means
    // deferred confirmations can still fire for a cancelled visit — surface it
    // instead of the alert claiming full auto-processing.
    try {
      const AppointmentReminders = require('./appointment-reminders');
      await AppointmentReminders.handleCancellation(svc.id, { sendNotification: false });
      const staleReminder = await db('appointment_reminders')
        .where({ scheduled_service_id: svc.id })
        .whereRaw('cancelled IS DISTINCT FROM true')
        .first('id');
      if (staleReminder) {
        errors.push(`reminder_cancel:${svc.id}`);
        logger.error(`[cancellation-processor] reminder row for ${svc.id} still active after cancellation — needs manual review`);
      }
    } catch (err) {
      errors.push(`reminder_cancel:${svc.id}`);
      logger.error(`[cancellation-processor] reminder cancellation failed for ${svc.id}: ${err.message}`);
    }

    // Void any still-open invoice pre-minted for this visit (e.g. the admin
    // Charge-now path) so dunning doesn't chase a cancelled job. The helper
    // never throws — it intentionally SKIPS invoices it can't safely void
    // (payment in flight / applied money / unverifiable PI) — so re-check for
    // anything NOT money-resolved and surface it as a manual-review error
    // instead of the alert claiming billing fully stopped. That includes
    // 'paid'/'processing' (cash captured or in flight for a visit that now
    // won't happen → refund/credit decision) and a transient 'sending' claim,
    // not just the voidable statuses the sweep skipped.
    try {
      const InvoiceService = require('./invoice');
      await InvoiceService.voidOpenInvoicesForCancelledService(svc.id);
      const unresolved = await db('invoices')
        .where({ scheduled_service_id: svc.id })
        .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
        .select('id');
      for (const inv of unresolved) {
        errors.push(`invoice_review:${inv.id}`);
        logger.error(`[cancellation-processor] invoice ${inv.id} for visit ${svc.id} still needs money handling — manual review`);
      }
    } catch (err) {
      errors.push(`void_invoices:${svc.id}`);
      logger.error(`[cancellation-processor] invoice void sweep failed for ${svc.id}: ${err.message}`);
    }

    // One-time card-on-file hold: an in-window cancellation charges the flat
    // late-cancel fee, otherwise the hold is released. No-op when no hold
    // exists; dark until ONE_TIME_CARD_HOLD. Failure comes back as a reason
    // code, not a throw — surface the money-unresolved outcomes (declined fee,
    // ambiguous Stripe result, post-charge write failure).
    try {
      const CardHolds = require('./estimate-card-holds');
      const holdResult = await CardHolds.handleCardHoldCancellation({ scheduledServiceId: svc.id });
      if (holdResult && CARD_HOLD_REVIEW_REASONS.has(holdResult.reason)) {
        errors.push(`card_hold:${svc.id}`);
        logger.error(`[cancellation-processor] card hold for ${svc.id} needs review: ${holdResult.reason}`);
      }
    } catch (err) {
      errors.push(`card_hold:${svc.id}`);
      logger.error(`[cancellation-processor] card-hold handling failed for ${svc.id}: ${err.message}`);
    }

    // Customer-visible track layer: track_state / cancelled_at /
    // cancellation_reason + tech-status clear + token-expiry extension. It
    // no-ops on a genuinely-complete visit, so it can't un-complete anything.
    // A failure/non-ok result means the public tracker still shows the visit
    // live after the status flip above — surface it so staff repair it.
    try {
      const trackResult = await trackTransitions.cancel(svc.id, { reason: cancelReason, actorId: null });
      if (!trackResult || trackResult.ok !== true) {
        errors.push(`track_cancel:${svc.id}`);
        logger.error(
          `[cancellation-processor] track-layer cancel not ok for ${svc.id}: ${(trackResult && trackResult.reason) || 'unknown'}`
        );
      }
    } catch (err) {
      errors.push(`track_cancel:${svc.id}`);
      logger.error(`[cancellation-processor] track-layer cancel failed for ${svc.id}: ${err.message}`);
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
        // churned_at is a DATE column — stamp the ET calendar date (a JS Date
        // lands on the wrong day after ET midnight; same rule as the admin
        // stage-change path).
        update.churned_at = etDateString();
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

module.exports = { processCancellationRequest, CHURN_REASON, CANCELLABLE_STATUSES };
