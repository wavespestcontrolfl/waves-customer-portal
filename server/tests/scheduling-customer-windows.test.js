/**
 * scheduling/customer-windows — the single hour grid, day-end bound, and
 * last-start rule every customer-facing offer surface shares (PR 2, 2026-09-23).
 */
const {
  CUSTOMER_HOUR_GRID,
  CUSTOMER_DAY_END_HOUR,
  CUSTOMER_DAY_END_MINUTES,
  CUSTOMER_LUNCH_START_MINUTES,
  CUSTOMER_LUNCH_END_MINUTES,
  customerOfferGrid,
  customerWindowAdmits,
  customerLastStart16Enabled,
  pastCustomerLastStart,
} = require('../services/scheduling/customer-windows');

describe('CUSTOMER_HOUR_GRID', () => {
  test('runs 09:00 through 17:00 hourly, including 12:00 and 17:00 (owner ruling 2026-09-23)', () => {
    expect(CUSTOMER_HOUR_GRID).toEqual([
      '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
    ]);
    expect(CUSTOMER_HOUR_GRID).toContain('12:00');
    expect(CUSTOMER_HOUR_GRID).toContain('17:00');
    expect(CUSTOMER_HOUR_GRID).toHaveLength(9);
  });
});

describe('CUSTOMER_DAY_END_HOUR / CUSTOMER_DAY_END_MINUTES', () => {
  test('is 18:00 — a 17:00 start plus the standard 60-minute visit', () => {
    expect(CUSTOMER_DAY_END_HOUR).toBe(18);
    expect(CUSTOMER_DAY_END_MINUTES).toBe(18 * 60);
  });
});

// Codex r4 on #4663: the ONE customer-window admission rule — the grid
// floor (09:00-17:00) and the resolved close, all in one
// call, so offer generation (both find-time paths), the estimate
// classifier, the slot debug mirror and reservation/commit checks can no
// longer drift the way four separate rounds of per-call-site patches did.
describe('customerWindowAdmits', () => {
  test('a start on the documented grid, ending by the (explicit) close, is admitted', () => {
    expect(customerWindowAdmits({ startMin: 9 * 60, endMin: 10 * 60, dayEndMinutes: 18 * 60 })).toBe(true);
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 18 * 60, dayEndMinutes: 18 * 60 })).toBe(true);
  });

  test('a start before the grid (08:00, find-time capacity mode\'s own shift start) is refused, even when it otherwise fits the close', () => {
    expect(customerWindowAdmits({ startMin: 8 * 60, endMin: 9 * 60, dayEndMinutes: 18 * 60 })).toBe(false);
  });

  test('an off-grid minute (not on the hour, or an hour outside 09:00-17:00) is refused', () => {
    expect(customerWindowAdmits({ startMin: 9 * 60 + 15, endMin: 10 * 60, dayEndMinutes: 18 * 60 })).toBe(false);
    expect(customerWindowAdmits({ startMin: 18 * 60, endMin: 19 * 60, dayEndMinutes: 20 * 60 })).toBe(false);
  });

  test('an end past the resolved close is refused, even for a documented-grid start', () => {
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 17 * 60 + 90, dayEndMinutes: 18 * 60 })).toBe(false);
    // A tighter, configured close (e.g. 16:00) narrows admission the same way.
    expect(customerWindowAdmits({ startMin: 16 * 60, endMin: 17 * 60, dayEndMinutes: 16 * 60 })).toBe(false);
  });

  test('noon is a normal hour: a 12:00-13:00 window is admitted', () => {
    expect(customerWindowAdmits({ startMin: 12 * 60, endMin: 13 * 60, dayEndMinutes: 18 * 60 })).toBe(true);
  });

  test('non-finite or inverted bounds are refused, never thrown', () => {
    expect(customerWindowAdmits({ startMin: null, endMin: 10 * 60 })).toBe(false);
    expect(customerWindowAdmits({ startMin: 9 * 60, endMin: undefined })).toBe(false);
    expect(customerWindowAdmits({ startMin: 10 * 60, endMin: 9 * 60 })).toBe(false);
    expect(customerWindowAdmits()).toBe(false);
  });

  test('dayEndMinutes defaults to the live currentDayEndMinutes() when not passed', () => {
    // Nothing has ever refreshed the cache in this describe — currentDayEndMinutes()
    // falls back to the fixed 18:00 constant, matching CUSTOMER_DAY_END_MINUTES.
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 18 * 60 })).toBe(true);
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 18 * 60 + 1 })).toBe(false);
    expect(customerWindowAdmits({ startMin: 12 * 60, endMin: 13 * 60 })).toBe(true);
  });
});

describe('customerOfferGrid (the offer grid every customer surface builds from)', () => {
  test('the lunch window is the fixed 12:00–13:00 hour (booking_config fallback)', () => {
    expect(CUSTOMER_LUNCH_START_MINUTES).toBe(12 * 60);
    expect(CUSTOMER_LUNCH_END_MINUTES).toBe(13 * 60);
  });

  test('the offer grid is the full hour grid, noon included', () => {
    expect(customerOfferGrid()).toEqual(CUSTOMER_HOUR_GRID);
    expect(customerOfferGrid()).toContain('12:00');
  });
});

describe('refreshCustomerBookingWindowConfig / currentLunchInterval / currentDayEndMinutes (Codex r1 P2s on #4663 — one booking_config authority)', () => {
  // booking.js (bookingSlotWindow) and the assistant's availability engine
  // already read booking_config.lunch_start/_end and .day_end, falling back
  // to the fixed constants above; the estimate picker and slot-reservation
  // used to read ONLY the fixed constants, which could disagree with an
  // owner-configured interval or a preserved (non-18:00) day_end override.
  let dbMock;
  let customerWindows;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    dbMock = require('../models/db');
    customerWindows = require('../services/scheduling/customer-windows');
  });
  afterEach(() => {
    jest.dontMock('../models/db');
  });

  function mockConfig(row) {
    dbMock.mockImplementation((table) => {
      if (table !== 'booking_config') throw new Error(`unexpected table ${table}`);
      return { first: jest.fn().mockResolvedValue(row) };
    });
  }

  test('before any refresh, the fixed constants apply', () => {
    expect(customerWindows.currentDayEndMinutes()).toBe(18 * 60);
    expect(customerWindows.currentLunchInterval()).toEqual({ startMinutes: 12 * 60, endMinutes: 13 * 60 });
  });

  test('reads booking_config.day_end + lunch_start/_end into the cache', async () => {
    mockConfig({ lunch_start: '11:30:00', lunch_end: '12:30:00', day_end: '16:00:00' });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(customerWindows.currentDayEndMinutes()).toBe(16 * 60);
    expect(customerWindows.currentLunchInterval()).toEqual({ startMinutes: 11 * 60 + 30, endMinutes: 12 * 60 + 30 });
  });

  test('a configured lunch interval (not 12:00-13:00) leaves the offer grid whole', async () => {
    mockConfig({ lunch_start: '11:00:00', lunch_end: '12:00:00', day_end: '18:00:00' });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(customerWindows.customerOfferGrid()).toEqual(CUSTOMER_HOUR_GRID);
  });

  test('a read failure falls back to the fixed constants, never blocking an offer', async () => {
    dbMock.mockImplementation(() => { throw new Error('db unavailable'); });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(customerWindows.currentDayEndMinutes()).toBe(18 * 60);
    expect(customerWindows.currentLunchInterval()).toEqual({ startMinutes: 12 * 60, endMinutes: 13 * 60 });
  });

  test('a null/missing booking_config row falls back to the fixed constants', async () => {
    mockConfig(undefined);
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(customerWindows.currentDayEndMinutes()).toBe(18 * 60);
    expect(customerWindows.currentLunchInterval()).toEqual({ startMinutes: 12 * 60, endMinutes: 13 * 60 });
  });

  test('caches within the TTL — a second refresh call does not re-query', async () => {
    mockConfig({ lunch_start: '11:30:00', lunch_end: '12:30:00', day_end: '16:00:00' });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(dbMock).toHaveBeenCalledTimes(1);
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(dbMock).toHaveBeenCalledTimes(1);
  });

  test('bookingWindowConfigKnown() is false before any successful read and true after one', async () => {
    expect(customerWindows.bookingWindowConfigKnown()).toBe(false);
    mockConfig({ lunch_start: '11:30:00', lunch_end: '12:30:00', day_end: '16:00:00' });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(customerWindows.bookingWindowConfigKnown()).toBe(true);
  });

  test('a read failure NEVER known: falls back to the fixed constants and stays unknown', async () => {
    dbMock.mockImplementation(() => { throw new Error('db unavailable'); });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(customerWindows.bookingWindowConfigKnown()).toBe(false);
    expect(customerWindows.currentDayEndMinutes()).toBe(18 * 60);
  });

  // Codex push-audit P1 on #4663: the first cut reset to the fixed
  // constants on ANY failure, including one AFTER a successful read —
  // reproduced, a configured 16:00 close + 11:00-12:00 lunch silently
  // became 18:00/12:00-13:00 (MORE permissive) for the rest of that
  // failure's 60s TTL, and reservation commits trust this same cache.
  test('a read failure AFTER a successful read preserves the last known-good config — never widens to the constants', async () => {
    jest.useFakeTimers();
    try {
      mockConfig({ lunch_start: '11:00:00', lunch_end: '12:00:00', day_end: '16:00:00' });
      await customerWindows.refreshCustomerBookingWindowConfig();
      expect(customerWindows.currentDayEndMinutes()).toBe(16 * 60);
      expect(customerWindows.currentLunchInterval()).toEqual({ startMinutes: 11 * 60, endMinutes: 12 * 60 });

      // Advance past the 60s TTL so the next call actually re-queries, then
      // fail that query.
      jest.advanceTimersByTime(61 * 1000);
      dbMock.mockImplementation(() => { throw new Error('db unavailable'); });
      await customerWindows.refreshCustomerBookingWindowConfig();

      // Still the configured 16:00/11:00-12:00 — NOT the fixed 18:00/12:00-13:00.
      expect(customerWindows.currentDayEndMinutes()).toBe(16 * 60);
      expect(customerWindows.currentLunchInterval()).toEqual({ startMinutes: 11 * 60, endMinutes: 12 * 60 });
      expect(customerWindows.bookingWindowConfigKnown()).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  test('a failure with no known-good retries on the NEXT call rather than caching the failure for the TTL', async () => {
    dbMock.mockImplementation(() => { throw new Error('db unavailable'); });
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(dbMock).toHaveBeenCalledTimes(1);
    // No advanceTimersByTime — a cached FAILURE must not block an immediate retry.
    await customerWindows.refreshCustomerBookingWindowConfig();
    expect(dbMock).toHaveBeenCalledTimes(2);
  });
});

// Owner ruling 2026-10-09 ("last start 16"): a 17:00 start quotes a 5-7 PM
// arrival window. One gate removes it from every customer surface.
describe('GATE_CUSTOMER_LAST_START_16', () => {
  const KEYS = ['GATE_CUSTOMER_LAST_START_16'];
  const previous = {};
  beforeEach(() => { for (const k of KEYS) { previous[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) {
      if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    }
  });

  test('off (default): the 17:00 start is offered and admitted, as before', () => {
    expect(customerLastStart16Enabled()).toBe(false);
    expect(customerOfferGrid()).toBe(CUSTOMER_HOUR_GRID);
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 18 * 60, dayEndMinutes: 18 * 60 })).toBe(true);
  });

  test('on: 16:00 is the last start offered and admitted; 17:00 is refused', () => {
    process.env.GATE_CUSTOMER_LAST_START_16 = 'true';
    expect(customerLastStart16Enabled()).toBe(true);
    expect(customerOfferGrid()).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
    expect(customerWindowAdmits({ startMin: 16 * 60, endMin: 17 * 60, dayEndMinutes: 18 * 60 })).toBe(true);
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 18 * 60, dayEndMinutes: 18 * 60 })).toBe(false);
    // A short visit that would end before the close is still past the last start.
    expect(customerWindowAdmits({ startMin: 17 * 60, endMin: 17 * 60 + 30, dayEndMinutes: 18 * 60 })).toBe(false);
  });

  test('pastCustomerLastStart is what the estimate reservation path checks: false with the gate off, true only after 16:00 with it on', () => {
    expect(pastCustomerLastStart(17 * 60)).toBe(false);
    process.env.GATE_CUSTOMER_LAST_START_16 = 'true';
    expect(pastCustomerLastStart(16 * 60)).toBe(false);
    expect(pastCustomerLastStart(17 * 60)).toBe(true);
  });

  test('the grid constant itself is unchanged, so staff surfaces and rollback keep 17:00', () => {
    process.env.GATE_CUSTOMER_LAST_START_16 = 'true';
    expect(CUSTOMER_HOUR_GRID).toContain('17:00');
  });
});
