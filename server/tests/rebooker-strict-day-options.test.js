/**
 * SmartRebooker.findRescheduleOptions `strict` (the schedule rain record, services/scheduling/rain-schedule-record.js).
 * Default: a failed occupancy probe keeps the candidate day (the commit-time check still refuses a clash). Strict: the
 * failure is thrown, so a read-only caller never offers a day it could not check.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({ clearTechCurrentJob: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()), isBlackoutDate: jest.fn(async () => false) }));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { findConflictingVisits } = require('../services/scheduling/occupancy');

const SERVICE = {
  id: 'svc-1', customer_id: 'c1', technician_id: null, scheduled_date: '2026-11-25', window_start: '14:00:00', window_end: '15:00:00',
  service_type: 'Quarterly Pest Control Service', first_name: 'A', last_name: 'B', city: 'Bradenton', zip: '34205',
};

// A chain that answers `.first()` with the visit on the first read and a count after, and awaits to an empty list.
function fakeDb() {
  let firsts = 0;
  const chain = () => {
    const c = new Proxy(() => c, {
      get: (_t, prop) => {
        if (prop === 'then') return (res) => Promise.resolve([]).then(res);
        if (prop === 'first') return async () => { firsts += 1; return firsts === 1 ? SERVICE : { count: '0' }; };
        return () => c;
      },
    });
    return c;
  };
  db.mockImplementation(() => chain());
  db.raw = jest.fn(() => 'raw');
}

beforeEach(() => { jest.clearAllMocks(); fakeDb(); });

test('a failed occupancy probe keeps the day by default and throws with strict: true', async () => {
  findConflictingVisits.mockRejectedValue(new Error('probe down'));
  const kept = await SmartRebooker.findRescheduleOptions('svc-1', 'weather_rain', { probeSpanMinutes: 60, caller: null });
  expect(kept.length).toBeGreaterThan(0);
  fakeDb();
  await expect(SmartRebooker.findRescheduleOptions('svc-1', 'weather_rain', { probeSpanMinutes: 60, caller: null, strict: true }))
    .rejects.toThrow('probe down');
});

test('strict changes nothing when the probe answers', async () => {
  findConflictingVisits.mockResolvedValue([]);
  const options = await SmartRebooker.findRescheduleOptions('svc-1', 'weather_rain', { probeSpanMinutes: 60, caller: null, strict: true });
  expect(options.length).toBeGreaterThan(0);
});
