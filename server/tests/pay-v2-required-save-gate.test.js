jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: true } }));

const db = require('../models/db');
const {
  invoiceRequiresSavedMethod,
  invoiceCaptureNeeded,
  invoiceCreditWouldFullyCover,
} = require('../routes/pay-v2');

// Chainable query mock: builder methods return `this`; `.first()` resolves
// (or rejects) the configured value.
function qb({ first = null, firstError = null } = {}) {
  const q = {};
  ['where', 'whereNot', 'whereNotNull', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => {
    if (firstError) throw firstError;
    return first;
  });
  return q;
}

function setQueues(queues) {
  const tables = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tables.get(table);
    if (!queue || !queue.length) throw new Error(`unexpected db('${table}') call`);
    return queue.shift();
  });
}

const INVOICE = { customer_id: 'cust-1', scheduled_service_id: 'ss-1' };

describe('invoiceRequiresSavedMethod fail-closed error handling (Codex #2507 round-6 P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('billing_mode customer requires save (baseline)', async () => {
    setQueues({ customers: [qb({ first: { billing_mode: 'per_application', monthly_rate: 55.3 } })] });
    await expect(invoiceRequiresSavedMethod(INVOICE)).resolves.toBe(true);
  });

  test('expected pre-migration shape (undefined column 42703) relaxes to false', async () => {
    const err = new Error('column "billing_mode" does not exist');
    err.code = '42703';
    setQueues({ customers: [qb({ firstError: err })] });
    await expect(invoiceRequiresSavedMethod(INVOICE)).resolves.toBe(false);
  });

  test('any OTHER lookup error surfaces — a transient prod read failure must fail the request, never silently drop the requirement', async () => {
    const err = new Error('connection reset');
    setQueues({ customers: [qb({ firstError: err })] });
    await expect(invoiceRequiresSavedMethod(INVOICE)).rejects.toThrow('connection reset');
  });

  test('scheduled-service lookup error surfaces the same way', async () => {
    const err = new Error('timeout');
    setQueues({
      customers: [qb({ first: { billing_mode: null, monthly_rate: 89 } })],
      scheduled_services: [qb({ firstError: err })],
    });
    await expect(invoiceRequiresSavedMethod(INVOICE)).rejects.toThrow('timeout');
  });

  test('payer-billed invoices never require save (no lookup at all)', async () => {
    setQueues({});
    await expect(invoiceRequiresSavedMethod({ ...INVOICE, payer_id: 'payer-1' })).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('invoiceCaptureNeeded — saved-chargeable-method test, NOT customerOnAutopay (Codex #2507 round-6 P1 + round-7 P2)', () => {
  beforeEach(() => jest.clearAllMocks());

  const CUSTOMER = { id: 'cust-1', autopay_enabled: true, ach_status: null, autopay_paused_until: null };
  const CARD_METHOD = {
    id: 'pm-1', processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_stripe_1', is_default: true, autopay_enabled: true,
  };

  test('unknown autopay state reads as CAPTURE NEEDED — this is the only gate on the covered-by-credit capture step and there is no PI/webhook fallback', async () => {
    setQueues({ customers: [qb({ firstError: new Error('connection reset') })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(true);
  });

  test('missing customer row is a data answer, not an error — no capture surface to offer', async () => {
    setQueues({ customers: [qb({ first: null })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(false);
  });

  test('no chargeable default method on file → capture needed', async () => {
    setQueues({ customers: [qb({ first: CUSTOMER })], payment_methods: [qb({ first: null })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(true);
  });

  test('chargeable card default on file → no capture', async () => {
    setQueues({ customers: [qb({ first: CUSTOMER })], payment_methods: [qb({ first: CARD_METHOD })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(false);
  });

  test('a PAUSED customer with a valid method is NOT asked to capture another — enrollment cannot clear a pause, so treating paused as capture-needed loops forever (round-7)', async () => {
    const paused = { ...CUSTOMER, autopay_paused_until: '2099-01-01' };
    setQueues({ customers: [qb({ first: paused })], payment_methods: [qb({ first: CARD_METHOD })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(false);
  });

  test('bank default while customer ACH state is unhealthy → capture needed (not chargeable)', async () => {
    const blocked = { ...CUSTOMER, ach_status: 'needs_verification' };
    const bankMethod = { ...CARD_METHOD, method_type: 'us_bank_account' };
    setQueues({ customers: [qb({ first: blocked })], payment_methods: [qb({ first: bankMethod })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(true);
  });

  test('card default while customer ACH state is unhealthy → still chargeable, no capture', async () => {
    const blocked = { ...CUSTOMER, ach_status: 'needs_verification' };
    setQueues({ customers: [qb({ first: blocked })], payment_methods: [qb({ first: CARD_METHOD })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(false);
  });
});

describe('invoiceCreditWouldFullyCover — held-coverage probe (Codex #2507 round-7 P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  const COVERED_INVOICE = { customer_id: 'cust-1', total: 100, credit_applied: 0 };

  test('credit ≥ amount due → would fully cover', async () => {
    setQueues({ customers: [qb({ first: { account_credits: 150 } })] });
    await expect(invoiceCreditWouldFullyCover(COVERED_INVOICE)).resolves.toBe(true);
  });

  test('partial credit → would NOT fully cover (normal apply + PI mint captures the method)', async () => {
    setQueues({ customers: [qb({ first: { account_credits: 40 } })] });
    await expect(invoiceCreditWouldFullyCover(COVERED_INVOICE)).resolves.toBe(false);
  });

  test('credit counts against amount DUE (total − credit_applied), not raw total', async () => {
    setQueues({ customers: [qb({ first: { account_credits: 60 } })] });
    await expect(invoiceCreditWouldFullyCover({ ...COVERED_INVOICE, credit_applied: 50 })).resolves.toBe(true);
  });

  test('payer-billed invoices never probe (homeowner credit must not touch them)', async () => {
    setQueues({});
    await expect(invoiceCreditWouldFullyCover({ ...COVERED_INVOICE, payer_id: 'payer-1' })).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
});
