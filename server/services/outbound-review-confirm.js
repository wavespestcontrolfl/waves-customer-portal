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
 */
async function runOutboundReviewConfirmHook(db, svc, routeTag = 'outbound-review') {
  // 1. Arm the 72h/24h reminders that were deferred at booking time.
  // Idempotent (registerAppointment dedupes by scheduled_service_id);
  // sendConfirmation:false = arm reminders only, the office owns any
  // confirmation message.
  try {
    const AppointmentReminders = require('./appointment-reminders');
    await AppointmentReminders.registerAppointment(
      svc.id,
      svc.customer_id,
      `${dateOnly(svc.scheduled_date)}T${svc.window_start || '09:00'}`,
      svc.service_type,
      'admin_manual',
      { sendConfirmation: false },
    );
    logger.info(`[${routeTag}] Armed reminders for confirmed outbound-review booking ${svc.id}`);
  } catch (e) { logger.error(`[${routeTag}] outbound-review reminder arm failed for ${svc.id}: ${e.message}`); }

  // 1a. Inspection-credit booking evidence — written HERE, not at the AI
  // booking insert (pre-push P0): a pending outbound-review row is not a
  // closed deal until this office confirmation, and the hourly sweep would
  // otherwise treat the event plus the live 'pending' status as proof and
  // mint $75 for an appointment the customer never confirmed. Idempotent
  // (unique per booking); never blocks the confirmation.
  try {
    const marked = await require('./inspection-credit').markBookingForInspectionCredit(db, {
      customerId: svc.customer_id,
      scheduledServiceId: svc.id,
      source: 'phone_call',
    });
    // Fast redemption too, mirroring the admin-schedule/self-book paths
    // (Codex #3178 r26 P2): confirmation is the booking moment, and a
    // Charge Now / pay link sent before the hourly sweep would otherwise
    // collect the full amount while the credit strands afterwards.
    // GATED on the evidence write landing (Codex #3178 r27 P2): this row
    // was inserted when the AI opened the pending review, so without an
    // event the redeemer would fall back to that PLACEHOLDER created_at —
    // for a row opened inside the window but confirmed after expiry, that
    // mints a credit this booking did not earn. On a failed evidence write
    // the post-commit retry recovers the event and the hourly sweep (which
    // only redeems FROM events) mints with the true confirmation moment.
    // Best-effort — the sweep remains the durable guarantee.
    if (marked === 1) {
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
      await CallProc.convertCallLeadOnPhoneBooking(db, {
        leadId,
        customerId: svc.customer_id,
        scheduledServiceId: svc.id,
        callSid: null,
        keepOpenForQuote,
      });
      logger.info(`[${routeTag}] Converted lead ${leadId} (keepOpenForQuote=${keepOpenForQuote}) for confirmed outbound-review booking ${svc.id}`);
    }
  } catch (e) { logger.error(`[${routeTag}] outbound-review lead conversion failed for ${svc.id}: ${e.message}`); }

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
  } catch (e) { logger.error(`[${routeTag}] outbound-review triage resolve failed for ${svc.id}: ${e.message}`); }

  // 4. Card-on-file request (Codex #2771 r2): the AI booking path skips
  // the card funnel for pending outbound-review rows, and without this the
  // confirmed visit would never get one. The office just re-confirmed the
  // appointment with the customer (same trust point that arms reminders),
  // and the funnel's canonical send path still enforces stored SMS
  // consent + suppression. Idempotent; dark until APPOINTMENT_CARD_REQUEST
  // + the template flip.
  try {
    const { requestCardForAppointment } = require('./appointment-card-request');
    await requestCardForAppointment({ scheduledServiceId: svc.id, trigger: 'outbound_review_confirm' });
  } catch (e) { logger.warn(`[${routeTag}] card-request funnel failed for ${svc.id}: ${e.message}`); }
}

module.exports = { runOutboundReviewConfirmHook };
