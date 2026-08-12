/**
 * Voice-relay request_booking — Phase B's ONE write, double-gated and
 * fail-closed.
 *
 * GATES (both required, both default off):
 *   - VOICE_RELAY_CONTEXT_ENABLED === 'true' (the Phase 2 context gate), AND
 *   - GATE_VOICE_AI_BOOKING === 'true' (independent booking gate).
 * Either off → the tool doesn't register (relay-tools.activeTools) AND its
 * body refuses (defense in depth). Kill switch: unset GATE_VOICE_AI_BOOKING.
 *
 * WHAT IT CREATES — a PENDING office-review booking, never a confirmed
 * appointment. This reuses the outbound-review booking lifecycle (PR #2583,
 * services/outbound-review-confirm.js) rather than inventing a parallel
 * pending state. The creation shape mirrors the call pipeline's pending
 * outbound-review insert (call-recording-processor.js ~11405: the
 * `insertData` for `outboundReviewBooking` rows) with its own distinct
 * source_action, VOICE_AGENT_BOOKING_SOURCE_ACTION ('voice_agent'):
 *   - status 'pending', customer_confirmed false, no confirmed_at;
 *   - the customer self-service routes hide/refuse it until the office
 *     confirms (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS membership);
 *   - reminder arming, lead conversion, the review-card resolve, and the
 *     card-on-file funnel all happen at OFFICE CONFIRM time via the shared
 *     runOutboundReviewConfirmHook (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS
 *     membership) — NEVER here;
 *   - an 'outbound_booking_review' triage card surfaces it in the existing
 *     admin confirm queue (payload.origin = 'voice_agent').
 * CREATE TIME SENDS NOTHING: no SMS, no email, no reminder registration —
 * the office/owner sends all customer communications (house rule).
 *
 * SLOT VALIDITY: the offered slot is re-checked through the SAME availability
 * engine find_slots quotes from (routes/booking.js `_internals`
 * buildBookingAvailability) before anything is written — the model's memory
 * of a slot is never trusted. House rule: no appointment may start before
 * 8:00 AM ET, enforced here as a hard floor on top of the engine.
 *
 * SERVICE IDENTITY: bookings must reference a real admin-portal catalog
 * service (owner directive 2026-07-10). The caller's ask resolves through
 * resolveCallBookingCatalogService (the call pipeline's resolver); anything
 * unclear falls back to the "Waves Assessment" catalog row (assess on-site)
 * — never an invented label. No assessment row available → no booking.
 */

const logger = require('../logger');

const EARLIEST_START_MINUTES = 8 * 60; // house rule: no client appointments before 8am ET

function isBookingGateOn() {
  return String(process.env.GATE_VOICE_AI_BOOKING || '').toLowerCase() === 'true';
}

/** Both gates, fail closed. */
function isBookingEnabled() {
  const { isContextEnabled } = require('./relay-context');
  return isContextEnabled() && isBookingGateOn();
}

/** 'YYYY-MM-DD' with a real calendar shape, else null. */
function normalizeDateInput(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** '9:00 AM' | '9 AM' | '09:00' | '13:30' → minutes past midnight, else null. */
function parseTimeToMinutes(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/\./g, '');
  let m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    if (m[3] === 'PM' && h !== 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  }
  m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

function slotStartMinutes(slot) {
  const t = String((slot && (slot.start_time || slot.startTime24)) || '');
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Re-run the SAME availability engine find_slots quotes from, pinned to the
 * requested date at the customer's on-file address, and return the engine
 * slot matching the requested start — or null (stale/invented slot).
 */
async function revalidateSlot({ customer, dateStr, startMinutes }) {
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('selfBooking')) return { status: 'engine_unavailable' };

  const booking = require('../../routes/booking')._internals;
  const config = await booking.loadBookingConfig();
  const street = String(customer.address_line1 || '').trim();
  const cityStr = String(customer.city || '').trim();
  const zipStr = String(customer.zip || '').trim();
  const addrParts = [street, cityStr, zipStr].filter(Boolean);
  const coords = await booking.resolveBookingCoords({
    address: (street || zipStr) && addrParts.length ? `${addrParts.join(', ')}, FL` : null,
    city: cityStr || null,
  });
  if (!coords.lat || !coords.lng) return { status: 'need_location' };

  const availability = await booking.buildBookingAvailability({
    lat: coords.lat,
    lng: coords.lng,
    duration: config.slot_duration_minutes || 60,
    rangeFrom: dateStr,
    rangeTo: dateStr,
    config,
    today: new Date(),
  });
  const slot = (availability.slots || []).find(
    (s) => s && s.date === dateStr && slotStartMinutes(s) === startMinutes
  );
  return slot ? { status: 'ok', slot } : { status: 'slot_gone' };
}

/** The real catalog row for the caller's ask, or the Waves Assessment fallback, or null. */
async function resolveBookableService(db, requestedService) {
  const {
    loadBookableCallServices,
    resolveCallBookingCatalogService,
  } = require('../call-booking-catalog');
  const services = await loadBookableCallServices(db);
  if (!services.length) return null;
  const asked = String(requestedService || '').trim();
  const resolved = asked
    ? resolveCallBookingCatalogService({
      extracted: { requested_service: asked, call_summary: asked },
      transcription: '',
      services,
    })
    : null;
  if (resolved) return resolved;
  // Unclear ask → the "Waves Assessment" catalog row (assess on-site) — a
  // real admin-portal service, never a guessed one. Same fallback (and same
  // name match) the call pipeline uses.
  return services.find((s) => /^waves assessment$/i.test(String(s.name || ''))) || null;
}

const REFUSE_GATE_OFF =
  'Booking requests are not available on this call. Offer open times if you have them, '
  + 'capture the lead with the caller\'s preferred time in preferred_date_time, and tell them '
  + 'a Waves team member will call to confirm. Do NOT tell the caller anything is booked.';

const REFUSE_NO_CUSTOMER =
  'Booking requests need a customer account: the caller\'s own matched account, or a '
  + 'customer_ref from lookup_customer. For a brand-new caller, capture the lead with their '
  + 'preferred time — a team member will call to book them. Do NOT tell the caller anything is booked.';

/**
 * The request_booking tool body. ctx is the relay session tool context
 * ({ customerId, callSid, resolveLookupRef, ... }).
 *
 * Returns a short model-facing script. On success the script says a team
 * member will text or call to confirm — the agent must NOT promise a locked
 * time (the row is pending office review).
 */
async function requestBookingText(input = {}, ctx = {}) {
  // Double gate, fail closed (defense in depth vs. a stale registered tool list).
  if (!isBookingEnabled()) return REFUSE_GATE_OFF;

  // Whose booking: the ANI-matched caller, or an account looked up on THIS
  // call (spouse/landlord/parent acting for the account holder).
  let customerId = null;
  const ref = String(input.customer_ref || '').trim();
  if (ref) {
    customerId = typeof ctx.resolveLookupRef === 'function' ? ctx.resolveLookupRef(ref) : null;
    if (!customerId) {
      return 'That customer_ref is not from a lookup_customer result on this call — call lookup_customer first. '
        + 'Do NOT tell the caller anything is booked.';
    }
  } else {
    customerId = ctx.customerId || null;
  }
  if (!customerId) return REFUSE_NO_CUSTOMER;

  const dateStr = normalizeDateInput(input.date);
  const startMinutes = parseTimeToMinutes(input.time);
  if (!dateStr || startMinutes === null) {
    return 'To request a booking I need the exact date (YYYY-MM-DD) and start time of a slot that '
      + 'find_slots or get_availability returned on this call. Offer times from those tools first.';
  }
  // House rule: no client appointments before 8am ET — hard floor, checked
  // before the engine is even consulted.
  if (startMinutes < EARLIEST_START_MINUTES) {
    return 'Appointments never start before 8:00 AM — do not offer or request earlier times. '
      + 'Pick a time from what find_slots returned, 8:00 AM or later.';
  }

  const db = require('../../models/db');
  const customer = await db('customers')
    .where({ id: customerId })
    .whereNull('deleted_at')
    .first('id', 'first_name', 'address_line1', 'city', 'zip');
  if (!customer) {
    return 'Could not load that account. Do not retry; capture the lead and a team member will follow up.';
  }

  // Never trust the model's memory of a slot: re-check the offered slot
  // through the same availability engine find_slots uses.
  const recheck = await revalidateSlot({ customer, dateStr, startMinutes });
  if (recheck.status === 'engine_unavailable') {
    return 'Live scheduling is not available right now, so no booking request can be placed. '
      + 'Capture the lead with the caller\'s preferred time; a team member will call to schedule.';
  }
  if (recheck.status === 'need_location') {
    return 'Could not verify the service location for this account, so no booking request was placed. '
      + 'Capture the lead with the preferred time; a team member will call to schedule.';
  }
  if (recheck.status !== 'ok') {
    return 'That time is no longer open — nothing was booked. Call find_slots again for fresh times '
      + 'and offer the caller a new option. Never promise a time the tools have not just confirmed.';
  }
  const slot = recheck.slot;

  // Real catalog service or the Waves Assessment fallback — never invented.
  const catalogRow = await resolveBookableService(db, input.service);
  if (!catalogRow) {
    return 'Could not match this to a bookable Waves service right now, so no booking request was '
      + 'placed. Capture the lead with what the caller needs; a team member will call to schedule.';
  }

  // Idempotency: a double tool-call (model retry) must not create two pending
  // rows for the same customer/slot.
  const { VOICE_AGENT_BOOKING_SOURCE_ACTION } = require('../call-booking-source-actions');
  const existing = await db('scheduled_services')
    .where({
      customer_id: customerId,
      scheduled_date: dateStr,
      source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION,
    })
    .whereIn('status', ['pending', 'confirmed'])
    .first('id', 'window_start');
  if (existing) {
    return 'A booking request for this caller and day is already in — do not create another. '
      + 'Tell the caller a Waves team member will text or call shortly to confirm the time.';
  }

  const { resolveCallBookingPrice, callBookingInvoiceOnComplete } = require('../call-booking-catalog');
  const priceInfo = resolveCallBookingPrice({ quotedPrice: null, catalogRow });

  // Link the live call's call_log row when it exists (the /voice webhook
  // creates it at call start) so the office-confirm hook can close the
  // originating lead and resolve the review card. Best-effort — a missing
  // row (sandbox path) just means the fallback lead lookup applies.
  let callLogId = null;
  if (ctx.callSid) {
    const callRow = await db('call_log')
      .where({ twilio_call_sid: ctx.callSid })
      .first('id')
      .catch(() => null);
    callLogId = (callRow && callRow.id) || null;
  }

  const requestedSummary = String(input.service || '').trim().slice(0, 160);
  const insertData = {
    customer_id: customerId,
    technician_id: slot.technician_id || null,
    scheduled_date: dateStr,
    window_start: slot.start_time || slot.startTime24,
    window_end: slot.end_time || slot.endTime24 || null,
    window_display: slot.start_label && slot.end_label ? `${slot.start_label} - ${slot.end_label}`.slice(0, 30) : null,
    service_type: catalogRow.name,
    service_id: catalogRow.id || null,
    estimated_price: priceInfo.price,
    create_invoice_on_complete: callBookingInvoiceOnComplete({ price: priceInfo.price, catalogRow }),
    estimated_duration_minutes: catalogRow.default_duration_minutes || 60,
    // PENDING office review — the office confirming it is what makes it real
    // (and what arms reminders, via the shared confirm hook). Same lifecycle
    // shape as the call pipeline's outbound-review insert.
    status: 'pending',
    customer_confirmed: false,
    // Customer-visible (GET /api/schedule returns notes verbatim) — but this
    // row is hidden from the customer while pending (dispatch-owned); keep it
    // customer-safe anyway.
    notes: 'Requested via the Waves phone assistant. A team member will confirm the time.',
    // Dispatcher-only review cue (surfaced in the dispatch JobDrawer).
    internal_notes: [
      'Voice-agent booking request — CONFIRM with customer before dispatch (pending review).',
      requestedSummary && requestedSummary.toLowerCase() !== String(catalogRow.name || '').toLowerCase()
        ? `Caller asked for: ${requestedSummary}.`
        : null,
    ].filter(Boolean).join(' '),
    booking_source: 'phone_call',
    source_call_log_id: callLogId,
    source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION,
  };

  await db.transaction(async (trx) => {
    const [created] = await trx('scheduled_services').insert(insertData).returning('*');
    // Surface the pending request in the existing admin confirm queue — the
    // same outbound_booking_review card the office already works. Only
    // possible when the live call has a call_log row (the card FKs it).
    if (callLogId && created) {
      const { buildTriageItem } = require('../call-routing-gates');
      await trx('triage_items')
        .insert(buildTriageItem({
          callLogId,
          flag: 'outbound_booking_review',
          extraction: {
            // buildTriageItem reads meta.call_summary for the card's synopsis.
            meta: {
              call_summary: `Voice-agent booking request: ${catalogRow.name} on ${dateStr} at ${slot.start_label || insertData.window_start}.`,
            },
          },
          severity: 'advisory',
          extraPayload: {
            origin: 'voice_agent',
            scheduled_service_id: created.id,
            lead_id: null,
            keep_open_for_quote: false,
          },
        }))
        .onConflict(trx.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
        .ignore();
    }
  });

  logger.info(`[voice-relay-booking] pending voice_agent booking created for customer ${customerId} on ${dateStr} (callSid=${ctx.callSid || 'n/a'})`);

  const spokenTime = slot.start_label || String(insertData.window_start);
  return `Booking REQUEST submitted for ${catalogRow.name} on ${dateStr} starting around ${spokenTime}. `
    + 'This is NOT a confirmed appointment: tell the caller a Waves team member will text or call '
    + 'shortly to confirm the final time. Do NOT say the time is locked in, booked, or guaranteed. '
    + 'Then call capture_lead as usual before ending the call.';
}

module.exports = {
  isBookingEnabled,
  isBookingGateOn,
  requestBookingText,
  parseTimeToMinutes,
  normalizeDateInput,
  EARLIEST_START_MINUTES,
};
