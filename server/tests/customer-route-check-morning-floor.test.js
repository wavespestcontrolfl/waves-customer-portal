/**
 * /book builder (buildBookingAvailability) with the REAL route check helper and a mocked
 * route simulation: the time-of-day filter runs before the check, so a morning-only
 * search is judged on its morning slots alone. Every morning start failing while an
 * afternoon start passes must give back the morning offers, never an empty picker.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => true),
  loadArrivalRouteContext: jest.fn(async () => ({ rows: [] })),
  evaluateArrivalPlacement: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  customerRouteCheckMode: () => 'on',
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const arrivalRoute = require('../services/scheduling/arrival-route');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const D = etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), 2));
const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00', max_self_books_per_day: 3 };
const slot = (startTime, rank) => ({
  date: D, start_time: startTime, end_time: null, technician: { id: 'tech-1' },
  detour_minutes: 3, stops_that_day: 2, rank, score: 100 - rank, insertion: { after_stop_id: 'stop-1' },
});
const startsOf = (result) => result.days.flatMap((d) => d.slots.map((s) => s.start_time)).sort();
const build = (timeOfDay) => buildBookingAvailability({
  lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date(),
  timeOfDay, surface: 'book',
});

beforeEach(() => {
  jest.clearAllMocks();
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
  listOccupiedWindows.mockResolvedValue([]);
  findAvailableSlots.mockResolvedValue({ slots: [slot('09:00', 1), slot('10:00', 2), slot('14:00', 3)], total_feasible: 3 });
});

test('every morning start fails and only the afternoon start passes: a morning search still gets its morning offers', async () => {
  arrivalRoute.evaluateArrivalPlacement.mockImplementation((_ctx, { windowStart }) => (windowStart < '12:00' ? { feasible: false, reason: 'arrival_window' } : { feasible: true }));
  const morning = await build('morning');
  expect(startsOf(morning)).toEqual(['09:00', '10:00']);
  expect(morning.slots.length).toBeGreaterThan(0);
});

test('with no time-of-day filter the same failures are removed while the afternoon survives', async () => {
  arrivalRoute.evaluateArrivalPlacement.mockImplementation((_ctx, { windowStart }) => (windowStart < '12:00' ? { feasible: false, reason: 'arrival_window' } : { feasible: true }));
  expect(startsOf(await build('any'))).toEqual(['14:00']);
});

test('one morning start passes: only the failing one goes', async () => {
  arrivalRoute.evaluateArrivalPlacement.mockImplementation((_ctx, { windowStart }) => (windowStart === '09:00' ? { feasible: false, reason: 'arrival_window' } : { feasible: true }));
  expect(startsOf(await build('morning'))).toEqual(['10:00']);
});
