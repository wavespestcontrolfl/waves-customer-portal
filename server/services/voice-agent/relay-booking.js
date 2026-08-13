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

// Rollback sentinel: this call already holds an open outbound_booking_review
// card, so a second booking would land outside the office confirm queue.
// Carried on err.code so the commit's own catch can tell it apart from a real
// failure (see the throw site in commitVoiceBooking).
const VOICE_BOOKING_CARD_TAKEN = 'VOICE_BOOKING_CARD_TAKEN';

function isBookingGateOn() {
  return String(process.env.GATE_VOICE_AI_BOOKING || '').toLowerCase() === 'true';
}

// Sub-gate: may an UNVERIFIED requester (a looked-up account, or an ANI that
// matched only a service-contact slot) have ANYTHING written for them — a
// booking here, a re-service ticket in relay-reservice? Off by default; one
// switch for both, because they are one question. Same exact-'true' shape as
// every gate here.
function allowsThirdPartyWrites() {
  return String(process.env.VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES || '').toLowerCase() === 'true';
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
 *  2. It carries the ORIGINAL `timeOfDay`, `expandOpenDays` and coords.
 *     timeOfDay is not merely a narrowing filter: dropping it lets
 *     morning candidates push an afternoon slot out of the per-day cap
 *     (`slots.slice(0, perDayCap)` after a start_time sort), so re-running
 *     "wide" can LOSE the very slot that was offered. Coords likewise — the
 *     offer was route-scored from the address the CALLER gave, and re-scoring
 *     from a different origin returns a different slot set.
 *
 * DURATION is the one input deliberately NOT taken from the offer. The offer
 * was generated with the GLOBAL slot duration (relay-tools.resolveAvailability
 * reads config.slot_duration_minutes), but the row this writer inserts occupies
 * the CATALOG service's duration — so a 90-minute service offered in a
 * 60-minute slot was conflict-checked for only 60 and the next job could
 * overlap it. The caller resolves the catalog service FIRST and passes
 * `durationMinutes` here, so the re-check, the engine's `end_time`, the written
 * `window_end` and `estimated_duration_minutes` all describe the SAME window.
 * A service that no longer fits at the offered start simply fails the re-check
 * (slot_gone) — fail closed, exactly like any other stale offer.
 */
async function revalidateSlot({ offer, durationMinutes = null }) {
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
    duration: durationMinutes || offer.duration || config.slot_duration_minutes || 60,
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

// The window the booked row will OCCUPY, resolved from the admin-portal
// catalog row (server-side, never model-supplied) and sanity-bounded the same
// way routes/booking.resolveBookingDuration bounds its own input: a catalog
// row with a null/0/absurd default_duration_minutes falls back to the duration
// the slot was OFFERED with, then to 60. This one number drives the
// availability re-check, the conflict probe and the written row — see
// revalidateSlot's DURATION note.
const MIN_VOICE_BOOKING_DURATION_MINUTES = 15;
const MAX_VOICE_BOOKING_DURATION_MINUTES = 480;
function resolveVoiceBookingDuration(catalogRow, offer) {
  const catalog = parseInt(catalogRow && catalogRow.default_duration_minutes, 10);
  if (Number.isInteger(catalog)
    && catalog >= MIN_VOICE_BOOKING_DURATION_MINUTES
    && catalog <= MAX_VOICE_BOOKING_DURATION_MINUTES) {
    return catalog;
  }
  const offered = parseInt(offer && offer.duration, 10);
  if (Number.isInteger(offered) && offered > 0) return offered;
  return 60;
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
  // predicate needs a real end, so fall back to the row's own duration. When
  // BOTH exist they agree by construction (the engine was re-run with the
  // catalog duration), but take the LATER of the two anyway: the probe must
  // never cover less time than the row it is about to write claims to occupy.
  const durationEnd = addMinutesToClock(windowStart, insertData.estimated_duration_minutes || 60);
  const endTime = laterClock(windowEnd, durationEnd);
  // …and the ROW carries that same end. Every other writer's occupancy
  // predicate reads COALESCE(window_end, window_start + estimated_duration), so
  // a window_end shorter than the duration would under-cover this visit for
  // everyone else too. Identical to `windowEnd` whenever the two agree.
  const insertRow = { ...insertData, window_end: endTime };

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
        // A REJECTED request (office 'skipped') is not a live booking and
        // must not block a replacement — the same inactive set the day cap and
        // the activation helper honour.
        .whereNotIn('status', ['cancelled', 'rescheduled', 'skipped'])
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
        // ⭐ INACTIVE ROWS ARE NOT OCCUPANCY. The helper's default excludes only
        // 'cancelled', but a REJECTED voice booking lands on 'skipped' and a
        // superseded one on 'rescheduled' — every other rail in this lane
        // treats all three as inactive, and counting them here made the very
        // slot the office just freed report slot_taken to its replacement.
        excludeStatuses: ['cancelled', 'skipped', 'rescheduled'],
      });
      if (clash.length) return { status: 'slot_taken' };

      const [created] = await trx('scheduled_services').insert(insertRow).returning('*');
      // Surface the pending request in the existing admin confirm queue — the
      // same outbound_booking_review card the office already works. Only
      // possible when the live call has a call_log row (the card FKs it).
      if (callLogId && created) {
        const { buildTriageItem } = require('../call-routing-gates');
        const synopsis = `Voice-agent booking request: ${catalogRow.name} on ${dateStr} at `
          + `${slot.start_label || windowStart}.`
          + (unverifiedNote ? ` ⚠️ ${unverifiedNote}` : '');
        const [card] = await trx('triage_items')
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
          .ignore()
          .returning('id');
        // ⭐ THE ONE-BOOKING-PER-CALL INVARIANT, ENFORCED BY THE DATABASE.
        //
        // requestBookingText refuses a second booking using the session's
        // in-memory latch, and that latch is only as durable as the session
        // object: a WebSocket reconnect on the SAME CallSid builds a fresh
        // RelayConversation with the latch cleared and the slot registry
        // empty, so a second booking on a DIFFERENT date clears the
        // customer+date dedupe above and inserts. Its card is then swallowed
        // by `triage_items_open_unique_idx` (one open card per
        // call_log_id+reason_code) — and a pending row with no card is
        // invisible to the office confirm queue, which is the only thing that
        // makes a pending voice booking real.
        //
        // So the CARD is the invariant, not the latch: no card, no booking.
        // The conflict-ignore returns no row precisely when this call already
        // holds an open review card, and throwing here rolls the
        // scheduled_services insert back with it. Same transaction, so the
        // check cannot be raced by a concurrent second session either.
        if (!card) {
          const err = new Error('a review card is already open for this call');
          err.code = VOICE_BOOKING_CARD_TAKEN;
          throw err;
        }
      } else if (created) {
        // LOUD: a pending row with no review card is invisible to the office
        // confirm queue. requestBookingText refuses to reach this state at all
        // (no call_log row ⇒ no booking), so this is a defensive guard for any
        // other caller of this exported writer — if it ever fires, the row
        // needs finding by hand.
        logger.error(
          `[voice-relay-booking] pending booking ${created.id} for customer ${customerId} created with NO `
          + 'outbound_booking_review card (no call_log row for this call) — it is invisible to the office confirm queue'
        );
      }
      return { status: 'ok', scheduledServiceId: created && created.id, callLogId };
    });
  } catch (err) {
    // Not a failure: the deliberate rollback that keeps "one booking per call"
    // true when the session latch has been reset by a reconnect.
    if (err && err.code === VOICE_BOOKING_CARD_TAKEN) {
      logger.warn(
        `[voice-relay-booking] second booking on call ${callLogId} rolled back — `
        + 'this call already holds an open outbound_booking_review card'
      );
      return { status: 'already_requested' };
    }
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

/** 'HH:MM[:SS]' → minutes past midnight, else null (clock comparison helper). */
function clockToMinutes(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/** The later of two 'HH:MM[:SS]' clocks; either may be null/unparseable. */
function laterClock(a, b) {
  const am = clockToMinutes(a);
  const bm = clockToMinutes(b);
  if (am === null) return b || null;
  if (bm === null) return a || null;
  return bm > am ? b : a;
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
  // ⭐ AN UNVERIFIED THIRD-PARTY REQUESTER — AND THERE ARE TWO WAYS TO BE ONE.
  //
  //  (a) A LOOKED-UP REF. lookup_customer can hand back a ref for an account
  //      the caller's phone did NOT match, so a caller who knows a name and a
  //      street can put a pending booking on a stranger's account.
  //
  //  (b) A REDACTED-TIER ANI MATCH — the hole this comparison used to have.
  //      The ANI match only earns 'full' when the calling number IS the
  //      account's own `customers.phone`; a match on one of the
  //      `service_contact*_phone` slots (a lead-dedup column set that holds
  //      spouses, tenants and PRIOR OCCUPANTS) recognises the account and
  //      authenticates NOBODY (relay-context.findUniqueCustomerByAni,
  //      relay-tools.matchedCallerTier — the same predicate every read path
  //      already honours). Those callers arrive with ctx.customerId SET, so an
  //      id-only comparison scored them as the account holder and stamped
  //      nothing at all.
  //
  // The write stays ALLOWED in both cases — a spouse calling about the family
  // account is the common, legitimate case — but it is marked UNVERIFIED. The
  // office confirming this row runs runOutboundReviewConfirmHook, which arms
  // reminders and opens the card-on-file funnel toward that customer, and
  // #3361 removed the office-review dispatch/reschedule hold, so a pending
  // voice booking can be MOVED by a dispatcher with no explicit confirm step.
  // The written warning is therefore the primary signal a human gets: it lands
  // on the row's internal_notes, the triage card's synopsis, and the card
  // payload.
  const { matchedCallerTier } = require('./relay-tools');
  const unverifiedTier = matchedCallerTier(ctx) !== 'full';
  const lookedUpAccount = customerId !== (ctx.customerId || null);
  thirdParty = lookedUpAccount || unverifiedTier;
  // …AND THE STAMP IS NOT AN AUTHORIZATION CONTROL, SO IT NO LONGER STANDS
  // ALONE. lookup_customer needs two criteria and is budgeted per session, but
  // a name and a street are not a secret: without a switch in front of it, a
  // caller who has both can put a pending row on a stranger's calendar, and a
  // dispatcher moving that row is enough to arm reminders and the card-on-file
  // funnel toward the real customer. So an unverified requester's booking is
  // now itself gated, and the gate ships OFF: by default only a FULL ANI match
  // (the calling number IS `customers.phone`) may write a booking, and everyone
  // else — looked-up refs and contact-slot matches alike — is captured as a
  // lead for a human to call back. `VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES=true`
  // restores the spouse/landlord case, with the UNVERIFIED stamps below as the
  // human-facing signal. Owner decision, one flag, either way reviewable.
  if (thirdParty && !allowsThirdPartyWrites()) {
    return 'Booking requests are only placed for the account the caller\'s own phone number matches. '
      + 'Capture the lead with the caller\'s name, the account they are calling about and their preferred '
      + 'time, and tell them a Waves team member will call to confirm. Do NOT tell the caller anything is booked.';
  }

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
    .first('id', 'first_name', 'address_line1', 'city', 'state', 'zip', 'latitude', 'longitude');
  if (!customer) {
    return 'Could not load that account. Do not retry; capture the lead and a team member will follow up.';
  }

  // Real catalog service or the Waves Assessment fallback — never invented.
  // Resolved BEFORE the availability re-check on purpose: the catalog row
  // carries the duration the booked window must occupy, and the re-check has to
  // ask the engine for THAT window, not the global slot length the offer was
  // generated with (see revalidateSlot's DURATION note).
  const catalogRow = await resolveBookableService(db, input.service);
  if (!catalogRow) {
    return 'Could not match this to a bookable Waves service right now, so no booking request was '
      + 'placed. Capture the lead with what the caller needs; a team member will call to schedule.';
  }
  const bookingDurationMinutes = resolveVoiceBookingDuration(catalogRow, offer);

  // ⭐ WHICH PROPERTY? A voice booking has no address field — the visit is
  // serviced at the account's address — but an account can have more than one
  // (a home and a rental). `scheduled_services.property_id` +
  // `service_address_*` exist precisely because a booking with no property
  // linkage renders and dispatches to the customer's primary mirror address,
  // which is how a rental's visit ended up at the owner's house. The agent
  // cannot ask "which property" (there is no parameter for it, and a voice
  // answer is not evidence), so a MULTI-PROPERTY account fails closed here and
  // a human calls back. Single-property and legacy accounts resolve through the
  // call pipeline's own linkage helper, and the visit carries the stamp.
  let propertyLinkage = null;
  // True once we know the account HAS at least one property row — after which a
  // linkage failure may never degrade to the mirror address.
  let linkageAttemptedWithProperties = false;
  try {
    const { resolveCallBookingPropertyLinkage } = require('../call-recording-processor');
    // `active`, not a soft-delete column — customer_properties has no
    // `deleted_at`, so filtering on one made Postgres reject the query and the
    // catch below scored EVERY account as zero properties. That is the guard
    // failing OPEN, which is the one thing it must not do: fail closed on an
    // unanswerable count (-1 is not "no properties", it is "ask a human").
    const propertyCount = await db('customer_properties')
      .where({ customer_id: customerId, active: true })
      .count('* as count')
      .first()
      .then((r) => parseInt((r && r.count) || 0, 10))
      .catch((err) => {
        logger.error(`[voice-relay-booking] property count failed for ${customerId} — refusing the booking: ${err.message}`);
        return -1;
      });
    if (propertyCount < 0) {
      return 'I could not confirm which property this account has on file, so nothing was booked. Capture the '
        + 'lead with the address they mean and their preferred time; a Waves team member will call to confirm.';
    }
    if (propertyCount > 1) {
      return 'This account has more than one property on file, and I cannot tell which one this visit is for, '
        + 'so nothing was booked. Capture the lead with the property they mean and their preferred time, and '
        + 'tell the caller a Waves team member will call to confirm which address.';
    }
    linkageAttemptedWithProperties = propertyCount >= 1;
    // Empty extraction ⇒ the helper falls back to the on-file address, matches
    // it against the property rows, and returns its geocode.
    propertyLinkage = await resolveCallBookingPropertyLinkage(customerId, {}, db);
    // …and a ONE-property account whose property the helper could not match is
    // the same ambiguity as a multi-property one, quietly: propertyLinkage stays
    // null, the visit is written with no property_id, and dispatch falls back to
    // the customer's primary mirror address — the exact premise mix-up this
    // guard exists to prevent. A property on file that cannot be resolved is a
    // question for a human, not a fallback.
    if (propertyCount === 1 && !(propertyLinkage && propertyLinkage.propertyId)) {
      logger.warn(
        `[voice-relay-booking] customer ${customerId} has one property on file that the linkage could not `
        + 'resolve — refusing the booking rather than dispatching to the mirror address'
      );
      return 'I could not confirm the service address on this account, so nothing was booked. Capture the lead '
        + 'with the address they mean and their preferred time; a Waves team member will call to confirm.';
    }
  } catch (err) {
    // ⭐ AND AN ERROR IS NOT A LEGACY ACCOUNT. Falling through here after a
    // property WAS found sends the visit to the customer's mirror address with
    // no property_id — the same wrong-premise dispatch the guard above refuses
    // when it can see the ambiguity. Only an account with zero property rows
    // may use the on-file address, and a failed COUNT already refused above.
    logger.warn(`[voice-relay-booking] property linkage unavailable for ${customerId}: ${err.message}`);
    if (linkageAttemptedWithProperties) {
      return 'I could not confirm the service address on this account, so nothing was booked. Capture the lead '
        + 'with the address they mean and their preferred time; a Waves team member will call to confirm.';
    }
  }

  // ⭐ RE-VALIDATE AT THE ADDRESS THE TECH WILL ACTUALLY DRIVE TO.
  //
  // The OFFER was route-scored from whatever address the model handed
  // find_slots — the caller's spoken words (relay-tools.resolveAvailability
  // geocodes `address_line1`/`city`/`zip` from the tool input and never
  // consults the matched account). The ROW this writer inserts carries no
  // address at all: the visit is serviced at the customer's stored address.
  // So an offer scored from one town could be committed as a visit in
  // another, and the drive-time/zone engine — the entire reason this lane
  // books through it instead of a generic calendar — would have validated a
  // route nobody is driving.
  //
  // The account's own coordinates are therefore the authority for the commit
  // re-check, resolved through the same helper the /book route uses (stored
  // lat/lng first, geocoded street address behind it). Everything else about
  // the offer is preserved deliberately (timeOfDay, expandOpenDays, date,
  // start) — see revalidateSlot's note on why dropping those loses slots. If
  // the slot does not survive at the real address, that is a stale offer like
  // any other: nothing is booked and the agent finds fresh times.
  // The property linkage's own geocode wins when it resolved one: that is the
  // pin the visit will carry, so it is the origin the route must be scored from.
  const bookingCoords = (propertyLinkage && propertyLinkage.lat && propertyLinkage.lng)
    ? { lat: propertyLinkage.lat, lng: propertyLinkage.lng }
    : await require('../../routes/booking')._internals.resolveBookingCoords({
      lat: customer.latitude || null,
      lng: customer.longitude || null,
      address: [customer.address_line1, customer.city, customer.state, customer.zip]
        .filter(Boolean).join(', ') || null,
      city: customer.city || null,
    }).catch(() => ({}));
  if (!bookingCoords || !bookingCoords.lat || !bookingCoords.lng) {
    return 'Could not verify the service location for this account, so no booking request was placed. '
      + 'Capture the lead with the preferred time; a team member will call to schedule.';
  }
  // Never trust the model's memory of a slot: re-check the offered slot
  // through the same availability engine, right now, at the account's address.
  const recheck = await revalidateSlot({
    offer: { ...offer, lat: bookingCoords.lat, lng: bookingCoords.lng },
    durationMinutes: bookingDurationMinutes,
  });
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

  const { resolveCallBookingPrice, callBookingInvoiceOnComplete } = require('../call-booking-catalog');
  const priceInfo = resolveCallBookingPrice({ quotedPrice: null, catalogRow });

  // Link the live call's call_log row (the signature-verified /voice webhook
  // creates it at call start) — it is what the review card FKs, and what lets
  // the office-confirm hook close the originating lead and resolve that card.
  // REQUIRED, not best-effort: no row ⇒ no card ⇒ no booking (below).
  let callLogId = null;
  if (ctx.callSid) {
    try {
      const callRow = await db('call_log')
        .where({ twilio_call_sid: ctx.callSid })
        .first('id');
      callLogId = (callRow && callRow.id) || null;
    } catch (lookupErr) {
      // ⭐ FAIL CLOSED ON AN UNANSWERABLE LOOKUP. A row with no card lands on
      // the dispatch calendar invisible to the office confirm queue — the one
      // thing that makes a pending voice booking real (see the one-per-call
      // guard above) — so a TRANSIENT failure here must not be swallowed into
      // `null` and read as "this call has no call_log row". Same doctrine as
      // the re-service dedupe: an unanswerable question is not a licence to
      // write. (A genuine ABSENCE refuses too, just below — with its own
      // message, because it is a different answer.)
      logger.error(`[voice-relay-booking] call_log lookup FAILED for callSid ${ctx.callSid} — refusing to book (no review-card linkage): ${lookupErr.message}`);
      return 'I could not reach the system that puts this in front of the office, so NOTHING was booked. '
        + 'Tell the caller a Waves team member will call to schedule, and capture the lead with their '
        + 'preferred time. Do NOT say anything is booked.';
    }
  }
  // NO CARD, NO BOOKING. The outbound_booking_review card is the office's only
  // view of a pending voice booking — a row without one sits on the dispatch
  // calendar hidden from the confirm queue that is supposed to make it real,
  // and the customer can't see it either (dispatch-owned). The card FKs
  // call_log, so no call_log row means no card: refuse rather than commit an
  // invisible appointment. In production this is unreachable (the
  // signature-verified /voice webhook writes the row at call start); the
  // TwiML-Bin sandbox path has no call_log row and now declines to book, which
  // is the right answer for a harness that cannot surface the request either.
  if (!callLogId) {
    logger.warn(`[voice-relay-booking] no call_log row for callSid=${ctx.callSid || 'n/a'} — refusing to book (the review card is what makes a pending booking real)`);
    return 'I cannot put a booking request in front of the office on this call, so NOTHING was booked. '
      + 'Capture the lead with the caller\'s preferred time and tell them a Waves team member will call '
      + 'to schedule. Do NOT say anything is booked.';
  }

  const { maskPhone } = require('./relay-protocol');
  // Same loud opener either way (the office queue and the dispatch JobDrawer
  // both key on it); the second sentence says WHICH kind of unverified this is,
  // because "matched a secondary contact slot" and "did not match at all" are
  // different things to verify.
  const unverifiedNote = !thirdParty
    ? null
    : (lookedUpAccount
      ? 'UNVERIFIED third-party requester — verify identity before confirming. Requested by the caller on '
        + `${maskPhone(ctx.from)}, whose phone number does NOT match this account.`
      : 'UNVERIFIED third-party requester — verify identity before confirming. The caller on '
        + `${maskPhone(ctx.from)} matched this account only on a secondary contact number `
        + '(spouse, tenant, or a previous occupant), NOT the account holder\'s own number.');
  const requestedSummary = String(input.service || '').trim().slice(0, 160);
  const windowStart = slot.start_time || slot.startTime24;
  const insertData = {
    customer_id: customerId,
    technician_id: slot.technician_id || null,
    scheduled_date: dateStr,
    window_start: windowStart,
    window_end: slot.end_time || slot.endTime24 || null,
    // ⭐ A BARE START, NEVER A RANGE — because `end_time` is the JOB DURATION,
    // not the arrival window. Writing "9:00 AM - 10:30 AM" here would promise a
    // 90-minute service block as the window; every customer surface owes the
    // caller `window_start` + 120 minutes (arrivalWindowRange), and they derive
    // that themselves precisely because stored display text cannot be trusted to
    // mean it. The invariant those loaders rely on is spelled out in
    // estimate-public.js: a stored value is only ever a bare start time (what
    // the phone-booking writer in call-recording-processor stores) or NULL. This
    // writer is the same lifecycle, so it stores the same thing.
    window_display: slot.start_label ? String(slot.start_label).slice(0, 30) : null,
    service_type: catalogRow.name,
    service_id: catalogRow.id || null,
    estimated_price: priceInfo.price,
    create_invoice_on_complete: callBookingInvoiceOnComplete({ price: priceInfo.price, catalogRow }),
    // The SAME number the availability re-check and the conflict probe used —
    // never a second, independently-derived duration (that divergence is how a
    // 90-minute service got a 60-minute conflict check).
    estimated_duration_minutes: bookingDurationMinutes,
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
      // The UNVERIFIED stamp LEADS: the JobDrawer truncates, and #3361 removed
      // the dispatch/reschedule hold, so this line must survive a glance.
      unverifiedNote ? `⚠️ ${unverifiedNote}` : null,
      'Voice-agent booking request — CONFIRM with customer before dispatch (pending review).',
      requestedSummary && requestedSummary.toLowerCase() !== String(catalogRow.name || '').toLowerCase()
        ? `Caller asked for: ${requestedSummary}.`
        : null,
    ].filter(Boolean).join(' '),
    booking_source: 'phone_call',
    source_call_log_id: callLogId,
    source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION,
    // WHICH ADDRESS THIS VISIT IS FOR, stamped rather than inferred — the
    // linkage columns #3 of the 2026-07-08 call-pipeline audit added, written
    // by the same resolver the call pipeline's own bookings use. Readers
    // COALESCE these over `customers.address_*`, so a null stamp is exactly
    // today's behaviour for a single-address account; a multi-property account
    // never reaches here (refused above).
    property_id: (propertyLinkage && propertyLinkage.propertyId) || null,
    // The resolver's coordinates ride with the row, exactly as the canonical
    // call-booking insert stores them: availability was CHECKED at these
    // coordinates, and without them dispatch/routing falls back to the
    // customer-level mirror point — a visit validated at the property could
    // be mapped somewhere else.
    ...(propertyLinkage && propertyLinkage.lat != null && propertyLinkage.lng != null
      ? { lat: propertyLinkage.lat, lng: propertyLinkage.lng }
      : {}),
    ...(propertyLinkage && propertyLinkage.address ? {
      service_address_line1: propertyLinkage.address.line1 || null,
      service_address_line2: propertyLinkage.address.line2 || null,
      service_address_city: propertyLinkage.address.city || null,
      service_address_state: propertyLinkage.address.state || null,
      service_address_zip: propertyLinkage.address.zip || null,
    } : {}),
  };

  const readSessionLeadId = () => (typeof ctx.leadId === 'function' ? ctx.leadId() : (ctx.leadId || null));
  const leadIdAtCommit = readSessionLeadId();
  const commit = await commitVoiceBooking({
    db, customerId, dateStr, windowStart, windowEnd: insertData.window_end,
    insertData, callLogId, catalogRow, slot, thirdParty, unverifiedNote,
    leadId: leadIdAtCommit,
  });
  if (commit.status === 'duplicate') {
    return 'A booking request for this caller and day is already in — do not create another. '
      + 'Tell the caller a Waves team member will text or call shortly to confirm the time.';
  }
  if (commit.status === 'already_requested') {
    // The DB-side half of the one-booking-per-call rule (the session latch
    // above is the other half, and a reconnect can clear it). NOTHING was
    // written — the transaction rolled back. Re-arm the latch so a third
    // attempt is refused in memory instead of rolling back another write.
    if (typeof ctx.markBookingRequested === 'function') ctx.markBookingRequested(callLogId);
    return 'A booking request has already been placed on this call — NOTHING new was booked. '
      + 'Tell the caller the Waves team member who calls to confirm can move the time if they need '
      + 'a different one. Do not say anything is booked or guaranteed.';
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
  // THE OTHER HALF OF THE LEAD BACK-FILL, for the slow-commit race.
  //
  // capture_lead back-fills the card when the booking already finished
  // (`bookingRequested()` true). It cannot when the booking is still in
  // flight — this tool has an 8s write timeout after which the turn loop
  // detaches it and the model moves on, so capture_lead can create the lead,
  // see the latch still false, and skip the back-fill entirely, while the card
  // written moments later carries the `lead_id: null` this call snapshotted
  // BEFORE the lead existed. The voice-origin confirm path deliberately skips
  // the "single active lead" fallback, so that null is permanent: the
  // captured lead stays active after the office confirms the appointment.
  //
  // Re-reading the session lead id here closes it — the card is durable by
  // now, and the attach is idempotent (it no-ops on a card that already has
  // one) so the two halves can never fight.
  const leadIdAfterCommit = readSessionLeadId();
  if (!leadIdAtCommit && leadIdAfterCommit) {
    await attachLeadToVoiceBookingCard(ctx.callSid, leadIdAfterCommit);
  }
  logger.info(
    `[voice-relay-booking] pending voice_agent booking created for customer ${customerId} on ${dateStr}`
    + `${thirdParty ? ' [UNVERIFIED third-party requester]' : ''} (callSid=${ctx.callSid || 'n/a'})`
  );

  // Customer-facing arrival copy is the SHARED +120min range (AGENTS.md) —
  // never a point time. "Around 9:00 AM" reads as a promise the reminders and
  // track page would then contradict with "9 to 11".
  let spokenTime = slot.start_label || String(windowStart);
  try {
    const { arrivalWindowRange, formatSmsTimeRange } = require('../../utils/sms-time-format');
    const range = arrivalWindowRange(windowStart);
    if (range) spokenTime = formatSmsTimeRange(range);
  } catch { /* the bare start remains the fallback */ }
  return `Booking REQUEST submitted for ${catalogRow.name} on ${dateStr} with an arrival window of ${spokenTime}. `
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
  allowsThirdPartyWrites,
  attachLeadToVoiceBookingCard,
  isBookingEnabled,
  isBookingGateOn,
  requestBookingText,
  commitVoiceBooking,
  revalidateSlot,
  parseTimeToMinutes,
  normalizeDateInput,
  addMinutesToClock,
  laterClock,
  resolveVoiceBookingDuration,
  EARLIEST_START_MINUTES,
};
