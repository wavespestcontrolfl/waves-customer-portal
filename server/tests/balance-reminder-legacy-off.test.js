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
 *
 * latePaymentCheck's retirement is COUPLED to GATE_DUNNING_LADDER_90 (Codex
 * P2): its Day 60/90 steps are what actually replace latePaymentCheck's
 * account-level 7/14/30/60/90 ladder, so legacy-off alone must not drop
 * every 60/90-day reminder with nothing picking it up. dailyCheck has no
 * such coupling — the pre-visit reminder already replaces it on its own.
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
const IGNORED_WARN = '[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: GATE_DUNNING_LADDER_90 is not live';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  delete process.env.GATE_DUNNING_LADDER_90;
});

afterAll(() => {
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  delete process.env.GATE_DUNNING_LADDER_90;
});

describe('dailyCheck', () => {
  test('gate on: returns without querying or sending, logs the retirement line', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    await expect(balanceReminder.dailyCheck()).resolves.toBeUndefined();
    expect(db).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(RETIRED_LOG);
  });

  test('gate on retires even with the ladder gate off — no coupling for dailyCheck', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    delete process.env.GATE_DUNNING_LADDER_90;
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
  test('both gates on: retires — returns without querying or sending, logs the retirement line', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    await expect(balanceReminder.latePaymentCheck()).resolves.toBeUndefined();
    expect(db).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(RETIRED_LOG);
    expect(logger.warn).not.toHaveBeenCalledWith(IGNORED_WARN);
  });

  test('legacy-off alone (ladder gate unset): warns and runs the legacy body unchanged', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    delete process.env.GATE_DUNNING_LADDER_90;
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(RETIRED_LOG);
  });

  test('legacy-off alone (ladder gate non-strict spelling): warns and runs the legacy body unchanged', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'TRUE';
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(RETIRED_LOG);
  });

  test('neither gate set: runs the legacy body unchanged, no warn, no retirement log', async () => {
    delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
    delete process.env.GATE_DUNNING_LADDER_90;
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(RETIRED_LOG);
  });

  test('a non-strict spelling on the legacy-off gate never disables it (strict === "true" only)', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = '1';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(RETIRED_LOG);
  });
});
