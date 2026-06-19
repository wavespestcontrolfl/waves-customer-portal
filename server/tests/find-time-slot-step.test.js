// find-time slotStepMinutes: auto-dispatch needs on-the-hour starts (stops are
// never at 10:15 / 1:30). Default (1) preserves exact earliest-feasible minute.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({ HQ: { lat: 27.39, lng: -82.39 }, haversine: () => 0.5 }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');

function chain(result) {
  const c = {};
  ['where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

beforeEach(() => {
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([])));
});

const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: '2026-09-01', dateTo: '2026-09-01', topN: 5 };

test('default (no step) returns the exact earliest-feasible minute', async () => {
  const { slots } = await findAvailableSlots(BASE);
  expect(slots.length).toBeGreaterThan(0);
  expect(slots[0].start_time).toBe('08:01'); // 08:00 open + 1 min drive from HQ
});

test('slotStepMinutes:60 snaps every start up to the hour', async () => {
  const { slots } = await findAvailableSlots({ ...BASE, slotStepMinutes: 60 });
  expect(slots.length).toBeGreaterThan(0);
  for (const s of slots) {
    expect(s.start_time.endsWith(':00')).toBe(true);
  }
  expect(slots[0].start_time).toBe('09:00'); // 08:01 rounded up to the next hour
});
