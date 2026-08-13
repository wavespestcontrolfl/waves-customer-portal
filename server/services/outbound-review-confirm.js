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
    const fresh = await db('scheduled_services').where({ id: svc.id }).first('status');
    if (!fresh || ['cancelled', 'skipped', 'rescheduled'].includes(String(fresh.status))) {
      logger.info(`[${routeTag}] activation stood down for ${svc.id} — row is ${fresh ? fresh.status : 'gone'}`);
      return false;
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
      const AppointmentReminders = require('./appointment-reminders');
      await AppointmentReminders.handleCancellation(svc.id, { sendNotification: false }).catch(() => {});
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
    const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
    const row = await db('scheduled_services')
      .where({ id: serviceId })
      .first('id', 'source_action', 'status', 'customer_confirmed', 'customer_id',
        'scheduled_date', 'window_start', 'service_type', 'source_call_log_id',
        'is_callback', 'estimated_price');
    if (!row || !OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(row.source_action) || row.customer_confirmed) {
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
      .whereNotIn('status', ['cancelled', 'skipped', 'rescheduled'])
      .update({ customer_confirmed: true, confirmed_at: new Date() });
    return stamped > 0;
  } catch (e) {
    logger.warn(`[${routeTag}] legacy outbound activation failed for ${serviceId}: ${e.message}`);
    return false;
  }
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
    const stamped = await dbh('scheduled_services')
      .where({ id: svc.id, customer_confirmed: false })
      // A rejection that committed during the hook window wins: never stamp a
      // cancelled/skipped row confirmed (same guard as the lazy helper).
      .whereNotIn('status', ['cancelled', 'skipped', 'rescheduled'])
      .update({ customer_confirmed: true, confirmed_at: new Date() });
    return stamped > 0;
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
  return { candidates: rows.length, activated };
}

module.exports = {
  runOutboundReviewConfirmHook,
  runOfficeConfirmActivation,
  activateLegacyOutboundReviewRowIfNeeded,
  sweepStrandedLegacyOutboundActivations,
  verifyReminderSlotAfterRegistration,
};
