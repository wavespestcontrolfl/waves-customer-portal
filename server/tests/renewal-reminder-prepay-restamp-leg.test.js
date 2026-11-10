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

  test('a failing leg is logged and never silences the covered-term sweep, then fails the run', async () => {
    prepay.restampUnstampedActiveTerms.mockRejectedValueOnce(new Error('boom'));

    await expect(renewalReminder.checkAndSend()).rejects.toThrow('renewal-reminders: 1 step(s) failed (prepay restamp); 0 sent');

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/restamp sweep failed: boom/));
    expect(prepay.reconcileCoveredTermsSweep).toHaveBeenCalledTimes(1);
  });
});

// runExclusive records a job failure only when the body throws, so every step
// that logs its own failure is named, the later steps still run, and the run
// throws once at the end. The date matching and the customer sends are untouched.
describe('daily workflow: a failed step fails the run after every step ran', () => {
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
  let customers;

  beforeEach(() => {
    jest.clearAllMocks();
    prepay.checkAndSend = jest.fn(async () => ({ sent: 2 }));
    prepay.restampUnstampedActiveTerms.mockResolvedValue({});
    prepay.reconcileCoveredTermsSweep.mockResolvedValue({});
    customers = [];
    db.raw = jest.fn((sql) => sql);
    db.mockImplementation(() => {
      const q = {
        whereNotNull: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNull: jest.fn(() => q),
        where: jest.fn(() => q), select: jest.fn(async () => customers), first: jest.fn(async () => undefined),
      };
      return q;
    });
  });

  afterEach(() => {
    delete prepay.checkAndSend;
  });

  test('a clean run resolves with the prepay count', async () => {
    await expect(renewalReminder.checkAndSend()).resolves.toEqual({ sent: 2 });
  });

  test('every failing step is named, with the sent count, after the last step ran', async () => {
    prepay.checkAndSend.mockRejectedValue(new Error('boom'));
    prepay.reconcileCoveredTermsSweep.mockRejectedValue(new Error('boom'));

    await expect(renewalReminder.checkAndSend()).rejects.toThrow(
      'renewal-reminders: 2 step(s) failed (prepay reminders, prepay covered-term sweep); 0 sent',
    );
    // The restamp leg and the termite reminder queries still ran.
    expect(prepay.restampUnstampedActiveTerms).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledWith('customers');
  });

  test('a pass the prepay service logged and skipped (failedPasses) fails the run', async () => {
    prepay.checkAndSend.mockResolvedValue({ sent: 1, failedPasses: ['termite missed-notice escalation'] });
    prepay.reconcileCoveredTermsSweep.mockResolvedValue({ terms: 0, failedPasses: ['covered-term query'] });
    prepay.restampUnstampedActiveTerms.mockResolvedValue({ failedPasses: ['restamp query'] });

    await expect(renewalReminder.checkAndSend()).rejects.toThrow(
      'renewal-reminders: 3 step(s) failed (prepay reminder passes, prepay restamp, prepay covered-term sweep); 1 sent',
    );
  });

  test("one customer's failed reminder is not a failed step", async () => {
    customers = [{ id: 'c1', first_name: 'Sam', phone: '+19415550100', location_id: null }];
    require('../services/sms-template-renderer').renderSmsTemplate.mockRejectedValue(new Error('render failed'));

    await expect(renewalReminder.checkAndSend()).resolves.toEqual({ sent: 2 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Renewal reminder failed for customer c1: render failed/));
  });
});
