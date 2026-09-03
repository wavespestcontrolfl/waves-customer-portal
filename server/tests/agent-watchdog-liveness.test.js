/**
 * Hermes watchdog liveness — the reciprocal check: one bell per ET day when
 * the external watchdog stops polling; nothing when it is fresh or the lane
 * is dark.
 */
let lastRow = null;
const mockDb = jest.fn(() => {
  const q = {
    where: jest.fn(() => q),
    max: jest.fn(() => q),
    first: jest.fn(async () => lastRow),
  };
  return q;
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true), isEnabled: jest.fn(() => true) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));

const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const { runWatchdogLivenessCheck, DEFAULT_STALE_MINUTES } = require('../services/agent-watchdog-liveness');

const NOW = new Date('2026-09-03T18:00:00.000Z'); // 14:00 ET

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(true);
  isEnabled.mockReturnValue(true);
  delete process.env.HERMES_WATCHDOG_STALE_MINUTES;
  lastRow = null;
});

test('gate off → skipped, no DB read, no bell', async () => {
  gateEnvValue.mockReturnValue(false);
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: true });
  expect(mockDb).not.toHaveBeenCalled();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('shared worker gate off → skipped (polls get a deliberate 403, so silence is not news)', async () => {
  isEnabled.mockReturnValue(false);
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: true });
  expect(isEnabled).toHaveBeenCalledWith('hermesWorker');
  expect(mockDb).not.toHaveBeenCalled();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('a fresh observed row → no bell', async () => {
  lastRow = { at: new Date(NOW.getTime() - 10 * 60000) };
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, alerted: 0, ageMinutes: 10, limit: DEFAULT_STALE_MINUTES });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('a stale observed row → one alert bell keyed to the ET day', async () => {
  lastRow = { at: new Date(NOW.getTime() - 90 * 60000) };
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, alerted: 1, ageMinutes: 90, limit: DEFAULT_STALE_MINUTES });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(category).toBe('alert');
  expect(title).toBe('FIX: Hermes watchdog silent');
  expect(body).toContain('90 min ago');
  expect(opts).toMatchObject({ bell: true, dedupeKey: 'hermes-watchdog-silent:2026-09-03', link: '/admin/agents?tab=queue' });
  expect(opts.metadata).toMatchObject({ age_minutes: 90, limit_minutes: DEFAULT_STALE_MINUTES });
});

test('never polled → bell says so; env override sets the limit; failed persist reports alerted 0', async () => {
  process.env.HERMES_WATCHDOG_STALE_MINUTES = '20';
  NotificationService.notifyAdmin.mockResolvedValueOnce(null);
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, alerted: 0, ageMinutes: null, limit: 20 });
  expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('never polled');
});

test('a deduped bell (same ET day) reports alerted 0 — the row already exists', async () => {
  lastRow = { at: new Date(NOW.getTime() - 90 * 60000) };
  NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'n1', deduped: true });
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, alerted: 0, ageMinutes: 90, limit: DEFAULT_STALE_MINUTES });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
});
