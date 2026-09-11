jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));

jest.mock('../services/missed-call-bell', () => ({ sweepMissedCalls: jest.fn() }));
jest.mock('../services/repeat-caller-bell', () => ({ sweepRepeatCallers: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { sweepMissedCalls } = require('../services/missed-call-bell');
const { sweepRepeatCallers } = require('../services/repeat-caller-bell');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(name => name === 'cronJobs');
});

test.each(['missed', 'repeat'])('one call-alert tick starts both sweeps when %s recovery is still pending', async pending => {
  let rejectPending;
  const blocked = pending === 'missed' ? sweepMissedCalls : sweepRepeatCallers;
  const other = pending === 'missed' ? sweepRepeatCallers : sweepMissedCalls;
  blocked.mockReturnValue(new Promise((_, reject) => { rejectPending = reject; }));
  other.mockResolvedValue(1);
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([, callback]) => /sweepMissedCalls|sweepRepeatCallers/.test(String(callback)));
  expect(registrations).toHaveLength(1);
  const [expression, tick, options] = registrations[0];
  expect(expression).toBe('*/2 * * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
  const running = tick();
  await Promise.resolve();
  expect(other).toHaveBeenCalledTimes(1);
  rejectPending(new Error('synthetic sweep failure'));
  await expect(running).resolves.toBeUndefined();
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('synthetic sweep failure'));
});
