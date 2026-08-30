const db = require('../models/db');
const logger = require('./logger');
const trackTransitions = require('./track-transitions');
const { transitionJobStatus } = require('./job-status');
const { etDateString } = require('../utils/datetime-et');
const { gateEnvValue } = require('../config/feature-gates');

// customers.churn_reason is varchar(30) — keep this at/under 30 chars.
const CHURN_REASON = 'Customer cancellation request';
// Status/track-state vocabulary lives in cancellation-eligibility so the
// POST /api/requests gate, the /api/schedule payload, and this sweep can
// never drift; re-exported below for existing consumers.
const { CANCELLABLE_STATUSES, LIVE_TRACK_STATES } = require('./cancellation-eligibility');
// Card-hold outcomes that leave money unresolved: the fee path never throws
// into the host flow — a decline / ambiguous Stripe outcome / post-charge
// write failure comes back as a reason code with the hold parked for review.
const CARD_HOLD_REVIEW_REASONS = new Set(['charge_failed', 'charge_review', 'charge_review_write_failed']);

/**
 * Process an accepted customer cancellation request, in an order chosen so the
 * highest-stakes wind-down happens before the slow parts:
 *   1. Mark the account churned / inactive AND stop billing FIRST (disable
 *      autopay, clear the next charge, disarm any armed failed-payment retry)
 *      — the per-visit sweep below can take a while (Stripe calls), and the
 *      billing crons must not find a chargeable customer in that window.
 *   2. Stop any recurring series BEFORE sweeping, so a concurrent completion
 *      can't auto-extend the series after we've read the visit list.
 *   3. Pull every upcoming cancellable visit off the calendar via the SAME
 *      composed path the admin cancel action uses: transitionJobStatus (status
 *      flip + job_status_history + overdue-alert auto-resolve + dispatch/customer
 *      broadcasts), reminder-record cancellation (suppressing the per-visit SMS —
 *      this flow sends one dedicated confirmation), open-invoice void, one-time
 *      card-hold resolution, and the customer-visible track-layer cancel. A
 *      second sweep pass catches a straggler occurrence inserted mid-flight.
 *      A visit already in progress (en_route / on_site, on either the status
 *      or the track layer) is never auto-cancelled — it's flagged into
 *      `errors` for manual handling, as is any money the helpers couldn't
 *      safely resolve (unvoidable invoice, failed/ambiguous late-cancel fee),
 *      so the admin alert never claims full auto-processing while something
 *      still needs office eyes.
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
async function raiseTermiteRetrievalTask(customerId, requestId = null) {
  // program filter: the table also holds rodent/trapping stations, which are
  // always Waves-owned and are NOT bait-station rentals.
  const stations = await db('termite_stations')
    .where({ customer_id: customerId, program: 'termite' })
    .select('id', 'owned_by', 'is_active');
  const rented = (stations || []).filter((row) => row && row.owned_by === 'waves' && row.is_active !== false);
  let flaggedRental = false;
  if (!rented.length) {
    // Customer-level flag (migration 20260726000003) covers rental programs
    // whose stations were never pinned on the map.
    const customer = await db('customers').where({ id: customerId }).first('termite_stations_rented');
    flaggedRental = !!(customer && customer.termite_stations_rented === true);
    if (!flaggedRental) return { raised: false, reason: 'no_rented_stations' };
  }
  const NotificationService = require('./notification-service');
  const count = rented.length;
  const result = await NotificationService.notifyAdmin(
    'service',
    'Termite stations to retrieve after cancellation',
    (count
      ? `${count} Waves-owned bait station${count === 1 ? '' : 's'} on this property need to be pulled — schedule the retrieval visit.`
      : 'This account is flagged as a bait-station rental — confirm the stations on site and schedule the retrieval visit.')
      + ' No charge to the customer.',
    {
      icon: '🪵',
      // Forces the bell past GATE_ADMIN_BELL_POLICY (bellAllowed honours
      // options.bell first): this is an office TASK, not an FYI, and must
      // never be silenced by the category allowlist.
      bell: true,
      link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
      // Keyed per cancellation EVENT (request), not per customer: retries of
      // the same request stay idempotent, while a restored customer who later
      // cancels another rental program gets a fresh task.
      dedupeKey: `termite_station_retrieval:${customerId}:${requestId || 'no-request'}`,
      metadata: { kind: 'termite_station_retrieval', customerId, stationCount: count, flaggedRental },
    }
  );
  // notifyAdmin resolves null (never throws) when the deduped insert fails —
  // surface that as an error so the cancel is not reported fully processed
  // while Waves-owned stations have no retrieval task.
  if (!result) throw new Error('admin notification did not persist');
  if (result.suppressed) {
    // With bell:true the only remaining suppression is the internal
    // test-customer gate (no reason) — no task wanted there. Anything else
    // means no row landed for a real account: fail loudly.
    if (result.reason) throw new Error(`admin notification suppressed (${result.reason})`);
    return { raised: false, reason: 'internal_test_customer', stationCount: count };
  }
  if (!result.id) throw new Error('admin notification did not persist');
  return { raised: true, stationCount: count };
}

async function processCancellationRequest({ customerId, reason, requestId } = {}) {
  if (!customerId) throw new Error('processCancellationRequest requires customerId');
  const cancelReason = String(reason || CHURN_REASON).slice(0, 500);
  const errors = [];

  // 1. Churn + stop all billing FIRST — before the (potentially slow,
  // Stripe-touching) visit sweep. The monthly charge loop preselects
  // active/autopay customers and the failed-payment retry ladder only skips
  // soft-deleted ones, so every second the account stays chargeable is a
  // window for a billing cron to charge a customer who just cancelled.
  let churned = false;
  let wasChurnedStage = false;
  try {
    const customer = await db('customers')
      .where({ id: customerId })
      .first('pipeline_stage', 'active', 'monthly_rate');
    if (customer) {
      wasChurnedStage = customer.pipeline_stage === 'churned';
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
        // Taxonomy (Phase 7): snapshot the rate AT churn (monthly_rate gets
        // zeroed/repriced later — without this the Pareto's dollars rewrite
        // history), keep the customer's own words (legacy churn_reason is
        // varchar(30)), and start at 'unclassified' — the AI classification
        // runs LAST (see below) so it can never block this wind-down.
        update.churn_mrr = Number(customer.monthly_rate) || 0;
        update.churn_reason_detail = cancelReason;
        update.churn_reason_code = 'unclassified';
      }
      // PR E (GATE_CANCEL_FLOW_V2): tier/rate wind-down — the 2026-08-30
      // audit's money leak. Tier alignment only ever PROMOTES
      // (self-booking-plan-sync), so a churned account that kept its
      // waveguard_tier / monthly_rate rejoins later at the old discount
      // forever. churn_mrr above already snapshotted the rate for reporting
      // (first churn); on a repeat churn it was stamped the first time.
      // Applied even when the stage was already 'churned' so admin
      // stage-flip residue self-heals on the next processor run. The scalar
      // clear and the per-family ledger reset run in ONE transaction —
      // fail-closed: with GATE_PLAN_RATE_LEDGER authoritative, a surviving
      // positive component would resurrect the old rate on a win-back, so a
      // ledger failure must fail the churn write (→ 'churn' error → office
      // review alert), never be swallowed. Dark: gate off → byte-identical
      // to H0.
      // Both saved payment METHODS (StripeService.charge() picks the default
      // by payment_methods.autopay_enabled alone) and any armed
      // failed-payment retry (the ladder does not check active/churn) are
      // independent charge rails and belong to the same wind-down.
      const disarmPaymentRails = async (dbh) => {
        await dbh('payment_methods')
          .where({ customer_id: customerId })
          .update({ autopay_enabled: false });
        await dbh('payments')
          .where({ customer_id: customerId, status: 'failed' })
          .whereNull('superseded_by_payment_id')
          .whereNotNull('next_retry_at')
          .update({ next_retry_at: null });
      };

      if (gateEnvValue('GATE_CANCEL_FLOW_V2')) {
        // PR E: the ENTIRE billing wind-down — customer flags/tier clear,
        // authoritative ledger reset, payment-method disable, retry disarm —
        // is ONE transaction. All-or-nothing is what makes the abort below
        // sound: on a throw here, nothing persisted and the account is
        // exactly as it was. The advisory ledger reset (gate off for
        // GATE_PLAN_RATE_LEDGER) runs after commit and only warns — an
        // advisory hiccup must never take the committed wind-down back.
        update.waveguard_tier = null;
        update.waveguard_tier_source = null;
        update.monthly_rate = null;
        const { resetLedgerToScalar, planRateLedgerEnabled } = require('./plan-rate-ledger');
        const ledgerAuthoritative = planRateLedgerEnabled();
        await db.transaction(async (trx) => {
          await trx('customers').where({ id: customerId }).update(update);
          if (ledgerAuthoritative) await resetLedgerToScalar(trx, customerId, 0, { source: 'cancellation' });
          await disarmPaymentRails(trx);
        });
        if (!ledgerAuthoritative) {
          try {
            await resetLedgerToScalar(db, customerId, 0, { source: 'cancellation' });
          } catch (ledgerErr) {
            logger.warn(`[cancellation-processor] advisory plan-rate wind-down failed for ${customerId}: ${ledgerErr.message}`);
          }
        }
      } else {
        // Legacy (H0) path, byte-identical: sequential writes, and on failure
        // the catch below records 'churn' and CONTINUES like H0 did.
        await db('customers').where({ id: customerId }).update(update);
        await disarmPaymentRails(db);
      }

      churned = true;
    }
  } catch (err) {
    errors.push('churn');
    logger.error(`[cancellation-processor] failed to churn customer ${customerId}: ${err.message}`);
    if (gateEnvValue('GATE_CANCEL_FLOW_V2')) {
      // ABORT (gated path only): the wind-down is a single transaction, so a
      // throw means NOTHING persisted and the account is still active and
      // chargeable. Continuing into the recurrence stop and visit sweep
      // would cancel SERVICE on a live billing account — the exact inversion
      // this processor exists to prevent. Return partial (ok=false): the
      // request row + admin review alert carry it, and both retry paths
      // (60s dedupe, inactive-account) re-run this processor idempotently.
      // The legacy path deliberately keeps H0's continue-and-flag behavior —
      // its writes are sequential, so "nothing persisted" cannot be assumed.
      return { cancelledCount: 0, recurrenceStopped: 0, churned: false, ok: false, errors };
    }
  }

  // 2. Stop any recurring series BEFORE reading the visit list, so a
  // concurrent completion that would auto-extend the series sees
  // recurring_ongoing=false instead of minting a fresh occurrence behind the
  // sweep's back. (The straggler re-sweep below covers an extension already
  // in flight past its flag read.)
  // Rented termite bait stations are Waves property and come out of the
  // ground when the program ends (signed agreement text, migration
  // 20260729000001) — but nothing scheduled that retrieval until H0
  // (2026-08-30). Raise an office task, deduped per request so retries never
  // double-bell. Failure is recorded in `errors` and never blocks the churn.
  // Only once the churn actually persisted: a failed customer update leaves
  // the account active and billable, and staff must never be told to pull
  // hardware from a live program.
  if (churned) {
    try {
      await raiseTermiteRetrievalTask(customerId, requestId);
    } catch (err) {
      errors.push('termite_retrieval_task');
      logger.error(`[cancellation-processor] termite station retrieval task failed for ${customerId}: ${err.message}`);
    }
  }

  let recurrenceStopped = 0;
  try {
    recurrenceStopped = await db('scheduled_services')
      .where({ customer_id: customerId, recurring_ongoing: true })
      .update({ recurring_ongoing: false, updated_at: new Date() });
  } catch (err) {
    errors.push('stop_recurrence');
    logger.error(`[cancellation-processor] failed to stop recurrence for ${customerId}: ${err.message}`);
  }

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

  // Visits a PRIOR attempt of this same request already flipped to cancelled:
  // the sweep only selects still-live statuses, so without this a retry (the
  // route re-runs the processor on a deduped resubmit) would skip a visit
  // whose status flip committed but whose side effects (invoice void, card
  // hold, reminders, track layer) failed — leaving them broken forever. The
  // flip stamps the request-scoped reason into job_status_history.notes, which
  // identifies exactly the visits this request cancelled; re-confirm each is
  // STILL cancelled so a visit an admin has since revived is left alone.
  // Repairs are only meaningful with a caller-scoped reason: the shared
  // CHURN_REASON fallback would match every reason-less cancellation's note
  // across requests, resurrecting unrelated work.
  let repairs = [];
  if (reason) {
    try {
      const history = await db('job_status_history')
        .where({ to_status: 'cancelled', notes: cancelReason })
        .select('job_id');
      const priorIds = [...new Set(history.map((h) => h.job_id))];
      if (priorIds.length) {
        repairs = await db('scheduled_services')
          .whereIn('id', priorIds)
          // Hard customer scope: job_status_history carries no customer_id,
          // and a duplicated note string must never let this request re-run
          // side effects against ANOTHER customer's cancelled visit.
          .where({ status: 'cancelled', customer_id: customerId })
          .select('id', 'status');
      }
    } catch (err) {
      errors.push('load_prior_cancelled');
      logger.error(`[cancellation-processor] failed to load prior-cancelled visits for ${customerId}: ${err.message}`);
    }
  }

  // 3. Cancel the customer's upcoming cancellable visits.
  let cancelledCount = 0;
  const processed = new Set();

  function sweepCancellable() {
    return db('scheduled_services')
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
  }

  async function processVisit(svc) {
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
          // Caller-owned: this processor suppresses per-visit notices via
          // its OWN awaited handleCancellation AFTER its went-live
          // compensation check — a fire-and-forget hook claim here could
          // land after a compensating revert and close the reminder row of
          // a re-armed active visit (codex r3).
          notifyCustomer: 'caller_suppress',
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
          return;
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
          return;
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
      // Appointment-card fee rail fallback for visits with no hold row
      // (mutually exclusive lanes — the rail re-checks). Customer-initiated
      // cancel: no waive. Same review-reason surfacing.
      if (holdResult?.reason === 'no_hold') {
        const ApptCardRequests = require('./appointment-card-request');
        const apptResult = await ApptCardRequests.handleAppointmentCardCancellation({ scheduledServiceId: svc.id });
        if (apptResult && CARD_HOLD_REVIEW_REASONS.has(apptResult.reason)) {
          errors.push(`appt_card_fee:${svc.id}`);
          logger.error(`[cancellation-processor] appointment-card fee for ${svc.id} needs review: ${apptResult.reason}`);
        }
      }
    } catch (err) {
      errors.push(`card_hold:${svc.id}`);
      logger.error(`[cancellation-processor] card-hold handling failed for ${svc.id}: ${err.message}`);
    }

    // Legacy rows predate the track layer (track_state NULL): normalize to
    // 'scheduled' first so trackTransitions.cancel's guarded update matches
    // and stamps cancelled_at / cancellation_reason — the helper reports ok
    // on its 0-row fallback, which would otherwise count this visit as fully
    // cancelled with the tracker fields never set.
    try {
      await db('scheduled_services')
        .where({ id: svc.id })
        .whereNull('track_state')
        .update({ track_state: 'scheduled' });
    } catch (err) {
      logger.warn(`[cancellation-processor] track-state normalize failed for ${svc.id}: ${err.message}`);
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

  // Pass 0 processes the sweep plus the prior-attempt repairs; pass 1 re-sweeps
  // ONCE for stragglers — recurrence is already off, but a completion that read
  // recurring_ongoing=true before our flip can still insert one final
  // occurrence while we're cancelling. At most one generation can appear, so a
  // single re-sweep bounds it.
  for (let pass = 0; pass < 2; pass += 1) {
    let rows = [];
    try {
      rows = await sweepCancellable();
    } catch (err) {
      errors.push('load_visits');
      logger.error(`[cancellation-processor] failed to load visits for ${customerId}: ${err.message}`);
      break;
    }
    const batch = rows
      .filter((r) => !processed.has(r.id))
      .map((s) => ({ ...s, alreadyCancelled: false }));
    if (pass === 0) {
      batch.push(...repairs
        .filter((r) => !processed.has(r.id))
        .map((s) => ({ ...s, alreadyCancelled: true })));
    }
    if (!batch.length) break;
    for (const svc of batch) {
      processed.add(svc.id);
      await processVisit(svc);
    }
  }

  // Audit trail on the customer timeline — only the first time we churn, and
  // written AFTER the sweep so the note carries the final visit count.
  if (churned && !wasChurnedStage) {
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

  // AI churn-reason classification — deliberately the LAST step so a slow or
  // broken model can never delay the billing wind-down or the visit sweep,
  // and deliberately OUTSIDE `errors` — a classification miss leaves the row
  // at 'unclassified' (fail-closed), it is not an operational failure that
  // should flag the request for manual review.
  if (churned && !wasChurnedStage) {
    try {
      const { classifyChurnReason } = require('./churn-classifier');
      const { code } = await classifyChurnReason(cancelReason);
      if (code && code !== 'unclassified') {
        await db('customers').where({ id: customerId }).update({ churn_reason_code: code });
      }
    } catch (err) {
      logger.warn(`[cancellation-processor] churn classification failed for ${customerId} (left unclassified): ${err.message}`);
    }
  }

  const ok = errors.length === 0;
  logger.info(
    `[cancellation-processor] customer ${customerId}: cancelled ${cancelledCount} visit(s), ` +
      `recurrence stopped on ${recurrenceStopped} row(s), churned=${churned}, ok=${ok}` +
      (ok ? '' : ` (errors: ${errors.join(', ')})`)
  );

  return { cancelledCount, recurrenceStopped, churned, ok, errors };
}

module.exports = { processCancellationRequest, raiseTermiteRetrievalTask, CHURN_REASON, CANCELLABLE_STATUSES };
