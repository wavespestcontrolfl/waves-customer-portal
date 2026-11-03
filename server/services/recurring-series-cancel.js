'use strict';

/**
 * Cancel what is left of one recurring series and stop its plan: the dispatch
 * board's "cancel this and following" / "cancel whole series" (PUT
 * /api/admin/dispatch/:serviceId/status, routes/admin-dispatch.js), moved here
 * unchanged so the moving flow's "Apply move" (services/customer-moves.js) runs
 * the same cancel instead of a copy of it.
 *
 *   cancelSeriesRemainder(opts)  -> { targets, cancelledCount, ongoingStopped, cancelNoticeOutcome }
 *
 * A refusal throws SeriesCancelError carrying the HTTP status and the exact
 * JSON body the dispatch route answers; nothing is written when it throws.
 */

const db = require('../models/db');
const logger = require('./logger');

class SeriesCancelError extends Error {
  constructor(status, body) {
    super(body.error);
    this.name = 'SeriesCancelError';
    this.status = status;
    this.body = body;
    this.code = body.code || null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.parentId           the series root (recurring_parent_id || id)
 * @param {string} opts.customerId
 * @param {string} opts.serviceType        names the service family for the prepay-invoice check
 * @param {string} opts.recurringPattern   recorded with the series stop
 * @param {'following'|'series'} opts.scope
 * @param {string|Date} [opts.fromDate]    'following': cancel live visits dated on or after this date
 * @param {string} [opts.anchorId]         the visit the office cancelled from: cancelled too unless
 *                                         terminal, and the combined notice's representative visit
 * @param {boolean} [opts.notifyCustomer]  false = no cancellation text (reminders are still cancelled)
 * @param {boolean} [opts.waiveFee]        settle card holds without the late-cancel fee
 * @param {boolean} [opts.allowEmpty]      stop the plan even when no visit is left to cancel
 */
async function cancelSeriesRemainder({
  parentId, customerId, serviceType, recurringPattern, scope,
  fromDate, anchorId, notifyCustomer, notes, lat, lng, actorId, waiveFee, source, allowEmpty,
}) {
  const cancellableStatuses = ['pending', 'confirmed', 'rescheduled'];
  const terminalStatuses = ['completed', 'skipped', 'cancelled'];
  const { transitionJobStatus } = require('./job-status');
  // An UNPAID payment_pending annual term is invisible to the in-trx
  // coverage guard (coveredTermsAsOf excludes it and its standalone
  // prepay invoice carries no scheduled_service_id), yet its public
  // invoice stays payable — a payment landing AFTER this cancel runs
  // syncTermForInvoicePayment and re-seeds coverage for the visits just
  // cancelled. Same refusal the Cancel plan engine applies before its
  // wind-down (admin-cancellation.js), scoped to this visit's service
  // family; an unreadable family means whole-account (fail closed).
  // (Codex #3878 r3 P1.)
  {
    const { findPendingPrepayInvoice } = require('./admin-cancellation');
    const { familyOfServiceRow } = require('./cancellation-processor');
    const family = familyOfServiceRow({ service_type: serviceType });
    const pending = await findPendingPrepayInvoice(customerId, family ? [family] : null);
    if (pending) {
      const { term, invoice } = pending;
      throw new SeriesCancelError(409, {
        error: `Can't cancel ${scope === 'series' ? 'this plan' : 'the rest of this plan'}: an unpaid annual-prepay invoice (${invoice.invoice_number || invoice.id}${term.plan_label ? `, ${term.plan_label}` : ''}) is still payable and would re-activate coverage if paid after this cancellation. Void it from the invoice tools first.`,
        code: 'pending_prepay_invoice',
      });
    }
  }

  let targets = [];
  let ongoingStopped = 0;
  // Set INSIDE the transaction when a target is already paid for; the
  // trx is rolled back by the throw and the 409 is answered after it.
  let billingCovered = null;
  // Shared claim token for every target's trx claim — declared out
  // here because the post-commit series handler needs it too.
  const seriesClaimToken = require('./job-status').nextClaimTs();
  try {
    await db.transaction(async (trx) => {
      // Serialize with the per-parent series-maintenance advisory lock
      // (runRecurringSeriesMaintenance, admin-schedule) BEFORE selecting
      // the cancel set (codex P0: completion hook recreated cancelled
      // future visits). A concurrent completion's auto-extend either
      // commits before the select below — so its fresh row lands in the
      // cancel set — or blocks on this lock until our commit and then
      // sees recurring_ongoing=false in its in-lock re-checks and no-ops.
      // Without the lock, maintenance could interleave between the row
      // cancels and the flag clear and re-extend (re-bill) the cadence
      // the customer just cancelled.
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['recurring-series-maintenance', String(parentId)],
      );

      // ONE lock order with the series prepaid stamp (Codex #3878 r3 P2 /
      // r4 P2): stampSeriesPrepaid locks the family's LIVE rows (its
      // TERMINAL_STATUSES excluded) in scheduled_date order. This branch
      // locks only cancellable targets below but its family-wide
      // recurring_ongoing clear later touches en_route / on_site
      // siblings too — so take the identical live-family lock set, in
      // the identical order, FIRST. Terminal rows are never locked by
      // either path.
      {
        const { TERMINAL_STATUSES: PREPAID_SKIP } = require('./prepaid-series');
        await trx('scheduled_services')
          .where(function () {
            this.where('id', parentId).orWhere('recurring_parent_id', parentId);
          })
          .whereNotIn('status', [...PREPAID_SKIP])
          // Identical three-column order to fetchSeriesRows — a date tie
          // alone would let the two paths take siblings in opposite order.
          .orderBy(['scheduled_date', 'window_start', 'id'])
          .forUpdate()
          .select('id');
      }

      const targetQuery = trx('scheduled_services')
        .where(function () {
          this.where('id', parentId).orWhere('recurring_parent_id', parentId);
        })
        .where(function () {
          this.whereIn('status', cancellableStatuses);
          if (anchorId) {
            this.orWhere(function () {
              this.where('id', anchorId).whereNotIn('status', terminalStatuses);
            });
          }
        });
      if (scope === 'following') {
        targetQuery.where('scheduled_date', '>=', fromDate);
      }
      // FOR UPDATE: the coverage read below and the per-row transitions
      // must see one consistent row state. A prepaid writer (single-visit
      // /:id/prepaid, stampSeriesPrepaid) updates prepaid_amount without
      // touching status, so the transition's status-only CAS would not
      // notice a payment that landed between this select and the
      // transition (Codex #3878 r1 P1). Row locks make the writer wait
      // for this commit (its own status filter then sees 'cancelled') or
      // make this select wait for the writer's commit and read the stamp.
      targets = await targetQuery
        .orderBy('scheduled_date', 'asc')
        .forUpdate()
        .select('id', 'status', 'customer_id', 'service_type', 'scheduled_date', 'annual_prepay_term_id', 'prepaid_amount');
      // Nothing to cancel: nothing written (the caller answers 409), unless
      // the caller only needs the plan stopped (allowEmpty).
      if (!targets.length && !allowEmpty) return;

      // Money already taken for a target (annual prepay term, hand-
      // collected prepayment, an invoice holding money) refuses the WHOLE cancel — the same contract
      // as the plan-length trim (findBillingCoveredVisits, admin-schedule):
      // a series cancel that silently dropped paid visits would leave
      // money taken for visits that never happen, with no refund or
      // coverage decision recorded. The Cancel plan flow on the customer
      // profile owns that decision (end at term / refund). Read in-lock,
      // before any row is written; fee holds are NOT a refusal reason here
      // because this route runs the fee rails with a waiver control.
      if (targets.length) {
        const { findBillingCoveredVisits } = require('../routes/admin-schedule');
        const covered = await findBillingCoveredVisits(trx, targets, { feeRails: false });
        if (covered.size > 0) {
          const [firstId, reason] = [...covered.entries()][0];
          const first = targets.find((t) => t.id === firstId);
          const { serviceDateOnly } = require('./complete-scheduled-service');
          billingCovered = { count: covered.size, reason, firstDate: serviceDateOnly(first?.scheduled_date) };
          throw new Error('BILLING_COVERED_VISIT');
        }
      }

      for (const target of targets) {
        await transitionJobStatus({
          jobId: target.id,
          fromStatus: target.status,
          toStatus: 'cancelled',
          transitionedBy: actorId,
          lat,
          lng,
          notes,
          trx,
          // Caller-owned: the series step below runs its own awaited
          // per-visit handleCancellation (notify-or-suppress per the
          // request flag) plus one combined notice — the hook must stand
          // down entirely, not race those claims.
          notifyCustomer: notifyCustomer === false ? 'caller_suppress' : 'caller',
          cancelNoticeToken: seriesClaimToken,
        });
      }

      // Stop the plan ATOMICALLY with the row cancels: both 'following'
      // and 'series' cancel the remainder of the series, so a parent left
      // flagged recurring_ongoing would let a later completion of an
      // earlier retained visit re-extend — and re-bill — the cancelled
      // cadence. Cleared series-wide (parent + children carry the flag)
      // in the SAME transaction, under the maintenance lock above.
      // Single-occurrence cancels (scope 'this_only') never come here
      // and leave the flag intact. The per-row cancellation reason
      // is already stamped by transitionJobStatus (notes →
      // job_status_history); the caller's activity_log line records the
      // plan stop.
      // Record the explicit series decision in the existing renewal ledger.
      // Appointment statuses cannot distinguish this from this_only cancels.
      await require('./recurring-plan-decisions').recordRecurringSeriesStops(trx, [{
        id: parentId, customer_id: customerId, recurring_pattern: recurringPattern,
      }], actorId);
      const cols = await trx('scheduled_services').columnInfo().catch(() => ({}));
      if (cols.recurring_ongoing) {
        ongoingStopped = await trx('scheduled_services')
          .where(function () {
            this.where('id', parentId).orWhere('recurring_parent_id', parentId);
          })
          .where('recurring_ongoing', true)
          .update({ recurring_ongoing: false, updated_at: new Date() });
      }
    });
  } catch (err) {
    if (!billingCovered) throw err;
    throw new SeriesCancelError(409, {
      error: `Can't cancel ${scope === 'series' ? 'this plan' : 'the rest of this plan'}: the ${billingCovered.firstDate || 'later'} visit is ${billingCovered.reason}`
        + (billingCovered.count > 1 ? ` (${billingCovered.count} visits are)` : '')
        + '. Use Cancel plan on the customer profile (it settles the prepaid term), or handle the billing first.',
      code: 'BILLING_COVERED_VISIT',
      coveredCount: billingCovered.count,
    });
  }

  if (!targets.length) {
    if (!allowEmpty) throw new SeriesCancelError(409, { error: 'No cancellable appointments found in this series' });
    return { targets, cancelledCount: 0, ongoingStopped, cancelNoticeOutcome: null };
  }

  let cancelNoticeOutcome = null;
  try {
    const AppointmentReminders = require('./appointment-reminders');
    const targetIds = targets.map((target) => target.id);
    cancelNoticeOutcome = notifyCustomer !== false ? {} : null;
    await AppointmentReminders.handleSeriesCancellation(targetIds, anchorId || targetIds[0], {
      sendNotification: notifyCustomer !== false,
      scope,
      // The trx claims were minted under this shared token — the
      // series claim adopts exactly them, never a foreign lease.
      claimToken: seriesClaimToken,
      ...(cancelNoticeOutcome ? { outcome: cancelNoticeOutcome } : {}),
    });
  } catch (e) { logger.error(`[recurring-series-cancel] series cancellation reminder handling failed: ${e.message}`); }

  // Post-commit cancellation follow-through — card fee rails (estimate
  // hold, falling back to the /secure appointment-card agreement), the
  // invoice void that restores applied credit and the deposit ledger, and
  // the tracker cancel. Extracted to services/visit-cancellation-
  // followthrough.js so the Edit-appointment plan-length trim runs the
  // SAME obligations instead of reimplementing a subset (Codex #3337 r4):
  // behavior here is unchanged, including the admin-only waive gate (the
  // caller decides waiveFee), the per-target isolation, and the ordering.
  {
    const { runVisitCancellationFollowThrough } = require('./visit-cancellation-followthrough');
    await runVisitCancellationFollowThrough({
      targetIds: targets.map((target) => target.id),
      actorId,
      waiveFee,
      reason: notes || null,
      source,
    });
  }

  return { targets, cancelledCount: targets.length, ongoingStopped, cancelNoticeOutcome };
}

module.exports = { cancelSeriesRemainder, SeriesCancelError };
