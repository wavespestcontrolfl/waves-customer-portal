/**
 * Self-serve arrival grace (owner ruling 2026-09-28, "I'd rather be more
 * lenient than strict" — Parrish live-miss). A customer-picked time names
 * an ARRIVAL window; SELF_SERVE_ARRIVAL_GRACE_MINUTES is the leniency,
 * capacity-mode-only and never for a same-day pick. See
 * server/services/scheduling/policy.js#selfServeArrivalGraceMinutes.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { selfServeArrivalGraceMinutes } = require('../services/scheduling/policy');

const { etDateString, addETDays } = require('../utils/datetime-et');

// Computed from the real clock so the same-day rule is tested on whatever
// day the suite runs (no near-today literals).
const TODAY = etDateString(new Date());
const FUTURE_DATE = etDateString(addETDays(new Date(), 7));

const ENV_KEYS = ['GATE_SCHEDULING_CAPACITY', 'SELF_SERVE_ARRIVAL_GRACE_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('unset env: default 0 (byte-identical-to-legacy)', () => {
  delete process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES;
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(0);
});

test('blank env: 0', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '   ';
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(0);
});

test('garbage env: 0', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = 'not-a-number';
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(0);
});

test('negative env: 0', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '-15';
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(0);
});

test('a live value in range passes through', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(90);
});

test('clamps to the 120-minute arrival promise — never widens it', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '999';
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(120);
});

test('exactly 120 passes through unclamped', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '120';
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(120);
});

test('a same-day (ET "today") pick gets 0 regardless of the configured value', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
  expect(selfServeArrivalGraceMinutes({ date: TODAY })).toBe(0);
});

test('capacity mode off: 0 regardless of the configured value (grace is a capacity-only feature)', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
  delete process.env.GATE_SCHEDULING_CAPACITY;
  expect(selfServeArrivalGraceMinutes({ date: FUTURE_DATE })).toBe(0);
});

test('no date given: never crashes, treated as not-today', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '60';
  expect(selfServeArrivalGraceMinutes({})).toBe(60);
  expect(selfServeArrivalGraceMinutes()).toBe(60);
});

// Codex pre-push fallback P1: a pg DATE column can deserialize as a JS Date
// at UTC midnight (never a plain 'YYYY-MM-DD' string) — the same-day check
// must still catch it via etCalendarDayOf, not a raw String()/etDateString
// conversion that would garble or shift it.
test('a same-day pick passed as a UTC-midnight Date object (pg DATE column shape) still gets 0', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
  const todayAsDate = new Date(`${TODAY}T00:00:00.000Z`);
  expect(selfServeArrivalGraceMinutes({ date: todayAsDate })).toBe(0);
});

test('a future-day pick passed as a UTC-midnight Date object still reads the live grace', () => {
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
  const futureAsDate = new Date(`${FUTURE_DATE}T00:00:00.000Z`);
  expect(selfServeArrivalGraceMinutes({ date: futureAsDate })).toBe(90);
});
