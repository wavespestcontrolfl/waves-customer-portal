/**
 * Retire the dormant legacy balance-reminder runs (dunning unification,
 * owner ruling 2026-09-27): balanceReminder.dailyCheck() (gentle/firm/urgent
 * pre-visit tiers) and .latePaymentCheck() (account-level 7/14/30/60/90 late
 * check) sent 0 messages in the last 30 days — the invoice follow-up ladder
 * and the pre-visit balance reminder own these now.
 *
 * GATE_BALANCE_REMINDER_LEGACY_OFF is checked inside BOTH methods
 * themselves (not just the scheduler's cron body), so an explicit call from
 * anywhere else is also inert. Gate off is byte-identical to before this
 * lane — proven here by running balance-reminder-late-payment-email.test.js
 * (unchanged, gate never set) alongside this suite.
 */

jest.mock('../models/db', () => jest.fn(() => {
  throw new Error('db must not be queried while GATE_BALANCE_REMINDER_LEGACY_OFF is on');
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const balanceReminder = require('../services/workflows/balance-reminder');

const RETIRED_LOG = '[balance-reminders] retired: GATE_BALANCE_REMINDER_LEGACY_OFF, the invoice follow-up ladder and the pre-visit balance reminder own these';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
});

afterAll(() => {
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
});

describe('dailyCheck', () => {
  test('gate on: returns without querying or sending, logs the retirement line', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    await expect(balanceReminder.dailyCheck()).resolves.toBeUndefined();
    expect(db).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(RETIRED_LOG);
  });

  test('a non-strict spelling never disables it (strict === "true" only)', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'TRUE';
    await expect(balanceReminder.dailyCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
  });
});

describe('latePaymentCheck', () => {
  test('gate on: returns without querying or sending, logs the retirement line', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    await expect(balanceReminder.latePaymentCheck()).resolves.toBeUndefined();
    expect(db).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(RETIRED_LOG);
  });

  test('a non-strict spelling never disables it (strict === "true" only)', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = '1';
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
  });
});
