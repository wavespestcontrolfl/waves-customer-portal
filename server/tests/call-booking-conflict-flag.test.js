/**
 * AI call bookings — schedule-conflict + time-sanity ADVISORY flags
 * (schedule-conflict lane, owner's chosen behavior): the insert txn's only
 * date-collision guard is customer-scoped, inbound bookings auto-confirm
 * with an immediate SMS, and the transcript-parsed time has no 8–5/weekend
 * clamp ("Sunday 7pm" books 19:00). The fix NEVER blocks: the booking
 * proceeds exactly as before, and a triage card (booking_time_conflict /
 * booking_out_of_hours) + admin bell surface the clash for the office.
 *
 * The pure sanity helper is tested directly via _test; the wiring through
 * the 500-line insert txn needs a live DB, so — matching the established
 * pattern (booking-availability-weekends.test.js) — the load-bearing wiring
 * is asserted at source level.
 */
const fs = require('fs');
const path = require('path');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { buildTriageItem } = require('../services/call-routing-gates');

const { callBookingTimeSanityFlags } = CallRecordingProcessor._test;

describe('callBookingTimeSanityFlags', () => {
  test('weekday visit that starts AND ends inside 8a–5p is clean', () => {
    // 2099-01-05 is a Monday.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '09:00' })).toEqual([]);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '08:00' })).toEqual([]);
    // Ends exactly at close — the boundary is inclusive, a visit ending at
    // 17:00 has not run past it.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '16:00' })).toEqual([]);
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: '17:00',
    })).toEqual([]);
    // A short visit late in the day still fits.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', durationMinutes: 20,
    })).toEqual([]);
  });

  // The P1: the check only ever looked at the START, so a 60-minute booking
  // at 16:30 ran until 17:30 and passed clean. Advisory only — the booking
  // still lands; this just puts it on the same out-of-hours card.
  test('an in-hours start whose visit RUNS PAST close flags ends_after_business_hours', () => {
    // Duration-derived end (no explicit windowEnd): 16:30 + 60 = 17:30.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '16:30' }))
      .toEqual(['ends_after_business_hours']);
    // Explicit windowEnd is preferred over the duration.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:00', windowEnd: '18:00',
    })).toEqual(['ends_after_business_hours']);
    // A long duration overruns from a start nowhere near close.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '14:00', durationMinutes: 240,
    })).toEqual(['ends_after_business_hours']);
    // One minute past close is past close.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:00', windowEnd: '17:01',
    })).toEqual(['ends_after_business_hours']);
    // Combines with the weekend flag on the same card (2099-01-03 = Saturday).
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-03', windowStart: '16:30', windowEnd: '17:30',
    })).toEqual(['weekend', 'ends_after_business_hours']);
  });

  test('an already-out-of-hours START is not double-flagged for its equally-late end', () => {
    // 19:00 + 60 = 20:00, past close — but 'outside_business_hours' already
    // says everything the card needs; a second flag is noise.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '19:00', windowEnd: '20:00',
    })).toEqual(['outside_business_hours']);
  });

  test('an unusable windowEnd falls back to the duration instead of clearing the flag', () => {
    // End at/behind start (parse noise, or a window crossing midnight) is not
    // evidence the visit fits — fall back to the duration: 16:30 + 60.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: '16:30',
    })).toEqual(['ends_after_business_hours']);
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: '00:30',
    })).toEqual(['ends_after_business_hours']);
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: 'garbage',
    })).toEqual(['ends_after_business_hours']);
  });

  test('evening / early-morning starts flag outside_business_hours (the "Sunday 7pm" clamp gap)', () => {
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '19:00' }))
      .toEqual(['outside_business_hours']);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '07:59' }))
      .toEqual(['outside_business_hours']);
    // 17:00 start means the visit runs past close — flagged.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '17:00' }))
      .toEqual(['outside_business_hours']);
  });

  test('weekend dates flag (Sat and Sun), combining with hour flags', () => {
    // 2099-01-04 is a Sunday, 2099-01-03 a Saturday.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-04', windowStart: '10:00' }))
      .toEqual(['weekend']);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-03', windowStart: '10:00' }))
      .toEqual(['weekend']);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-04', windowStart: '19:00' }))
      .toEqual(['weekend', 'outside_business_hours']);
  });

  test('missing pieces degrade to no flags, never a throw', () => {
    expect(callBookingTimeSanityFlags({})).toEqual([]);
    expect(callBookingTimeSanityFlags({ scheduledDate: null, windowStart: null })).toEqual([]);
    expect(callBookingTimeSanityFlags({ scheduledDate: 'garbage', windowStart: 'garbage' })).toEqual([]);
  });
});

describe('booking conflict wiring (source-level — behavior needs a live DB)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the occupancy check runs inside the insert txn, cross-customer, and NEVER blocks the insert', () => {
    // Between the same-day hold and insertData: the shared-module call with
    // the same-customer exclusion.
    const txnSlice = src.slice(
      src.indexOf("reason: 'existing_appointment_same_date'"),
      src.indexOf('const insertData = {'),
    );
    expect(txnSlice).toContain("require('./scheduling/occupancy')");
    expect(txnSlice).toContain('excludeCustomerId: customerId');
    // Advisory only: the check has no throw and its failure path books
    // unflagged rather than failing the booking.
    expect(txnSlice).not.toContain('throw');
    expect(txnSlice).toContain('booking proceeds unflagged');
  });

  test('a fresh booking with findings gets the advisory triage card + admin bell', () => {
    const cardSlice = src.slice(
      src.indexOf("flag: 'unassigned_auto_booking'"),
      src.indexOf('attachedManualBookingId && attachSkippedFollowUpPlan'),
    );
    expect(cardSlice).toContain("'booking_time_conflict'");
    expect(cardSlice).toContain("'booking_out_of_hours'");
    expect(cardSlice).toContain("severity: 'advisory'");
    expect(cardSlice).toContain('conflicting_visits');
    expect(cardSlice).toContain('time_sanity_flags');
    // Same open-card dedupe upsert as every other triage insert here.
    expect(cardSlice).toContain("onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\\'open\\', \\'in_progress\\')'))");
    // Admin bell rides the shared notification channel.
    expect(cardSlice).toContain("require('./notification-service').notifyAdmin");
    expect(cardSlice).toContain("'schedule'");
  });

  test('the sanity helper is fed the visit END, not just its start', () => {
    const callSlice = src.slice(
      src.indexOf('const timeSanityFlags = callBookingTimeSanityFlags({'),
      src.indexOf("if (bookingTimeConflicts.length || timeSanityFlags.length)"),
    );
    // Same end + duration the visit row was inserted with — an end-past-close
    // flag computed from anything else would describe a different visit.
    expect(callSlice).toContain('windowEnd:');
    expect(callSlice).toContain('durationMinutes:');
    expect(callSlice).toContain('DEFAULT_CALL_BOOKING_DURATION_MINUTES');
    // The card carries the end so the office can read the overrun.
    const cardSlice = src.slice(
      src.indexOf("flag: conflictFlag"),
      src.indexOf('conflicting_visits'),
    );
    expect(cardSlice).toContain('window_end:');
  });

  test('both flags map to the time_ambiguous review lane', () => {
    expect(buildTriageItem({ callLogId: 'c1', flag: 'booking_time_conflict' }).category).toBe('time_ambiguous');
    expect(buildTriageItem({ callLogId: 'c1', flag: 'booking_out_of_hours' }).category).toBe('time_ambiguous');
  });
});
