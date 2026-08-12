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
 * Re-run the SAME availability engine, with the SAME inputs the offer was
 * generated from, pinned to the offered date — and return the engine slot
 * matching the offered start, or a status the caller turns into script.
 *
 * TWO THINGS THIS GETS RIGHT THAT THE FIRST CUT DID NOT:
 *
 *  1. It searches `days[].slots`, not `availability.slots`. The latter is
 *     `curateSlots(...)` output: at most FOUR picks, at most ONE PER DATE,
 *     score-ranked with an AM/PM diversity swap. A caller offered "Wednesday
 *     2 PM" whose day's top pick is 9 AM would re-validate against a list
 *     containing only the 9 AM and get `slot_gone` — for a slot that was still
 *     wide open. `days[].slots` is the full per-day list (up to 8 with
 *     expandOpenDays).
 *  2. It carries the ORIGINAL `timeOfDay`, `expandOpenDays`, coords and
 *     duration. timeOfDay is not merely a narrowing filter: dropping it lets
 *     morning candidates push an afternoon slot out of the per-day cap
 *     (`slots.slice(0, perDayCap)` after a start_time sort), so re-running
 *     "wide" can LOSE the very slot that was offered. Coords likewise — the
 *     offer was route-scored from the address the CALLER gave, and re-scoring
 *     from a different origin returns a different slot set.
 */
async function revalidateSlot({ offer }) {
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('selfBooking')) return { status: 'engine_unavailable' };
  if (!offer || !offer.lat || !offer.lng || !offer.date) return { status: 'need_location' };

  const booking = require('../../routes/booking')._internals;
  const config = await booking.loadBookingConfig();

  // COMMIT-TIME DATE BOUNDS, the same mirror createSelfBooking applies
  // (advance_days_min floor + the 90-day browse horizon), BEFORE the engine is
  // consulted. Without it a stale offer — or a model-invented date — could ask
  // to book a same-day slot the builder never offers, or one 300 days out.
  const dateError = booking.validateBookingSlotDate(offer.date, config);
  if (dateError) return { status: 'date_out_of_bounds', message: dateError };

  // Past date / past time, ET-anchored exactly like createSelfBooking's own
  // pre-transaction checks (`scheduled_date` is a DATE, so a plain ET-day
  // string comparison is the correct predicate — no timestamptz window).
  const { etDateString, etParts } = require('../../utils/datetime-et');
  const todayEt = etDateString();
  if (offer.date < todayEt) return { status: 'in_the_past' };
  if (offer.date === todayEt) {
    const nowEt = etParts(new Date());
    if (offer.startMinutes <= nowEt.hour * 60 + nowEt.minute) return { status: 'in_the_past' };
  }

  const availability = await booking.buildBookingAvailability({
    lat: offer.lat,
    lng: offer.lng,
    duration: offer.duration || config.slot_duration_minutes || 60,
    rangeFrom: offer.date,
    rangeTo: offer.date,
    config,
    today: new Date(),
    timeOfDay: offer.timeOfDay || 'any',
    expandOpenDays: offer.expandOpenDays === true,
  });
  const day = (availability.days || []).find((d) => d && d.date === offer.date);
  const slot = ((day && day.slots) || []).find((s) => s && slotStartMinutes(s) === offer.startMinutes);
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

const { VOICE_AGENT_BOOKING_SOURCE_ACTION } = require('../call-booking-source-actions');

/**
 * THE COMMIT GATE. Everything above this point is an OFFER; this is the write,
 * and it takes the same gates every other scheduled_services writer takes.
 *
 * Before this, the voice booking called the availability BUILDER and then
 * inserted in a plain transaction with no locks and no re-check. The builder is
 * an OFFER surface — services/scheduling/occupancy.js lists it as EXEMPT from
 * the lock contract precisely BECAUSE "every offer is re-validated under lock at
 * its own commit gate". This writer had no such gate, so two callers (or a
 * caller racing a web booker) could take the same slot.
 *
 * LOCK LADDER — the ORDERING CONTRACT in services/scheduling/occupancy.js,
 * coarsest first, skipping only the rungs this writer does not need:
 *   1. date-occupancy   acquireOccupancyLock(trx, date)              [required]
 *   2. self-booking     'self-booking-confirm' / `<customerId>:<date>`
 *   3. technician       'slot-reserve' / `<techId>:<date>`  (when assigned)
 *   4. zone             SKIPPED — this writer resolves no zone
 *   5. global day cap   acquireSelfBookingDayCapLock(trx, date)
 *   6. customer-comms   lockCustomerComms(trx, customerId)           [required
 *      of EVERY writer that COMMITS a scheduled_services INSERT, and taken
 *      before any row lock]
 *
 * And the second half of the contract: a rung-1 holder MUST run the GLOBAL
 * predicate (findConflictingVisits) under the lock, before its insert. The lock
 * only serializes writers; it cannot widen what a writer's own narrow check
 * sees, and this writer's dedupe is customer-scoped, so the global probe is the
 * only thing that catches a different customer's committed row in the window.
 */
async function commitVoiceBooking({
  db, customerId, dateStr, windowStart, windowEnd, insertData, callLogId,
  catalogRow, slot, thirdParty, unverifiedNote, leadId,
}) {
  const { acquireOccupancyLock, findConflictingVisits } = require('../scheduling/occupancy');
  const { acquireSelfBookingDayCapLock, countActiveSelfBookingsForDay } = require('../availability');
  const { lockCustomerComms } = require('../../utils/customer-comms-lock');
  const booking = require('../../routes/booking')._internals;
  const config = await booking.loadBookingConfig();
  const { maxPerDay } = booking.bookingSlotWindow(config);
  // window_end may be NULL on a slot with no explicit end; the conflict
  // predicate needs a real end, so fall back to the row's own duration.
  const endTime = windowEnd || addMinutesToClock(windowStart, insertData.estimated_duration_minutes || 60);

  try {
    return await db.transaction(async (trx) => {
      // Rung 1 — FIRST statement in the transaction, before every row lock.
      await acquireOccupancyLock(trx, dateStr);
      // Rung 2 — serializes this customer's own same-day writers, which is
      // what makes the read-then-insert dedupe below safe (it was a bare
      // read-then-insert with no constraint behind it).
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['self-booking-confirm', `${customerId}:${dateStr}`],
      );
      // Rung 3 — only when the offer carries a technician.
      if (insertData.technician_id) {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['slot-reserve', `${insertData.technician_id}:${dateStr}`],
        );
      }
      // Rung 5 — the global self-booking day cap.
      await acquireSelfBookingDayCapLock(trx, dateStr);
      // Rung 6 — every scheduled_services INSERT owes this one.
      await lockCustomerComms(trx, customerId);

      // DEDUPE, now under rung 2. Widened past the old
      // source_action='voice_agent' scope: the point is not "no second VOICE
      // booking", it is "do not put this customer in two places at once", so
      // any live row of theirs at that date+start counts.
      const existing = await trx('scheduled_services')
        .where({ customer_id: customerId, scheduled_date: dateStr })
        .whereNotIn('status', ['cancelled', 'rescheduled'])
        .where((q) => q
          .where('window_start', windowStart)
          .orWhere('source_action', VOICE_AGENT_BOOKING_SOURCE_ACTION))
        .first('id');
      if (existing) return { status: 'duplicate' };

      // Commit-time max_self_books_per_day re-check, the same predicate the
      // availability builder drops full days with (shared helper). The builder's
      // cap is advisory-only without this.
      const dayCount = await countActiveSelfBookingsForDay(trx, dateStr);
      if (dayCount >= maxPerDay) return { status: 'day_full' };

      // The GLOBAL, tech-blind occupancy probe the contract requires of every
      // rung-1 holder. Excludes this customer's own rows only via the dedupe
      // above — a clash here is somebody ELSE's committed visit or live hold.
      const clash = await findConflictingVisits({
        db: trx, date: dateStr, windowStart, windowEnd: endTime,
      });
      if (clash.length) return { status: 'slot_taken' };

      const [created] = await trx('scheduled_services').insert(insertData).returning('*');
      // Surface the pending request in the existing admin confirm queue — the
      // same outbound_booking_review card the office already works. Only
      // possible when the live call has a call_log row (the card FKs it).
      if (callLogId && created) {
        const { buildTriageItem } = require('../call-routing-gates');
        const synopsis = `Voice-agent booking request: ${catalogRow.name} on ${dateStr} at `
          + `${slot.start_label || windowStart}.`
          + (unverifiedNote ? ` ⚠️ ${unverifiedNote}` : '');
        await trx('triage_items')
          .insert(buildTriageItem({
            callLogId,
            flag: 'outbound_booking_review',
            extraction: {
              // buildTriageItem reads meta.call_summary for the card's synopsis.
              meta: { call_summary: synopsis },
            },
            severity: 'advisory',
            extraPayload: {
              origin: 'voice_agent',
              scheduled_service_id: created.id,
              // Threaded from capture_lead when it already ran on this call.
              // outbound-review-confirm.js falls back to "the customer's single
              // active lead" when this is null — which can convert an unrelated
              // open quote to WON.
              lead_id: leadId || null,
              keep_open_for_quote: false,
              // Read by the office confirm queue UI alongside the synopsis.
              unverified_requester: Boolean(thirdParty),
              ...(unverifiedNote ? { unverified_requester_note: unverifiedNote } : {}),
            },
          }))
          .onConflict(trx.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
          .ignore();
      }
      return { status: 'ok', scheduledServiceId: created && created.id, callLogId };
    });
  } catch (err) {
    logger.error(`[voice-relay-booking] commit failed for customer ${customerId} on ${dateStr}: ${err.message}`);
    return { status: 'error' };
  }
}

/** 'HH:MM[:SS]' + minutes → 'HH:MM:SS' (the conflict predicate needs a real end). */
function addMinutesToClock(value, minutes) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (Number(minutes) || 0);
  const h = Math.floor(total / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
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

  // ONE booking request per call. The triage card's onConflict is
  // `(call_log_id, reason_code) WHERE status IN ('open','in_progress')`, so a
  // SECOND booking on the same call gets NO review card — it lands on the
  // dispatch calendar invisible to the office confirm queue, which is the one
  // thing that makes a pending voice booking real. Refusing the second is the
  // safe half of "one card per booking, or refuse a second booking per call".
  if (typeof ctx.bookingRequested === 'function' && ctx.bookingRequested() === true) {
    return 'A booking request has already been placed on this call — do NOT place another. If the caller '
      + 'wants a different time, tell them the Waves team member who calls to confirm can move it. '
      + 'Do not say anything is booked or guaranteed.';
  }

  // Whose booking: the ANI-matched caller, or an account looked up on THIS
  // call (spouse/landlord/parent acting for the account holder).
  let customerId = null;
  let thirdParty = false;
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
  // ⭐ AN UNVERIFIED THIRD-PARTY REQUESTER. lookup_customer can hand back a ref
  // for an account the caller's phone did NOT match, so a caller who knows a
  // name and a street can put a pending booking on a stranger's account — and
  // the office confirming it runs runOutboundReviewConfirmHook, which arms
  // reminders and opens the card-on-file funnel toward that customer. The row
  // and the review card both carry a loud, explicit warning so the human who
  // confirms it knows to verify identity first.
  thirdParty = customerId !== (ctx.customerId || null);

  // The OPAQUE SLOT REF the availability tools handed the model. Refs, not an
  // echoed 'YYYY-MM-DD' + '9:00 AM' pair: speakSlot says "Tuesday August 18 at
  // 9 AM" with no ISO date anywhere, so asking request_booking for a date
  // string made the model reconstruct a key it was never given. Same doctrine
  // as the lookup refs — an invented ref resolves to nothing.
  const slotRef = String(input.slot_ref || '').trim();
  const offer = slotRef && typeof ctx.resolveSlotRef === 'function' ? ctx.resolveSlotRef(slotRef) : null;
  if (!offer) {
    return 'To request a booking I need the slot_ref of a time that find_slots or get_availability '
      + 'returned on THIS call (they look like S1, S2). Call one of those tools, read the caller two or '
      + 'three of the options, and pass back the slot_ref they picked. Never invent one.';
  }
  const dateStr = offer.date;
  const startMinutes = offer.startMinutes;
  // House rule: no client appointments before 8am ET — hard floor, checked
  // before the engine is even consulted.
  if (!Number.isFinite(startMinutes) || startMinutes < EARLIEST_START_MINUTES) {
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
  // through the same availability engine, with the same inputs, right now.
  const recheck = await revalidateSlot({ offer });
  if (recheck.status === 'engine_unavailable') {
    return 'Live scheduling is not available right now, so no booking request can be placed. '
      + 'Capture the lead with the caller\'s preferred time; a team member will call to schedule.';
  }
  if (recheck.status === 'need_location') {
    return 'Could not verify the service location for this account, so no booking request was placed. '
      + 'Capture the lead with the preferred time; a team member will call to schedule.';
  }
  if (recheck.status === 'in_the_past' || recheck.status === 'date_out_of_bounds') {
    return 'That day is not open for booking any more — nothing was booked. Call find_slots again for '
      + 'fresh times and offer the caller a new option.';
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

  const { maskPhone } = require('./relay-protocol');
  const unverifiedNote = thirdParty
    ? `UNVERIFIED third-party requester — verify identity before confirming. Requested by the caller on `
      + `${maskPhone(ctx.from)}, whose phone number does NOT match this account.`
    : null;
  const requestedSummary = String(input.service || '').trim().slice(0, 160);
  const windowStart = slot.start_time || slot.startTime24;
  const insertData = {
    customer_id: customerId,
    technician_id: slot.technician_id || null,
    scheduled_date: dateStr,
    window_start: windowStart,
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
      unverifiedNote,
      requestedSummary && requestedSummary.toLowerCase() !== String(catalogRow.name || '').toLowerCase()
        ? `Caller asked for: ${requestedSummary}.`
        : null,
    ].filter(Boolean).join(' '),
    booking_source: 'phone_call',
    source_call_log_id: callLogId,
    source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION,
  };

  const commit = await commitVoiceBooking({
    db, customerId, dateStr, windowStart, windowEnd: insertData.window_end,
    insertData, callLogId, catalogRow, slot, thirdParty, unverifiedNote,
    leadId: typeof ctx.leadId === 'function' ? ctx.leadId() : (ctx.leadId || null),
  });
  if (commit.status === 'duplicate') {
    return 'A booking request for this caller and day is already in — do not create another. '
      + 'Tell the caller a Waves team member will text or call shortly to confirm the time.';
  }
  if (commit.status === 'slot_taken') {
    return 'That time was just taken by someone else — NOTHING was booked. Call find_slots again for '
      + 'fresh times and offer the caller a new option.';
  }
  if (commit.status === 'day_full') {
    return 'That day just filled up — NOTHING was booked. Call find_slots again and offer the caller a '
      + 'different day.';
  }
  if (commit.status !== 'ok') {
    return 'The booking request could not be placed — NOTHING was booked. Tell the caller a Waves team '
      + 'member will call to schedule, and capture the lead with their preferred time.';
  }

  if (typeof ctx.markBookingRequested === 'function') ctx.markBookingRequested(commit.callLogId || callLogId);
  logger.info(
    `[voice-relay-booking] pending voice_agent booking created for customer ${customerId} on ${dateStr}`
    + `${thirdParty ? ' [UNVERIFIED third-party requester]' : ''} (callSid=${ctx.callSid || 'n/a'})`
  );

  const spokenTime = slot.start_label || String(windowStart);
  return `Booking REQUEST submitted for ${catalogRow.name} on ${dateStr} starting around ${spokenTime}. `
    + 'This is NOT a confirmed appointment: tell the caller a Waves team member will text or call '
    + 'shortly to confirm the final time. Do NOT say the time is locked in, booked, or guaranteed. '
    + 'Then call capture_lead as usual before ending the call.';
}

/**
 * Back-fill `payload.lead_id` on the booking review card for this call.
 *
 * request_booking normally runs BEFORE capture_lead (the prompt tells the agent
 * to book, then capture), so the lead id does not exist yet when the card is
 * written. Without it, outbound-review-confirm.js takes its documented
 * pre-payload fallback — "the customer's single active lead" — which can
 * convert an unrelated open quote to WON on confirm.
 *
 * Best-effort and never throws: the card is already durable, and the fallback
 * is what happens today.
 */
async function attachLeadToVoiceBookingCard(callSid, leadId) {
  if (!callSid || !leadId) return false;
  try {
    const db = require('../../models/db');
    const callRow = await db('call_log').where({ twilio_call_sid: callSid }).first('id');
    if (!callRow) return false;
    const card = await db('triage_items')
      .where({ call_log_id: callRow.id, reason_code: 'outbound_booking_review' })
      .whereIn('status', ['open', 'in_progress'])
      .orderBy('created_at', 'desc')
      .first('id', 'payload');
    if (!card) return false;
    const payload = typeof card.payload === 'string' ? JSON.parse(card.payload) : (card.payload || {});
    if (payload.origin !== 'voice_agent' || payload.lead_id) return false; // not ours, or already set
    await db('triage_items')
      .where({ id: card.id })
      .update({ payload: JSON.stringify({ ...payload, lead_id: leadId }), updated_at: new Date() });
    logger.info(`[voice-relay-booking] lead ${leadId} attached to booking review card ${card.id}`);
    return true;
  } catch (err) {
    logger.warn(`[voice-relay-booking] could not attach lead ${leadId} to the booking review card: ${err.message}`);
    return false;
  }
}

module.exports = {
  attachLeadToVoiceBookingCard,
  isBookingEnabled,
  isBookingGateOn,
  requestBookingText,
  commitVoiceBooking,
  revalidateSlot,
  parseTimeToMinutes,
  normalizeDateInput,
  addMinutesToClock,
  EARLIEST_START_MINUTES,
};
