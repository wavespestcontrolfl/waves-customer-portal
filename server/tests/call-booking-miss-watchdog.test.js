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
  agentHoldReason,
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

// A finished pass stores the call agent's decision; this one let the booking through.
const ALLOWED = { mode: 'enforce', generated_at: NOW.toISOString(), routing: { allowed: true, reason: null, flags: [], appointment_blocking_flags: [] } };

function call(over = {}) {
  return {
    id: 'call-1', twilio_call_sid: 'CAsynthetic001', customer_id: 'cust-1',
    direction: 'outbound', created_at: OLD_ENOUGH,
    from_phone: '+19415550100', to_phone: '+19415550111',
    ai_extraction_enriched: extraction(),
    processing_status: 'processed',
    ai_validation: ALLOWED,
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
  const held = (flags = ['address_unverified'], over = {}) => ({
    mode: 'enforce', generated_at: NOW.toISOString(), routing: { allowed: false, reason: 'triage_flags', appointment_blocking_flags: flags }, ...over,
  });
  const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();

  test('rings after HELD_GRACE_MINUTES with its reason; an unheld call of the same age still waits GRACE_MINUTES', () => {
    const misses = computeBookingMisses([
      call({ id: 'held', created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ai_validation: held() }),
      call({ id: 'unheld', created_at: minutesAgo(HELD_GRACE_MINUTES + 1) }),
      call({ id: 'held-too-recent', created_at: minutesAgo(HELD_GRACE_MINUTES - 1), ai_validation: held() }),
    ], [], { now: NOW });
    expect(misses.map((m) => [m.call.id, m.holdReason])).toEqual([['held', 'the address is not confirmed']]);
    // A booking still clears a held call.
    const booked = computeBookingMisses([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ai_validation: held() })],
      [bookedRow({ source_call_log_id: 'call-1' })], { now: NOW });
    expect(booked).toHaveLength(0);
  });

  test('only an enforce-mode routing decision that blocked the booking counts as held', () => {
    expect(agentHoldReason(held())).toBe('the address is not confirmed');
    expect(agentHoldReason(held(['address_unverified'], { mode: 'shadow' }))).toBeNull();
    expect(agentHoldReason({ mode: 'enforce', routing: { allowed: true, appointment_blocking_flags: [] } })).toBeNull();
    expect(agentHoldReason({ mode: 'enforce', routing: null })).toBeNull();
    expect(agentHoldReason(null)).toBeNull();
    // A decision stored as JSON text reads the same; unreadable text is not a hold.
    expect(agentHoldReason(JSON.stringify(held()))).toBe('the address is not confirmed');
    expect(agentHoldReason('{not json')).toBeNull();
  });

  test('the reason is the first blocking flag in HOLD_REASONS order, else the fallback', () => {
    expect(agentHoldReason(held(['address_unverified', 'commercial_requires_quote']))).toBe('a commercial job needs a quote first');
    expect(agentHoldReason(held(['address_unverifiable', 'address_unverified']))).toBe('the address is not confirmed');
    expect(agentHoldReason(held(['a_flag_with_no_phrase']))).toBe(HOLD_REASON_FALLBACK);
    expect(agentHoldReason(held([]))).toBe(HOLD_REASON_FALLBACK);
  });

  // Pre-push P1 (2026-11-18): some blocked decisions carry their cause in routing.reason,
  // with empty or less exact blocking flags.
  test('a routing reason of its own names the hold before the flags do', () => {
    const blocked = (reason, flags = []) => ({ mode: 'enforce', routing: { allowed: false, reason, appointment_blocking_flags: flags } });
    expect(agentHoldReason(blocked('off_hour_start'))).toBe('the start time is not on the hour');
    expect(agentHoldReason(blocked('address_not_validated'))).toBe('the address is not confirmed');
    expect(agentHoldReason(blocked('low_confidence'))).toBe('the call details are unclear');
    expect(agentHoldReason(blocked('v1_only_new_address', ['address_unverified']))).toBe('the address is not the one on file');
    expect(agentHoldReason(blocked('triage_flags', ['caller_not_authorized']))).toBe('the caller is not the account holder');
    expect(agentHoldReason(blocked(null))).toBe(HOLD_REASON_FALLBACK);
    // The house-number hold stores no reason and no blocking flag; its flag rides routing.flags.
    const houseNumber = (reason) => ({ mode: 'enforce', routing: { allowed: false, reason, flags: ['on_file_house_number_conflict'], appointment_blocking_flags: [] } });
    expect(agentHoldReason(houseNumber(null))).toBe('a different house number was given');
    // Beside a decision blocked for its own reason, the same flag is advice, not the hold.
    expect(agentHoldReason(houseNumber('triage_flags'))).toBe(HOLD_REASON_FALLBACK);
  });

  // Pre-push P1 (2026-11-18): the /voice webhook inserts the row when the call begins, so a
  // long call would ring while the office is still booking it right after hanging up.
  test('a held call waits from the end of the call, not from its start', () => {
    const ended = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();
    const misses = computeBookingMisses([
      // Inserted at pickup, 12 minutes long: ended 3 minutes ago, still waiting.
      call({ id: 'long-call', created_at: minutesAgo(15), duration_seconds: 12 * 60, ai_validation: held() }),
      // The same call 8 minutes later: ended 11 minutes ago.
      call({ id: 'long-call-done', created_at: minutesAgo(23), duration_seconds: 12 * 60, ai_validation: held() }),
      // A post-call row: created_at is already after the call.
      call({ id: 'post-call-row', created_at: minutesAgo(11), duration_seconds: 12 * 60, metadata: { source: 'status_callback' }, ai_validation: held() }),
      // Twilio's end stamp wins over created_at + length: ended 5 minutes ago.
      call({ id: 'end-stamped', created_at: minutesAgo(30), duration_seconds: 60, metadata: { ended_at: ended(5) }, ai_validation: held() }),
      // Pre-push P1 (2026-11-18): an outbound bridge's customer-leg receipt wins over the row's
      // length, which can count the staff leg's ringing: the customer hung up 5, then 11, minutes ago.
      call({ id: 'bridge-leg', created_at: minutesAgo(30), duration_seconds: 60, metadata: { customer_leg: { ended_at: ended(5) } }, ai_validation: held() }),
      call({ id: 'bridge-leg-done', created_at: minutesAgo(30), duration_seconds: 60, metadata: { customer_leg: { ended_at: ended(11) } }, ai_validation: held() }),
    ], [], { now: NOW });
    expect(misses.map((m) => m.call.id)).toEqual(['long-call-done', 'post-call-row', 'bridge-leg-done']);
    // An unheld call keeps its wait from created_at.
    expect(computeBookingMisses([call({ duration_seconds: 120 * 60 })], [], { now: NOW })).toHaveLength(1);
  });

  test('the bell says why it was held; an unheld miss keeps "nothing is on the calendar"', () => {
    const [miss] = computeBookingMisses([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ai_validation: held() })], [], { now: NOW });
    const text = bookItAlert(miss, false);
    expect(text.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the address is not confirmed.');
    expect(text.detail).toContain('The call agent held this visit and did not book it, because the address is not confirmed.');
    const [plain] = computeBookingMisses([call()], [], { now: NOW });
    expect(bookItAlert(plain, false).why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; nothing is on the calendar.');
    expect(bookItAlert(plain, false).detail).not.toContain('The call agent held');
  });

  // Pre-push P1 (2026-11-18): an opt-out or a missing number must not end on "call back".
  test('a hold where a callback is wrong or impossible names it first and drops the callback step', () => {
    const missFor = (flag) => computeBookingMisses([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ai_validation: held(['address_unverified', flag]) })], [], { now: NOW })[0];
    const optOut = bookItAlert(missFor('do_not_contact_requested'), false);
    expect(optOut.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the caller asked not to be contacted.');
    expect(optOut.detail).toContain('Review it in dispatch before booking, and do not call or text the caller.');
    expect(optOut.detail).not.toContain('call back');
    const noNumber = bookItAlert(missFor('caller_phone_missing'), false);
    expect(noNumber.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; held because the call has no callback number.');
    expect(noNumber.detail).toContain('Book it in dispatch; the call left no number to call back.');
    expect(noNumber.detail).not.toContain('or call back');
    // The routing-reason form of the opt-out reads the same.
    expect(agentHoldReason({ mode: 'enforce', routing: { allowed: false, reason: 'do_not_contact', appointment_blocking_flags: [] } })).toBe('the caller asked not to be contacted');
  });

  // Pre-push P1s (2026-11-18): an 'extraction_failed' pass can still be retried and book the
  // visit, a reprocess keeps the previous pass's decision until it stores its own, and a
  // hard-veto exit stores none. Only a finished pass's own decision proves a hold.
  test('a hold needs a finished pass and that pass\'s own decision; anything else waits GRACE_MINUTES and names no reason', () => {
    const fast = (over) => computeBookingMisses([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ...over })], [], { now: NOW });
    const slow = (over) => computeBookingMisses([call(over)], [], { now: NOW });
    const claimedAt = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();
    // This pass claimed the row 5 minutes before it stored its decision: the decision is its own.
    expect(fast({ ai_validation: held(['address_unverified'], { generated_at: claimedAt(0) }), processing_started_at: claimedAt(5) }))
      .toEqual([expect.objectContaining({ holdReason: 'the address is not confirmed' })]);
    const unproven = {
      'no stored decision': { ai_validation: null },
      'a decision with no time': { ai_validation: held(['address_unverified'], { generated_at: undefined }) },
      'a decision from before the last claim': { ai_validation: held(['address_unverified'], { generated_at: claimedAt(5) }), processing_started_at: claimedAt(0) },
      'a pass that can still be retried': { ai_validation: held(), processing_status: 'extraction_failed' },
    };
    for (const [label, over] of Object.entries(unproven)) {
      expect([label, fast(over)]).toEqual([label, []]);
      expect([label, slow(over).map((m) => m.holdReason)]).toEqual([label, [null]]);
    }
  });

  // Pre-push P1s (2026-11-18): every stored opt-out signal bars contact, and an opt-out alone
  // never proves a hold (in shadow mode V2 does not decide the booking; in enforce mode the
  // processor's hard-veto exit stores no decision).
  test('an opt-out in any stored signal never asks for a call, and alone it does not shorten the wait', () => {
    const optOuts = {
      'V2 consent': { ai_extraction_enriched: extraction({ consent: { do_not_contact_request: true } }) },
      // A flag-only opt-out: the processor's hard veto reads the flag, with no consent boolean.
      'V2 triage flag': { ai_extraction_enriched: extraction({ triage_flags: ['do_not_contact_requested'] }) },
      'V1 extraction': { ai_extraction: { do_not_contact_request: true } },
    };
    for (const [label, over] of Object.entries(optOuts)) {
      expect([label, computeBookingMisses([call({ created_at: minutesAgo(HELD_GRACE_MINUTES + 1), ai_validation: null, ...over })], [], { now: NOW })]).toEqual([label, []]);
      const [miss] = computeBookingMisses([call({ ai_validation: null, ...over })], [], { now: NOW });
      expect(miss.holdReason).toBeNull();
      const text = bookItAlert(miss, false);
      expect(text.why).toBe('Confirmed Sat Aug 1 at 12:00 PM on a call; nothing is on the calendar.');
      expect([label, text.detail]).toEqual([label, expect.stringContaining('Review it in dispatch before booking, and do not call or text the caller.')]);
      expect(text.detail).not.toContain('call back');
    }
  });

  // Pre-push P1s (2026-11-18): the bell shows, and offers a callback on, the processor's own
  // contact number. Our own line is never one (the fixtures' from_phone stands in for it, so the
  // cases below leave it out: the test env has no list of our numbers).
  test('the number shown and the callback step follow the processor\'s contact number', () => {
    const detailOf = (over) => bookItAlert(computeBookingMisses([call({ from_phone: null, ...over })], [], { now: NOW })[0], false).detail;
    const withheld = detailOf({ to_phone: 'anonymous' });
    expect(withheld).toMatch(/^Pat Sample \(no number\) confirmed /);
    expect(withheld).toContain('Book it in dispatch; the call left no number to call back.');
    const spoken = detailOf({ to_phone: null, ai_extraction: { phone: '+19415550123' } });
    expect(spoken).toMatch(/^Pat Sample \(\+19415550123\) confirmed /);
    expect(spoken).toContain('Book it in dispatch or call back to reset expectations.');
    // A form-callback bridge dials staff first: the lead's number is the customer's, not the staff leg.
    const bridge = detailOf({ source: 'lead-webhook-auto-bridge', to_phone: '+19415550177', metadata: { type: 'lead_auto_bridge', leadPhone: '+19415550188' } });
    expect(bridge).toMatch(/^Pat Sample \(\+19415550188\) confirmed /);
  });

  // Pre-push P1 (2026-11-18): the date check follows the same contact rule as "book it".
  test('a date check never asks staff to contact an opted-out caller, or to confirm on a call with no number', () => {
    const slot = { dateET: '2026-08-01', minutes: 12 * 60 };
    const mismatch = { visit_id: 'visit-9', date: '2026-08-03', time: '09:00' };
    const check = (c, holdReason = null) => dateCheckAlert({ name: 'Pat Sample', slot, call: c, mismatch, service: 'Waves Assessment', holdReason }).detail;
    expect(check(call())).toMatch(/Move it to the agreed day, or confirm the new day with the customer, then tap Done\.$/);
    const optedOut = check(call({ ai_extraction_enriched: extraction({ consent: { do_not_contact_request: true } }) }));
    expect(optedOut).toMatch(/Move it to the agreed day or keep the booked day, then tap Done; do not call or text the caller\.$/);
    expect(optedOut).not.toContain('confirm the new day with the customer');
    expect(check(call(), 'the caller asked not to be contacted')).toContain('do not call or text the caller');
    // Our own line (the fixture's from_phone) is never a number to reach the caller on.
    expect(check(call({ to_phone: null, from_phone: null }))).toMatch(/the call left no number to confirm a new day\.$/);
    expect(check(call({ to_phone: 'anonymous', from_phone: null }))).toMatch(/the call left no number to confirm a new day\.$/);
    expect(check(call({ ai_extraction: { do_not_contact_request: true } }))).toContain('do not call or text the caller');
    expect(check(call(), 'the call has no callback number')).toMatch(/the call left no number to confirm a new day\.$/);
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
