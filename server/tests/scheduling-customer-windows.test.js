/**
 * scheduling/customer-windows — the single hour grid, day-end bound, and
 * lunch gate every customer-facing offer surface shares (PR 2, 2026-09-23).
 */
const {
  CUSTOMER_HOUR_GRID,
  CUSTOMER_DAY_END_HOUR,
  CUSTOMER_DAY_END_MINUTES,
  lunchBlockEnabled,
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
