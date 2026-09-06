jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: async () => new Set() }));
jest.mock('../services/auto-dispatch/geo', () => ({ HQ: { lat: 27, lng: -82 }, driveMin: () => 0 }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { etDateString, addETDays } = require('../utils/datetime-et');
const DATE = etDateString(addETDays(new Date(), 10));
const OPTIONS = { lat: 27, lng: -82, dateFrom: DATE, dateTo: DATE, durationMinutes: 60, includeWeekends: true };

// Execute the builder's selection predicates on synthetic rows; no database or APIs.
function serviceQuery(input) {
  let rows = input;
  const column = key => key.split('.').pop();
  const q = {
    whereBetween: () => q,
    whereNotIn(key, values) { rows = rows.filter(row => !values.includes(row[column(key)])); return q; },
    whereNotNull(key) { rows = rows.filter(row => row[column(key)] != null); return q; },
    where(fn) {
      let nullColumn;
      let liveColumn;
      const group = {
        whereNull(key) { nullColumn = column(key); return group; },
        orWhereRaw(sql) {
          expect(sql).toBe('scheduled_services.reservation_expires_at > NOW()');
          liveColumn = 'reservation_expires_at';
          return group;
        },
      };
      fn(group);
      rows = rows.filter(row => row[nullColumn] == null || new Date(row[liveColumn]) > new Date());
      return q;
    },
    leftJoin: () => q,
    select: async () => rows,
  };
  return q;
}

function wire(rows) {
  db.raw = sql => sql;
  db.mockImplementation(table => table === 'technicians'
    ? { where() { return this; }, select: async () => [{ id: 'tech-1' }] }
    : serviceQuery(rows));
}

const stop = overrides => ({
  id: 'synthetic-stop', technician_id: 'tech-1', scheduled_date: DATE,
  window_start: '08:00', window_end: '17:00', status: 'confirmed',
  estimated_duration_minutes: 60, reservation_expires_at: null, ...overrides,
});

test.each(['skipped', 'rescheduled', 'cancelled', 'no_show'])('%s rows release the route day', async status => {
  wire([stop({ status })]);
  expect((await findAvailableSlots(OPTIONS)).slots).toHaveLength(1);
});

test('expired holds release the route while live holds still block it', async () => {
  wire([stop({ reservation_expires_at: new Date(Date.now() - 60_000) })]);
  expect((await findAvailableSlots(OPTIONS)).slots).toHaveLength(1);
  wire([stop({ reservation_expires_at: new Date(Date.now() + 60_000) })]);
  expect((await findAvailableSlots(OPTIONS)).slots).toHaveLength(0);
});

test('untimed placeholders do not invent a morning stop', async () => {
  wire([stop({ window_start: null, window_end: null })]);
  const { slots } = await findAvailableSlots(OPTIONS);
  expect(slots[0].start_time).toBe('08:00');
  expect(slots[0].stops_that_day).toBe(0);
});

test('confirmed and completed timed rows retain their occupied windows', async () => {
  for (const status of ['confirmed', 'completed']) {
    wire([stop({ status })]);
    expect((await findAvailableSlots(OPTIONS)).slots).toHaveLength(0);
  }
});
