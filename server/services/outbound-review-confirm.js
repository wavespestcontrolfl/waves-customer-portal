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

  // 2. Close the originating call lead. The insert path deliberately skipped
  // conversion for the pending review row; it stashed the lead's id on the
  // outbound_booking_review triage card, because the booking can REUSE an
  // existing unclaimed phone lead that never gets customer_id stamped — a
  // customer_id search would miss it (or close an unrelated lead). Fall back
  // to the single-active-lead heuristic only for pre-payload rows.
  // convertCallLeadOnPhoneBooking is ownership-guarded (unclaimed or
  // same-customer only), so a stale carried id can never reassign another
  // customer's lead.
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
    if (leadId) {
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
      await db('triage_items')
        .where({ call_log_id: svc.source_call_log_id, reason_code: 'outbound_booking_review' })
        .whereIn('status', ['open', 'in_progress'])
        .update({ status: 'resolved', updated_at: db.fn.now() });
    }
  } catch (e) { logger.error(`[${routeTag}] outbound-review triage resolve failed for ${svc.id}: ${e.message}`); }
}

module.exports = { runOutboundReviewConfirmHook };
