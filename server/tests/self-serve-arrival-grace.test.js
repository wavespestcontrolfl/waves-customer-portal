/**
 * Self-serve arrival grace (owner ruling 2026-09-28, "I'd rather be more
 * lenient than strict" — Parrish live-miss). A customer-picked time names
 * an ARRIVAL window; SELF_SERVE_ARRIVAL_GRACE_MINUTES is the leniency,
 * capacity-mode-only and never for a same-day pick. See
 * server/services/scheduling/policy.js#selfServeArrivalGraceMinutes.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-09-29T16:00:00Z'); // 2026-09-29 is "today" ET for these tests
  return { ...actual, etDateString: (date) => actual.etDateString(date || PINNED_NOW) };
});

const { selfServeArrivalGraceMinutes } = require('../services/scheduling/policy');

const FUTURE_DATE = '2026-10-06'; // clearly a different ET day than the pinned "today"
const TODAY = '2026-09-29';

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
