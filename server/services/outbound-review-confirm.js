/**
 * Office-confirmation side effects for a pending outbound-callback review
 * booking (source_action = CALL_OUTBOUND_REVIEW_SOURCE_ACTION).
 *
 * The AI call pipeline creates these rows PENDING and intentionally defers
 * everything that treats the appointment as live: reminder registration (the
 * reminder cron doesn't skip 'pending', so arming at booking would text the
 * customer before review), lead conversion (a phantom closed sale that
 * reverts if staff reject), and the outbound_booking_review triage card.
 * Confirming the row is what makes it real — so EVERY route that can flip
 * such a row to 'confirmed' (admin-schedule bare status route, admin-dispatch
 * status route) must run this hook after its commit, or the row ends up
 * confirmed-but-half-armed: no reminders, an open lead, a lingering card.
 *
 * All legs are best-effort (log + continue) — the confirm itself already
 * committed; a failed side effect must not un-confirm the visit.
 */

const logger = require('./logger');
const db = require('../models/db');

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value).split('T')[0];
}

// Statuses that mirror the call pipeline's TERMINAL_LEAD_STATUSES — a lead in
// one of these is not "active" for the fallback lookup below.
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate'];

/**
 * Run the confirm side effects for `svc` (a scheduled_services row already
 * flipped to 'confirmed' by the calling route). Caller is responsible for
 * checking source_action === CALL_OUTBOUND_REVIEW_SOURCE_ACTION.
 *
 * @param {object} db   knex instance
 * @param {object} svc  the scheduled_services row (needs id, customer_id,
 *                      scheduled_date, window_start, service_type,
 *                      source_call_log_id)
 * @param {string} [routeTag] label for log lines ('admin-schedule' / 'admin-dispatch')
 * @param {object} [opts]
 * @param {boolean} [opts.skipCardRequest] Owner decision 2026-08-11 (PR
 *   #3356): a FIELD-confirmed booking (tech-track dispatch-implies-confirm)
 *   skips the card-on-file leg entirely — the tech is already driving to
 *   meet the customer and collects a card in person, and the funnel's
 *   pending/confirmed eligibility window doesn't survive the immediate
 *   advance to en_route/on_site. Office-confirmed bookings keep the full
 *   funnel.
 * @param {boolean} [opts.suppressCardAskWithoutClearance] lazy-activation
 *   callers set this: a silent move/replay is not a customer trust point,
 *   so without durable call-level SMS clearance (call_sms_cleared_at) the
 *   card leg runs the funnel in its non-messaging mode (Codex #3361 r4
 *   P1). Office-confirm callers omit it and keep the Codex #2771 r2
 *   contract — the office just re-confirmed with the customer, and the
 *   funnel's canonical send still enforces stored consent + suppression.
 */
async function runOutboundReviewConfirmHook(db, svc, routeTag = 'outbound-review', opts = {}) {
  // Reported to callers that use the stamp-on-success activation pattern
  // (activateLegacyOutboundReviewRowIfNeeded): true only when every CORE
  // leg (reminders, lead conversion, triage resolve) ran without error.
  // The credit-evidence and card-request legs stay warn-only — each has
  // its own durable recovery (the hourly sweep; the pre-visit card
  // backstop). Existing callers that ignore the return value are
  // unaffected.
  let coreLegsOk = true;
  // 1. Arm the 72h/24h reminders that were deferred at booking time.
  // Idempotent (registerAppointment dedupes by scheduled_service_id);
  // sendConfirmation:false = arm reminders only, the office owns any
  // confirmation message.
  try {
    const AppointmentReminders = require('./appointment-reminders');
    // Register against the CURRENT slot, not the caller's snapshot: a
    // sweep-held row snapshot can predate a concurrent reschedule, and
    // registerAppointment's existing-row dedupe would keep the stale
    // appointment_time (Codex #3361 r10 P2). Fresh read here; any move
    // that lands after it is corrected by that move's own
    // handleReschedule reminder resync, which now finds the row this
    // registration creates.
    let slotDate = svc.scheduled_date;
    let slotStart = svc.window_start;
    try {
      const freshSlot = await db('scheduled_services')
        .where({ id: svc.id })
        .first('scheduled_date', 'window_start');
      if (freshSlot) {
        slotDate = freshSlot.scheduled_date;
        slotStart = freshSlot.window_start;
      }
    } catch { /* fall back to the caller's snapshot */ }
    // registerAppointment is fail-soft: it catches internally and returns
    // NULL on failure (every success path — including the already-
    // registered dedupe — returns the record). The catch below alone would
    // never see a swallowed transient error, silently stamping a row whose
    // reminders never armed (Codex #3361 r6 P1).
    const reminderRecord = await AppointmentReminders.registerAppointment(
      svc.id,
      svc.customer_id,
      `${dateOnly(slotDate)}T${slotStart || '09:00'}`,
      svc.service_type,
      'admin_manual',
      {
        sendConfirmation: false,
        // A windowless visit (the office cleared its arrival time)
        // registers the pre-closed placeholder, never an ARMED reminder at
        // the fabricated 09:00 fallback — the cron would otherwise text a
        // time nobody chose (Codex #3361 r17 P1).
        closeReminderWindows: !slotStart,
      },
    );
    if (!reminderRecord) {
      coreLegsOk = false;
      logger.error(`[${routeTag}] outbound-review reminder arm returned null (swallowed failure) for ${svc.id}`);
    } else {
      logger.info(`[${routeTag}] Armed reminders for confirmed outbound-review booking ${svc.id}`);
      // Post-registration slot verify (Codex #3361 r11 P2): a reschedule
      // committing between the fresh read above and the insert can have
      // run its own handleReschedule resync BEFORE the reminder row
      // existed. One more read AFTER registration closes the ordering
      // both ways — a move committed before this read is resynced here;
      // a move committed after it finds the now-existing row and
      // resyncs itself. A detected move whose resync fails marks the
      // leg failed so the sweep retries (registration dedupes; the
      // retry re-runs this verify).
      try {
        const postSlot = await db('scheduled_services')
          .where({ id: svc.id })
          .first('scheduled_date', 'window_start');
        if (postSlot && !postSlot.window_start && slotStart) {
          // The verified slot went WINDOWLESS (a concurrent edit cleared
          // the arrival time after our registration armed a start): never
          // resync to the fabricated 09:00 fallback — close both reminder
          // windows on the armed row so the cron cannot text a time nobody
          // chose (Codex #3361 r18 P2). Deliberately NOT hand-writing the
          // windows_preclosed placeholder flags: they carry trigger-managed
          // sibling invariants; closed sent-flags achieve the same silence,
          // and a later edit that sets a real window re-arms them through
          // its own handleReschedule resync (start moved → flags
          // recompute).
          const closedWindows = await db('appointment_reminders')
            .where({ scheduled_service_id: svc.id, cancelled: false })
            // Atomic windowless guard (Codex #3361 r19 P2, same shape as
            // handleReschedule's expectSchedule): a THIRD move assigning a
            // real window between the postSlot read and this write makes
            // the close miss instead of silencing the re-armed reminders —
            // that move's own resync owns the row's state.
            .whereRaw('EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.window_start IS NULL)')
            .update({
              reminder_72h_sent: true,
              reminder_72h_sent_at: new Date(),
              reminder_24h_sent: true,
              reminder_24h_sent_at: new Date(),
              updated_at: new Date(),
            });
          if (!closedWindows) {
            // Guard miss = a real window arrived and its own sync owns the
            // reminder state now — success, not a retryable failure.
            logger.info(`[${routeTag}] windowless close skipped for ${svc.id} — the service regained a window; its own resync owns the state`);
          } else {
            logger.info(`[${routeTag}] reminder windows closed after concurrent windowless move for ${svc.id}`);
          }
        } else if (postSlot && (dateOnly(postSlot.scheduled_date) !== dateOnly(slotDate)
          || String(postSlot.window_start || '') !== String(slotStart || ''))) {
          // expectSchedule = the observed slot, enforced atomically inside
          // handleReschedule: a SECOND move (B) landing after the postSlot
          // read makes this stale resync miss instead of stomping B's own
          // sync back to A (Codex #3361 r12 P2). handleReschedule is
          // fail-soft (null on no-row/invalid-time/error) — a null here is
          // an unsynced slot, so the leg fails and the sweep retries
          // (Codex #3361 r12 P2).
          const resynced = await AppointmentReminders.handleReschedule(
            svc.id,
            `${dateOnly(postSlot.scheduled_date)}T${postSlot.window_start || '09:00'}`,
            {
              sendNotification: false,
              expectSchedule: {
                date: dateOnly(postSlot.scheduled_date),
                windowStart: postSlot.window_start || null,
              },
            },
          );
          if (resynced === null) {
            coreLegsOk = false;
            logger.warn(`[${routeTag}] reminder slot resync returned null for ${svc.id} — leaving retryable`);
          } else {
            logger.info(`[${routeTag}] reminder slot resynced after concurrent move for ${svc.id}`);
          }
        }
      } catch (postSyncErr) {
        coreLegsOk = false;
        logger.warn(`[${routeTag}] post-registration slot verify failed for ${svc.id} — leaving retryable: ${postSyncErr.message}`);
      }
    }
  } catch (e) { coreLegsOk = false; logger.error(`[${routeTag}] outbound-review reminder arm failed for ${svc.id}: ${e.message}`); }

  // 1a. Inspection-credit booking evidence — written HERE, not at the AI
  // booking insert (pre-push P0): a pending outbound-review row is not a
  // closed deal until this office confirmation, and the hourly sweep would
  // otherwise treat the event plus the live 'pending' status as proof and
  // mint $75 for an appointment the customer never confirmed. Idempotent
  // (unique per booking); never blocks the confirmation.
  try {
    // On a retry, reuse the instant the failed earlier write froze so the
    // retry cannot shift the offer-boundary ordering (Codex #3361 r16 P1).
    // The immediate job-status activation passes it in opts; the CRASH
    // path — process exit before that activation, recovered by the hourly
    // sweep — must recover it from the durable evidence outbox instead,
    // or this insert's first-write-wins would beat the outbox replay with
    // a fresh, later timestamp (Codex #3361 r17 P1). Null = call time,
    // the ordinary confirm contract.
    let evidenceMoment = opts.evidenceBookedAt || null;
    if (!evidenceMoment) {
      try {
        const outboxRow = await db('notifications')
          .where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'reason' = 'booking_evidence_outbox'")
          .whereRaw("metadata->>'scheduledServiceId' = ?", [String(svc.id)])
          .orderBy('created_at', 'asc')
          .first(db.raw("metadata->>'bookedAt' as booked_at"));
        if (outboxRow && outboxRow.booked_at) evidenceMoment = new Date(outboxRow.booked_at);
      } catch { /* no outbox readable — fall through to call time */ }
    }
    const marked = await require('./inspection-credit').markBookingForInspectionCredit(db, {
      customerId: svc.customer_id,
      scheduledServiceId: svc.id,
      source: 'phone_call',
      bookedAt: evidenceMoment,
    });
    // Fast redemption too, mirroring the admin-schedule/self-book paths
    // (Codex #3178 r26 P2): confirmation is the booking moment, and a
    // Charge Now / pay link sent before the hourly sweep would otherwise
    // collect the full amount while the credit strands afterwards.
    // GATED on the evidence write landing (Codex #3178 r27 P2): this row
    // was inserted when the AI opened the pending review, so without an
    // event the redeemer would fall back to that PLACEHOLDER created_at —
    // for a row opened inside the window but confirmed after expiry, that
    // mints a credit this booking did not earn. A marker call that did not
    // throw means the event EXISTS now (1 = inserted here, 0 = already
    // present — e.g. the completion transition committed it in-trx, Codex
    // #3361 r13 P1), and redeeming from an existing event uses the true
    // moment, so both fire the fast redemption; only a THROWN write (no
    // event) defers to the post-commit retry + hourly sweep.
    // Best-effort — the sweep remains the durable guarantee.
    if (marked === 1 || marked === 0) {
      await require('./inspection-credit').redeemInspectionCreditForBooking({
        customerId: svc.customer_id,
        scheduledServiceId: svc.id,
        createdBy: 'system:inspection_credit_outbound_confirm',
      });
    }
  } catch (e) { logger.warn(`[${routeTag}] inspection-credit booking evidence failed for ${svc.id}: ${e.message}`); }

  // 2. Close the originating call lead. The insert path deliberately skipped
  // conversion for the pending review row; it stashed the lead's id on the
  // outbound_booking_review triage card, because the booking can REUSE an
  // existing unclaimed phone lead that never gets customer_id stamped — a
  // customer_id search would miss it (or close an unrelated lead). Fall back
  // to the single-active-lead heuristic only for pre-payload rows.
  // convertCallLeadOnPhoneBooking is ownership-guarded (unclaimed or
  // same-customer only), so a stale carried id can never reassign another
  // customer's lead.
  // A covered re-service confirmed from outbound review is still a $0
  // callback, not a closed sale (codex #3231): the WON conversion is
  // suppressed for callback rows — but ONLY the won branch. A call that
  // ALSO promised a quote stored keep_open_for_quote on the review card,
  // and convertCallLeadOnPhoneBooking's quote branch claims/reopens the
  // lead and records the booked appointment WITHOUT marking it won — that
  // must still run or the owed quote silently disappears (codex r5). Row
  // identity (is_callback stamp or the re-service label) is the authority.
  const { isReService } = require('./re-service');
  // Priced callbacks (operator-added billable extra) are PAID sales and
  // convert normally (codex #3231 r7) — only an actually-free callback
  // suppresses the won branch.
  const svcIsCallback = (svc.is_callback === true || isReService({ serviceType: svc.service_type }))
    && !(Number(svc.estimated_price) > 0);
  try {
    const CallProc = require('./call-recording-processor');
    let leadId = null;
    let keepOpenForQuote = false;
    if (svc.source_call_log_id) {
      const card = await db('triage_items')
        .where({ call_log_id: svc.source_call_log_id, reason_code: 'outbound_booking_review' })
        .orderBy('created_at', 'desc')
        .first('payload');
      const payload = typeof card?.payload === 'string'
        ? JSON.parse(card.payload)
        : (card?.payload || null);
      if (payload?.lead_id) {
        leadId = payload.lead_id;
        keepOpenForQuote = payload.keep_open_for_quote === true;
      }
    }
    if (leadId) {
      // Preserve a promised-quote follow-up: beyond the booking-time flag, a
      // lead that has since moved mid-estimate must also stay OPEN so the
      // booking doesn't hide an owed quote.
      const lead = await db('leads').where({ id: leadId }).first('status');
      keepOpenForQuote = keepOpenForQuote || /estimate|quote/i.test(String(lead?.status || ''));
    } else {
      // Pre-payload fallback: only when EXACTLY ONE active lead maps to this
      // customer (avoids converting the wrong lead when ambiguous).
      const activeLeads = await db('leads')
        .where({ customer_id: svc.customer_id })
        .whereNotIn('status', TERMINAL_LEAD_STATUSES)
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(2)
        .select('id', 'status');
      if (activeLeads.length === 1) {
        leadId = activeLeads[0].id;
        keepOpenForQuote = /estimate|quote/i.test(String(activeLeads[0].status || ''));
      }
    }
    if (leadId && svcIsCallback && !keepOpenForQuote) {
      logger.info(`[${routeTag}] Skipping won-conversion for confirmed re-service callback ${svc.id} ($0 callback, not a sale; no quote owed)`);
    } else if (leadId) {
      // convertCallLeadOnPhoneBooking is fail-soft too: NULL = transient
      // failure (retry-worthy), FALSE = a deliberate no-op (quote kept
      // open, lead already won/unowned, lost race) that must NOT block
      // the activation stamp (Codex #3361 r6 P1).
      const converted = await CallProc.convertCallLeadOnPhoneBooking(db, {
        leadId,
        customerId: svc.customer_id,
        scheduledServiceId: svc.id,
        callSid: null,
        keepOpenForQuote,
      });
      if (converted === null) {
        coreLegsOk = false;
        logger.error(`[${routeTag}] outbound-review lead conversion returned null (swallowed failure) for ${svc.id}`);
      } else {
        logger.info(`[${routeTag}] Lead ${leadId} conversion ran (converted=${converted}, keepOpenForQuote=${keepOpenForQuote}) for confirmed outbound-review booking ${svc.id}`);
      }
    }
  } catch (e) { coreLegsOk = false; logger.error(`[${routeTag}] outbound-review lead conversion failed for ${svc.id}: ${e.message}`); }

  // 3. Resolve the outbound_booking_review Needs-Review card — otherwise it
  // lingers in the queue as already-handled.
  try {
    if (svc.source_call_log_id) {
      // Shared per-call lock contract (utils/triage-locks.js) with the other
      // triage writers — serialize before the card update so an overlapping
      // sweep/verdict can't deadlock or interleave the aggregate.
      const { lockTriageCall } = require('../utils/triage-locks');
      await db.transaction(async (trx) => {
        await lockTriageCall(trx, svc.source_call_log_id);
        await trx('triage_items')
          .where({ call_log_id: svc.source_call_log_id, reason_code: 'outbound_booking_review' })
          .whereIn('status', ['open', 'in_progress'])
          .update({ status: 'resolved', updated_at: trx.fn.now() });
      });
    }
  } catch (e) { coreLegsOk = false; logger.error(`[${routeTag}] outbound-review triage resolve failed for ${svc.id}: ${e.message}`); }

  // 4. Card-on-file request (Codex #2771 r2): the AI booking path skips
  // the card funnel for pending outbound-review rows, and without this the
  // confirmed visit would never get one. The office just re-confirmed the
  // appointment with the customer (same trust point that arms reminders),
  // and the funnel's canonical send path still enforces stored SMS
  // consent + suppression. Idempotent; dark until APPOINTMENT_CARD_REQUEST
  // + the template flip. Field-confirmed bookings opt out entirely — see
  // the skipCardRequest JSDoc above (PR #3356); lazy-activation callers
  // run it clearance-gated instead (suppressCardAskWithoutClearance).
  if (opts.skipCardRequest) {
    logger.info(`[${routeTag}] Skipping card-on-file request for field-confirmed booking ${svc.id} (tech collects in person)`);
  } else {
    try {
      const { requestCardForAppointment } = require('./appointment-card-request');
      let cardCallOpts = {};
      if (opts.suppressCardAskWithoutClearance) {
        // Only a durable call-level clearance stamp lets the lazy path send;
        // otherwise non-messaging mode (auto-secure still runs, the
        // pre-visit sweep owns any later ask). Fail closed on a read error.
        const clearance = await db('scheduled_services')
          .where({ id: svc.id })
          .first('call_sms_cleared_at', 'call_sms_cleared_recipient')
          .catch(() => null);
        cardCallOpts = clearance && clearance.call_sms_cleared_at
          ? { recipientPhone: clearance.call_sms_cleared_recipient || null }
          : { delivery: 'none' };
      }
      await requestCardForAppointment({ scheduledServiceId: svc.id, trigger: 'outbound_review_confirm', ...cardCallOpts });
    } catch (e) { logger.warn(`[${routeTag}] card-request funnel failed for ${svc.id}: ${e.message}`); }
  }

  return coreLegsOk;
}

/**
 * Lazy activation for a LEGACY outbound-review row (created pending before
 * the 2026-08-11 review-hold removal, PR #3361) touched by a writer that
 * does NOT go through transitionJobStatus — the direct reschedule writers
 * (SmartRebooker, admin-schedule update-details, the bulk paths) and the
 * shared reschedule-notice sender. The hook runs BEFORE the stamp and the
 * stamp lands only when every core leg succeeded — so a transient leg
 * failure leaves the row unstamped and the next touch retries (hook legs
 * are idempotent, so retries and concurrent double-runs are safe); the
 * conditional UPDATE keeps the stamp itself at-most-once. No-op for every
 * other row — one indexed read. Best-effort by contract: the caller's
 * move/notice must never fail on an activation hiccup.
 *
 * @returns {Promise<boolean>} true when THIS call performed the activation
 */
async function activateLegacyOutboundReviewRowIfNeeded(db, serviceId, routeTag = 'legacy-activation', opts = {}) {
  try {
    const { CALL_OUTBOUND_REVIEW_SOURCE_ACTION } = require('./call-booking-source-actions');
    const row = await db('scheduled_services')
      .where({ id: serviceId })
      .first('id', 'source_action', 'status', 'customer_confirmed', 'customer_id',
        'scheduled_date', 'window_start', 'service_type', 'source_call_log_id',
        'is_callback', 'estimated_price');
    if (!row || row.source_action !== CALL_OUTBOUND_REVIEW_SOURCE_ACTION || row.customer_confirmed) {
      return false;
    }
    // Rejected rows are not activated — a cancelled/skipped legacy review
    // booking was the office declining it. Completed/no_show rows DO
    // activate: transitionJobStatus defers its own activation to this
    // helper post-commit, so by the time it runs the row already carries
    // the terminal status — and the lead conversion / card resolution /
    // credit evidence are exactly what a worked visit still owes.
    if (['cancelled', 'skipped'].includes(String(row.status || ''))) {
      return false;
    }
    // Fresh rejection re-check immediately before the side effects: the
    // first read above may be arbitrarily stale by the time a sweep batch
    // reaches this row, and a just-committed cancel/skip must win
    // (Codex #3361 r8 P1). A cancel landing INSIDE the hook window is
    // handled below by the status-guarded stamp plus the cancellation
    // paths' own compensating seams (invoice void + credit reversal run
    // on every cancel/skip transition; a lead converted moments before a
    // cancel matches ordinary book-then-cancel semantics).
    const fresh = await db('scheduled_services')
      .where({ id: serviceId })
      .first('status', 'customer_confirmed');
    if (!fresh || fresh.customer_confirmed
      || ['cancelled', 'skipped'].includes(String(fresh.status || ''))) {
      return false;
    }
    // Hook FIRST, stamp on success: the customer_confirmed stamp is the
    // completion marker, so stamping before the hook would make a
    // transiently-failed leg unretryable forever (Codex #3361 r3 P1).
    // Every hook leg is idempotent (registration dedupes, lead conversion
    // is ownership-guarded, the card resolve no-ops), so both a retry
    // after partial completion and a concurrent double-run are safe; the
    // guarded UPDATE below still keeps the stamp itself at-most-once.
    const coreLegsOk = await runOutboundReviewConfirmHook(db, row, routeTag, {
      suppressCardAskWithoutClearance: true,
      // The completion instant a failed in-trx evidence write froze — the
      // belt marker retry must carry it, not a fresh now() (Codex #3361
      // r16 P1).
      evidenceBookedAt: opts.evidenceBookedAt || null,
    });
    if (!coreLegsOk) {
      logger.warn(`[${routeTag}] legacy outbound activation for ${serviceId}: a core hook leg failed — leaving unstamped so the next touch retries`);
      return false;
    }
    const stamped = await db('scheduled_services')
      .where({ id: serviceId, customer_confirmed: false })
      // A rejection that committed during the hook window wins: never
      // stamp a cancelled/skipped row confirmed (Codex #3361 r8 P1).
      .whereNotIn('status', ['cancelled', 'skipped'])
      .update({ customer_confirmed: true, confirmed_at: new Date() });
    return stamped > 0;
  } catch (e) {
    logger.warn(`[${routeTag}] legacy outbound activation failed for ${serviceId}: ${e.message}`);
    return false;
  }
}

/**
 * Hourly backstop that drains the ENTIRE legacy outbound-review population
 * (Codex #3361 r5/r7 P1): the per-path lazy activations
 * (transitionJobStatus, the reschedule writers, the call-pipeline reuse
 * paths) are fast paths, not the guarantee — a process exit or transient
 * core-leg failure after any of them leaves the row unstamped, and a moved
 * row can still carry status 'pending', so a status-scoped sweep could not
 * retry it. Every un-confirmed outbound-review row except the cancel/skip
 * rejections therefore activates here — including untouched pending rows:
 * the review hold was removed collectively (owner directive 2026-08-11),
 * new outbound bookings land live at insert, and a legacy pending row is a
 * REAL booking the old pipeline was holding, so parity activates it too
 * (reminders armed, lead converted, review card resolved; the card-ask leg
 * stays clearance-gated). Idempotent (the helper's guarded stamp), bounded
 * per run, and self-terminating: the legacy population only shrinks, so
 * runs become free no-ops once it drains.
 */
async function sweepStrandedLegacyOutboundActivations(dbh = db, { limit = 25 } = {}) {
  const { CALL_OUTBOUND_REVIEW_SOURCE_ACTION } = require('./call-booking-source-actions');
  const rows = await dbh('scheduled_services')
    .where({ source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION, customer_confirmed: false })
    .whereNotIn('status', ['cancelled', 'skipped'])
    // Random order (Codex #3361 r15 P2): with more rows than the batch cap,
    // an unordered LIMIT could hand a batch of permanently-unactivatable
    // rows (bad slot data, malformed payloads) to every run and starve the
    // valid tail forever. Random sampling guarantees every eligible row
    // keeps getting drawn; poisoned rows just fail their leg and stay
    // unstamped without monopolizing the batch.
    .orderBy(dbh.raw('random()'))
    .limit(limit)
    .select('id');
  let activated = 0;
  for (const row of rows) {
    if (await activateLegacyOutboundReviewRowIfNeeded(dbh, row.id, 'legacy-activation-sweep')) {
      activated += 1;
    }
  }
  if (rows.length) {
    logger.info(`[legacy-activation-sweep] activated ${activated}/${rows.length} stranded legacy outbound-review rows`);
  }
  return { candidates: rows.length, activated };
}

module.exports = {
  runOutboundReviewConfirmHook,
  activateLegacyOutboundReviewRowIfNeeded,
  sweepStrandedLegacyOutboundActivations,
};
