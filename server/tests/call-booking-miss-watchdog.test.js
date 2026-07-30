// Call booking-miss watchdog (2026-07-30). Born from a July 2026 outbound
// callback that confirmed "Saturday at noon": the V2 extraction captured the
// slot (scheduling.status=confirmed + confirmed_start_at), every auto-booking
// guard parked it into a 1,700-item open triage backlog, and nobody was
// scheduled. These tests pin the pure diff — confirmed-slot parsing (object
// AND string-era extractions), the v2IsoToEtWallClock wall-clock contract,
// call-linked clearing evidence, grace filter, unlinked-call handling — and
// the gate-off no-op. All fixture identities are synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const {
  runCallBookingMissWatchdog,
  computeBookingMisses,
  extractConfirmedSlot,
  confirmedWallClockET,
  rowClearsSlot,
  GRACE_MINUTES,
} = require('../services/call-booking-miss-watchdog');

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

  test('another customer\'s same-date booking never clears', () => {
    expect(computeBookingMisses([call()], [bookedRow({ customer_id: 'cust-other', source_call_log_id: 'call-1' })], { now: NOW })).toHaveLength(1);
  });

  test('an UNLINKED call (customer_id null) with a confirmed slot is always a miss', () => {
    expect(computeBookingMisses([call({ customer_id: null })], [bookedRow({ source_call_log_id: 'call-1' })], { now: NOW })).toHaveLength(1);
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
