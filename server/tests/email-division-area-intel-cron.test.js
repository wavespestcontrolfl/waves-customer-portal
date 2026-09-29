/** Email division area-intel cron: gate-off no-op + gate-on smoke check +
 * the day-1..10 late-arrival window + the persisted previous-month
 * catch-up marker. Same mocking shape as
 * scheduler-geocoder-backstop.test.js. */
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../models/db', () => {
  // system_settings state lives on the mock function itself (not a
  // module-scoped closure) so tests can set/read it after require()
  // without hitting jest.mock's hoisting restrictions.
  const db = jest.fn((table) => {
    if (table === 'system_settings') {
      return {
        where: () => ({ first: async () => db.__systemSettingsRow }),
        insert: (row) => ({ onConflict: () => ({ merge: async () => { db.__systemSettingsRow = row; db.__inserts.push(row); return []; } }) }),
      };
    }
    return { where() { return this; }, del: jest.fn().mockResolvedValue(0) };
  });
  db.__systemSettingsRow = null;
  db.__inserts = [];
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'cronJobs'), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(), emailAreaIntelLive: jest.fn(() => false),
}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []), recordMissedTick: jest.fn() }));
jest.mock('../services/email-division/area-intel', () => ({ computeAreaIntel: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const db = require('../models/db');
const { emailAreaIntelLive } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');
const { computeAreaIntel } = require('../services/email-division/area-intel');
const { initScheduledJobs } = require('../services/scheduler');

function registeredTick() {
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expr, cb]) =>
    expr === '10 5 * * *' && cb.toString().includes('emailAreaIntelLive'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  db.__systemSettingsRow = null;
  db.__inserts = [];
});

test('gate off — the tick returns immediately: no compute, no lock taken', async () => {
  emailAreaIntelLive.mockReturnValue(false);
  await registeredTick()();
  expect(computeAreaIntel).not.toHaveBeenCalled();
  expect(runExclusive).not.toHaveBeenCalled();
});

test('gate on, no prior success marker — recomputes both the current and previous month', async () => {
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-09-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(runExclusive).toHaveBeenCalledWith('email-area-intel-recompute', expect.any(Function));
  expect(computeAreaIntel).toHaveBeenCalledTimes(2);
});

test('day 5 of the month, no prior success recorded — recomputes the previous month but does NOT mark it final (only a day-10+ success does; codex round 7 P2)', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-05T09:10:00Z')); // 5:10 AM ET, Oct 5 — past the old day-3 window
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-10-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(computeAreaIntel).toHaveBeenCalledTimes(2);
  const months = computeAreaIntel.mock.calls.map(([{ month: m }]) => m);
  expect(months[0].getUTCMonth()).toBe(9); // October — current month
  expect(months[1].getUTCMonth()).toBe(8); // September — previous month, still caught up on day 5
  expect(db.__inserts).toHaveLength(0); // an in-window success is not the final recompute
  jest.useRealTimers();
});

test('day 10 — the final late-arrival recompute succeeds and is recorded as final', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T09:10:00Z')); // 5:10 AM ET, Oct 10 — last window day
  db.__systemSettingsRow = { value: '2026-08-01' };
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-10-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(computeAreaIntel).toHaveBeenCalledTimes(2);
  expect(db.__inserts).toEqual([expect.objectContaining({ key: 'email_area_intel_previous_month_computed', value: '2026-09-01' })]);
  jest.useRealTimers();
});

test('a failed day-10 recompute leaves the month unfinalised, so day 11 retries it (codex round 7 P2)', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T09:10:00Z'));
  db.__systemSettingsRow = { value: '2026-08-01' }; // earlier in-window successes never finalised September
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel
    .mockResolvedValueOnce({ month: '2026-10-01', citiesProcessed: 0, summary: [] })
    .mockRejectedValueOnce(new Error('synthetic db failure'));
  const tick = registeredTick();
  await tick();
  expect(db.__inserts).toHaveLength(0);

  jest.setSystemTime(new Date('2026-10-11T09:10:00Z')); // day 11: window closed, marker still not September
  computeAreaIntel.mockReset();
  computeAreaIntel.mockResolvedValue({ month: '2026-10-01', citiesProcessed: 0, summary: [] });
  await tick();
  expect(computeAreaIntel).toHaveBeenCalledTimes(2);
  expect(computeAreaIntel.mock.calls[1][0].month.getUTCMonth()).toBe(8);
  expect(db.__inserts).toEqual([expect.objectContaining({ value: '2026-09-01' })]);
  jest.useRealTimers();
});

test('after the late-arrival window, previous month already recorded as succeeded — the tick recomputes only the current month', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-11T09:10:00Z')); // 5:10 AM ET, Oct 11 — window closed after day 10
  db.__systemSettingsRow = { value: '2026-09-01' }; // September already caught up
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-10-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(computeAreaIntel).toHaveBeenCalledTimes(1); // current month only
  expect(db.__inserts).toHaveLength(0); // no new marker write — nothing changed
  jest.useRealTimers();
});

// A prior-month closeout backfilled (earlier service_date) AFTER the first
// successful previous-month run must still reach that month's aggregate —
// the marker alone must not make the day-1 computation final.
test.each([
  ['Oct 2, 5:10 AM ET', '2026-10-02T09:10:00Z'],
  ['Oct 6, 5:10 AM ET', '2026-10-06T09:10:00Z'],
  ['Oct 10, 11:10 PM ET (Oct 11 in UTC)', '2026-10-11T03:10:00Z'],
])('inside the late-arrival window (%s), marker already current — still recomputes the previous month, no marker rewrite', async (_label, iso) => {
  jest.useFakeTimers().setSystemTime(new Date(iso));
  db.__systemSettingsRow = { value: '2026-09-01' }; // September's first run already succeeded
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-10-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(computeAreaIntel).toHaveBeenCalledTimes(2);
  const months = computeAreaIntel.mock.calls.map(([{ month: m }]) => m);
  expect(months[0].getUTCMonth()).toBe(9); // October — current month
  expect(months[1].getUTCMonth()).toBe(8); // September — recomputed again for late arrivals
  expect(db.__inserts).toHaveLength(0);
  jest.useRealTimers();
});

test('after the window, marker still names an older month (missed window) — catch-up recomputes the previous month once and records it', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-20T09:10:00Z'));
  db.__systemSettingsRow = { value: '2026-08-01' }; // September never succeeded
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-10-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(computeAreaIntel).toHaveBeenCalledTimes(2);
  expect(computeAreaIntel.mock.calls[1][0].month.getUTCMonth()).toBe(8);
  expect(db.__inserts).toEqual([expect.objectContaining({ key: 'email_area_intel_previous_month_computed', value: '2026-09-01' })]);
  jest.useRealTimers();
});

test('a failed previous-month recompute never writes the marker, so the next tick retries', async () => {
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel
    .mockResolvedValueOnce({ month: '2026-09-01', citiesProcessed: 0, summary: [] }) // current month succeeds
    .mockRejectedValueOnce(new Error('synthetic db failure')); // previous-month call fails
  await expect(registeredTick()()).resolves.toBeUndefined(); // the outer try/catch swallows it, logs instead
  expect(db.__inserts).toHaveLength(0);
});
