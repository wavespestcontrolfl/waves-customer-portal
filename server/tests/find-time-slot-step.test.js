// find-time slotStepMinutes: auto-dispatch needs on-the-hour starts (stops are
// never at 10:15 / 1:30). Default (1) preserves exact earliest-feasible minute.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  // The stop query selects db.raw(...) coordinate expressions (stamped-address
  // divergence guard) — mirror knex's raw so building the select can't throw.
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
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

test('earliestStartMin floors the gap start so a later preferred-time slot is generated', async () => {
  // Empty day: without the floor this gap collapses to ~08:01. An afternoon
  // preference (13:00) must still produce a candidate AT 13:00, not be lost.
  const { slots } = await findAvailableSlots({ ...BASE, earliestStartMin: 13 * 60 });
  expect(slots.length).toBeGreaterThan(0);
  expect(slots[0].start_time).toBe('13:00');
});

test('earliestStartMin past what fits before day close yields no slot (correctly)', async () => {
  // 16:30 floor + 60 min duration = 17:30 > 17:00 close → the gap can't fit it.
  const { slots } = await findAvailableSlots({ ...BASE, earliestStartMin: 16 * 60 + 30 });
  expect(slots.length).toBe(0);
});

test('earliestStartMin default (0) is a no-op — identical legacy behavior', async () => {
  const { slots } = await findAvailableSlots(BASE);
  expect(slots[0].start_time).toBe('08:01');
});

test('a coordless stop (divergent stamped rental) degrades to zero drive, not hidden gaps (round-9 P2)', async () => {
  const stop = {
    id: 's1', scheduled_date: '2026-09-01', technician_id: 't1',
    window_start: '10:00', window_end: '11:00', service_type: 'pest',
    estimated_duration_minutes: 60,
    svc_lat: null, svc_lng: null, cust_lat: null, cust_lng: null,
    first_name: 'Rental', last_name: 'Stop', city: 'Venice',
  };
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([stop])));
  const { slots } = await findAvailableSlots(BASE);
  const starts = slots.map((s) => s.start_time);
  // Both gaps around the coordless stop must still offer slots.
  expect(starts.some((t) => t < '10:00')).toBe(true);
  expect(starts.some((t) => t >= '11:00')).toBe(true);
});
