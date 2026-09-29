/**
 * Commit-time arrival grace (owner ruling 2026-09-28, "I'd rather be more
 * lenient than strict"): verifyArrivalCapacity's arrivalGraceMinutes option
 * refuses a certified fit whose OWN simulated arrival delay exceeds the
 * caller's grace — tighter than the system's existing 120-minute arrival
 * promise (effectiveWindowRange/simulateArrivalRoute), never wider.
 *
 * arrivalExceedsGrace is exercised directly (arrival-route.js's own
 * DB-backed callers make verifyArrivalCapacity itself hard to unit-test
 * without a real transaction/connection — see
 * booking-capacity-commit-db.test.js and rebooker-capacity-placement.test.js
 * for the end-to-end Postgres coverage of the whole function).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { arrivalExceedsGrace } = require('../services/scheduling/arrival-route')._internals;

test('grace 90, delay 100: exceeds — refused', () => {
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 100 }, 90)).toBe(true);
});

test('grace 90, delay 80: within — ok', () => {
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 80 }, 90)).toBe(false);
});

test('grace 90, delay exactly 90: within (inclusive) — ok', () => {
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 90 }, 90)).toBe(false);
});

test('grace 0 (unset/off/same-day): unchanged — the 120-minute promise is the only bound', () => {
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 119 }, 0)).toBe(false);
});

test('no grace passed at all (staff/voice callers never opt in): unchanged', () => {
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 119 }, undefined)).toBe(false);
});

test('a negative or non-finite grace is treated as no grace', () => {
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 119 }, -5)).toBe(false);
  expect(arrivalExceedsGrace({ arrivalDelayMinutes: 119 }, NaN)).toBe(false);
});

test('a fit with no arrivalDelayMinutes never throws and is never treated as exceeding', () => {
  expect(arrivalExceedsGrace({}, 90)).toBe(false);
  expect(arrivalExceedsGrace(null, 90)).toBe(false);
});
