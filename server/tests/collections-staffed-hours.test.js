/**
 * staffed-hours.js delegates to the policy's ONE call-window predicate, so the
 * owner shakedown override opens the transfer branch for SUPERVISED
 * (admin-approved) calls only — an autodial case stays on the real clock
 * (codex P1 on #3555 + audit finding 2026-08-27).
 */
const { isStaffedHours } = require('../services/collections/outbound-voice/staffed-hours');

const WED_11AM_EDT = new Date('2026-08-12T15:00:00Z');
const WED_1930_EDT = new Date('2026-08-12T23:30:00Z');
const SAT_11AM_EDT = new Date('2026-08-15T15:00:00Z');
const HOUR = 60 * 60 * 1000;

afterEach(() => { delete process.env.COLLECTIONS_CALL_WINDOW_OVERRIDE_UNTIL; });

test('no override: staffed = weekday 9:00–17:59 ET regardless of supervision', () => {
  expect(isStaffedHours(WED_11AM_EDT)).toBe(true);
  expect(isStaffedHours(WED_11AM_EDT, { supervised: true })).toBe(true);
  expect(isStaffedHours(WED_1930_EDT)).toBe(false);
  expect(isStaffedHours(WED_1930_EDT, { supervised: true })).toBe(false);
  expect(isStaffedHours(SAT_11AM_EDT, { supervised: true })).toBe(false);
});

test('a live override opens staffed hours for a supervised call only', () => {
  process.env.COLLECTIONS_CALL_WINDOW_OVERRIDE_UNTIL = new Date(WED_1930_EDT.getTime() + 2 * HOUR).toISOString();
  expect(isStaffedHours(WED_1930_EDT, { supervised: true })).toBe(true);
  expect(isStaffedHours(WED_1930_EDT, { supervised: false })).toBe(false);
  expect(isStaffedHours(WED_1930_EDT)).toBe(false);
});

test('an expired override changes nothing', () => {
  process.env.COLLECTIONS_CALL_WINDOW_OVERRIDE_UNTIL = new Date(WED_1930_EDT.getTime() - 1000).toISOString();
  expect(isStaffedHours(WED_1930_EDT, { supervised: true })).toBe(false);
});
