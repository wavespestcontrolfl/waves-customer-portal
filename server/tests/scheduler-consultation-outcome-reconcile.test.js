/**
 * The hourly consultation-outcome reconciliation sweep's cron registration
 * (round 10 — server/services/scheduler.js, ':27 * * * *'). The reconcile
 * LOGIC itself (evidence check, row lock, idempotency, per-row best-effort)
 * is unit-tested directly in server/tests/consultation-outcomes.test.js;
 * this file only proves the job is wired the way the repo wires every other
 * periodic job (same mock shape as scheduler-schedule-integrity.test.js).
 */
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

jest.mock('../services/consultation-outcomes', () => ({ reconcileOpenConsultationOutcomes: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');
const { reconcileOpenConsultationOutcomes } = require('../services/consultation-outcomes');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((name) => name === 'cronJobs');
});

function registeredHandler() {
  initScheduledJobs();
  const registration = cron.schedule.mock.calls.find(([expression]) => expression === '27 * * * *');
  expect(registration).toBeDefined();
  expect(registration[2]).toEqual({ timezone: 'America/New_York' });
  return registration[1];
}

test('registers hourly at :27 America/New_York and runs under the exclusive cron lock', async () => {
  reconcileOpenConsultationOutcomes.mockResolvedValue({ scanned: 0, won: 0, errors: 0 });
  const handler = registeredHandler();
  await handler();
  expect(runExclusive).toHaveBeenCalledWith('consultation-outcome-reconcile', expect.any(Function));
  expect(reconcileOpenConsultationOutcomes).toHaveBeenCalledTimes(1);
});

test('a no-op tick (nothing to reconcile) logs nothing FOR THIS JOB — dark by construction, not behind a gate', async () => {
  reconcileOpenConsultationOutcomes.mockResolvedValue({ scanned: 0, won: 0, errors: 0 });
  const handler = registeredHandler();
  logger.info.mockClear(); // initScheduledJobs() itself logs unrelated "X crons initialized" lines
  await handler();
  expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('consultation-outcome-reconcile'));
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

test('a tick that wins rows logs the counts', async () => {
  reconcileOpenConsultationOutcomes.mockResolvedValue({ scanned: 5, won: 2, errors: 0 });
  const handler = registeredHandler();
  await handler();
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('scanned=5 won=2 errors=0'));
});

test('a tick with per-row errors still logs (visibility into the best-effort skip count)', async () => {
  reconcileOpenConsultationOutcomes.mockResolvedValue({ scanned: 3, won: 0, errors: 1 });
  const handler = registeredHandler();
  await handler();
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('errors=1'));
});

test('the sweep function throwing (contract violation — it should never throw) is caught, not fatal to the tick', async () => {
  reconcileOpenConsultationOutcomes.mockRejectedValue(new Error('unexpected'));
  const handler = registeredHandler();
  await expect(handler()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Consultation-outcome reconcile tick failed'));
});
