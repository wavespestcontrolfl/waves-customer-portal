/**
 * scheduling/customer-windows — the single hour grid, day-end bound, and
 * lunch gate every customer-facing offer surface shares (PR 2, 2026-09-23).
 */
const {
  CUSTOMER_HOUR_GRID,
  CUSTOMER_DAY_END_HOUR,
  CUSTOMER_DAY_END_MINUTES,
  CUSTOMER_LUNCH_START_MINUTES,
  CUSTOMER_LUNCH_END_MINUTES,
  lunchBlockEnabled,
  customerOfferGrid,
  overlapsLunch,
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

describe('lunchBlockEnabled (GATE_BOOKING_LUNCH_BLOCK)', () => {
  const ENV_KEY = 'GATE_BOOKING_LUNCH_BLOCK';
  let previous;
  beforeEach(() => { previous = process.env[ENV_KEY]; });
  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  test('unset (default): disabled — noon is a normal offerable/reservable hour', () => {
    delete process.env[ENV_KEY];
    expect(lunchBlockEnabled()).toBe(false);
  });

  test('"true" (and the other gateEnvValue truthy spellings): enabled', () => {
    for (const v of ['true', '1', 'on', 'TRUE', 'On']) {
      process.env[ENV_KEY] = v;
      expect(lunchBlockEnabled()).toBe(true);
    }
  });

  test('any other value (including "false") stays disabled', () => {
    for (const v of ['false', '0', 'off', 'nonsense', '']) {
      process.env[ENV_KEY] = v;
      expect(lunchBlockEnabled()).toBe(false);
    }
  });

  test('read at CALL time, not cached — a mid-process flip takes effect immediately', () => {
    delete process.env[ENV_KEY];
    expect(lunchBlockEnabled()).toBe(false);
    process.env[ENV_KEY] = 'true';
    expect(lunchBlockEnabled()).toBe(true);
    delete process.env[ENV_KEY];
    expect(lunchBlockEnabled()).toBe(false);
  });
});

describe('customerOfferGrid / overlapsLunch (the two gate-aware predicates every offer + commit surface uses)', () => {
  const ENV_KEY = 'GATE_BOOKING_LUNCH_BLOCK';
  let previous;
  beforeEach(() => { previous = process.env[ENV_KEY]; });
  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  test('the lunch window is the fixed 12:00–13:00 hour', () => {
    expect(CUSTOMER_LUNCH_START_MINUTES).toBe(12 * 60);
    expect(CUSTOMER_LUNCH_END_MINUTES).toBe(13 * 60);
  });

  test('gate unset: the offer grid is the full hour grid and nothing overlaps lunch', () => {
    delete process.env[ENV_KEY];
    expect(customerOfferGrid()).toEqual(CUSTOMER_HOUR_GRID);
    expect(customerOfferGrid()).toContain('12:00');
    expect(overlapsLunch(12 * 60, 13 * 60)).toBe(false);
    expect(overlapsLunch(11 * 60 + 30, 12 * 60 + 30)).toBe(false);
  });

  test('gate on: noon leaves the offer grid and any window touching 12:00–13:00 overlaps', () => {
    process.env[ENV_KEY] = 'true';
    expect(customerOfferGrid()).toEqual(CUSTOMER_HOUR_GRID.filter((t) => t !== '12:00'));
    expect(customerOfferGrid()).not.toContain('12:00');
    expect(overlapsLunch(12 * 60, 13 * 60)).toBe(true);
    // Partial overlaps on either edge.
    expect(overlapsLunch(11 * 60 + 30, 12 * 60 + 30)).toBe(true);
    expect(overlapsLunch(12 * 60 + 30, 13 * 60 + 30)).toBe(true);
    // A long window that spans the whole block.
    expect(overlapsLunch(10 * 60, 14 * 60)).toBe(true);
    // Half-open: a window ENDING at 12:00 or STARTING at 13:00 touches, never overlaps.
    expect(overlapsLunch(11 * 60, 12 * 60)).toBe(false);
    expect(overlapsLunch(13 * 60, 14 * 60)).toBe(false);
  });

  test('gate on: non-finite bounds never overlap (a caller with no window falls through to its other guards)', () => {
    process.env[ENV_KEY] = 'true';
    expect(overlapsLunch(null, 13 * 60)).toBe(false);
    expect(overlapsLunch(12 * 60, undefined)).toBe(false);
    expect(overlapsLunch(NaN, NaN)).toBe(false);
  });

  test('both read the gate at CALL time — a flip needs no reload', () => {
    delete process.env[ENV_KEY];
    expect(customerOfferGrid()).toContain('12:00');
    process.env[ENV_KEY] = 'true';
    expect(customerOfferGrid()).not.toContain('12:00');
    expect(overlapsLunch(12 * 60, 13 * 60)).toBe(true);
    delete process.env[ENV_KEY];
    expect(overlapsLunch(12 * 60, 13 * 60)).toBe(false);
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
  const ENV_KEY = 'GATE_BOOKING_LUNCH_BLOCK';
  let previousGate;

  beforeEach(() => {
    previousGate = process.env[ENV_KEY];
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    dbMock = require('../models/db');
    customerWindows = require('../services/scheduling/customer-windows');
  });
  afterEach(() => {
    if (previousGate === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousGate;
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

  test('a configured lunch interval (not 12:00-13:00) changes which grid hours the lunch gate removes', async () => {
    process.env[ENV_KEY] = 'true';
    mockConfig({ lunch_start: '11:00:00', lunch_end: '12:00:00', day_end: '18:00:00' });
    await customerWindows.refreshCustomerBookingWindowConfig();
    // 11:00-12:00 overlaps the configured interval and leaves the grid;
    // 12:00-13:00 (the old fixed interval) no longer does.
    expect(customerWindows.customerOfferGrid()).not.toContain('11:00');
    expect(customerWindows.customerOfferGrid()).toContain('12:00');
    expect(customerWindows.overlapsLunch(11 * 60, 12 * 60)).toBe(true);
    expect(customerWindows.overlapsLunch(12 * 60, 13 * 60)).toBe(false);
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
});
