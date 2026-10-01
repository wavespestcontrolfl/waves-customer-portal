/**
 * Office-confirmation side effects for a pending office-review booking
 * (source_action ∈ OFFICE_REVIEW_PENDING_SOURCE_ACTIONS — the outbound-
 * callback review booking, and the voice-agent booking that reuses the same
 * lifecycle rather than inventing a parallel pending state).
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
const { findStreetLevelHoldCard, isStreetLevelHoldVisit, approvedAddressStillCurrent, reopenHoldCardForRestoredVisit } = require('./street-level-hold');
const db = require('../models/db');
const { parseETDateTime } = require('../utils/datetime-et');

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
 * checking source_action ∈ OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.
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
  // ⭐ 0a. THE ROW'S CURRENT STATUS, NOT THE CALLER'S SNAPSHOT. `svc` was read
  // when the confirmation committed — on the sweep path that can be an hour
  // ago — and a cancellation that landed since must stand: activating a
  // cancelled visit arms reminders that TEXT the customer about a visit nobody
  // is making. The terminal-status guard on the stamp (below, and in both
  // legacy stampers) only stopped the RECEIPT; the legs had already run. So
  // the legs themselves stand down on a terminal row — not a failure, the
  // call's own answer: nothing stamps, and the sweep excludes cancel/skip
  // rejections, so there is no retry churn.
  try {
    const fresh = await db('scheduled_services').where({ id: svc.id }).first('status', 'field_confirmed_at');
    if (!fresh || ['cancelled', 'skipped', 'rescheduled'].includes(String(fresh.status))) {
      logger.info(`[${routeTag}] activation stood down for ${svc.id} — row is ${fresh ? fresh.status : 'gone'}`);
      return false;
    }
    // ⭐ THE FIELD-CONFIRM MODE IS RE-APPLIED ON EVERY RAIL. A field-confirmed
    // row whose first activation failed reaches the sweep WITHOUT the calling
    // route's in-memory skipCardRequest — the durable stamp is what makes the
    // retry honour the owner rule (tech collects the card in person; no
    // funnel, no clearance stamp).
    if (fresh.field_confirmed_at && !opts.skipCardRequest) {
      opts = { ...opts, skipCardRequest: true, suppressCardAskWithoutClearance: false };
      logger.info(`[${routeTag}] ${svc.id} is field-confirmed (durable stamp) — card funnel skipped on this rail`);
    }
  } catch (freshErr) {
    // Unknown is not safe: refusing to activate leaves the row unstamped,
    // which is exactly the retry rail.
    logger.error(`[${routeTag}] could not read current status for ${svc.id} — reporting retryable: ${freshErr.message}`);
    return false;
  }
  // 0. Office-confirm clearance stamp — FIRST, before every best-effort leg
  // (Codex #3361 r28 P1): the calling route already committed the
  // confirmation, so a process exit inside any leg below leaves the row
  // customer_confirmed with no retry rail (the legacy sweep skips stamped
  // rows) — an unstamped clearance would then lock the card invitation out
  // of the pre-visit sweep forever. The office confirmation IS the
  // call-level clearance decision (the human just re-confirmed with the
  // customer), and the sweep no longer accepts status='confirmed' as that
  // evidence because lazy activation of a silently-rescheduled legacy row
  // lands on the same status (r27 P1). Guarded whereNull — never overwrites
  // a processor stamp; recipient stays with the funnel's normal resolution.
  // Lazy-activation callers (suppressCardAskWithoutClearance) only READ the
  // stamp, and field confirms (skipCardRequest) deliberately don't stamp:
  // the tech collects in person, and the sweep must not text later.
  if (!opts.suppressCardAskWithoutClearance && !opts.skipCardRequest) {
    try {
      await db('scheduled_services')
        .where({ id: svc.id })
        .whereNull('call_sms_cleared_at')
        .update({ call_sms_cleared_at: new Date() });
    } catch (stampErr) {
      // ⭐ AND A FAILED CLEARANCE STAMP IS A FAILED CORE LEG. This stamp is what
      // the pre-visit card sweep keys on, so a row that is stamped
      // customer_confirmed WITHOUT it falls between both rails: the legacy
      // activation sweep skips it (already confirmed) and the pre-visit sweep
      // excludes it (no clearance). Reporting failure here keeps
      // customer_confirmed unstamped, which is exactly the retry rail.
      coreLegsOk = false;
      logger.error(`[${routeTag}] office-confirm clearance stamp failed for ${svc.id} — reporting retryable: ${stampErr.message}`);
    }
  }
  // 1. Ensure the 72h/24h reminder row exists and matches the confirmed
  // slot. Since the 2026-08-17 owner ruling the self-heal sweep usually
  // arms it FIRST (within 15 min of booking) — this leg is now the
  // idempotent backstop (registerAppointment dedupes by
  // scheduled_service_id) rather than the sole arming point;
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
      // Post-registration slot verify — shared helper (see
      // verifyReminderSlotAfterRegistration below). A failed repair marks
      // the leg failed so the sweep retries (registration dedupes; the
      // retry re-runs this verify).
      const slotVerified = await verifyReminderSlotAfterRegistration(db, {
        serviceId: svc.id,
        slotDate,
        slotStart,
        routeTag,
      });
      if (!slotVerified) coreLegsOk = false;
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
    // A VOICE card with no lead_id is an ANSWER, not a gap — see below.
    let noLeadIdentifiedOnCall = false;
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
      } else if (payload && payload.origin === 'voice_agent') {
        // ⭐ …BUT FIRST, ASK THE CALL ITSELF. The lead id lands on this card by
        // a BACKFILL after capture_lead runs, and that backfill is best-effort:
        // one transient failure and a lead that really exists is invisible here
        // forever, because the branch below then treats the null as the call's
        // answer and permanently skips conversion. Leads stamp their own
        // `twilio_call_sid`, so the call can be asked directly — an EXACT
        // recovery keyed to this call, never the single-active-lead guess the
        // comment below rules out.
        // Exact linkage only: capture_lead stamps call_log.metadata.relay_lead_id
        // for THIS call. (leads.twilio_call_sid is set at INSERT only — a lead
        // reused by phone keeps its ORIGINAL call's sid, so a sid-keyed lookup
        // silently missed every reuse and could never be trusted here.)
        const callRow = await db('call_log')
          .where({ id: svc.source_call_log_id })
          .first('metadata');
        const callMeta = callRow && (typeof callRow.metadata === 'string'
          ? (() => { try { return JSON.parse(callRow.metadata); } catch { return {}; } })()
          : (callRow.metadata || {}));
        const linkedLeadId = callMeta && callMeta.relay_lead_id ? String(callMeta.relay_lead_id) : null;
        const recovered = linkedLeadId
          ? await db('leads')
            .where({ id: linkedLeadId })
            .whereNull('deleted_at')
            .first('id', 'status')
          : null;
        if (recovered) {
          leadId = recovered.id;
          logger.info(`[${routeTag}] voice card for ${svc.id} carried no lead_id — recovered lead ${leadId} via call_log.metadata.relay_lead_id`);
        }
        // ⭐ NO LEAD ON A VOICE CARD MEANS NO LEAD — DO NOT GUESS ONE.
        // The single-active-lead fallback below exists for PRE-PAYLOAD
        // outbound-review rows, where a missing lead_id only meant the card
        // predates the field. A voice card always carries the key, so a null
        // is the call's own answer: capture_lead either never ran or matched
        // an existing customer and created no lead. Falling back would mark
        // whatever unrelated quote that customer happens to have open as WON —
        // a booked ants visit closing an open termite estimate. (Only once the
        // CallSid recovery above has come up empty too: then there genuinely is
        // no lead from this call.)
        noLeadIdentifiedOnCall = !recovered;
      }
    }
    if (noLeadIdentifiedOnCall) {
      logger.info(`[${routeTag}] voice booking ${svc.id} identified no lead on the call — skipping the single-active-lead fallback`);
    }
    if (leadId) {
      // Preserve a promised-quote follow-up: beyond the booking-time flag, a
      // lead that has since moved mid-estimate must also stay OPEN so the
      // booking doesn't hide an owed quote.
      const lead = await db('leads').where({ id: leadId }).first('status');
      keepOpenForQuote = keepOpenForQuote || /estimate|quote/i.test(String(lead?.status || ''));
    } else if (!noLeadIdentifiedOnCall) {
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
        // The converter derives "is this an assessment" from the row itself
        // (an assessment is not a win — owner ruling 2026-09-08).
        booking: svc,
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
      const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
      await db.transaction(async (trx) => {
        await lockTriageCall(trx, svc.source_call_log_id);
        // Street-level address holds only (one lookup): every other pending office-review
        // booking resolves its card exactly as before.
        const hold = await findStreetLevelHoldCard(trx, { callLogId: svc.source_call_log_id, visitId: svc.id });
        const isHold = !!hold?.payload?.street_level_address;
        if (isHold) {
          await fileOwedFollowUpForStreetLevelHold(trx, svc, hold);
          await stampBookedDispositionForStreetLevelHold(trx, svc, hold);
        }
        await trx('triage_items')
          .where({ call_log_id: svc.source_call_log_id, reason_code: 'outbound_booking_review' })
          .whereIn('status', ['open', 'in_progress'])
          .update({ status: 'resolved', updated_at: trx.fn.now() });
        // The hold's call review state closes with its last open card (same aggregate
        // every card writer keeps, under the same per-call lock).
        if (isHold) await syncCallReviewStatus(trx, svc.source_call_log_id);
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

  // ⭐ 0a's MIRROR: a cancellation that landed DURING the legs. The entry check
  // closes the wide window (sweep-path minutes); this closes the narrow one.
  // The cancel path's own cleanup ran before the reminder existed and found
  // nothing to close, so the just-armed reminder is the one artifact that
  // would go on to TEXT the customer about a cancelled visit — close it here.
  // handleCancellation is internally guarded (no-ops unless the visit is
  // still cancelled at write time) and sends nothing. Lead conversion and the
  // resolved review card keep normal confirm-then-cancel semantics — cancel
  // after activation is the everyday sequence and its paths own that cleanup.
  // Reporting FALSE keeps the row unstamped, same as the entry check.
  try {
    const post = await db('scheduled_services').where({ id: svc.id }).first('status');
    if (post && ['cancelled', 'skipped', 'rescheduled'].includes(String(post.status))) {
      // ⭐ ALL THREE TERMINAL PATHS CLOSE THE REMINDER, NOT JUST 'cancelled'.
      // handleCancellation deliberately no-ops unless the visit is still
      // exactly 'cancelled' at write time — so a skip or reschedule that
      // committed during the legs (its own cleanup ran before this reminder
      // existed) left the just-armed reminder active. Close it directly, with
      // the same one-statement status guard handleCancellation uses so a
      // restoration committing after the status read above is never re-closed.
      // 'rescheduled' is a SUPERSEDED row in this lane (the rebook is a new
      // row with its own reminder), so closing its reminder is final, not a
      // pending-rebook hold.
      await db('appointment_reminders')
        .where({ scheduled_service_id: svc.id })
        .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status IN ('cancelled','skipped','rescheduled'))")
        .update({ cancelled: true, updated_at: new Date() })
        .catch((e) => logger.warn(`[${routeTag}] terminal-race reminder close failed for ${svc.id}: ${e.message}`));
      if (String(post.status) === 'cancelled') {
        // The cancelled path also takes the cancellation-notice claim (a
        // sendNotification:false caller claims to BLOCK a later auto-send).
        const AppointmentReminders = require('./appointment-reminders');
        await AppointmentReminders.handleCancellation(svc.id, { sendNotification: false }).catch(() => {});
      }
      logger.info(`[${routeTag}] visit ${svc.id} went ${post.status} during the confirm hook — reminder closed, activation stood down`);
      return false;
    }
  } catch (postErr) {
    // Fail CLOSED, same as the entry check: an unreadable status cannot prove
    // the cancellation race did not happen, and returning coreLegsOk here would
    // let the stamp land over an unverified activation. False leaves the row
    // unstamped — the retry rail — and every leg is idempotent on the retry.
    logger.error(`[${routeTag}] post-hook status re-read failed for ${svc.id} — reporting retryable: ${postErr.message}`);
    return false;
  }

  return coreLegsOk;
}

// Post-registration slot verify (Codex #3361 r11 P2), shared by the confirm
// hook's registration leg and the call pipeline's same-key replay repair
// (Codex #3361 r26 P2 — the replay has the same fresh-read → insert gap): a
// reschedule committing between a registration's fresh slot read and its
// reminder insert ran its own sync BEFORE the reminder row existed. One
// more read AFTER registration closes the ordering both ways — a move
// committed before this read is repaired here; a move committed after it
// finds the now-existing row and syncs itself (app resync or the DB
// trigger). `slotDate`/`slotStart` are the values the registration was
// built from. Returns true when the slot is verified consistent (or another
// actor's sync owns the row's state), false when a needed repair failed or
// the verify itself errored — retryable by the caller's rail.
async function verifyReminderSlotAfterRegistration(dbh, { serviceId, slotDate, slotStart, routeTag = 'outbound-review' }) {
  try {
    const AppointmentReminders = require('./appointment-reminders');
    const postSlot = await dbh('scheduled_services')
      .where({ id: serviceId })
      .first('scheduled_date', 'window_start');
    // The verification SUBJECT is the PERSISTED reminder row, not this
    // registration's arguments (Codex #3361 r27 P2): an activation retry
    // whose earlier attempt armed the row at stale slot A (and whose
    // post-registration resync then failed) re-registers with current slot
    // B — registerAppointment's dedupe returns the A row untouched, and an
    // args-only comparison (B vs the service's still-current B) declares
    // success while the reminder keeps quoting A. Compare what actually
    // persists against the service's current slot; the registration args
    // remain only the fallback when no row is readable.
    let persisted = null;
    if (postSlot) {
      persisted = await dbh('appointment_reminders')
        .where({ scheduled_service_id: serviceId, cancelled: false })
        .first('id', 'appointment_time', 'windows_preclosed');
      if (!persisted) {
        // NO persisted row after a registration attempt is a verification
        // FAILURE, never a pass (pre-push P1 on r27): both rails register
        // fail-soft (registerScheduleSideEffects swallows; registration's
        // every success path — placeholder inserts included — returns the
        // record), so a missing row here means the reminder insert did not
        // persist. Returning true would let the replay's confirmation
        // repairs proceed rowlessly while the later self-heal recreates the
        // row confirmation_sent=true — the booking confirmation would be
        // permanently lost. False = the caller's rail retries; the
        // re-registration dedupes if a concurrent actor won.
        logger.warn(`[${routeTag}] post-registration verify found NO reminder row for ${serviceId} — leaving retryable`);
        return false;
      }
    }
    // Windowless service ⇒ the persisted row must be the pre-closed
    // placeholder — an ARMED row (whatever slot it holds, including a stale
    // A an args-only comparison could never see) converts below.
    const needsWindowlessConversion = !!postSlot && !postSlot.window_start
      && persisted.windows_preclosed !== true;
    // Windowed service ⇒ the persisted row must be ARMED at exactly the
    // composed current slot instant (the same parseETDateTime composition
    // registration and the DB sync trigger build appointment_time with). A
    // preclosed placeholder under a real window, a stale armed time, or an
    // uncomposable slot all resync below.
    let persistedSlotStale = false;
    if (postSlot && postSlot.window_start) {
      const expected = parseETDateTime(`${dateOnly(postSlot.scheduled_date)}T${String(postSlot.window_start).slice(0, 8)}`);
      persistedSlotStale = persisted.windows_preclosed === true
        || Number.isNaN(expected.getTime())
        || new Date(persisted.appointment_time).getTime() !== expected.getTime();
    }
    if (needsWindowlessConversion) {
      // The verified slot went WINDOWLESS (a concurrent edit cleared
      // the arrival time after our registration armed a start): never
      // resync to the fabricated 09:00 fallback — convert the armed
      // row to the CANONICAL windowless pre-closed placeholder
      // (windows_preclosed + suppressed_by_sibling + all windows
      // closed), the exact state registerAppointment's
      // closeReminderWindows insert produces (Codex #3361 r18 P2,
      // hardened r22 P2). A flag-only close is transient: the DB sync
      // trigger preserves closed windows across a later date-only move
      // only for windows_preclosed rows — an unmarked row would
      // recompute against the fabricated 08:00 time and re-arm a
      // reminder for a time nobody chose. The marker makes the DB
      // machinery hold placeholder semantics durably, and the trigger's
      // real-window branch re-arms the row normally when an arrival
      // time is later set.
      const converted = await dbh.transaction(async (trx) => {
        // Pre-conversion state: the row's suppression (an ARMED row may
        // own its 08:00 fallback slot with a real sibling suppressed
        // beneath it) and its sent flags (a window the armed owner
        // already delivered was rendered with the merged slot label, so
        // a promoted sibling inherits it — the same contract the sync
        // trigger's slot-departure path applies).
        const armed = await trx('appointment_reminders')
          .where({ scheduled_service_id: serviceId, cancelled: false })
          .first('id', 'customer_id', 'appointment_time', 'suppressed_by_sibling',
            'reminder_72h_sent', 'reminder_72h_sent_at', 'reminder_24h_sent', 'reminder_24h_sent_at');
        if (!armed) return 0;
        // Same lock order as registration and the sync trigger: slot
        // advisory lock FIRST, then reminder-row writes — inverting it
        // deadlocks against a concurrent registration on this slot.
        await trx.raw('SELECT pg_advisory_xact_lock(reminder_slot_lock_key(?::uuid, ?::timestamptz))', [armed.customer_id, armed.appointment_time]);
        // Atomic windowless guard (Codex #3361 r19 P2, same shape as
        // handleReschedule's expectSchedule): a THIRD move assigning a
        // real window between the postSlot read and this write makes
        // the conversion miss instead of silencing the re-armed
        // reminders — that move's own resync owns the row's state.
        const rows = await trx('appointment_reminders')
          .where({ id: armed.id, cancelled: false })
          .whereRaw('EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.window_start IS NULL)')
          .update({
            suppressed_by_sibling: true,
            windows_preclosed: true,
            confirmation_sent: true,
            confirmation_sent_at: trx.raw('COALESCE(confirmation_sent_at, NOW())'),
            reminder_72h_sent: true,
            reminder_72h_sent_at: trx.raw('COALESCE(reminder_72h_sent_at, NOW())'),
            reminder_24h_sent: true,
            reminder_24h_sent_at: trx.raw('COALESCE(reminder_24h_sent_at, NOW())'),
            updated_at: new Date(),
          });
        if (rows && !armed.suppressed_by_sibling) {
          // The conversion demoted a slot OWNER: a real visit
          // registered at the same slot may sit suppressed beneath it,
          // and no trigger event fires for this app-side demotion —
          // promote exactly as the trigger does on slot departure,
          // carrying the owner's delivered-window state. The vacated
          // slot is the one the ARMED ROW actually occupies, so its
          // date/window params are the ET decomposition of the row's
          // own appointment_time (Codex #3361 r23 P2) — NOT the
          // post-move service slot: when the windowless edit landed
          // BEFORE our registration inserted (the stale-read ordering
          // the r11 verify exists for), the row still sits at the
          // pre-move real slot (e.g. 09:00, possibly a different
          // date), and passing the post-move date + NULL(→08:00)
          // window could never match the 09:00 sibling's service row
          // in the promotion's candidate filter. Decomposing
          // appointment_time inverts exactly the (date + COALESCE
          // window) AT TIME ZONE composition the trigger builds slot
          // times with, so it is right in both orderings.
          await trx.raw(
            `SELECT promote_suppressed_reminder_sibling(
               ?::uuid, ?::uuid, ?::timestamptz,
               ((?::timestamptz) AT TIME ZONE 'America/New_York')::date,
               ((?::timestamptz) AT TIME ZONE 'America/New_York')::time,
               ?, ?, ?, ?)`,
            [armed.customer_id, serviceId, armed.appointment_time,
              armed.appointment_time, armed.appointment_time,
              armed.reminder_72h_sent === true, armed.reminder_72h_sent_at || null,
              armed.reminder_24h_sent === true, armed.reminder_24h_sent_at || null],
          );
        }
        return rows;
      });
      if (!converted) {
        // Guard miss = a real window arrived and its own sync owns the
        // reminder state now — success, not a retryable failure.
        logger.info(`[${routeTag}] windowless placeholder conversion skipped for ${serviceId} — the service regained a window; its own resync owns the state`);
      } else {
        logger.info(`[${routeTag}] reminder converted to windowless placeholder after concurrent windowless move for ${serviceId}`);
      }
    } else if (persistedSlotStale) {
      // expectSchedule = the observed slot, enforced atomically inside
      // handleReschedule: a SECOND move (B) landing after the postSlot
      // read makes this stale resync miss instead of stomping B's own
      // sync back to A (Codex #3361 r12 P2). The explicit null start is
      // enforced too (window_start IS NULL) — a date-only move observed
      // windowless must not overwrite a concurrently-assigned real
      // window with the fabricated 09:00 fallback (Codex #3361 r21 P2).
      // handleReschedule is fail-soft (null on no-row/invalid-time/
      // error) — a null here is an unsynced slot, so the caller's rail
      // retries (Codex #3361 r12 P2).
      const resynced = await AppointmentReminders.handleReschedule(
        serviceId,
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
        logger.warn(`[${routeTag}] reminder slot resync returned null for ${serviceId} — leaving retryable`);
        return false;
      }
      logger.info(`[${routeTag}] reminder slot resynced after concurrent move for ${serviceId}`);
    }
    return true;
  } catch (postSyncErr) {
    logger.warn(`[${routeTag}] post-registration slot verify failed for ${serviceId} — leaving retryable: ${postSyncErr.message}`);
    return false;
  }
}

/**
 * A street-level address hold (call-recording-processor: the review card
 * carries payload.street_level_address) deferred the promised second visit
 * instead of booking it at an unverified address. Once the office confirms the
 * visit, that follow-up must not vanish: file the existing owed-follow-up card
 * (attached_booking_followup_unbooked, carrying follow_up_plan) that the office
 * books by hand and Resolves — the same card the settled house-number dispute
 * files. Idempotent: nothing is filed when a child visit already exists, when
 * an owed-follow-up card was already handled, and an open card just takes the
 * current plan. Runs inside the caller's transaction, before the review card
 * is resolved.
 */
async function fileOwedFollowUpForStreetLevelHold(trx, svc, knownCard) {
  // The visit's latest street-level card, open or already superseded by a
  // recording replacement: the promised follow-up must not depend on it staying open.
  const card = knownCard || await findStreetLevelHoldCard(trx, { callLogId: svc.source_call_log_id, visitId: svc.id });
  const payload = card?.payload || null;
  if (!payload?.follow_up_plan) return false;
  const owned = await trx('scheduled_services')
    .where((q) => q.where({ parent_service_id: svc.id }).orWhere({ followup_source_service_id: svc.id }))
    .first('id');
  if (owned) return false;
  const handled = await trx('triage_items')
    .where({ call_log_id: svc.source_call_log_id, reason_code: 'attached_booking_followup_unbooked' })
    .whereIn('status', ['resolved', 'dismissed'])
    .first('id');
  if (handled) return false;
  const { buildTriageItem } = require('./call-routing-gates');
  await trx('triage_items')
    .insert(buildTriageItem({
      callLogId: svc.source_call_log_id,
      flag: 'attached_booking_followup_unbooked',
      extraction: { meta: { call_summary: 'Address confirmed — the follow-up visit promised on the call is still unbooked' }, scheduling: { status: 'confirmed' } },
      extraPayload: { follow_up_plan: payload.follow_up_plan, skipped_reason: 'street_level_address_confirmed_follow_up_unbooked' },
    }))
    .onConflict(trx.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
    .merge({
      payload: trx.raw("COALESCE(triage_items.payload, '{}'::jsonb) || EXCLUDED.payload"),
      summary: trx.raw('EXCLUDED.summary'),
      updated_at: new Date(),
    });
  return true;
}

/**
 * Owner ruling 2026-09-30: a street-level address hold counts as booked only
 * once the office confirms. At call time the disposition was recorded as
 * lead_response_flow_triggered (reason appointment_pending_office_review); the
 * confirm stamps 'booked'. Compare-and-swap on that exact value, so a human's
 * own disposition tag or a later reprocess is never overwritten. No-op unless
 * the disposition gate is live and the card is a street-level hold for this
 * visit. Runs before the review card is resolved.
 */
async function stampBookedDispositionForStreetLevelHold(trx, svc, knownCard) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callDispositionV1')) return false;
  if (!(knownCard || await findStreetLevelHoldCard(trx, { callLogId: svc.source_call_log_id, visitId: svc.id }))) return false;
  const stamped = await trx('call_log')
    .where({ id: svc.source_call_log_id, disposition: 'lead_response_flow_triggered' })
    .update({ disposition: 'booked', updated_at: new Date() });
  if (stamped) logger.info(`[outbound-review-confirm] call ${svc.source_call_log_id} disposition booked (street-level hold confirmed for ${svc.id})`);
  return stamped > 0;
}

/**
 * Runs AFTER customer_confirmed is stamped. The hook's own disposition / review
 * legs run before the stamp, so a call-processor pass still in flight can read
 * the visit as unconfirmed and write the pending disposition or reopen
 * review_status after them. Once the stamp has landed, put both right under the
 * shared per-call lock: disposition booked (compare-and-swap on the pending
 * value) and review_status recomputed from the call's open cards. Street-level
 * holds only; best-effort, never throws.
 */
async function reconcileStreetLevelHoldAfterStamp(dbh, svc) {
  try {
    if (!svc?.source_call_log_id) return false;
    const card = await findStreetLevelHoldCard(dbh, { callLogId: svc.source_call_log_id, visitId: svc.id });
    if (!card) return false;
    const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
    await dbh.transaction(async (trx) => {
      await lockTriageCall(trx, svc.source_call_log_id);
      await stampBookedDispositionForStreetLevelHold(trx, svc);
      await syncCallReviewStatus(trx, svc.source_call_log_id);
    });
    return true;
  } catch (e) {
    logger.warn(`[street-level-hold] post-stamp reconcile failed for ${svc?.id}: ${e.code || e.name || 'error'}`);
    return false;
  }
}

// True when the visit has a recorded transition TO confirmed BY A USER (the office confirm
// route's transitionJobStatus row) from ANY prior status: a hold SmartRebooker moved is
// already `confirmed`, so the office's later confirm records confirmed -> confirmed and
// must still count. Fails closed (false) on a lookup error.
async function hasRecordedOfficeConfirm(dbh, serviceId) {
  try {
    const row = await dbh('job_status_history')
      .where({ job_id: serviceId, to_status: 'confirmed' })
      // SmartRebooker records its own pending -> confirmed on a move with transitioned_by NULL;
      // the office confirm route records the acting user. Only the latter is an approval.
      .whereNotNull('transitioned_by')
      .first('job_id');
    return !!row;
  } catch (e) {
    logger.warn(`[street-level-hold] confirm-history lookup failed for ${serviceId}: ${e.code || e.name || 'error'}`);
    return false;
  }
}

/**
 * Owner ruling 2026-10-01: COMPLETING a street-level hold's visit counts as confirming its
 * address (the technician or admin is at the property). Called by the shared completion
 * engine once the completion attempt is claimed: confirms the visit (pending -> confirmed,
 * attributed to the completing user) and runs the same office-confirm activation the
 * confirm route runs (card resolved, reminders armed, lead converted, disposition booked),
 * so the visit is no longer a hold and its recap sends normally. The card-on-file request
 * is skipped (the tech collects in person). No-op for every other visit; best-effort, never
 * throws — a failed release leaves the hold (and its customer-message hold) in place.
 * @returns {Promise<boolean|null>} null when the visit is not a hold (nothing to do), true when THIS
 *   call released it, false when it is a hold that could not be released
 */
async function releaseStreetLevelHoldForPerformedCompletion(serviceId, actor = {}, routeTag = 'completion') {
  try {
    const dbh = require('../models/db');
    const svc = await dbh('scheduled_services').where({ id: serviceId }).first('id', 'source_action', 'customer_confirmed');
    return await releaseStreetLevelHoldForCompletion(svc, actor, routeTag);
  } catch (e) {
    logger.warn(`[${routeTag}] street-level hold release lookup failed for ${serviceId}: ${e.code || e.name || 'error'}`);
    return false;
  }
}

async function releaseStreetLevelHoldForCompletion(svc, actor = {}, routeTag = 'completion') {
  try {
    const { VOICE_AGENT_BOOKING_SOURCE_ACTION } = require('./call-booking-source-actions');
    if (!svc?.id || svc.source_action !== VOICE_AGENT_BOOKING_SOURCE_ACTION || svc.customer_confirmed === true) return null;
    const dbh = require('../models/db');
    if (!(await isStreetLevelHoldVisit(svc.id, dbh))) return null;
    // Read the CURRENT row: completion may already have moved the visit to 'completed'.
    let row = await dbh('scheduled_services').where({ id: svc.id }).first(
      'id', 'customer_id', 'scheduled_date', 'window_start', 'service_type', 'source_call_log_id', 'is_callback', 'estimated_price', 'status',
    );
    if (row && String(row.status) === 'pending') {
      const { transitionJobStatus } = require('./job-status');
      await transitionJobStatus({
        jobId: svc.id,
        fromStatus: 'pending',
        toStatus: 'confirmed',
        transitionedBy: actor.technicianId || null,
        notes: 'Confirmed by completing the visit (the address was confirmed on site)',
        legacyOutboundActivation: 'caller',
      });
      row = { ...row, status: 'confirmed' };
    }
    if (!row) return false;
    let released = await runOfficeConfirmActivation(dbh, row, routeTag, { skipCardRequest: true });
    if (!released) {
      // The completion's own transition to 'completed' also schedules the lazy activation post-commit;
      // if that one won the confirmed stamp, this call's stamp matched no row and answered false even
      // though the hold IS released (the hook legs are idempotent, the stamp at-most-once). Re-read
      // before calling it a failure.
      const after = await dbh('scheduled_services').where({ id: svc.id }).first('customer_confirmed');
      if (after?.customer_confirmed === true) released = true;
    }
    if (released) {
      // The caller's snapshot reflects the confirmed state from here on.
      svc.customer_confirmed = true;
    }
    return released;
  } catch (e) {
    logger.warn(`[${routeTag}] street-level hold release failed for ${svc?.id}: ${e.code || e.name || 'error'}`);
    return false;
  }
}

/**
 * Lazy activation for a PENDING OFFICE-REVIEW row — a legacy outbound-review
 * row (created pending before the 2026-08-11 review-hold removal, PR #3361)
 * OR a voice-agent booking, which is created with the same pending/
 * unconfirmed shape and owes the same legs (the membership list is
 * call-booking-source-actions.OFFICE_REVIEW_PENDING_SOURCE_ACTIONS; matching
 * only the outbound marker here is what let a moved voice booking go
 * operational half-armed) — touched by a writer that
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
    const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS, VOICE_AGENT_BOOKING_SOURCE_ACTION } = require('./call-booking-source-actions');
    const row = await db('scheduled_services')
      .where({ id: serviceId })
      .first('id', 'source_action', 'status', 'customer_confirmed', 'customer_id',
        'scheduled_date', 'window_start', 'service_type', 'source_call_log_id',
        'is_callback', 'estimated_price', 'field_confirmed_at');
    if (!row || !OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(row.source_action) || row.customer_confirmed) {
      return false;
    }
    // A street-level address hold is released ONLY by the office's explicit confirm: no writer that
    // merely moves the visit (SmartRebooker, update-details, the bulk paths, the sweep) may activate it.
    // Status 'confirmed' is NOT proof (SmartRebooker writes it on a move); the proof is a recorded
    // pending -> confirmed transition BY A USER (SmartRebooker's own row has transitioned_by NULL), or,
    // for a COMPLETED hold, the field-confirmation stamp the completion engine commits with the status
    // when the closeout was performed at the property (an incomplete / declined closeout carries none, and
    // the stamp also keeps the card funnel off in the hook). A hold the office confirmed whose hook then
    // failed stays on the retry rail. Fails closed.
    // (Recognized by its card whatever its state: a hold the completion settled without approving — an
    // incomplete / declined closeout — stays a non-activatable hold.)
    let officeApprovedHold = false;
    if (row.source_action === VOICE_AGENT_BOOKING_SOURCE_ACTION && await isStreetLevelHoldVisit(serviceId, db, { includeClosedOut: true })) {
      const officeApproved = row.status === 'confirmed' && await hasRecordedOfficeConfirm(db, serviceId);
      // The recorded approval binds to the address the office confirmed: a correction after it voids it
      // (the office re-confirms the new address), so a retry never releases the hold for an unseen address.
      const addressVoided = officeApproved && !(await approvedAddressStillCurrent(db, serviceId));
      const approved = (row.status === 'completed' && !!row.field_confirmed_at) || (officeApproved && !addressVoided);
      if (addressVoided) {
        // An earlier attempt's hook may already have resolved the hold's review card: bring it back, or the
        // unconfirmed visit would be hidden from the office's open queue.
        await reopenHoldCardForRestoredVisit(serviceId, db);
      }
      if (!approved) {
        logger.info(`[${routeTag}] legacy activation skipped for ${serviceId}: street-level address hold awaiting the office confirm`);
        return false;
      }
      officeApprovedHold = officeApproved;
    }
    // Rejected rows are not activated (a cancelled/skipped booking was the office declining it);
    // completed/no_show rows DO — the lead conversion / card resolution / credit evidence are what a
    // worked visit still owes. The fresh re-read below is the rejection check (the first read may be
    // arbitrarily stale by the time a sweep batch reaches this row; a just-committed cancel/skip wins,
    // Codex #3361 r8 P1).
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
    // An office-approved street-level hold is activated behind its address witness: lock + verify + stamp,
    // THEN the legs (activateHoldFencedByAddress explains the order). A hold completed on site (field
    // stamp) and every other row keep hook-first below.
    if (officeApprovedHold) {
      return await activateHoldFencedByAddress(db, row, routeTag, {
        suppressCardAskWithoutClearance: true,
        evidenceBookedAt: opts.evidenceBookedAt || null,
      });
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
    // A rejection that committed during the hook window wins: never stamp a cancelled/skipped row
    // confirmed (Codex #3361 r8 P1).
    const stamped = await stampCustomerConfirmed(db, { id: serviceId });
    if (stamped > 0) await reconcileStreetLevelHoldAfterStamp(db, row);
    return stamped > 0;
  } catch (e) {
    logger.warn(`[${routeTag}] legacy outbound activation failed for ${serviceId}: ${e.message}`);
    return false;
  }
}

/**
 * THE guarded customer_confirmed stamp (the receipt of a completed activation), shared by the office-confirm
 * activation and the lazy / sweep activation. Returns the number of rows stamped.
 *
 * For a voice-agent booking the stamp is conditional on the address the office approved: the approval's
 * address witness (street-level-hold.js recordApprovedAddressWitness) is compared with the visit's address
 * read from the row LOCKED FOR UPDATE in the stamping transaction. Every writer of a visit's service address
 * (appointment-address applyAppointmentAddress, the rebooker, update-details, the geocode-review visit moves)
 * updates the scheduled_services row itself under that row's lock, so an address write either commits before
 * this lock (and is seen: the stamp is refused, the hold stays pending for the office to re-confirm) or waits
 * behind it (and lands on an already-released hold, as any later correction does). The visit's address for
 * the confirm is its own stamped service_address_* columns, never the customer's profile address, so a
 * customers-table edit is not a change to the confirmed address. A hold with no witness, every other
 * source, and a visit confirmed ON SITE by its technician (field stamp / performed completion: the tech
 * stood at the property) stamp exactly as before — the caller passes bindAddress for the office approvals.
 */
async function stampCustomerConfirmed(dbh, svc, { bindAddress = false, stampedAt = new Date(), markActivationPending = null } = {}) {
  const stamp = (conn) => conn('scheduled_services')
    .where({ id: svc.id, customer_confirmed: false })
    // A rejection that committed during the hook window wins: never stamp a
    // cancelled/skipped row confirmed (same guard as the lazy helper).
    .whereNotIn('status', ['cancelled', 'skipped', 'rescheduled'])
    .update({ customer_confirmed: true, confirmed_at: stampedAt });
  if (!bindAddress) return stamp(dbh);
  let refused = false;
  const stamped = await dbh.transaction(async (trx) => {
    const locked = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first('id', 'source_call_log_id');
    if (!(await approvedAddressStillCurrent(trx, svc.id))) {
      refused = true;
      return 0;
    }
    const n = await stamp(trx);
    // Stamp-first (activateHoldFencedByAddress): the legs still owed are recorded durably IN THE SAME
    // transaction as the stamp, on the hold's review card, so a process exit before they finish is
    // recovered by resumePendingHoldActivations instead of stranding a stamped, half-activated visit.
    if (n > 0 && markActivationPending && locked?.source_call_log_id) {
      await setHoldActivationPending(trx, locked.source_call_log_id, svc.id, markActivationPending);
    }
    return n;
  });
  if (refused) {
    logger.info(`[street-level-hold] stamp refused for ${svc.id}: the visit address changed after the office approval — the hold stays pending`);
    // The hook (which ran before the stamp) resolved the hold's review card: bring it back so the office can
    // confirm the new address. Best-effort; the hold itself (card + unconfirmed visit) already stands.
    await reopenHoldCardForRestoredVisit(svc.id, dbh);
  }
  return stamped;
}

// The durable "legs still owed" marker of a stamp-first hold activation: payload.activation_pending on the
// hold's latest review card (any status — the legs resolve it), valued with the activation's MODE so a
// resumed activation runs the legs exactly as the interrupted one would have: 'office' (the office-confirm
// route: it also writes the call-level clearance stamp and may text the card-on-file ask) or 'lazy' (the
// retry rail: the ask only on an existing clearance). Written with the stamp, cleared when the legs are done
// (or the stamp is taken back). pending = false clears it.
// `onlyIfMode` (clearing only): clear the marker just when it still carries THIS activation's mode — a lazy
// activation finishing must not wipe an 'office' upgrade written by the office path that lost the stamp.
async function setHoldActivationPending(conn, callLogId, visitId, pending, onlyIfMode = null) {
  const card = await findStreetLevelHoldCard(conn, { callLogId, visitId });
  if (!card) return false;
  await conn('triage_items').where({ id: card.id }).modify((q) => {
    if (!pending && onlyIfMode) q.whereRaw("payload->>'activation_pending' = ?", [onlyIfMode]);
  }).update({
    payload: pending
      ? conn.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('activation_pending', ?::text, 'activation_pending_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))", [String(pending)])
      : conn.raw("COALESCE(payload, '{}'::jsonb) - 'activation_pending' - 'activation_pending_at'"),
  });
  return true;
}

/**
 * Activation of an office-APPROVED street-level address hold (the voice-agent booking Google matched only to
 * the street), fenced by the approval's address witness. ORDER: lock + verify + STAMP, then act.
 *
 *   1. In ONE transaction (stampCustomerConfirmed): take the visit row FOR UPDATE, re-read the visit's
 *      address from that locked row, compare it with the witness, and stamp customer_confirmed — or refuse
 *      (and reopen the hold's review card) when the address changed since the approval.
 *   2. Only after that commit run the hook legs (lead conversion, review-card resolve, owed follow-up and
 *      disposition, reminders, inspection-credit evidence, the card-on-file text).
 *
 * Why stamp-first here (the rest of the lane keeps hook-first/stamp-on-success): the hook's legs are
 * irreversible customer / money effects spread over several connections that themselves lock or update the
 * visit row (inspection-credit redemption, the card funnel's card_link_sent_at, reminder registration), so
 * they cannot run inside the lock without deadlocking against it — and an address correction committing
 * after a verify made BEFORE the legs would still release them for an unseen address. With the stamp inside
 * the same locked transaction as the verify, a correction that commits after the verify serializes behind
 * the lock and lands AFTER the stamp: an ordinary post-approval correction of an approved visit, exactly as
 * if the office had confirmed first and the customer corrected later. No leg ever runs for an address that
 * was not the approved one.
 *
 * Crash / failure safety (the reason the lane is otherwise hook-first): a core leg that fails, or a visit
 * cancelled during the legs, UN-STAMPS the visit (the exact stamp this call wrote, by its timestamp, and only
 * while it is still 'confirmed' — a visit a technician advanced since keeps its approval and its pending
 * marker for the sweep) and reopens a review card the legs resolved, restoring the unstamped,
 * office-approved state the lazy / stranded-activation sweep retries (its witness check re-verifies the
 * address first). When another activation wins the stamp, the office path still runs the office-only legs
 * (clearance stamp, card ask) itself. A process exit
 * between the stamp and the legs is covered too: the stamp's own transaction also writes
 * payload.activation_pending on the hold's review card (the legs still owed, durably), and the hourly
 * sweep (resumePendingHoldActivations) re-runs the idempotent legs and clears the marker. Every other
 * source, and every non-hold voice booking, keeps hook-first.
 *
 * @returns {Promise<boolean>} true when the legs ran and the visit is stamped; false otherwise.
 */
async function activateHoldFencedByAddress(dbh, svc, routeTag, hookOpts) {
  const mode = hookOpts.suppressCardAskWithoutClearance ? 'lazy' : 'office';
  const stampedAt = new Date();
  const stamped = await stampCustomerConfirmed(dbh, svc, { bindAddress: true, stampedAt, markActivationPending: mode });
  if (!(stamped > 0)) {
    // Refused (address changed: the card is reopened inside), a rejection took the row, or another activator
    // stamped it first.
    const after = await dbh('scheduled_services').where({ id: svc.id }).first('customer_confirmed', 'status');
    if (after?.customer_confirmed !== true) return false;
    // Another activation (typically the stranded-activation sweep, in LAZY mode) won the stamp. The legs it
    // runs are the shared idempotent ones, but the office-confirm-only work — the call-level clearance stamp
    // and the card-on-file invitation — is NOT part of a lazy activation and nothing repairs it later (the
    // pre-visit sweep requires the clearance). The office path owns those legs: it runs the hook in office
    // mode itself (idempotent: registration dedupes, the card resolve no-ops, the funnel dedupes), under its
    // own marker so an exit mid-way is resumed in office mode. A lazy activation keeps its own work.
    if (mode === 'office' && !['cancelled', 'skipped', 'rescheduled'].includes(String(after.status))) {
      if (svc.source_call_log_id) await setHoldActivationPending(dbh, svc.source_call_log_id, svc.id, 'office').catch(() => {});
      let officeOk = false;
      try {
        officeOk = await runOutboundReviewConfirmHook(dbh, svc, routeTag, hookOpts);
      } catch (e) {
        logger.error(`[${routeTag}] office legs after a lost stamp threw for ${svc.id}: ${e.message}`);
      }
      // On a failure the marker stays: the sweep re-runs the legs in office mode.
      if (officeOk && svc.source_call_log_id) await setHoldActivationPending(dbh, svc.source_call_log_id, svc.id, false, 'office').catch(() => {});
    }
    return true;
  }
  let legsOk = false;
  try {
    legsOk = await runOutboundReviewConfirmHook(dbh, svc, routeTag, hookOpts);
  } catch (e) {
    logger.error(`[${routeTag}] hold activation hook threw for ${svc.id}: ${e.message}`);
  }
  if (!legsOk) {
    try {
      // Take the stamp back ONLY while the visit is still in its pre-dispatch approved state (status
      // 'confirmed', this call's own stamp). A technician may legitimately have advanced the approved visit
      // (en_route / on_site / completed) since the stamp committed: un-stamping it would restore a hold the
      // lazy rail and tech-track both refuse, stranding it. An advanced visit KEEPS its approval and its
      // activation_pending marker, and the sweep (resumePendingHoldActivations) finishes the legs.
      const unstamped = await dbh('scheduled_services')
        .where({ id: svc.id, customer_confirmed: true, status: 'confirmed' })
        .where('confirmed_at', stampedAt)
        .update({ customer_confirmed: false, confirmed_at: null });
      if (unstamped > 0) {
        logger.error(`[${routeTag}] hold activation incomplete for ${svc.id} — un-stamped so the activation sweep retries it`);
        if (svc.source_call_log_id) await setHoldActivationPending(dbh, svc.source_call_log_id, svc.id, false, mode);
        await reopenHoldCardForRestoredVisit(svc.id, dbh);
      } else {
        logger.error(`[${routeTag}] hold activation incomplete for ${svc.id} — visit already advanced or taken: approval and pending marker kept for the sweep`);
      }
    } catch (e) {
      logger.error(`[${routeTag}] un-stamp after a failed hold activation failed for ${svc.id}: ${e.message}`);
    }
    return false;
  }
  // Only this activation's own marker: a lazy one never clears an office upgrade.
  if (svc.source_call_log_id) await setHoldActivationPending(dbh, svc.source_call_log_id, svc.id, false, mode).catch(() => {});
  await reconcileStreetLevelHoldAfterStamp(dbh, svc);
  return true;
}

/**
 * Recovery of stamp-first hold activations that a process exit interrupted: every hold card still marked
 * activation_pending whose visit is stamped has its hook legs re-run (all idempotent) and, once they report
 * success, the marker cleared. A visit a rejection took (cancelled / skipped / rescheduled) just drops the
 * marker. The legs run in the mode the interrupted activation recorded on the marker (office-confirm: the
 * clearance stamp and card ask included; lazy: the ask only on an existing clearance). Run by the hourly
 * stranded-activation sweep; bounded per run; leases a fresh marker (see HOLD_ACTIVATION_RESUME_AFTER_MINUTES).
 */
const HOLD_ACTIVATION_RESUME_AFTER_MINUTES = 10;
async function resumePendingHoldActivations(dbh = db, { limit = 25 } = {}) {
  const rows = await dbh('triage_items as ti')
    .join('scheduled_services as ss', dbh.raw("ss.id::text = ti.payload->>'scheduled_service_id'"))
    .where('ti.reason_code', 'outbound_booking_review')
    .whereIn(dbh.raw("ti.payload->>'activation_pending'"), ['office', 'lazy'])
    // A lease, like every stale-claim rail here: a marker younger than HOLD_ACTIVATION_RESUME_AFTER_MINUTES
    // belongs to an activation that is still running in a live process (its own failure rollback included),
    // so the sweep leaves it alone and only recovers one that has been quiet that long.
    .whereRaw("COALESCE((ti.payload->>'activation_pending_at')::timestamptz, 'epoch'::timestamptz) < NOW() - make_interval(mins => ?)", [HOLD_ACTIVATION_RESUME_AFTER_MINUTES])
    .where('ss.customer_confirmed', true)
    .limit(limit)
    .select(dbh.raw("ti.payload->>'activation_pending' as pending_mode"), 'ss.id', 'ss.status', 'ss.customer_id', 'ss.scheduled_date', 'ss.window_start', 'ss.service_type', 'ss.source_call_log_id', 'ss.source_action',
      // The same row shape the lazy activation hands the hook (callback / pricing / field-confirm fields).
      'ss.customer_confirmed', 'ss.is_callback', 'ss.estimated_price', 'ss.field_confirmed_at');
  let resumed = 0;
  for (const row of rows) {
    try {
      if (['cancelled', 'skipped', 'rescheduled'].includes(String(row.status))) {
        await setHoldActivationPending(dbh, row.source_call_log_id, row.id, false);
        continue;
      }
      // Same legs, same semantics as the interrupted activation (its mode is on the marker).
      const ok = await runOutboundReviewConfirmHook(dbh, row, 'hold-activation-resume',
        row.pending_mode === 'lazy' ? { suppressCardAskWithoutClearance: true } : {});
      if (ok) {
        // Only the mode this resume ran in: an 'office' upgrade written meanwhile stays owed for the next pass.
        await setHoldActivationPending(dbh, row.source_call_log_id, row.id, false, row.pending_mode);
        await reconcileStreetLevelHoldAfterStamp(dbh, row);
        resumed += 1;
      }
    } catch (e) {
      logger.warn(`[hold-activation-resume] ${row.id} failed: ${e.message}`);
    }
  }
  if (rows.length) logger.info(`[hold-activation-resume] resumed ${resumed}/${rows.length} interrupted hold activations`);
  return { candidates: rows.length, resumed };
}

/**
 * OFFICE-CONFIRM activation — hook FIRST, stamp on success, for the two admin
 * status routes (admin-dispatch, admin-schedule) that flip an office-review
 * row to 'confirmed' themselves.
 *
 * Those routes used to stamp `customer_confirmed` inside the confirmation
 * transaction and then call the hook post-commit, ignoring its result. But
 * `customer_confirmed` is the COMPLETION MARKER for this whole lane, not just a
 * UI flag: activateLegacyOutboundReviewRowIfNeeded skips a stamped row, and
 * sweepStrandedLegacyOutboundActivations selects on `customer_confirmed:
 * false`. So a row whose core legs failed — or whose process exited between the
 * commit and the hook — was already stamped, and both retry rails rejected it
 * forever: no reminder registration, an unconverted lead, an open review card,
 * with nothing left to notice.
 *
 * The fix is the rule the rest of the lane already follows (Codex #3361 r3/r4
 * P1, job-status.processLegacyOutboundActivation): the stamp is the RECEIPT for
 * a completed activation, so it is written here, after the legs, and only when
 * they succeeded. A failure leaves the row confirmed-but-unstamped — exactly
 * the state the hourly sweep exists to drain — and every leg is idempotent, so
 * the retry is safe.
 *
 * Callers keep their own hook call (office semantics: the clearance stamp and
 * the messaging-mode card ask, which the lazy-activation path deliberately
 * suppresses) and must tell transitionJobStatus to stand down via
 * `legacyOutboundActivation: 'caller'`, or the two would run concurrently.
 *
 * `opts` is forwarded verbatim to the hook — notably `skipCardRequest` for a
 * FIELD confirm (a technician tapping confirm collects a card in person; the
 * office-only card-request funnel and its clearance stamp must not fire behind
 * them, per the #3356 owner decision).
 *
 * @returns {Promise<boolean>} true when the legs ran AND the row is now stamped.
 */
async function runOfficeConfirmActivation(dbh, svc, routeTag = 'office-confirm', opts = {}) {
  let coreLegsOk = false;
  // An office approval of a street-level address hold is fenced by its address witness (lock + verify +
  // stamp, then the legs: activateHoldFencedByAddress). A technician's own field confirm (skipCardRequest)
  // is confirmed on site and not bound; every other voice booking keeps hook-first below.
  const bindAddress = svc.source_action === 'voice_agent' && !opts.skipCardRequest;
  if (bindAddress && await isStreetLevelHoldVisit(svc.id, dbh)) {
    return activateHoldFencedByAddress(dbh, svc, routeTag, opts);
  }
  try {
    coreLegsOk = await runOutboundReviewConfirmHook(dbh, svc, routeTag, opts);
  } catch (e) {
    logger.error(`[${routeTag}] office-confirm hook threw for ${svc.id}: ${e.message}`);
  }
  if (!coreLegsOk) {
    logger.error(
      `[${routeTag}] office-confirm activation incomplete for ${svc.id} — leaving customer_confirmed `
      + 'unstamped so the legacy-activation sweep retries it'
    );
    return false;
  }
  try {
    const stamped = await stampCustomerConfirmed(dbh, svc);
    if (stamped > 0) await reconcileStreetLevelHoldAfterStamp(dbh, svc);
    if (stamped > 0) return true;
    // A zero-row stamp is not a failure when another activator (the stranded-activation sweep, a
    // move's lazy activation, the completion release) won the guarded stamp while this call's legs
    // ran: the legs are idempotent and all ran OK here, so the row IS activated. Re-read before
    // answering false (same rule as releaseStreetLevelHoldForCompletion) — a false here suppresses the
    // technician's new-visit card on an office approval of a moved hold (confirmed -> confirmed).
    // A row a rejection took (cancelled / skipped / rescheduled) stays unstamped and answers false.
    const after = await dbh('scheduled_services').where({ id: svc.id }).first('customer_confirmed');
    return after?.customer_confirmed === true;
  } catch (e) {
    logger.error(`[${routeTag}] office-confirm stamp failed for ${svc.id}: ${e.message}`);
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
 *
 * ⭐ VOICE-AGENT ROWS ARE IN THIS SWEEP, BUT ONLY ONCE SOMETHING MOVED THEM.
 * Every other activation consumer takes the whole
 * OFFICE_REVIEW_PENDING_SOURCE_ACTIONS set unchanged, because each of them
 * fires on a WRITER TOUCHING THE ROW (a transition, a reschedule, a pipeline
 * reuse) — the touch is the activation trigger, and a voice booking owes the
 * same legs as an outbound-review one. This sweep is the one consumer whose
 * predicate is not a touch: it drains the LEGACY population outright,
 * including never-touched pending rows, and that is correct ONLY because the
 * office-review hold was removed collectively for those rows (owner directive
 * 2026-08-11) and that population only shrinks. Voice bookings are the
 * opposite: they are created pending on purpose, RIGHT NOW, with an
 * outbound_booking_review card for the office to work — and this hook resolves
 * that card, arms customer reminders and converts the lead. Draining
 * never-touched voice rows would therefore auto-confirm an unreviewed AI
 * booking, close the office's own review card behind their back, and arm
 * customer-facing reminder SMS for it. So voice rows enter this backstop only
 * in the state it exists to repair: a row some writer already moved off
 * 'pending' that is still unstamped (a crash or a transient core-leg failure
 * after a lazy activation). Untouched pending voice rows stay for the office.
 */
async function sweepStrandedLegacyOutboundActivations(dbh = db, { limit = 25 } = {}) {
  const {
    CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
    VOICE_AGENT_BOOKING_SOURCE_ACTION,
  } = require('./call-booking-source-actions');
  const rows = await dbh('scheduled_services')
    .where({ customer_confirmed: false })
    .where((q) => q
      .where('source_action', CALL_OUTBOUND_REVIEW_SOURCE_ACTION)
      .orWhere((q2) => q2
        .where('source_action', VOICE_AGENT_BOOKING_SOURCE_ACTION)
        .whereNot('status', 'pending')))
    // ⭐ 'rescheduled' is a SUPERSEDED row (the live visit is a different row) —
    // activating it arms reminders for an appointment the customer already
    // moved. Excluded here AND at the activation entry check, so neither rail
    // can resurrect it.
    .whereNotIn('status', ['cancelled', 'skipped', 'rescheduled'])
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
  // Stamp-first street-level hold activations a process exit interrupted (activateHoldFencedByAddress).
  await resumePendingHoldActivations(dbh, { limit }).catch((e) => logger.warn(`[hold-activation-resume] sweep leg failed: ${e.message}`));
  return { candidates: rows.length, activated };
}

module.exports = {
  releaseStreetLevelHoldForCompletion,
  releaseStreetLevelHoldForPerformedCompletion,
  fileOwedFollowUpForStreetLevelHold,
  reconcileStreetLevelHoldAfterStamp,
  stampBookedDispositionForStreetLevelHold,
  runOutboundReviewConfirmHook,
  runOfficeConfirmActivation,
  activateLegacyOutboundReviewRowIfNeeded,
  sweepStrandedLegacyOutboundActivations,
  resumePendingHoldActivations,
  verifyReminderSlotAfterRegistration,
  _test: { hasRecordedOfficeConfirm, stampCustomerConfirmed, activateHoldFencedByAddress },
};
