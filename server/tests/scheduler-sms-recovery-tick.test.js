jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
  gateEnvValue: jest.fn(() => true),
  gateEnvTimestamp: jest.fn(),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn((name, work) => work()),
  recordMissedTick: jest.fn(),
  recordJobStart: jest.fn(),
  recordJobEnd: jest.fn(),
  wasLockSkipped: jest.fn(),
  isLocked: jest.fn(),
  sanitizeJobError: (message) => message,
}));
jest.mock('../services/sms-operational-actions', () => ({ runSmsOperationalActions: jest.fn() }));

const { runSmsRecoveryTick } = require('../services/scheduler');
const { recordMissedTick } = require('../utils/cron-lock');
const { runSmsOperationalActions } = require('../services/sms-operational-actions');
const logger = require('../services/logger');

describe('SMS profile-capture recovery tick', () => {
  afterEach(() => jest.clearAllMocks());

  test('a tick the lock machinery skipped without a connection is ledgered as a missed tick', async () => {
    runSmsOperationalActions.mockResolvedValue({ skipped: true, reason: 'no_connection' });
    await runSmsRecoveryTick({ now: 1_700_000_000_000 });
    expect(recordMissedTick).toHaveBeenCalledWith('sms-operational-actions', 1_700_000_000_000, 'tick skipped: no_connection');
    expect(logger.error).toHaveBeenCalled();
  });

  test.each([
    [{ skipped: true, reason: 'lease_held' }],
    [{ skipped: 'gate_off' }],
    [{ skipped: 'activation_time_required' }],
    [{ processed: 1, failed: 0, skipped: 0 }],
  ])('%j is not a missed tick', async (result) => {
    runSmsOperationalActions.mockResolvedValue(result);
    expect(await runSmsRecoveryTick()).toEqual(result);
    expect(recordMissedTick).not.toHaveBeenCalled();
  });
});
