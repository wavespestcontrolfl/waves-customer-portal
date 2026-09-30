// GATE_LATE_PAYMENT_CHECKER_OFF (dunning unification PR 3): once the
// invoice follow-up ladder (plus the orphan-adoption sweep in
// invoice-followups.js) owns every overdue invoice, this account-level
// cron is redundant with — and can double-nag alongside — the per-invoice
// ladder. On, checkAndNotify retires immediately, before any query. Off
// (unset, or any spelling other than exactly 'true'): byte-identical to
// before this gate.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(async () => 'body') }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/pay123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/invoice-followups', () => ({
  hasActiveSequence: jest.fn(async () => false),
  isDunningStopped: jest.fn(async () => false),
}));
jest.mock('../services/workflows/balance-reminder', () => ({
  sendLatePaymentEmail: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const LatePaymentChecker = require('../services/late-payment-checker');

// A minimal query stub for the fallthrough (gate-off) path: no invoices, so
// the loop body (which these tests are not exercising) never runs.
function emptyInvoicesQuery() {
  const q = {};
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.orWhereNot = jest.fn(() => q);
  q.orWhere = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.andWhere = jest.fn(() => q);
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.limit = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

describe('GATE_LATE_PAYMENT_CHECKER_OFF', () => {
  const ORIGINAL = process.env.GATE_LATE_PAYMENT_CHECKER_OFF;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
    delete process.env.GATE_DUNNING_LADDER_90;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
    else process.env.GATE_LATE_PAYMENT_CHECKER_OFF = ORIGINAL;
    delete process.env.GATE_DUNNING_LADDER_90;
  });

  test('gate on: returns the retired shape, issues no query, sends nothing, logs one line', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    db.mockImplementation((table) => { throw new Error(`unexpected query on a retired checker: ${table}`); });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(result).toEqual({
      notified: 0, emailedFallback: 0, skipped: 0, retired: true,
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[late-payment-checker] retired: GATE_LATE_PAYMENT_CHECKER_OFF'),
    );
  });

  test('gate off (unset): falls through to the normal query path, unchanged', async () => {
    db.mockImplementation((table) => {
      if (table === 'invoices') return emptyInvoicesQuery();
      throw new Error(`unexpected table ${table}`);
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(result).toEqual({
      notified: 0, skipped: 0, emailedFallback: 0, totalUnpaid: 0,
    });
    expect(result.retired).toBeUndefined();
  });

  test('any spelling other than exactly "true" is treated as off', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'TRUE';
    db.mockImplementation((table) => {
      if (table === 'invoices') return emptyInvoicesQuery();
      throw new Error(`unexpected table ${table}`);
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(result.retired).toBeUndefined();
    expect(result.totalUnpaid).toBe(0);
  });

  test('legacy-off without the Day 90 ladder is ignored with a warning: the checker still runs', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    delete process.env.GATE_DUNNING_LADDER_90;
    db.mockImplementation(() => emptyInvoicesQuery());

    const result = await LatePaymentChecker.checkAndNotify();

    expect(result.retired).toBeUndefined();
    expect(db).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GATE_LATE_PAYMENT_CHECKER_OFF ignored: GATE_DUNNING_LADDER_90 is not live'));
  });
});
