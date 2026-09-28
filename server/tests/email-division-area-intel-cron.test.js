/** Email division area-intel cron: gate-off no-op + gate-on smoke check.
 * Same mocking shape as scheduler-geocoder-backstop.test.js. */
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
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

beforeEach(() => jest.clearAllMocks());

test('gate off — the tick returns immediately: no compute, no lock taken', async () => {
  emailAreaIntelLive.mockReturnValue(false);
  await registeredTick()();
  expect(computeAreaIntel).not.toHaveBeenCalled();
  expect(runExclusive).not.toHaveBeenCalled();
});

test('gate on — recomputes the current month under runExclusive', async () => {
  emailAreaIntelLive.mockReturnValue(true);
  computeAreaIntel.mockResolvedValue({ month: '2026-09-01', citiesProcessed: 0, summary: [] });
  await registeredTick()();
  expect(runExclusive).toHaveBeenCalledWith('email-area-intel-recompute', expect.any(Function));
  expect(computeAreaIntel).toHaveBeenCalled();
});
