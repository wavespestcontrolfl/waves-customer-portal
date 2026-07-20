/**
 * Zone-Based Availability Engine
 *
 * Only shows slots when a tech is already working in the customer's zone.
 * Finds 1-hour gaps between existing jobs with buffer enforcement.
 */
const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { etParts, etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { generateConfirmationCode } = require('../utils/slot-offer-token');
const { findConflictingVisits, acquireOccupancyLock } = require('./scheduling/occupancy');

function bookingError(message, code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, isOperational: true });
}

// ---- global self-booking day cap (shared by EVERY writer) -----------------
//
// max_self_books_per_day is GLOBAL by calendar date, but the writers'
// narrower locks (customer/tech/zone) don't serialize two confirms in
// DIFFERENT zones — both could observe a cap-1 count and insert, exceeding
// the cap. These two primitives centralize the fix: one date-scoped advisory
// lock + one global count, required by BOTH self_booked_appointments writers
// (routes/booking.js createSelfBooking and confirmBooking below) so neither
// can bypass the other. Lock-ordering contract: every writer takes its
// narrower locks FIRST (createSelfBooking: customer → tech → zone;
// confirmBooking: zone) and this date lock LAST — same relative order
// everywhere, so concurrent confirms can never deadlock.
const SELF_BOOKING_DAY_CAP_LOCK_NS = 'self-booking-day-cap';

async function acquireSelfBookingDayCapLock(trx, dateStr) {
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [SELF_BOOKING_DAY_CAP_LOCK_NS, String(dateStr)],
  );
}

// Same non-cancelled predicate the availability builder counts full days
// with. excludeSelfBookingId: a same-day reschedule replaces its own row —
// counting the row being moved would reject the move on a full day even
// though the final count is unchanged.
async function countActiveSelfBookingsForDay(trx, dateStr, { excludeSelfBookingId = null } = {}) {
  const row = await trx('self_booked_appointments')
    .where('date', String(dateStr))
    .whereNot('status', 'cancelled')
    .modify((q) => {
      if (excludeSelfBookingId) q.whereNot('id', excludeSelfBookingId);
    })
    .count('* as count')
    .first();
  return parseInt(row?.count || 0, 10);
}

class AvailabilityEngine {

  async getAvailableSlots(city, estimateId) {
    // 1. Resolve city → zone
    const zone = await this.resolveZone(city);
    if (!zone) return { zone: null, days: [], message: `No service zone found for ${city}` };

    // 2. Get config
    const config = await db('booking_config').first() || {
      advance_days_min: 1, advance_days_max: 14,
      day_start: '08:00', day_end: '17:00',
      lunch_start: '12:00', lunch_end: '13:00',
      slot_duration_minutes: 60, buffer_minutes: 15,
      max_self_books_per_day: 3,
    };

    const slotDuration = config.slot_duration_minutes || 60;
    const buffer = config.buffer_minutes || 15;
    const lunchStart = this.timeToMin(config.lunch_start || '12:00');
    const lunchEnd = this.timeToMin(config.lunch_end || '13:00');
    const dayStart = this.timeToMin(config.day_start || '08:00');
    const dayEnd = this.timeToMin(config.day_end || '17:00');

    const days = [];
    const today = new Date();

    // Owner blackout days apply to this legacy engine too — it feeds the
    // lead-response availability tool, which quotes days to customers.
    const { getBlackoutDates } = require('./scheduling/blackout-dates');
    const blackout = await getBlackoutDates(
      etDateString(addETDays(today, config.advance_days_min)),
      etDateString(addETDays(today, config.advance_days_max)),
    );

    for (let i = config.advance_days_min; i <= config.advance_days_max; i++) {
      // ET calendar math — toISOString() reads the UTC date (already tomorrow
      // between 8 PM and midnight ET) and getDay() reads the UTC weekday, so
      // the offered day and the ET labels below would diverge in that window.
      const date = addETDays(today, i); // anchored at noon UTC on the ET calendar day
      if (etParts(date).dayOfWeek === 0) continue; // skip Sunday (ET)

      const dateStr = etDateString(date);
      if (blackout.has(dateStr)) continue;

      // Find techs working in this zone on this day
      const techBlocks = await db('tech_schedule_blocks')
        .where('service_zone_id', zone.id)
        .where('date', dateStr)
        .where('block_type', 'available');

      // Also check if any scheduled_services exist in this zone for the day
      const zoneCities = zone.cities || [];
      const scheduledInZone = await db('scheduled_services')
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .where('scheduled_services.scheduled_date', dateStr)
        .whereNotIn('scheduled_services.status', ['cancelled'])
        .whereIn('customers.city', zoneCities)
        .select('scheduled_services.*');

      // If no tech blocks AND no existing services in zone, skip this day
      if (techBlocks.length === 0 && scheduledInZone.length === 0) continue;

      // Day-cap filter: max_self_books_per_day is GLOBAL by calendar date
      // (the shared helper confirmBooking enforces under the day-cap lock).
      // Counting only this zone's bookings here let the engine keep OFFERING
      // a day that another zone had already filled — every confirm on those
      // offers then failed with SLOT_TAKEN. Same count, same predicate, so
      // the builder never offers a day the confirm path would reject on cap.
      const existingBookingsCount = await countActiveSelfBookingsForDay(db, dateStr);

      if (existingBookingsCount >= (config.max_self_books_per_day || 3)) continue;

      // Build occupied slots from scheduled_services
      const occupied = scheduledInZone.map(s => ({
        start: this.timeToMin(s.window_start || '09:00'),
        end: this.timeToMin(s.window_end || (s.window_start ? this.addMinutes(s.window_start, 60) : '10:00')),
      }));

      // Add existing self-bookings
      const selfBooked = await db('self_booked_appointments')
        .where('service_zone_id', zone.id)
        .where('date', dateStr)
        .whereNot('status', 'cancelled');
      selfBooked.forEach(b => {
        occupied.push({ start: this.timeToMin(b.start_time), end: this.timeToMin(b.end_time) });
      });

      // Add lunch block
      occupied.push({ start: lunchStart, end: lunchEnd });

      // Sort occupied by start time
      occupied.sort((a, b) => a.start - b.start);

      // Find gaps
      const slots = this.findGaps(occupied, dayStart, dayEnd, slotDuration, buffer);

      if (slots.length > 0) {
        days.push({
          date: dateStr,
          dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
          dayNum: date.getUTCDate(),
          month: date.toLocaleDateString('en-US', { month: 'short', timeZone: 'America/New_York' }),
          fullDate: date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' }),
          slots: slots.map(s => ({
            start: this.minToTime12(s.start),
            end: this.minToTime12(s.end),
            startTime24: this.minToTime24(s.start),
            endTime24: this.minToTime24(s.end),
          })),
          zone: zone.zone_name,
        });
      }
    }

    return { zone: zone.zone_name, days };
  }

  findGaps(occupied, dayStart, dayEnd, slotDuration, buffer) {
    const slots = [];
    let cursor = dayStart;

    // Round minutes-since-midnight UP to the next clean hour. Customer-
    // facing slot starts like 1:15 / 2:45 felt like "we're squeezing you
    // into a travel gap" — the operator wants every quoted time to land
    // on the hour (1:00, 2:00). The buffer still applies but the slot
    // only starts at the next :00 after buffer.
    const roundUpToHour = (min) => Math.ceil(min / 60) * 60;

    for (const block of occupied) {
      const gapStart = roundUpToHour(cursor + buffer);
      const gapEnd = block.start - buffer;

      if (gapEnd - gapStart >= slotDuration) {
        slots.push({ start: gapStart, end: gapStart + slotDuration });
      }
      cursor = Math.max(cursor, block.end);
    }

    // Gap after the last occupied block — same clean-hour rule.
    const finalStart = roundUpToHour(cursor + buffer);
    if (dayEnd - finalStart >= slotDuration) {
      slots.push({ start: finalStart, end: finalStart + slotDuration });
    }

    return slots.slice(0, 4); // max 4 slots per day
  }

  async resolveZone(city) {
    const zones = await db('service_zones');
    for (const zone of zones) {
      const cities = zone.cities || [];
      if (cities.some(c => c.toLowerCase() === (city || '').toLowerCase())) {
        return zone;
      }
    }
    return null;
  }

  // options.excludeServiceId / options.excludeSelfBookingId: skip a specific
  // existing appointment in the occupancy re-check — used by the onboarding
  // reschedule, which books the replacement BEFORE cancelling the original
  // (so a refused slot leaves the customer's original appointment intact)
  // and must not collide with the row it is about to cancel.
  async confirmBooking(estimateId, customerId, date, startTime, customerNotes, options = {}) {
    // Resolve estimate
    const estimate = estimateId ? await db('estimates').where('id', estimateId).first() : null;
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) throw new Error('Customer not found');

    const zone = await this.resolveZone(customer.city);
    const config = await db('booking_config').first();
    const slotDuration = config?.slot_duration_minutes || 60;
    const maxPerDay = config?.max_self_books_per_day || 3;

    const endTime = this.addMinutes(startTime, slotDuration);

    // The slot list was computed in getAvailableSlots minutes earlier —
    // nothing else stops a stale (or hand-crafted) confirm. Reject
    // impossible dates before touching the calendar.
    const dateStr = String(date || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw bookingError('Invalid booking date', 'INVALID_DATE', 400);
    }
    const todayStr = etDateString();
    if (dateStr < todayStr) {
      throw bookingError('That date has already passed — please pick another day', 'INVALID_DATE', 400);
    }
    if (etParts(parseETDateTime(`${dateStr}T12:00`)).dayOfWeek === 0) {
      throw bookingError('We are closed on Sundays — please pick another day', 'INVALID_DATE', 400);
    }
    // Owner blackout re-check at COMMIT — the quoted option may predate the
    // blackout (AI book_appointment confirms options quoted earlier).
    {
      const { isBlackoutDate } = require('./scheduling/blackout-dates');
      if (await isBlackoutDate(dateStr)) {
        throw bookingError('That day is no longer available — please pick another day', 'INVALID_DATE', 409);
      }
    }
    const startMin = this.timeToMin(startTime);
    const endMin = this.timeToMin(endTime);
    if (dateStr === todayStr) {
      const nowEt = etParts(new Date());
      if (startMin <= nowEt.hour * 60 + nowEt.minute) {
        throw bookingError('That time has already passed today — please pick another slot', 'SLOT_TAKEN');
      }
    }

    // Shared CSPRNG generator (utils/slot-offer-token.js) — this row is served
    // by the same public /booking/status/:code as the /book confirm path, so a
    // guessable four-char code here would undercut the ≈50-bit codes there.
    const confCode = generateConfirmationCode();
    const serviceType = estimate?.services?.[0] || estimate?.service_type || 'General Pest Control';
    const zoneCities = zone?.cities || [];

    // Two customers browsing the same zone see the same slots and can both
    // confirm one — the window is the whole slot-picker session, not
    // milliseconds. Serialize confirms per zone+day with an advisory lock
    // and re-validate occupancy inside it; both inserts ride the same
    // transaction so a partial failure can't leave a booking without its
    // dispatch row. options.trx lets a caller make the booking atomic with
    // its own writes (onboarding reschedule books + cancels in one txn) —
    // side effects are then deferred to the returned notify() so nothing
    // customer-visible fires before the outer transaction commits.
    const runBookingWork = async (work) => (options.trx ? work(options.trx) : db.transaction(work));
    const { booking, scheduled } = await runBookingWork(async (trx) => {
      // RUNG 1 — date-wide occupancy lock, FIRST and UNCONDITIONAL (see the
      // ORDERING CONTRACT in scheduling/occupancy.js). This confirm inserts a
      // scheduled_services row that the GLOBAL tech-blind checks (rebooker
      // single + series) count, and those checks read committed rows only:
      // without this lock our uncommitted insert is invisible to them and
      // both sides commit an overlap. It is taken on the ZONE-RESOLVED branch
      // too — that branch validates against a zone-scoped occupied set, so it
      // is precisely the writer whose insert a global checker would miss. The
      // zone-null branch below additionally relies on it to guard its own
      // findConflictingVisits call. Hoisted above the zone + day-cap locks so
      // every writer in the family acquires the shared rungs in one order.
      await acquireOccupancyLock(trx, dateStr);
      // slot-reserve namespace + zone-key shape match routes/booking.js
      // exactly, so confirms through onboarding/AI and the public
      // /api/booking/confirm serialize against each other for the same
      // zone+day (different namespaces would let both pass their overlap
      // checks under READ COMMITTED).
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['slot-reserve', `zone:${zone?.id || 'unknown'}:${dateStr}`],
      );

      // Global day cap — the shared lock + count every
      // self_booked_appointments writer takes (see the helpers above). The
      // zone lock only serializes same-zone writers; the cap is global by
      // date, so a per-zone count here let cross-zone confirms (this engine
      // vs the public /book confirm) exceed max_self_books_per_day. Lock
      // order stays fixed — date → zone → day-cap, the same relative order
      // as createSelfBooking's date → customer → tech → zone → day-cap — so
      // concurrent confirms across both writers can never deadlock.
      await acquireSelfBookingDayCapLock(trx, dateStr);
      const dayCount = await countActiveSelfBookingsForDay(trx, dateStr, {
        excludeSelfBookingId: options.excludeSelfBookingId || null,
      });
      if (dayCount >= maxPerDay) {
        throw bookingError('That day just filled up — please pick another day', 'SLOT_TAKEN');
      }

      // Rows the tech-blind probe below must ignore — the onboarding
      // reschedule books the replacement BEFORE cancelling the original, so
      // it must not collide with the row(s) it is about to cancel. Resolved
      // for BOTH branches: the zone-resolved fast path excludes the same
      // rows via its own options.exclude* modifiers.
      const occupancyExcludes = [];
      if (options.excludeServiceId) occupancyExcludes.push(options.excludeServiceId);
      if (options.excludeSelfBookingId) {
        // The onboarding reschedule identifies the row it is replacing by
        // its self-booking id — exclude that booking's dispatch row too.
        const replacedRow = await trx('scheduled_services')
          .where({ self_booking_id: options.excludeSelfBookingId })
          .first('id');
        if (replacedRow?.id) occupancyExcludes.push(replacedRow.id);
      }

      if (zone) {
        // Mirror getAvailableSlots' occupied set: zone services + live
        // self-bookings. Any overlap means the slot was taken since the
        // customer loaded the picker.
        const occupied = [];
        const scheduledInZone = await trx('scheduled_services')
          .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
          .where('scheduled_services.scheduled_date', dateStr)
          .whereNotIn('scheduled_services.status', ['cancelled'])
          .whereIn('customers.city', zoneCities)
          .modify((q) => {
            if (options.excludeServiceId) q.whereNot('scheduled_services.id', options.excludeServiceId);
          })
          .select('scheduled_services.window_start', 'scheduled_services.window_end');
        for (const s of scheduledInZone) {
          occupied.push({
            start: this.timeToMin(s.window_start || '09:00'),
            end: this.timeToMin(s.window_end || (s.window_start ? this.addMinutes(s.window_start, 60) : '10:00')),
          });
        }
        const selfBooked = await trx('self_booked_appointments')
          .where('service_zone_id', zone.id)
          .where('date', dateStr)
          .whereNot('status', 'cancelled')
          .modify((q) => {
            if (options.excludeSelfBookingId) q.whereNot('id', options.excludeSelfBookingId);
          });
        for (const b of selfBooked) {
          occupied.push({ start: this.timeToMin(b.start_time), end: this.timeToMin(b.end_time) });
        }
        // Live estimate-slot holds (customer_id NULL, tech-keyed, no zone)
        // occupy real route time even though they don't match the zone
        // predicates above — count them so a self-booking can't land on a
        // held slot.
        const liveHolds = await trx('scheduled_services')
          .where('scheduled_date', dateStr)
          .whereNull('customer_id')
          .whereRaw('reservation_expires_at > NOW()')
          .select('window_start', 'window_end');
        for (const h of liveHolds) {
          occupied.push({
            start: this.timeToMin(h.window_start || '09:00'),
            end: this.timeToMin(h.window_end || (h.window_start ? this.addMinutes(h.window_start, 60) : '10:00')),
          });
        }
        if (occupied.some((b) => b.start < endMin && b.end > startMin)) {
          throw bookingError('That time slot was just taken — please pick another', 'SLOT_TAKEN');
        }
      }

      // Shared tech-blind occupancy probe, BOTH branches (ORDERING CONTRACT:
      // every rung-1 holder runs the global predicate under the date lock
      // before committing — the lock only serializes writers; it cannot
      // widen what a check sees). For the zone-NULL branch this is the only
      // window validation there is (AI-assistant book tool, onboarding
      // reschedule). For the zone-RESOLVED branch the occupied-set check
      // above remains the fast path, but it is zone-scoped: an overlapping
      // visit whose customer city is outside this zone's list — or a
      // tech-assigned row from the estimate lane — never enters `occupied`,
      // and with one active tech any overlap is a real clash. Status set
      // matches the zone path (non-cancelled occupies); live holds count,
      // expired ones don't. The date-wide occupancy lock this runs under
      // was taken at the TOP of the transaction (rung 1 of the global
      // order) — the rebooker takes neither the zone nor the day-cap lock,
      // so that date lock is the only rung shared with it.
      const occupancyClash = await findConflictingVisits({
        db: trx,
        date: dateStr,
        windowStart: startTime,
        windowEnd: endTime,
        excludeServiceIds: occupancyExcludes,
      });
      if (occupancyClash.length) {
        throw bookingError('That time slot was just taken — please pick another', 'SLOT_TAKEN');
      }

      // Create self_booked_appointment
      const [bookingRow] = await trx('self_booked_appointments').insert({
        customer_id: customerId,
        estimate_id: estimateId || null,
        service_zone_id: zone?.id || null,
        date: dateStr,
        start_time: startTime,
        end_time: endTime,
        duration_minutes: slotDuration,
        customer_notes: customerNotes || null,
        confirmation_code: confCode,
      }).returning('*');

      // Create scheduled_service so it shows on the dispatch board
      const [scheduledRow] = await trx('scheduled_services').insert({
        customer_id: customerId,
        scheduled_date: dateStr,
        window_start: startTime,
        window_end: endTime,
        service_type: serviceType,
        status: 'confirmed',
        customer_confirmed: true,
        confirmed_at: new Date(),
        notes: customerNotes ? `Self-booked. Notes: ${customerNotes}` : 'Self-booked via portal',
        source: 'self_booked',
        self_booking_id: bookingRow.id,
        zone: zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null,
      }).returning('*');

      return { booking: bookingRow, scheduled: scheduledRow };
    });

    // Dispatch-v2 reads scheduled_services directly; no legacy dispatch sync.

    const notify = async () => {
    try {
      const AppointmentReminders = require('./appointment-reminders');
      // Confirms through the shared appointment_confirmation flow
      // (prefs/channel-aware, email fallback, reschedule link) — the bespoke
      // self_booking_confirmation template was retired 2026-07-06.
      await AppointmentReminders.registerAppointment(
        scheduled.id,
        customerId,
        `${dateStr}T${startTime || '08:00'}`,
        serviceType,
        'booking_new',
        { sendConfirmation: true },
      );
    } catch (err) {
      logger.error(`[availability] Appointment reminder registration failed for ${scheduled.id}: ${err.message}`);
    }

    // Customer confirmation is handled by registerAppointment above.
    try {
      const TwilioService = require('./twilio');
      const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
      // Adam notification
      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `New self-booked appointment:\n${customer.first_name} ${customer.last_name}\n${serviceType}\n${dateLabel} ${this.minToTime12(this.timeToMin(startTime))}\n${customer.city}\nCode: ${confCode}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`Booking SMS failed: ${err.message}`);
    }
    };

    if (options.trx) {
      // Caller commits the outer transaction first, then runs notify() —
      // reminders/SMS must not fire for a booking that could roll back.
      return { booking, confirmationCode: confCode, notify };
    }
    await notify();
    return { booking, confirmationCode: confCode };
  }

  // Time helpers
  timeToMin(t) {
    if (!t) return 540; // default 9:00
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  minToTime12(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  minToTime24(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  addMinutes(time, mins) {
    const total = this.timeToMin(time) + mins;
    return this.minToTime24(total);
  }
}

module.exports = new AvailabilityEngine();
// Shared global day-cap primitives — required by routes/booking.js's
// createSelfBooking (lazily, so the route ↔ service load order can't cycle).
module.exports.acquireSelfBookingDayCapLock = acquireSelfBookingDayCapLock;
module.exports.countActiveSelfBookingsForDay = countActiveSelfBookingsForDay;
