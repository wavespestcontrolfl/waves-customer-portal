// Call booking-miss watchdog (2026-07-30). Born from a July 2026 outbound
// callback that confirmed "Saturday at noon": the V2 extraction captured the
// slot (scheduling.status=confirmed + confirmed_start_at), every auto-booking
// guard parked it into a 1,700-item open triage backlog, and nobody was
// scheduled. These tests pin the pure diff — confirmed-slot parsing (object
// AND string-era extractions), the v2IsoToEtWallClock wall-clock contract,
// call-linked clearing evidence, grace filter (shorter for a visit the call
// agent held, whose bell names why), unlinked-call handling — and the gate-off
// no-op. All fixture identities are synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const {
  runCallBookingMissWatchdog,
  computeBookingMisses,
  extractConfirmedSlot,
  confirmedWallClockET,
  rowClearsSlot,
  bookItAlert,
  dateCheckAlert,
  liveDecision,
  decisionHoldReason,
  GRACE_MINUTES,
  HELD_GRACE_MINUTES,
  HOLD_REASONS,
  HOLD_REASON_FALLBACK,
  HOLD_REASONS_BY_ROUTING,
} = require('../services/call-booking-miss-watchdog');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const NOW = new Date('2026-07-30T16:00:00Z');
const OLD_ENOUGH = new Date(NOW.getTime() - (GRACE_MINUTES + 30) * 60 * 1000).toISOString();
const TOO_RECENT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();

// Synthetic fixture: an outbound callback that confirmed Sat Aug 1 noon ET.
function extraction(over = {}) {
  return {
    caller: { name_full: 'Pat Sample', first_name: 'Pat' },
    service_request: { specific_service_name: 'Waves Assessment', primary_service_category: 'termite' },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-08-01T12:00:00-04:00' },
    ...over,
  };
}


function call(over = {}) {
  return {
    id: 'call-1', twilio_call_sid: 'CAsynthetic001', customer_id: 'cust-1',
    direction: 'outbound', created_at: OLD_ENOUGH,
    from_phone: '+19415550100', to_phone: '+19415550111',
    ai_extraction_enriched: extraction(),
    processing_status: 'processed',
    ...over,
  };
}

function bookedRow(over = {}) {
  return {
    customer_id: 'cust-1', sched_date: '2026-08-01', window_start: '12:00:00',
    created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    source_call_log_id: null, notes: null,
    ...over,
  };
}

describe('confirmedWallClockET — v2IsoToEtWallClock contract', () => {
  test('ET offset (correct season) keeps the wall clock verbatim', () => {
    expect(confirmedWallClockET('2026-08-01T12:00:00-04:00')).toEqual({ dateET: '2026-08-01', minutes: 720 });
  });

  test('the seasonally WRONG ET offset still keeps the agreed wall clock (no date shift)', () => {
    // As an instant, 23:30-05:00 in July is 00:30-04:00 the NEXT day; the
    // wall clock the caller agreed to is 23:30 on the stated date.
    expect(confirmedWallClockET('2026-07-31T23:30:00-05:00')).toEqual({ dateET: '2026-07-31', minutes: 23 * 60 + 30 });
  });

  test('a zone-less stamp is treated as ET wall clock verbatim', () => {
    expect(confirmedWallClockET('2026-08-01T09:00:00')).toEqual({ dateET: '2026-08-01', minutes: 540 });
  });

  test('a true foreign instant (Z) converts to its ET wall clock', () => {
    // 2026-08-02T02:00Z is 2026-08-01 22:00 ET.
    expect(confirmedWallClockET('2026-08-02T02:00:00Z')).toEqual({ dateET: '2026-08-01', minutes: 22 * 60 });
  });

  test('garbage returns null', () => {
    expect(confirmedWallClockET('saturday-ish')).toBeNull();
    expect(confirmedWallClockET(null)).toBeNull();
  });
});

describe('extractConfirmedSlot', () => {
  test('parses a confirmed slot from an object extraction', () => {
    const slot = extractConfirmedSlot(extraction());
    expect(slot.name).toBe('Pat Sample');
    expect(slot.service).toBe('Waves Assessment');
    expect(slot.dateET).toBe('2026-08-01');
    expect(slot.minutes).toBe(720);
  });

  test('parses a STRING-era extraction (column stored stringified JSON historically)', () => {
    const slot = extractConfirmedSlot(JSON.stringify(extraction()));
    expect(slot).not.toBeNull();
    expect(slot.dateET).toBe('2026-08-01');
  });

  test('non-confirmed, missing start, unparseable start, and garbage all return null', () => {
    expect(extractConfirmedSlot(extraction({ scheduling: { status: 'requested', confirmed_start_at: '2026-08-01T12:00:00-04:00' } }))).toBeNull();
    expect(extractConfirmedSlot(extraction({ scheduling: { status: 'confirmed', confirmed_start_at: null } }))).toBeNull();
    expect(extractConfirmedSlot(extraction({ scheduling: { status: 'confirmed', confirmed_start_at: 'saturday-ish' } }))).toBeNull();
    expect(extractConfirmedSlot('not json')).toBeNull();
    expect(extractConfirmedSlot(null)).toBeNull();
  });
});

describe('rowClearsSlot — call-linked booking evidence only', () => {
  const slot = { dateET: '2026-08-01', minutes: 720 };

  test('source_call_log_id match clears', () => {
    expect(rowClearsSlot(bookedRow({ source_call_log_id: 'call-1', created_at: null, window_start: null }), call(), slot)).toBe(true);
  });

  test('Call SID notes marker clears', () => {
    expect(rowClearsSlot(bookedRow({ notes: 'Booked by phone. Call SID: CAsynthetic001.', created_at: null, window_start: null }), call(), slot)).toBe(true);
  });

  test('window_start within 2h of the confirmed wall clock clears; beyond it does not', () => {
    expect(rowClearsSlot(bookedRow({ window_start: '13:00:00', created_at: null }), call(), slot)).toBe(true);
    expect(rowClearsSlot(bookedRow({ window_start: '08:00:00', created_at: null }), call(), slot)).toBe(false);
  });

  test('provenance clears DATE-AGNOSTICALLY (in-place reschedule moved the row) but window-proximity does not', () => {
    // SmartRebooker mutates the same row's scheduled_date, keeping
    // source_call_log_id — still booked, must not page.
    const rescheduled = bookedRow({ sched_date: '2026-08-05', source_call_log_id: 'call-1', window_start: null, created_at: null });
    expect(rowClearsSlot(rescheduled, call(), slot)).toBe(true);
    const markerMoved = bookedRow({ sched_date: '2026-08-05', notes: 'Call SID: CAsynthetic001.', window_start: null, created_at: null });
    expect(rowClearsSlot(markerMoved, call(), slot)).toBe(true);
    // A near-noon window on some OTHER date is not evidence for this slot.
    const wrongDateWindow = bookedRow({ sched_date: '2026-08-05', window_start: '12:00:00', created_at: null });
    expect(rowClearsSlot(wrongDateWindow, call(), slot)).toBe(false);
  });

  test('post-call timing alone is NOT evidence — an unrelated row created after the call does not clear', () => {
    const afterCall = bookedRow({ window_start: '08:00:00', created_at: new Date(new Date(OLD_ENOUGH).getTime() + 10 * 60 * 1000).toISOString() });
    const beforeCall = bookedRow({ window_start: '08:00:00', created_at: new Date(new Date(OLD_ENOUGH).getTime() - 10 * 60 * 1000).toISOString() });
    expect(rowClearsSlot(afterCall, call(), slot)).toBe(false);
    expect(rowClearsSlot(beforeCall, call(), slot)).toBe(false);
  });
});

describe('rowClearsSlot — cancelled/rescheduled rows clear only on call provenance', () => {
  const slot = { dateET: '2026-08-01', minutes: 720 };
  const afterCall = new Date(new Date(OLD_ENOUGH).getTime() + 10 * 60 * 1000).toISOString();

  test('a cancelled/rescheduled row carrying the call (source_call_log_id or the Call SID note) clears, on any date or time', () => {
    const cancelled = bookedRow({ status: 'cancelled', window_start: '08:00:00', created_at: afterCall });
    expect(rowClearsSlot({ ...cancelled, source_call_log_id: 'call-1' }, call(), slot)).toBe(true);
    expect(rowClearsSlot({ ...cancelled, status: 'rescheduled', source_call_log_id: 'call-1' }, call(), slot)).toBe(true);
    expect(rowClearsSlot({ ...cancelled, sched_date: '2026-08-05', notes: 'Call SID: CAsynthetic001.' }, call(), slot)).toBe(true);
  });

  test('a cancelled row WITHOUT provenance never clears: not near the slot, not at the slot time, not created after the call', () => {
    for (const window_start of ['08:00:00', '12:00:00', '13:00:00', null]) {
      for (const status of ['cancelled', 'rescheduled']) {
        expect(rowClearsSlot(bookedRow({ status, window_start, created_at: afterCall }), call(), slot)).toBe(false);
      }
    }
    // Another call's provenance is not this call's.
    expect(rowClearsSlot(bookedRow({ status: 'cancelled', source_call_log_id: 'call-other' }), call(), slot)).toBe(false);
  });

  test('an ACTIVE row keeps the window-proximity rule', () => {
    expect(rowClearsSlot(bookedRow({ status: 'confirmed', window_start: '13:00:00', created_at: afterCall }), call(), slot)).toBe(true);
    expect(rowClearsSlot(bookedRow({ status: 'scheduled', window_start: '08:00:00', created_at: afterCall }), call(), slot)).toBe(false);
  });

  test('computeBookingMisses: a provenance-linked cancelled visit is no miss; the same row without provenance is', () => {
    const cancelled = bookedRow({ status: 'cancelled', window_start: '12:00:00', created_at: afterCall, source_call_log_id: 'call-1' });
    expect(computeBookingMisses([call()], [cancelled], { now: NOW })).toEqual([]);
    expect(computeBookingMisses([call()], [{ ...cancelled, source_call_log_id: null }], { now: NOW })).toHaveLength(1);
  });
});

describe('computeBookingMisses — confirmed-slot vs schedule diff', () => {
  test('a confirmed slot with no booking evidence is a miss', () => {
    const misses = computeBookingMisses([call()], [], { now: NOW });
    expect(misses).toHaveLength(1);
    expect(misses[0].serviceDateET).toBe('2026-08-01');
  });

  test('a call-linked booking on the confirmed ET date clears the miss', () => {
    expect(computeBookingMisses([call()], [bookedRow({ source_call_log_id: 'call-1' })], { now: NOW })).toHaveLength(0);
  });

  test('an UNRELATED pre-existing same-day appointment does NOT suppress the miss', () => {
    const unrelated = bookedRow({
      window_start: '08:00:00',
      created_at: new Date(new Date(OLD_ENOUGH).getTime() - 24 * 3600 * 1000).toISOString(),
    });
    expect(computeBookingMisses([call()], [unrelated], { now: NOW })).toHaveLength(1);
  });

  test('another customer\'s same-date booking at the same time never clears without the call on it', () => {
    expect(computeBookingMisses([call()], [bookedRow({ customer_id: 'cust-other' })], { now: NOW })).toHaveLength(1);
  });

  // Owner 2026-10-03: the office booked a spouse's call on the household's
  // account; the visit carried the call's id and the pager rang four more times.
  test('a visit that carries the call clears it under ANY customer: the call id or the Call SID note, linked call or not', () => {
    const household = [
      bookedRow({ customer_id: 'cust-other', source_call_log_id: 'call-1' }),
      bookedRow({ customer_id: 'cust-other', notes: 'Booked from call. Call SID: CAsynthetic001' }),
    ];
    for (const row of household) {
      expect(computeBookingMisses([call({ customer_id: null })], [row], { now: NOW })).toHaveLength(0);
      expect(computeBookingMisses([call()], [row], { now: NOW })).toHaveLength(0);
    }
  });

  test('an UNLINKED call (customer_id null) is a miss unless a visit carries the call: a same-slot row alone, or another call\'s visit, does not clear', () => {
    const unlinked = call({ customer_id: null });
    expect(computeBookingMisses([unlinked], [], { now: NOW })).toHaveLength(1);
    expect(computeBookingMisses([unlinked], [bookedRow({ customer_id: null })], { now: NOW })).toHaveLength(1);
    expect(computeBookingMisses([unlinked], [bookedRow({ customer_id: 'cust-other', source_call_log_id: 'call-2' })], { now: NOW })).toHaveLength(1);
  });

  test('in-grace calls and non-confirmed extractions are excluded', () => {
    const rows = [
      call({ id: 'fresh', created_at: TOO_RECENT }),
      call({ id: 'requested', ai_extraction_enriched: extraction({ scheduling: { status: 'requested', confirmed_start_at: null } }) }),
      call({ id: 'no-extraction', ai_extraction_enriched: null }),
    ];
    expect(computeBookingMisses(rows, [], { now: NOW })).toHaveLength(0);
  });
});

// Owner 2026-11-18 (option A of the call booking holds scope): a visit the call agent
// itself held waited 90 minutes for its first bell, and the bell never said why. It now
// rings after HELD_GRACE_MINUTES and names the reason.
describe('a visit the call agent held', () => {
  // The call agent's live decision on a call's last pass (route_decisions, mode enforce).
  const decision = (over = {}) => ({
    call_log_id: 'call-1', mode: 'enforce', recording_sid: '', final_action_taken: 'triage_review',
    blocked_reasons: ['address_unverified'], created_at: NOW.toISOString(), ...over,
  });
  const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();
  // computeBookingMisses with each listed call's live decision (the run loads them by call id).
  const missesOf = (calls, decided = {}, booked = []) => computeBookingMisses(calls, booked, { now: NOW, decisions: new Map(Object.entries(decided)) });
  const heldMiss = (over = {}, held = decision()) => missesOf([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ...over })], { 'call-1': held })[0];

  test('rings after HELD_GRACE_MINUTES with its reason; an unheld call of the same age still waits GRACE_MINUTES', () => {
    const misses = missesOf([
      call({ id: 'held', created_at: minutesAgo(HELD_GRACE_MINUTES + 1) }),
      call({ id: 'booked-by-agent', created_at: minutesAgo(HELD_GRACE_MINUTES + 1) }),
      call({ id: 'no-decision', created_at: minutesAgo(HELD_GRACE_MINUTES + 1) }),
      call({ id: 'held-too-recent', created_at: minutesAgo(HELD_GRACE_MINUTES - 1) }),
    ], { held: decision(), 'booked-by-agent': decision({ final_action_taken: 'auto_route', blocked_reasons: [] }), 'held-too-recent': decision() });
    expect(misses.map((m) => [m.call.id, m.holdReason])).toEqual([['held', 'the address is not confirmed']]);
    // A booking still clears a held call.
    expect(missesOf([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1) })], { 'call-1': decision() }, [bookedRow({ source_call_log_id: 'call-1' })])).toHaveLength(0);
  });

  // Pre-push P1 (2026-11-18): ai_validation is an audit rebuild that can differ from the live
  // decision (an address recovery routes on the recovered address, the rebuild on the original).
  test('the live decision is the newest enforce row for the call\'s recording, written by its last pass', () => {
    const row = (over) => ({ call_log_id: 'call-1', mode: 'enforce', recording_sid: 'RE1', final_action_taken: 'triage_review', created_at: minutesAgo(30), ...over });
    const c = call({ recording_sid: 'RE1', processing_started_at: minutesAgo(40) });
    const newest = row({ created_at: minutesAgo(20), final_action_taken: 'auto_route' });
    expect(liveDecision(c, [row(), newest, row({ mode: 'shadow', created_at: minutesAgo(10) }), row({ recording_sid: 'RE0', created_at: minutesAgo(5) }), row({ call_log_id: 'call-2', created_at: minutesAgo(1) })])).toBe(newest);
    // A decision from before the last claim belongs to an earlier pass: a reprocess has not decided yet.
    expect(liveDecision({ ...c, processing_started_at: minutesAgo(15) }, [row(), newest])).toBeNull();
    expect(liveDecision(c, [])).toBeNull();
    // A call with no recording matches the blank recording key the processor writes.
    expect(liveDecision(call(), [row({ recording_sid: '' })])).toEqual(expect.objectContaining({ recording_sid: '' }));
  });

  test('a decision holds when routing blocked it or a later check skipped it; a booked one does not', () => {
    expect(decisionHoldReason(decision())).toBe('the address is not confirmed');
    expect(decisionHoldReason(decision({ final_action_taken: 'auto_route_skipped', blocked_reasons: [] }))).toBe(HOLD_REASON_FALLBACK);
    expect(decisionHoldReason(decision({ final_action_taken: 'auto_route', blocked_reasons: [] }))).toBeNull();
    expect(decisionHoldReason(null)).toBeNull();
    // blocked_reasons stored as JSON text reads the same; unreadable text still holds, with no named reason.
    expect(decisionHoldReason(decision({ blocked_reasons: JSON.stringify(['caller_not_authorized']) }))).toBe('the caller is not the account holder');
    expect(decisionHoldReason(decision({ blocked_reasons: '{not json' }))).toBe(HOLD_REASON_FALLBACK);
  });

  test('the reason is the routing reason first, then the first blocking flag in HOLD_REASONS order, else the fallback', () => {
    const reasonOf = (reasons) => decisionHoldReason(decision({ blocked_reasons: reasons }));
    expect(reasonOf(['address_unverified', 'commercial_requires_quote'])).toBe('a commercial job needs a quote first');
    expect(reasonOf(['address_unverifiable', 'address_unverified'])).toBe('the address is not confirmed');
    expect(reasonOf(['off_hour_start'])).toBe('the start time is not on the hour');
    expect(reasonOf(['address_not_validated'])).toBe('the address is not confirmed');
    expect(reasonOf(['low_confidence'])).toBe('the call details are unclear');
    expect(reasonOf(['v1_only_new_address', 'address_unverified'])).toBe('the address is not the one on file');
    expect(reasonOf(['a_flag_with_no_phrase'])).toBe(HOLD_REASON_FALLBACK);
    expect(reasonOf([])).toBe(HOLD_REASON_FALLBACK);
  });

  // Pre-push P1s (2026-11-18): the processor writes the live decision before its hard-veto exit
  // (spam, out of area, an opt-out), and a booking a later check held stores 'auto_route_skipped'.
  test('a hard-veto exit and a booking held after approval ring fast too', () => {
    expect(heldMiss({}, decision({ blocked_reasons: ['out_of_service_area'] })).holdReason).toBe('the address is outside our area');
    expect(heldMiss({}, decision({ final_action_taken: 'auto_route_skipped', blocked_reasons: [] })).holdReason).toBe(HOLD_REASON_FALLBACK);
    const optOut = bookItAlert(heldMiss({}, decision({ blocked_reasons: ['do_not_contact_requested'] })), false);
    expect(optOut.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the caller asked not to be contacted.');
    expect(optOut.detail).toContain('Check the call in dispatch before booking it, and do not call or text the caller.');
    expect(optOut.detail).not.toContain('call back');
    // A 'spam' row keeps the plain wait.
    expect(missesOf([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), processing_status: 'spam' })], { 'call-1': decision({ blocked_reasons: ['spam_or_wrong_number'] }) })).toHaveLength(0);
  });

  // Pre-push P1s (2026-11-18): an 'extraction_failed' pass can still be retried and book the visit.
  test('a hold needs a finished pass; a pass that can still be retried waits GRACE_MINUTES and names no reason', () => {
    for (const status of ['extraction_failed', 'voicemail']) {
      expect([status, missesOf([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), processing_status: status })], { 'call-1': decision() })]).toEqual([status, []]);
      expect([status, missesOf([call({ processing_status: status })], { 'call-1': decision() }).map((m) => m.holdReason)]).toEqual([status, [null]]);
    }
  });

  // Pre-push P1 (2026-11-18): the /voice webhook inserts the row when the call begins, so a
  // long call would ring while the office is still booking it right after hanging up.
  test('a held call waits from the end of the call, not from its start', () => {
    const ended = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();
    const calls = [
      // Inserted at pickup, 12 minutes long: ended 3 minutes ago, still waiting.
      call({ id: 'long-call', created_at: minutesAgo(15), duration_seconds: 12 * 60 }),
      // The same call 8 minutes later: ended 11 minutes ago.
      call({ id: 'long-call-done', created_at: minutesAgo(23), duration_seconds: 12 * 60 }),
      // A post-call row: created_at is already after the call.
      call({ id: 'post-call-row', created_at: minutesAgo(11), duration_seconds: 12 * 60, metadata: { source: 'status_callback' } }),
      // Twilio's end stamp wins over created_at + length: ended 5 minutes ago.
      call({ id: 'end-stamped', created_at: minutesAgo(30), duration_seconds: 60, metadata: { ended_at: ended(5) } }),
      // Pre-push P1 (2026-11-18): an outbound bridge's customer-leg receipt wins over the row's
      // length, which can count the staff leg's ringing: the customer hung up 5, then 11, minutes ago.
      call({ id: 'bridge-leg', created_at: minutesAgo(30), duration_seconds: 60, metadata: { customer_leg: { ended_at: ended(5) } } }),
      call({ id: 'bridge-leg-done', created_at: minutesAgo(30), duration_seconds: 60, metadata: { customer_leg: { ended_at: ended(11) } } }),
      // Pre-push P1 (2026-11-18): an admin bridge with no end receipt ends at bridged_at + length,
      // not created_at + length (created_at can precede the staff answer): 9, then 11, minutes ago.
      call({ id: 'bridged', created_at: minutesAgo(30), bridged_at: minutesAgo(14), duration_seconds: 5 * 60 }),
      call({ id: 'bridged-done', created_at: minutesAgo(30), bridged_at: minutesAgo(16), duration_seconds: 5 * 60 }),
    ];
    const misses = missesOf(calls, Object.fromEntries(calls.map((c) => [c.id, decision({ call_log_id: c.id })])));
    expect(misses.map((m) => m.call.id)).toEqual(['long-call-done', 'post-call-row', 'bridge-leg-done', 'bridged-done']);
    // An unheld call keeps its wait from created_at.
    expect(missesOf([call({ duration_seconds: 120 * 60 })])).toHaveLength(1);
  });

  // Pre-push P1 (2026-11-18): a held visit may not be one to book as agreed (a cancel request, a
  // visit already on file), so its bell says review and asks staff to check the call first.
  test('a held bell says review and why, and asks to check the call; an unheld miss keeps "book" and "nothing is on the calendar"', () => {
    const text = bookItAlert(heldMiss(), false);
    expect(text.action).toBe("review Pat Sample's Waves Assessment");
    expect(text.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the address is not confirmed.');
    expect(text.detail).toContain('The call agent held this visit and did not book it, because the address is not confirmed.');
    expect(text.detail).toContain('Check the call in dispatch before booking it; tap Done if no visit is needed.');
    expect(text.detail).not.toContain('Book it in dispatch');
    const cancel = bookItAlert(heldMiss({}, decision({ blocked_reasons: ['cancellation_request'] })), false);
    expect(cancel.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the caller asked to cancel.');
    expect(cancel.detail).toContain('tap Done if no visit is needed');
    const [plain] = missesOf([call()]);
    expect(bookItAlert(plain, false).action).toBe("book Pat Sample's Waves Assessment");
    expect(bookItAlert(plain, false).why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; nothing is on the calendar.');
    expect(bookItAlert(plain, false).detail).toContain('Book it in dispatch or call back to reset expectations.');
  });

  // Pre-push P1 (2026-11-18): a hold for having no number must not end on "call back".
  test('a hold for having no number names it and drops the callback step', () => {
    const noNumber = bookItAlert(heldMiss({}, decision({ blocked_reasons: ['address_unverified', 'caller_phone_missing'] })), false);
    expect(noNumber.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the call has no callback number.');
    expect(noNumber.detail).toContain('Check the call in dispatch before booking it; the call left no number to call back.');
    // The routing-reason form of the opt-out reads the same as the flag.
    expect(decisionHoldReason(decision({ blocked_reasons: ['do_not_contact'] }))).toBe('the caller asked not to be contacted');
  });

  // Pre-push P1s (2026-11-18): every stored opt-out signal bars contact, and an opt-out alone
  // never proves a hold (in shadow mode V2 does not decide the booking).
  test('an opt-out in any stored signal never asks for a call, and alone it does not shorten the wait', () => {
    const optOuts = {
      'V2 consent': { ai_extraction_enriched: extraction({ consent: { do_not_contact_request: true } }) },
      // A flag-only opt-out: the processor's hard veto reads the flag, with no consent boolean.
      'V2 triage flag': { ai_extraction_enriched: extraction({ triage_flags: ['do_not_contact_requested'] }) },
      'V1 extraction': { ai_extraction: { do_not_contact_request: true } },
    };
    for (const [label, over] of Object.entries(optOuts)) {
      expect([label, missesOf([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ...over })])]).toEqual([label, []]);
      const [miss] = missesOf([call(over)]);
      expect(miss.holdReason).toBeNull();
      const text = bookItAlert(miss, false);
      expect(text.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; nothing is on the calendar.');
      expect([label, text.detail]).toEqual([label, expect.stringContaining('Review it in dispatch before booking, and do not call or text the caller.')]);
      expect(text.detail).not.toContain('call back');
    }
  });

  // The watchdog makes no contact rule of its own: the number a bell shows is main's (the
  // customer's leg of the call), and only a stored opt-out or a no-number hold changes the step.
  test('the number shown is the customer\'s leg of the call, and a missing number alone keeps the callback step', () => {
    const detailOf = (over) => bookItAlert(missesOf([call(over)])[0], false).detail;
    expect(detailOf({})).toMatch(/^Pat Sample \(\+19415550111\) confirmed /);
    const noLine = detailOf({ to_phone: null });
    expect(noLine).toMatch(/^Pat Sample \(no number\) confirmed /);
    expect(noLine).toContain('Book it in dispatch or call back to reset expectations.');
  });

  // Pre-push P1 (2026-11-18): the date check follows the same contact rule as "book it".
  test('a date check never asks staff to contact an opted-out caller, or to confirm on a call with no number', () => {
    const slot = { dateET: '2026-08-01', minutes: 12 * 60 };
    const mismatch = { visit_id: 'visit-9', date: '2026-08-03', time: '09:00' };
    const check = (c, holdReason = null) => dateCheckAlert({ name: 'Pat Sample', slot, call: c, mismatch, service: 'Waves Assessment', holdReason }).detail;
    expect(check(call())).toMatch(/Move it to the agreed day, or confirm the new day with the customer, then tap Done\.$/);
    const optedOut = check(call({ ai_extraction_enriched: extraction({ consent: { do_not_contact_request: true } }) }));
    // Pre-push P1 (2026-11-18): with no way to confirm a new day, the step never offers to keep the booked one.
    expect(optedOut).toMatch(/Move it to the agreed day, then tap Done; do not call or text the caller\.$/);
    expect(optedOut).not.toContain('keep the booked day');
    expect(optedOut).not.toContain('confirm the new day with the customer');
    expect(check(call(), 'the caller asked not to be contacted')).toContain('do not call or text the caller');
    expect(check(call({ ai_extraction: { do_not_contact_request: true } }))).toContain('do not call or text the caller');
    expect(check(call(), 'the call has no callback number')).toMatch(/Move it to the agreed day, then tap Done; the call left no number to confirm a new day\.$/);
  });

  test('every blocking triage flag has a phrase', () => {
    const { BLOCKING_TRIAGE_FLAGS } = require('../services/call-triage-flags');
    const phrased = new Set(HOLD_REASONS.map(([flag]) => flag));
    expect([...BLOCKING_TRIAGE_FLAGS].filter((flag) => !phrased.has(flag))).toEqual([]);
  });

  test('every reason fits the why rules behind the longest prefix and slot', () => {
    const slot = { dateET: '2026-09-30', minutes: 12 * 60, name: 'Pat Sample', service: 'Waves Assessment' };
    for (const holdReason of [...HOLD_REASONS.map(([, phrase]) => phrase), ...HOLD_REASONS_BY_ROUTING.values(), HOLD_REASON_FALLBACK]) {
      for (const repeat of [false, true]) {
        const text = bookItAlert({ call: call(), slot, holdReason }, repeat);
        expect(() => composeAdminAlert({
          area: 'Schedule', action: text.action, why: text.why, severity: 'needs-you', link: text.link,
          subject: { type: 'call', id: 'call-1' }, doneWhen: 'visit_booked', who: 'person',
        })).not.toThrow();
      }
    }
  });
});

describe('runCallBookingMissWatchdog — gate', () => {
  const OLD_GATE = process.env.GATE_CALL_BOOKING_MISS_WATCHDOG;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_CALL_BOOKING_MISS_WATCHDOG;
    else process.env.GATE_CALL_BOOKING_MISS_WATCHDOG = OLD_GATE;
  });

  test('gated off (default) → no-op, no DB access', async () => {
    delete process.env.GATE_CALL_BOOKING_MISS_WATCHDOG;
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
  });
});
