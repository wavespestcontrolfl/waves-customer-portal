/**
 * Retire the dormant legacy balance-reminder runs (dunning unification,
 * owner ruling 2026-09-27): balanceReminder.dailyCheck() (gentle/firm/urgent
 * pre-visit tiers) and .latePaymentCheck() (account-level 7/14/30/60/90 late
 * check) sent 0 messages in the last 30 days — the invoice follow-up
 * ladder, late-payment-checker.js, and the pre-visit balance reminder own
 * these now.
 *
 * GATE_BALANCE_REMINDER_LEGACY_OFF is checked inside BOTH methods
 * themselves (not just the scheduler's cron body), so an explicit call from
 * anywhere else is also inert. Gate off is byte-identical to before this
 * lane — proven by balance-reminder-late-payment-email.test.js (unchanged,
 * gate never set) continuing to pass unmodified alongside this suite.
 *
 * Each method has its OWN coupling to its OWN replacement (Codex round-2
 * review, dunning unification):
 *   - dailyCheck() retires ONLY once the pre-visit balance reminder is
 *     actually live: PREVISIT_BALANCE_REMINDER=true AND its seeded SMS
 *     template active. GATE_PREVISIT_BALANCE_5DAY only widens that
 *     reminder's lead window and says nothing about whether it runs at all.
 *     The one duty dailyCheck carried that the pre-visit reminder has no
 *     equivalent for — the internal owner alert for a balance ≥30 days
 *     overdue with service today/tomorrow — keeps running
 *     (imminentOverdueOwnerAlertSweep) even while dailyCheck retires.
 *   - latePaymentCheck() retires ONLY together with GATE_DUNNING_LADDER_90
 *     also live (its Day 60/90 steps are what actually replace it).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/previsit-balance-reminder', () => ({
  gateEnabled: jest.fn(() => false),
  smsTemplateActive: jest.fn(async () => false),
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
// customerDunningStopped (module-private in balance-reminder.js) lazily
// requires invoice-followups.js for its sequence/stop checks — stub it so
// the alert-sweep tests below don't drag in the real dunning-stop machinery.
jest.mock('../services/invoice-followups', () => ({
  hasActiveSequence: jest.fn(async () => false),
  isDunningStopped: jest.fn(async () => false),
  // The real readers, so the sequence-less-owner coupling reads the env.
  latePaymentCheckerRetiredLive: () => process.env.GATE_LATE_PAYMENT_CHECKER_OFF === 'true'
    && process.env.GATE_DUNNING_LADDER_90 === 'true',
  adoptOrphanInvoicesLive: () => process.env.GATE_DUNNING_ADOPT_ORPHANS === 'true'
    && process.env.GATE_LATE_PAYMENT_CHECKER_OFF === 'true' && process.env.GATE_DUNNING_LADDER_90 === 'true',
}));

const db = require('../models/db');
const logger = require('../services/logger');
const PrevisitBalanceReminder = require('../services/previsit-balance-reminder');
const TwilioService = require('../services/twilio');
const balanceReminder = require('../services/workflows/balance-reminder');

const DAILY_RETIRED_LOG = '[balance-reminders] dailyCheck retired: GATE_BALANCE_REMINDER_LEGACY_OFF, the pre-visit balance reminder owns these now';
const DAILY_IGNORED_WARN = '[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for dailyCheck: the pre-visit balance reminder replacement (PREVISIT_BALANCE_REMINDER + its SMS template) is not live yet';
const LATE_RETIRED_LOG = '[balance-reminders] latePaymentCheck retired: GATE_BALANCE_REMINDER_LEGACY_OFF, the invoice follow-up ladder and late-payment-checker.js (or orphan adoption) own these';
const LATE_NO_ORPHAN_OWNER_WARN = '[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: the late-payment checker is retired and orphan adoption is not live';
const LATE_IGNORED_WARN = '[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: GATE_DUNNING_LADDER_90 is not live';

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): db's per-test mockImplementation must
  // not leak into the next test — an unmocked db() call should throw
  // "unexpected table", proving the legacy body actually ran, not silently
  // resolve against the PREVIOUS test's table stub.
  jest.resetAllMocks();
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  delete process.env.GATE_DUNNING_LADDER_90;
  PrevisitBalanceReminder.gateEnabled.mockReturnValue(false);
  PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(false);
});

afterAll(() => {
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  delete process.env.GATE_DUNNING_LADDER_90;
});

// A minimal, chainable stand-in for the imminent-overdue alert sweep's own
// scheduled_services query (where/where/whereIn/leftJoin/where/whereNull/
// whereNotNull/select) — every method returns the same object so any call
// order/count on it resolves, and `select()` is the terminal read.
// customerDunningStopped's own reads for a balance with invoice ids: no
// active payment plan, no invoice awaiting microdeposit verification.
function firstChain(row) {
  const q = {};
  ['where', 'whereIn'].forEach((method) => { q[method] = jest.fn(() => q); });
  q.first = jest.fn(async () => row);
  return q;
}

function scheduledServicesChain(rows) {
  const q = {};
  ['where', 'whereIn', 'leftJoin', 'whereNull', 'whereNotNull'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.select = jest.fn(() => Promise.resolve(rows));
  return q;
}

describe('dailyCheck', () => {
  test('gate on, previsit replacement fully live: retires, runs no legacy query, logs the retirement line', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    // The imminent-overdue owner-alert sweep still queries (see the
    // dedicated alert-sweep tests below for that duty) — empty result here
    // means it finds nothing and sends nothing, which is all this test
    // cares about; the legacy dailyCheck body's OWN queries never run.
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledServicesChain([]);
      throw new Error(`unexpected query on table ${table}`);
    });

    await expect(balanceReminder.dailyCheck()).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(DAILY_RETIRED_LOG);
    expect(logger.warn).not.toHaveBeenCalledWith(DAILY_IGNORED_WARN);
  });

  test('gate on, PREVISIT_BALANCE_REMINDER dark: warns and runs the legacy body unchanged', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(false);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    await expect(balanceReminder.dailyCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(DAILY_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(DAILY_RETIRED_LOG);
  });

  test('gate on, SMS template dark: warns and runs the legacy body unchanged', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(false);
    await expect(balanceReminder.dailyCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(DAILY_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(DAILY_RETIRED_LOG);
  });

  test('gate unset: legacy body runs unchanged, no warn, no retirement log', async () => {
    await expect(balanceReminder.dailyCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(DAILY_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(DAILY_RETIRED_LOG);
    expect(PrevisitBalanceReminder.gateEnabled).not.toHaveBeenCalled();
  });

  test('a non-strict spelling never disables it (strict === "true" only)', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'TRUE';
    await expect(balanceReminder.dailyCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(PrevisitBalanceReminder.gateEnabled).not.toHaveBeenCalled();
  });
});

describe('imminentOverdueOwnerAlertSweep (the one dailyCheck duty with no pre-visit equivalent)', () => {
  // Clock pinned to ~10 AM ET (14:00Z) — the real 11 AM cron's neighborhood
  // and, not coincidentally, the exact offset that a naive
  // `new Date(scheduled_date) - new Date()` millisecond subtraction gets
  // wrong for a DATE column (Codex P1): a UTC-midnight DATE value minus a
  // 14:00Z clock floors to -1 for TODAY's visit (skipped) and 0 for
  // TOMORROW's visit (mislabeled "today"). scheduled_date below is a
  // DATE-style UTC-midnight value, like the real pg driver returns, not an
  // instant matching the clock — proving the fix reads calendar dates, not
  // millisecond offsets.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('several services for one customer on the same day produce ONE owner alert', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    const base = {
      cust_id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan',
      scheduled_date: new Date('2026-05-26T00:00:00.000Z'), waveguard_tier: 'Gold',
    };
    const services = [{ ...base, id: 'ss-a' }, { ...base, id: 'ss-b' }];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledServicesChain(services);
      if (table === 'payment_plans') return firstChain(undefined);
      if (table === 'invoices') return scheduledServicesChain([]);
      throw new Error(`unexpected table ${table}`);
    });
    jest.spyOn(balanceReminder, 'getCustomerBalance').mockResolvedValue({
      totalBalance: 250, daysOverdue: 35, invoiceIds: ['inv-1'], oldestInvoiceId: 'inv-1',
    });

    await balanceReminder.dailyCheck();

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a $0 balance', { totalBalance: 0, daysOverdue: 35, invoiceIds: ['inv-1'], oldestInvoiceId: 'inv-1' }],
    ['debt with no unpaid invoice behind it', { totalBalance: 120, daysOverdue: 35, invoiceIds: [], oldestInvoiceId: null }],
  ])('no owner alert for %s (the legacy alert\'s own scope)', async (_label, balance) => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    const service = {
      id: 'ss-9', cust_id: 'cust-9', first_name: 'Alex', last_name: 'Kim',
      scheduled_date: new Date('2026-05-26T00:00:00.000Z'), waveguard_tier: 'Gold',
    };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledServicesChain([service]);
      if (table === 'payment_plans') return firstChain(undefined);
      if (table === 'invoices') return scheduledServicesChain([]);
      throw new Error(`unexpected table ${table}`);
    });
    jest.spyOn(balanceReminder, 'getCustomerBalance').mockResolvedValue(balance);

    await balanceReminder.dailyCheck();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('a customer 30+ days overdue with service today gets the owner alert even though dailyCheck retired', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    const service = {
      id: 'ss-1', cust_id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan',
      scheduled_date: new Date('2026-05-26T00:00:00.000Z'), waveguard_tier: 'Gold',
    };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledServicesChain([service]);
      if (table === 'payment_plans') return firstChain(undefined);
      if (table === 'invoices') return scheduledServicesChain([]);
      throw new Error(`unexpected table ${table}`);
    });
    jest.spyOn(balanceReminder, 'getCustomerBalance').mockResolvedValue({
      totalBalance: 250, daysOverdue: 35, invoiceIds: ['inv-1'], oldestInvoiceId: 'inv-1',
    });

    await balanceReminder.dailyCheck();

    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Taylor Morgan'),
      expect.objectContaining({ messageType: 'internal_alert' }),
    );
    const [, message] = TwilioService.sendSMS.mock.calls[0];
    expect(message).toContain('today');
    expect(message).not.toContain('tomorrow');
  });

  test('a customer 30+ days overdue with service tomorrow gets the owner alert labeled "tomorrow", not "today"', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    const service = {
      id: 'ss-2', cust_id: 'cust-2', first_name: 'Jamie', last_name: 'Rivera',
      scheduled_date: new Date('2026-05-27T00:00:00.000Z'), waveguard_tier: 'Gold',
    };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledServicesChain([service]);
      if (table === 'payment_plans') return firstChain(undefined);
      if (table === 'invoices') return scheduledServicesChain([]);
      throw new Error(`unexpected table ${table}`);
    });
    jest.spyOn(balanceReminder, 'getCustomerBalance').mockResolvedValue({
      totalBalance: 90, daysOverdue: 30, invoiceIds: ['inv-1'], oldestInvoiceId: 'inv-1',
    });

    await balanceReminder.dailyCheck();

    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Jamie Rivera'),
      expect.objectContaining({ messageType: 'internal_alert' }),
    );
    const [, message] = TwilioService.sendSMS.mock.calls[0];
    expect(message).toContain('tomorrow');
    expect(message).not.toContain('today.');
  });

  test('a customer under 30 days overdue gets no alert', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    PrevisitBalanceReminder.gateEnabled.mockReturnValue(true);
    PrevisitBalanceReminder.smsTemplateActive.mockResolvedValue(true);
    const service = {
      id: 'ss-1', cust_id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan',
      scheduled_date: new Date('2026-05-26T00:00:00.000Z'), waveguard_tier: 'Gold',
    };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledServicesChain([service]);
      if (table === 'payment_plans') return firstChain(undefined);
      if (table === 'invoices') return scheduledServicesChain([]);
      throw new Error(`unexpected table ${table}`);
    });
    jest.spyOn(balanceReminder, 'getCustomerBalance').mockResolvedValue({
      totalBalance: 40, daysOverdue: 10, invoiceIds: [], oldestInvoiceId: 'inv-1',
    });

    await balanceReminder.dailyCheck();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});

describe('latePaymentCheck', () => {
  // The retirement's one read: are any legacy `unpaid`-status invoices open?
  // Answers none by default; any other table throws "unexpected table",
  // proving the legacy body ran.
  function mockUnpaidCheck(row) {
    db.mockImplementation((table) => {
      if (table === 'invoices') return firstChain(row);
      throw new Error(`unexpected table ${table}`);
    });
  }
  beforeEach(() => mockUnpaidCheck(undefined));

  test('both gates on: retires — returns without querying or sending, logs the retirement line', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    await expect(balanceReminder.latePaymentCheck()).resolves.toBeUndefined();
    expect(db.mock.calls).toEqual([['invoices']]);
    expect(logger.info).toHaveBeenCalledWith(LATE_RETIRED_LOG);
    expect(logger.warn).not.toHaveBeenCalledWith(LATE_IGNORED_WARN);
  });

  test('checker retired but orphan adoption off: nobody owns sequence-less invoices, so latePaymentCheck keeps running', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    delete process.env.GATE_DUNNING_ADOPT_ORPHANS;
    try {
      await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
      expect(db).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(LATE_NO_ORPHAN_OWNER_WARN);
      expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
    } finally {
      delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
    }
  });

  test('checker retired and orphan adoption live: retires', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    try {
      await expect(balanceReminder.latePaymentCheck()).resolves.toBeUndefined();
      expect(db.mock.calls).toEqual([['invoices']]);
      expect(logger.info).toHaveBeenCalledWith(LATE_RETIRED_LOG);
    } finally {
      delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
      delete process.env.GATE_DUNNING_ADOPT_ORPHANS;
    }
  });

  test('an open legacy unpaid-status invoice keeps latePaymentCheck running (neither replacement reads that status)', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    mockUnpaidCheck({ id: 'inv-unpaid' });
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow('unexpected table customers');
    expect(logger.warn).toHaveBeenCalledWith('[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: legacy unpaid-status invoices still need it');
    expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
  });

  test('an unreadable unpaid-status check keeps latePaymentCheck running', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    db.mockImplementation((table) => { throw new Error(`unexpected table ${table}`); });
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow('unexpected table customers');
    expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
  });

  test('legacy-off alone (ladder gate unset): warns and runs the legacy body unchanged', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    delete process.env.GATE_DUNNING_LADDER_90;
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(LATE_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
  });

  test('legacy-off alone (ladder gate non-strict spelling): warns and runs the legacy body unchanged', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'TRUE';
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(LATE_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
  });

  test('neither gate set: runs the legacy body unchanged, no warn, no retirement log', async () => {
    delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
    delete process.env.GATE_DUNNING_LADDER_90;
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(LATE_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
  });

  test('a non-strict spelling on the legacy-off gate never disables it (strict === "true" only)', async () => {
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = '1';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    await expect(balanceReminder.latePaymentCheck()).rejects.toThrow();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(LATE_IGNORED_WARN);
    expect(logger.info).not.toHaveBeenCalledWith(LATE_RETIRED_LOG);
  });
});
