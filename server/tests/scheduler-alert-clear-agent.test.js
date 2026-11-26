/**
 * The alert clear-up agent cron: the gate is read at TICK time with alertClearAgentMode(), before the lock. Off = no lock, no sweep and
 * no job-health row; shadow = one sweep under runExclusive, counts only in the log. Same mocking shape as
 * scheduler-day-agreement-shadow.test.js.
 */
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockMode = { value: 'shadow' };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'cronJobs'), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  alertClearAgentMode: jest.fn(() => mockMode.value),
}));
const mockHealth = [];
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, task) => {
    try {
      const out = await task();
      mockHealth.push([name, 'ok']);
      return out;
    } catch (err) {
      mockHealth.push([name, 'failed', err.code]);
      throw err;
    }
  }),
  settleDeadRunningJobs: jest.fn(async () => []),
  recordMissedTick: jest.fn(async () => {}),
}));
jest.mock('../services/alert-clear-agent', () => ({ runAlertClearAgent: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { runExclusive } = require('../utils/cron-lock');
const { runAlertClearAgent } = require('../services/alert-clear-agent');
const { initScheduledJobs } = require('../services/scheduler');

function tick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes("runExclusive('alert-clear-agent'"));
  expect(regs).toHaveLength(1);
  expect(regs[0][0]).toBe('5,15,25,35,45,55 * * * *');
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHealth.length = 0;
  mockMode.value = 'shadow';
  runAlertClearAgent.mockResolvedValue({ alerts: 3, rule_answered: 1 });
});

test.each(['off', 'true', undefined])('mode %p: no lock, no sweep, no job-health row', async (value) => {
  mockMode.value = value;
  await tick()();
  expect(runExclusive).not.toHaveBeenCalled();
  expect(runAlertClearAgent).not.toHaveBeenCalled();
  expect(mockHealth).toEqual([]);
});

test('shadow: one sweep under the lock, counts logged, a successful run', async () => {
  await tick()();
  expect(mockHealth).toEqual([['alert-clear-agent', 'ok']]);
  expect(runAlertClearAgent).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"alerts":3'));
});

test('the gate is re-read on every tick: a flip needs no restart', async () => {
  const run = tick();
  mockMode.value = 'off';
  await run();
  expect(runAlertClearAgent).not.toHaveBeenCalled();
  mockMode.value = 'shadow';
  await run();
  expect(runAlertClearAgent).toHaveBeenCalledTimes(1);
});

test('a sweep that throws is a failed run, logged by code only', async () => {
  runAlertClearAgent.mockRejectedValue(Object.assign(new Error('secret detail'), { code: 'ECONNRESET' }));
  await tick()();
  expect(mockHealth).toEqual([['alert-clear-agent', 'failed', 'ECONNRESET']]);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret detail');
});
