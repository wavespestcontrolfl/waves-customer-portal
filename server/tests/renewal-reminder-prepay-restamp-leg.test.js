jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (name, fn) => fn()) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  restampUnstampedActiveTerms: jest.fn(async () => ({})),
  reconcileCoveredTermsSweep: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { runExclusive } = require('../utils/cron-lock');
const prepay = require('../services/annual-prepay-renewals');
const renewalReminder = require('../services/workflows/renewal-reminder');

describe('daily workflow: annual-prepay restamp leg', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => {
      const q = {
        whereNotNull: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNull: jest.fn(() => q),
        where: jest.fn(() => q), select: jest.fn(async () => []), first: jest.fn(async () => undefined),
      };
      return q;
    });
  });

  test('runs under the SAME lease as the hourly tick, and before the covered-term sweep', async () => {
    await renewalReminder.checkAndSend();

    expect(runExclusive).toHaveBeenCalledWith('annual-prepay-restamp-sweep', expect.any(Function));
    expect(prepay.restampUnstampedActiveTerms).toHaveBeenCalledTimes(1);
    expect(prepay.restampUnstampedActiveTerms.mock.invocationCallOrder[0])
      .toBeLessThan(prepay.reconcileCoveredTermsSweep.mock.invocationCallOrder[0]);
  });

  test('a failing leg is logged and never silences the covered-term sweep', async () => {
    prepay.restampUnstampedActiveTerms.mockRejectedValueOnce(new Error('boom'));

    await renewalReminder.checkAndSend();

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/restamp sweep failed: boom/));
    expect(prepay.reconcileCoveredTermsSweep).toHaveBeenCalledTimes(1);
  });
});
