// Call booking-miss watchdog (2026-07-30). Born from the Knorr/Riverwalk
// miss: an outbound callback confirmed "Saturday at noon", the V2 extraction
// captured it (scheduling.status=confirmed + confirmed_start_at), every
// auto-booking guard parked it into a 1,700-item open triage backlog, and
// nobody was scheduled. These tests pin the pure diff — confirmed-slot
// parsing (object AND string-era extractions), ET date keying, grace filter,
// unlinked-call handling — and the gate-off no-op.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const {
  runCallBookingMissWatchdog,
  computeBookingMisses,
  extractConfirmedSlot,
  GRACE_MINUTES,
} = require('../services/call-booking-miss-watchdog');

const NOW = new Date('2026-07-30T16:00:00Z');
const OLD_ENOUGH = new Date(NOW.getTime() - (GRACE_MINUTES + 30) * 60 * 1000).toISOString();
const TOO_RECENT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();

// The Knorr shape: outbound call, slot confirmed for Sat Aug 1 noon ET.
function extraction(over = {}) {
  return {
    caller: { name_full: 'Jennifer Richard', first_name: 'Jennifer' },
    service_request: { specific_service_name: 'Waves Assessment', primary_service_category: 'termite' },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-08-01T12:00:00-04:00' },
    ...over,
  };
}

function call(over = {}) {
  return {
    id: 'call-1', customer_id: 'cust-1', direction: 'outbound', created_at: OLD_ENOUGH,
    from_phone: '+19412975749', to_phone: '+19413759789',
    ai_extraction_enriched: extraction(),
    ...over,
  };
}

describe('extractConfirmedSlot', () => {
  test('parses a confirmed slot from an object extraction', () => {
    const slot = extractConfirmedSlot(extraction());
    expect(slot.name).toBe('Jennifer Richard');
    expect(slot.service).toBe('Waves Assessment');
    expect(slot.startAt.toISOString()).toBe('2026-08-01T16:00:00.000Z');
  });

  test('parses a STRING-era extraction (column stored stringified JSON historically)', () => {
    const slot = extractConfirmedSlot(JSON.stringify(extraction()));
    expect(slot).not.toBeNull();
    expect(slot.startAt.toISOString()).toBe('2026-08-01T16:00:00.000Z');
  });

  test('non-confirmed, missing start, unparseable start, and garbage all return null', () => {
    expect(extractConfirmedSlot(extraction({ scheduling: { status: 'requested', confirmed_start_at: '2026-08-01T12:00:00-04:00' } }))).toBeNull();
    expect(extractConfirmedSlot(extraction({ scheduling: { status: 'confirmed', confirmed_start_at: null } }))).toBeNull();
    expect(extractConfirmedSlot(extraction({ scheduling: { status: 'confirmed', confirmed_start_at: 'saturday-ish' } }))).toBeNull();
    expect(extractConfirmedSlot('not json')).toBeNull();
    expect(extractConfirmedSlot(null)).toBeNull();
  });
});

describe('computeBookingMisses — confirmed-slot vs schedule diff', () => {
  test('a confirmed slot with no booking on that ET date is a miss', () => {
    const misses = computeBookingMisses([call()], new Set(), { now: NOW });
    expect(misses).toHaveLength(1);
    expect(misses[0].serviceDateET).toBe('2026-08-01');
  });

  test('a booking for that customer on the confirmed ET date clears the miss', () => {
    const booked = new Set(['cust-1:2026-08-01']);
    expect(computeBookingMisses([call()], booked, { now: NOW })).toHaveLength(0);
  });

  test('the ET date key survives the UTC boundary (11pm ET slot is NOT the next UTC day)', () => {
    // 2026-08-01T23:00-04:00 is 03:00Z on Aug 2 — the booking lives on Aug 1 ET.
    const late = call({ ai_extraction_enriched: extraction({ scheduling: { status: 'confirmed', confirmed_start_at: '2026-08-01T23:00:00-04:00' } }) });
    expect(computeBookingMisses([late], new Set(['cust-1:2026-08-01']), { now: NOW })).toHaveLength(0);
    expect(computeBookingMisses([late], new Set(['cust-1:2026-08-02']), { now: NOW })).toHaveLength(1);
  });

  test('an UNLINKED call (customer_id null) with a confirmed slot is always a miss', () => {
    const orphan = call({ customer_id: null });
    // Even a same-date booking key for some other customer cannot clear it.
    const misses = computeBookingMisses([orphan], new Set(['cust-1:2026-08-01']), { now: NOW });
    expect(misses).toHaveLength(1);
  });

  test('in-grace calls and non-confirmed extractions are excluded', () => {
    const rows = [
      call({ id: 'fresh', created_at: TOO_RECENT }),
      call({ id: 'requested', ai_extraction_enriched: extraction({ scheduling: { status: 'requested', confirmed_start_at: null } }) }),
      call({ id: 'no-extraction', ai_extraction_enriched: null }),
    ];
    expect(computeBookingMisses(rows, new Set(), { now: NOW })).toHaveLength(0);
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
