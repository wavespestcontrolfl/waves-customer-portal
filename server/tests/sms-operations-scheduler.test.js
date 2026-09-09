jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  const builder = {};
  for (const name of ['insert', 'onConflict', 'ignore', 'catch']) builder[name] = () => builder;
  const db = jest.fn(() => builder);
  db.fn = { now: () => 'NOW()' };
  db.raw = jest.fn(async () => ({ rows: [] }));
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true), logGateStatus: jest.fn(), gateEnvValue: jest.fn(() => true),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, run) => run()),
  settleDeadRunningJobs: jest.fn(async () => ({})),
  recordJobStart: jest.fn(async () => {}), recordJobEnd: jest.fn(async () => {}),
}));
jest.mock('../services/sms-operational-actions', () => ({
  runSmsOperationalActions: jest.fn(), refreshSmsCommitments: jest.fn(),
}));
jest.mock('../services/callback-cards', () => ({ enabled: jest.fn(() => true), notifyDueCallbacks: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { gateEnvValue } = require('../config/feature-gates');
const { runExclusive, recordJobStart, recordJobEnd } = require('../utils/cron-lock');
const { runSmsOperationalActions, refreshSmsCommitments } = require('../services/sms-operational-actions');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

describe('scheduled SMS intake and fulfillment failure isolation', () => {
  let tick;
  beforeAll(() => {
    initScheduledJobs();
    const registration = cron.schedule.mock.calls.find(([, task]) => String(task).includes('GATE_SMS_OPERATIONAL_ACTIONS'));
    expect(registration).toBeDefined();
    tick = registration[1];
  });
  beforeEach(() => {
    jest.clearAllMocks();
    gateEnvValue.mockReturnValue(true);
    runSmsOperationalActions.mockReset().mockResolvedValue({ scanned: 0 });
    refreshSmsCommitments.mockReset().mockResolvedValue({ scanned: 1 });
  });

  test('an intake rejection still checks existing commitments under their lock', async () => {
    runSmsOperationalActions.mockRejectedValue(new Error('intake receipt unavailable'));
    await expect(tick()).resolves.toBeUndefined();
    expect(refreshSmsCommitments).toHaveBeenCalledTimes(1);
    expect(runExclusive).toHaveBeenCalledWith('sms-commitment-fulfillment', expect.any(Function));
    expect(logger.error).toHaveBeenCalledWith('[sms-operations] intake did not complete');
  });

  test('a fulfillment failure is contained and the next tick still runs', async () => {
    refreshSmsCommitments.mockRejectedValueOnce(new Error('fulfillment unavailable'));
    await expect(tick()).resolves.toBeUndefined();
    await expect(tick()).resolves.toBeUndefined();
    expect(runSmsOperationalActions).toHaveBeenCalledTimes(2);
    expect(refreshSmsCommitments).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('[sms-operations] commitment watcher did not complete');
  });

  test('the disabled gate stops both jobs', async () => {
    gateEnvValue.mockReturnValue(false);
    await tick();
    expect(runSmsOperationalActions).not.toHaveBeenCalled();
    expect(refreshSmsCommitments).not.toHaveBeenCalled();
    expect(runExclusive).not.toHaveBeenCalled();
  });

  test.each(['no_connection', 'lease_held'])('records missed work for %s without blaming a running peer', async (reason) => {
    runExclusive.mockResolvedValueOnce({ skipped: true, reason });
    await tick();
    expect(refreshSmsCommitments).not.toHaveBeenCalled();
    if (reason === 'lease_held') {
      expect(recordJobStart).not.toHaveBeenCalled();
      expect(recordJobEnd).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    } else {
      expect(recordJobStart).toHaveBeenCalledWith('sms-commitment-fulfillment');
      expect(recordJobEnd).toHaveBeenCalledWith('sms-commitment-fulfillment', expect.any(Number), expect.any(Error));
      expect(logger.error).toHaveBeenCalledWith('[sms-operations] commitment watcher did not complete');
    }
  });

  test('an intentionally disabled fulfillment service is not a missed tick', async () => {
    refreshSmsCommitments.mockResolvedValue({ skipped: 'gate_off' });
    await tick();
    expect(recordJobStart).not.toHaveBeenCalled();
    expect(recordJobEnd).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('callback-card scheduler health', () => {
  let tick;
  beforeAll(() => {
    initScheduledJobs();
    tick = cron.schedule.mock.calls.find(([, task]) => String(task).includes("runExclusive('callback-cards'"))[1];
  });
  beforeEach(() => jest.clearAllMocks());

  test.each(['no_connection', 'lease_held'])('records a skipped %s run only when work was missed', async (reason) => {
    runExclusive.mockResolvedValueOnce({ skipped: true, reason });
    await tick();
    expect(require('../services/callback-cards').notifyDueCallbacks).not.toHaveBeenCalled();
    if (reason === 'lease_held') {
      expect(recordJobStart).not.toHaveBeenCalled();
      expect(recordJobEnd).not.toHaveBeenCalled();
    } else {
      expect(recordJobStart).toHaveBeenCalledWith('callback-cards');
      expect(recordJobEnd).toHaveBeenCalledWith('callback-cards', expect.any(Number), expect.any(Error));
      expect(logger.error).toHaveBeenCalledWith('[callback-cards] tick failed (Error)');
    }
  });
});
