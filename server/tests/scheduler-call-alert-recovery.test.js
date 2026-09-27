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
jest.mock('../services/promise-chaser-bell', () => ({ sweepPromiseChasers: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { sweepMissedCalls } = require('../services/missed-call-bell');
const { sweepRepeatCallers } = require('../services/repeat-caller-bell');
const { sweepPromiseChasers } = require('../services/promise-chaser-bell');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

const SWEEPS = { missed: sweepMissedCalls, repeat: sweepRepeatCallers, 'promise-chaser': sweepPromiseChasers };

// The promise-chaser sweep is gate-checked before its cron lock (codex r9
// P2), so these ticks run with its two gates on.
const PROMISE_CHASER_GATES = ['promiseChaserBell', 'callCommitments'];

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(name => name === 'cronJobs' || PROMISE_CHASER_GATES.includes(name));
});

test.each(['missed', 'repeat', 'promise-chaser'])('one call-alert tick starts every sweep when %s recovery is still pending', async pending => {
  let rejectPending;
  const others = Object.entries(SWEEPS).filter(([key]) => key !== pending).map(([, fn]) => fn);
  const blocked = SWEEPS[pending];
  blocked.mockReturnValue(new Promise((_, reject) => { rejectPending = reject; }));
  others.forEach((fn) => fn.mockResolvedValue(1));
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([, callback]) => /sweepMissedCalls|sweepRepeatCallers|sweepPromiseChasers/.test(String(callback)));
  expect(registrations).toHaveLength(1);
  const [expression, tick, options] = registrations[0];
  expect(expression).toBe('*/2 * * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
  const running = tick();
  await Promise.resolve();
  others.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
  rejectPending(new Error('synthetic sweep failure'));
  await expect(running).resolves.toBeUndefined();
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('synthetic sweep failure'));
});

test.each(PROMISE_CHASER_GATES)('with %s off, the tick never takes the promise-chaser lock or calls its sweep', async (offGate) => {
  const { runExclusive } = require('../utils/cron-lock');
  isEnabled.mockImplementation(name => name === 'cronJobs' || (PROMISE_CHASER_GATES.includes(name) && name !== offGate));
  sweepMissedCalls.mockResolvedValue(0);
  sweepRepeatCallers.mockResolvedValue(0);
  initScheduledJobs();
  const [, tick] = cron.schedule.mock.calls.find(([, callback]) => /sweepPromiseChasers/.test(String(callback)));
  await tick();
  expect(sweepPromiseChasers).not.toHaveBeenCalled();
  expect(runExclusive).not.toHaveBeenCalledWith('promise-chaser-bell', expect.any(Function));
});
