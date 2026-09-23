/**
 * AvailabilityEngine.findGaps — morning/afternoon coverage once the lunch
 * block is off (GATE_BOOKING_LUNCH_BLOCK unset, owner ruling 2026-09-23).
 * The block used to split every day into two gaps, so an empty day offered
 * [09:00, 14:00]; with it gone the day is one gap and the legacy
 * first-accepted-start-per-gap rule would offer 09:00 alone, losing every
 * afternoon choice for the assistant's check_availability tool. A gap that
 * spans the configured afternoon boundary now also offers its first accepted
 * start at/after it; gate on keeps the legacy shape exactly.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const engine = require('../services/availability');

const H = (h, m = 0) => h * 60 + m;
const starts = (slots) => slots.map((s) => s.start);

describe('findGaps — afternoon coverage without the lunch block', () => {
  const DAY_START = H(8);
  const DAY_END = H(17);
  const DURATION = 60;
  const BUFFER = 15;

  test('legacy (block on = lunch occupied, no boundary): an empty day offers 09:00 and 14:00', () => {
    const occupied = [{ start: H(12), end: H(13) }];
    expect(starts(engine.findGaps(occupied, DAY_START, DAY_END, DURATION, BUFFER, null)))
      .toEqual([H(9), H(14)]);
  });

  test('block off, no boundary passed (legacy findGaps contract): one gap → 09:00 only', () => {
    expect(starts(engine.findGaps([], DAY_START, DAY_END, DURATION, BUFFER, null)))
      .toEqual([H(9)]);
  });

  test('block off + afternoon boundary 13:00: an empty day offers 09:00 AND 13:00', () => {
    expect(starts(engine.findGaps([], DAY_START, DAY_END, DURATION, BUFFER, null, { afternoonStartMin: H(13) })))
      .toEqual([H(9), H(13)]);
  });

  test('block off: a gap that opens onto noon offers noon (it is the gap\'s first accepted start)', () => {
    // Stop 10:00–11:00: the leading gap (09:00–09:45) can't hold 60 min;
    // the next gap starts roundUp(11:15) = 12:00 — noon is its first start,
    // and the afternoon boundary still adds 13:00.
    const occupied = [{ start: H(10), end: H(11) }];
    const got = starts(engine.findGaps(occupied, DAY_START, DAY_END, DURATION, BUFFER, null, { afternoonStartMin: H(13) }));
    expect(got).toEqual([H(12), H(13)]);
  });

  test('block off: a gap entirely in the afternoon is unaffected by the boundary (no duplicate)', () => {
    const occupied = [{ start: H(9), end: H(13)  }];
    expect(starts(engine.findGaps(occupied, DAY_START, DAY_END, DURATION, BUFFER, null, { afternoonStartMin: H(13) })))
      .toEqual([H(14)]);
  });

  test('block off: the accept predicate governs the afternoon pick too (first ACCEPTED start at/after the boundary)', () => {
    const accept = (slot) => slot.start !== H(13) && slot.start !== H(9); // reject 09:00 and 13:00
    expect(starts(engine.findGaps([], DAY_START, DAY_END, DURATION, BUFFER, accept, { afternoonStartMin: H(13) })))
      .toEqual([H(10), H(14)]);
  });

  test('block off: the four-slot-per-day cap still applies', () => {
    const occupied = [
      { start: H(10), end: H(10, 30) }, { start: H(12), end: H(12, 30) }, { start: H(14), end: H(14, 30) },
    ];
    const got = engine.findGaps(occupied, DAY_START, DAY_END, 30, 0, null, { afternoonStartMin: H(13) });
    expect(got.length).toBeLessThanOrEqual(4);
  });
});
