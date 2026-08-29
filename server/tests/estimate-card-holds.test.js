// One-time card-on-file hold service. Mirrors the estimate-deposits test
// harness: db + stripe + logger mocked, the pure decision logic exercised
// directly, and the trust-boundary verify path checked against Stripe.

let mockDbHandler = () => { throw new Error('db handler not configured'); };
let mockDbUpdates = [];
let mockDbInserts = [];
jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.transaction = jest.fn((cb) => cb(mock)); // run the txn body against the same mock
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The real registry snapshots env at module load — re-read it per call so
// the sticky tests can flip GATE_STICKY_CANCEL_WINDOW in beforeEach.
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => (name === 'stickyCancelWindow' && process.env.GATE_STICKY_CANCEL_WINDOW === 'true')
    || (name === 'cardHoldRescheduleAdopt' && process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT === 'true')
    || (name === 'cardHoldParkOnCancel' && process.env.GATE_CARD_HOLD_PARK_ON_CANCEL === 'true')),
  gates: {},
}));

// No-show fee settlement + recap completion-invoice dependencies (lazy-required).
const mockInvoiceCreate = jest.fn(async () => ({ id: 'inv1', token: 'tok1' }));
const mockSendReceipt = jest.fn(async () => ({ sent: true }));
const mockCreateFromService = jest.fn(async () => ({ id: 'inv_recap', token: 'tokr' }));
jest.mock('../services/invoice', () => ({
  create: (...a) => mockInvoiceCreate(...a),
  sendReceipt: (...a) => mockSendReceipt(...a),
  createFromService: (...a) => mockCreateFromService(...a),
  buildLineItemsForScheduledService: (...a) => mockBuildLines(...a),
}));
const mockBuildLines = jest.fn(async () => ({
  lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 49, amount: 49, category: 'Pest Control' }],
  discountIds: undefined,
}));
const mockMintWithDeposit = jest.fn(async () => ({ invoice: { id: 'inv_recap', service_record_id: 'sr1' }, reused: false }));
jest.mock('../services/scheduled-invoice-mint', () => ({
  mintScheduledServiceInvoiceWithDeposit: (...a) => mockMintWithDeposit(...a),
}));
const mockSendSMS = jest.fn();
jest.mock('../services/twilio', () => ({ sendSMS: (...a) => mockSendSMS(...a) }));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendCustomerMessage(...a) }));
const mockSendReceiptEmail = jest.fn(async () => ({ ok: true }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: (...a) => mockSendReceiptEmail(...a) }));
const mockEnqueueReceiptDelivery = jest.fn(async () => ({ enqueued: true }));
jest.mock('../services/receipt-delivery-queue', () => ({ enqueueReceiptDelivery: (...a) => mockEnqueueReceiptDelivery(...a) }));
const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-06-25'),
  addETDays: jest.fn(),
  formatETDate: jest.fn(() => 'July 13, 2026'),
  formatETTime: jest.fn(() => '9:00 AM'),
  // Real implementation: the sticky-window lookup composes reschedule_log's
  // original DATE+TIME into an ET instant with it, and the tests pin real
  // ET math (fixed EDT dates), not a stub's.
  parseETDateTime: jest.requireActual('../utils/datetime-et').parseETDateTime,
}));
// cardHoldCancelPreview resolves the appointment start via the shared helper
// when not supplied; the cancel-path tests pass serviceStart explicitly and
// never hit this mock.
const mockApptTime = jest.fn();
jest.mock('../services/appointment-reminders', () => ({ scheduledServiceApptTime: (...a) => mockApptTime(...a) }));

const mockRetrievePaymentIntent = jest.fn(async () => ({ latest_charge: { refunded: false, amount_refunded: 0 } }));
const mockRetrieveSetupIntent = jest.fn();
const mockCreateSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
const mockChargeInvoiceWithSavedCard = jest.fn();
const mockChargeOffSession = jest.fn();
const mockRetrievePaymentMethod = jest.fn(async () => ({ id: 'pm_s', customer: 'cus_1' }));
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  retrievePaymentMethod: (...a) => mockRetrievePaymentMethod(...a),
  retrievePaymentIntent: (...a) => mockRetrievePaymentIntent(...a),
  createEstimateCardHoldSetupIntent: (...a) => mockCreateSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
  chargeInvoiceWithSavedCard: (...a) => mockChargeInvoiceWithSavedCard(...a),
  chargeSavedPaymentMethodOffSession: (...a) => mockChargeOffSession(...a),
  savedCardChargeNeedsReconciliation: (err) => [
    'STRIPE_CHARGED_DB_FAILED',
    'STRIPE_AMBIGUOUS_OUTCOME',
  ].includes(err?.code),
  savedCardChargeSuppressesAlternateCollection: (err) => [
    'STRIPE_CHARGED_DB_FAILED',
    'STRIPE_AMBIGUOUS_OUTCOME',
    'STRIPE_CHARGE_IN_PROGRESS',
  ].includes(err?.code),
}));

// The db mock itself (a jest.fn taking the table name) — lets the freeze
// tests assert which TABLES a path consulted, not just what it returned.
const dbMock = require('../models/db');

const {
  isCardHoldEnabled,
  cardHoldNoShowFee,
  cardHoldCancelWindowHours,
  resolveCardHoldPolicy,
  verifyCardHoldIntent,
  isWithinCancelWindow,
  handleCardHoldCancellation,
  cardHoldCancelPreview,
  cardHoldReminderLine,
  cardHoldReminderNote,
  recordCardHoldHeld,
  chargeCardHoldOnCompletion,
  chargeCardHoldForRecapCompletion,
  chargeNoShowFee,
  settleNoShowFee,
  _private: { cardHoldIntentMatchesEstimate },
  createCardHoldSetupIntentForEstimate,
} = require('../services/estimate-card-holds');

beforeEach(() => {
  jest.clearAllMocks();
  mockDbUpdates = [];
  mockDbInserts = [];
  process.env.ONE_TIME_CARD_HOLD = 'true';
});
afterEach(() => {
  delete process.env.ONE_TIME_CARD_HOLD;
});

// Chainable db stub. Each db() call returns a fresh chain; terminal .first()
// calls consume `firstResults` in order (so hasHeldCard's lookup and the
// webhook-pending fallback lookup can return different rows).
let mockRescheduleLogChains = [];
function stubDb(firstResults, { rescheduleLog = [], holdRows = null, visitRows = null, laneRows = undefined, updateReturns = null } = {}) {
  const updateQueue = Array.isArray(updateReturns) ? [...updateReturns] : null;
  const queue = Array.isArray(firstResults) ? [...firstResults] : [firstResults];
  mockRescheduleLogChains = [];
  mockDbHandler = (table) => {
    const chain = {};
    for (const m of ['where', 'whereNot', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'andWhere', 'orWhere', 'orderBy', 'modify', 'select', 'forUpdate']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.first = jest.fn(() => {
      const v = queue.length ? queue.shift() : null;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    });
    chain.update = jest.fn((payload) => {
      mockDbUpdates.push(payload);
      // updateReturns lets a test model a lost CAS (0 rows matched);
      // default stays 1 so every existing path is untouched.
      const rows = updateQueue && updateQueue.length ? updateQueue.shift() : 1;
      return Promise.resolve(rows);
    });
    chain.insert = jest.fn((payload) => {
      mockDbInserts.push(payload);
      return Promise.resolve([{}]);
    });
    chain.del = jest.fn(() => Promise.resolve(1));
    if (table === 'estimate_card_holds' && holdRows) {
      // The adoption candidates query awaits the chain itself (multi-row
      // select, no .first()) — same thenable treatment as reschedule_log.
      // .first() calls on this table still consume the shared queue.
      chain.then = (resolve, reject) => (holdRows instanceof Error
        ? Promise.reject(holdRows)
        : Promise.resolve(holdRows)).then(resolve, reject);
    }
    if (table === 'appointment_card_requests') {
      // Table-scoped .first(): the cross-lane exclusivity checks read this
      // table on many money paths — serving it from the shared queue would
      // shift every fee/charge test's stub. Default: no lane row (null),
      // no queue consumption; a test opts into a row (or an Error) via the
      // laneRows option.
      chain.first = jest.fn(() => (laneRows instanceof Error
        ? Promise.reject(laneRows)
        : Promise.resolve(laneRows === undefined ? null : laneRows)));
    }
    if (table === 'scheduled_services' && visitRows) {
      // The adoption 1:1 sibling check awaits a scheduled_services chain
      // (multi-row select); .first() reads still consume the shared queue.
      chain.then = (resolve, reject) => (visitRows instanceof Error
        ? Promise.reject(visitRows)
        : Promise.resolve(visitRows)).then(resolve, reject);
    }
    if (table === 'reschedule_log') {
      // Knex chains are thenables — the sticky-window lookup awaits the
      // chain itself (multi-row select, no .first()). Captured per call so
      // tests can pin the customer-actor SQL filter.
      chain.then = (resolve, reject) => (rescheduleLog instanceof Error
        ? Promise.reject(rescheduleLog)
        : Promise.resolve(rescheduleLog)).then(resolve, reject);
      mockRescheduleLogChains.push(chain);
    }
    return chain;
  };
}

describe('isCardHoldEnabled — dark by default', () => {
  it('is true only for truthy flag spellings', () => {
    for (const v of ['true', '1', 'on']) { process.env.ONE_TIME_CARD_HOLD = v; expect(isCardHoldEnabled()).toBe(true); }
    for (const v of ['false', '0', 'off', '']) { process.env.ONE_TIME_CARD_HOLD = v; expect(isCardHoldEnabled()).toBe(false); }
    delete process.env.ONE_TIME_CARD_HOLD;
    expect(isCardHoldEnabled()).toBe(false);
  });
});

describe('completion charge reconciliation outcomes', () => {
  // The accepted-amount cap reads the amount FROZEN on the hold row before
  // the claim — these tests exercise the post-cap charge outcomes, so the
  // frozen accepted amount comfortably covers the invoice.
  const hold = { id: 'hold-1', customer_id: 'cust-1', stripe_payment_method_id: 'pm-stripe-1', accepted_amount: 100 };
  const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: 75 };
  const paymentMethod = { id: 'pm-row-1' };

  test.each([
    ['STRIPE_CHARGED_DB_FAILED', { stripePaymentIntentId: 'pi-orphan-1' }],
    ['STRIPE_AMBIGUOUS_OUTCOME', {}],
  ])('parks invoice and card hold for terminal %s', async (code, extra) => {
    stubDb([hold, invoice, paymentMethod]);
    mockChargeInvoiceWithSavedCard.mockRejectedValue(Object.assign(new Error('reconcile me'), { code, ...extra }));

    await expect(chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' }))
      .resolves.toEqual(expect.objectContaining({ charged: false, reason: 'charge_review' }));

    expect(mockDbUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'processing' }),
      expect.objectContaining({ status: 'charge_review' }),
    ]));
  });

  test('restores a fresh concurrent claim collision for retry without exposing another rail', async () => {
    stubDb([hold, invoice, paymentMethod]);
    mockChargeInvoiceWithSavedCard.mockRejectedValue(Object.assign(new Error('first attempt declined'), {
      code: 'STRIPE_CHARGE_IN_PROGRESS',
    }));

    await expect(chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' }))
      .resolves.toEqual(expect.objectContaining({ charged: false, reason: 'charge_in_progress' }));
    expect(mockDbUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'charging' }),
      expect.objectContaining({ status: 'held' }),
    ]));
    expect(mockDbUpdates).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'charge_review' })]));
    expect(mockDbUpdates).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'processing' })]));
  });
});

describe('completion charge accepted-amount cap — frozen at booking, never collect above it', () => {
  // The cap reads estimate_card_holds.accepted_amount, FROZEN inside the
  // accept transaction by recordCardHoldHeld — never a charge-time read of
  // scheduled_services.estimated_price (Codex #2821 P1: the admin editors
  // rewrite that field, so a live read would follow a staff price edit).
  const holdWithCap = (acceptedAmount) => ({
    id: 'hold-1', customer_id: 'cust-1', stripe_payment_method_id: 'pm-stripe-1', accepted_amount: acceptedAmount,
  });
  const paymentMethod = { id: 'pm-row-1' };

  test('an invoice retotaled ABOVE the frozen accepted amount is NOT charged — review alert, hold stays held', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 600, total: 600 };
    stubDb([holdWithCap(250), invoice]);
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'above_accepted_amount' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('above accepted amount'),
      expect.stringContaining('NOT charged'),
      expect.objectContaining({ link: '/admin/customers/cust-1' }),
    );
    // The hold is never claimed or moved — it stays 'held' (un-charged,
    // reviewable), so no status write of any kind lands.
    expect(mockDbUpdates).toEqual([]);
  });

  test('the cap SURVIVES a staff price edit — scheduled_services is never even consulted at charge time', async () => {
    // Booking froze $250 on the hold; staff later re-priced the visit AND
    // its invoice to $600 (admin-schedule editors rewrite estimated_price).
    // The frozen stamp still caps the charge, and the mutable
    // scheduled_services row is not read at all on this path.
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 600, total: 600 };
    stubDb([holdWithCap(250), invoice]);
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'above_accepted_amount' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(dbMock.mock.calls.map((c) => c[0])).not.toContain('scheduled_services');
  });

  test('at the frozen accepted amount → charges exactly as before', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 250, total: 250 };
    stubDb([holdWithCap(250), invoice, paymentMethod]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi-ok', amount: 250 });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: true });
    expect(mockChargeInvoiceWithSavedCard).toHaveBeenCalledWith('inv-1', 'pm-row-1', { maxAuthorizedSubtotal: 250, requireSelfPayScheduledServiceId: 'svc-1', requireInvoiceScheduledServiceBinding: true, requireCompletedOneTimeVisit: true, requireNoAppointmentCardLane: true });
    expect(mockDbUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'charged_completion' }),
    ]));
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('under the frozen accepted amount → charges', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 199, total: 199 };
    stubDb([holdWithCap(250), invoice, paymentMethod]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi-ok', amount: 199 });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: true });
  });

  test('the comparator nets a recorded discount off the grossed-up subtotal (manual-discount accepts)', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 300, discount_amount: 50, total: 250 };
    stubDb([holdWithCap(250), invoice, paymentMethod]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi-ok', amount: 250 });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: true });
  });

  test('tax on top of the accepted base does not trip the cap (subtotal is the comparator)', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 250, tax_amount: 17.5, total: 267.5 };
    stubDb([holdWithCap(250), invoice, paymentMethod]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi-ok', amount: 267.5 });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: true });
  });

  test('FAILS CLOSED when the hold carries no frozen amount (legacy pre-stamp row) — not charged, review alert', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 250, total: 250 };
    stubDb([holdWithCap(null), invoice]);
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_accepted_amount' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('no accepted amount'),
      expect.stringContaining('NOT charged'),
      expect.anything(),
    );
    expect(mockDbUpdates).toEqual([]);
  });

  test('FAILS CLOSED on an unreadable frozen stamp (non-numeric)', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', subtotal: 250, total: 250 };
    stubDb([holdWithCap('garbage'), invoice]);
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_accepted_amount' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('cardHoldNoShowFee / cardHoldCancelWindowHours', () => {
  it('default to $75 / 24h (owner ruling 2026-08-01)', () => {
    expect(cardHoldNoShowFee()).toBe(75);
    expect(cardHoldCancelWindowHours()).toBe(24);
  });
  it('read constants.CARD_HOLD (pricing_config-authoritative) and fall back on junk', () => {
    const { CARD_HOLD } = require('../services/pricing-engine/constants');
    const original = { ...CARD_HOLD };
    try {
      CARD_HOLD.noShowFeeAmount = 60; CARD_HOLD.cancelWindowHours = 48;
      expect(cardHoldNoShowFee()).toBe(60);
      expect(cardHoldCancelWindowHours()).toBe(48);
      CARD_HOLD.noShowFeeAmount = -5; CARD_HOLD.cancelWindowHours = 'junk';
      expect(cardHoldNoShowFee()).toBe(75);
      expect(cardHoldCancelWindowHours()).toBe(24);
    } finally {
      Object.assign(CARD_HOLD, original);
    }
  });
});

describe('estimate_card_hold admin validation (bounded — charge-authoritative values)', () => {
  const { validatePricingConfigData } = require('../routes/admin-pricing-config');
  it('accepts sane values, rejects typos and extremes', () => {
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 75, cancelWindowHours: 24 }).ok).toBe(true);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 49.5, cancelWindowHours: 48 }).ok).toBe(true);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 750, cancelWindowHours: 24 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 0, cancelWindowHours: 24 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: -75, cancelWindowHours: 24 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 75.001, cancelWindowHours: 24 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 75, cancelWindowHours: 0 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 75, cancelWindowHours: 1.5 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 75, cancelWindowHours: 500 }).ok).toBe(false);
    expect(validatePricingConfigData('estimate_card_hold', { noShowFeeAmount: 'many', cancelWindowHours: 24 }).ok).toBe(false);
  });
});

describe('resolveCardHoldPolicy', () => {
  it('inert when the flag is off', () => {
    delete process.env.ONE_TIME_CARD_HOLD;
    expect(resolveCardHoldPolicy({ treatAsOneTime: true })).toEqual(
      expect.objectContaining({ enforced: false, required: false }),
    );
  });
  it('REQUIRES a hold for a one-time accept with fee + window', () => {
    const p = resolveCardHoldPolicy({ treatAsOneTime: true });
    expect(p.required).toBe(true);
    expect(p.noShowFeeAmount).toBe(75);
    expect(p.cancelWindowHours).toBe(24);
  });
  it('never required for recurring', () => {
    expect(resolveCardHoldPolicy({ treatAsOneTime: false })).toEqual(
      expect.objectContaining({ enforced: true, required: false, exemptReason: 'recurring' }),
    );
  });
  it('exempts invoice-mode one-time estimates', () => {
    expect(resolveCardHoldPolicy({ treatAsOneTime: true, billByInvoice: true })).toEqual(
      expect.objectContaining({ required: false, exemptReason: 'invoice_mode' }),
    );
  });
  it('exempts a prepay choice', () => {
    expect(resolveCardHoldPolicy({ treatAsOneTime: true, paymentMethodPreference: 'prepay_annual' })).toEqual(
      expect.objectContaining({ required: false, exemptReason: 'prepay_annual' }),
    );
  });
});

describe('cardHoldIntentMatchesEstimate — trust boundary', () => {
  const base = { status: 'succeeded', payment_method: 'pm_1', metadata: { purpose: 'estimate_card_hold', estimate_id: 'EST' } };
  it('accepts a succeeded, card-bearing, estimate-pinned setup intent', () => {
    expect(cardHoldIntentMatchesEstimate(base, 'EST')).toBe(true);
  });
  it('rejects wrong status / purpose / estimate / missing card / null', () => {
    expect(cardHoldIntentMatchesEstimate({ ...base, status: 'processing' }, 'EST')).toBe(false);
    expect(cardHoldIntentMatchesEstimate({ ...base, metadata: { purpose: 'other', estimate_id: 'EST' } }, 'EST')).toBe(false);
    expect(cardHoldIntentMatchesEstimate(base, 'OTHER')).toBe(false);
    expect(cardHoldIntentMatchesEstimate({ ...base, payment_method: null }, 'EST')).toBe(false);
    expect(cardHoldIntentMatchesEstimate(null, 'EST')).toBe(false);
  });
});

describe('isWithinCancelWindow', () => {
  const now = new Date('2026-06-24T12:00:00Z');
  const hold = { cancel_window_hours: 24 };
  it('inside the window when the visit is sooner than the cutoff', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-25T06:00:00Z'), now })).toBe(true);
  });
  it('outside the window when the visit is further out than the cutoff', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-26T12:00:01Z'), now })).toBe(false);
  });
  it('false on an unparseable start (fail toward free release)', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: 'not-a-date', now })).toBe(false);
  });
  it('true just after start — the tech may still arrive (2h arrival window), so a post-start cancel is still a late cancel', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T12:00:00Z'), now })).toBe(true); // exactly at start
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T11:55:00Z'), now })).toBe(true); // the 10:05 cancel of a 10–12 appointment
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T10:00:01Z'), now })).toBe(true); // 1s inside the grace
  });
  it('false past the arrival-window grace — missed dispatch / stale-row cleanup is never a late cancel', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T10:00:00Z'), now })).toBe(false); // exactly grace boundary (start + 2h == now)
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T08:00:00Z'), now })).toBe(false); // same-day morning visit never delivered
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-20T12:00:00Z'), now })).toBe(false); // days-stale (churn-sweep rescheduled phantom)
  });

  // Card-on-file spec Phase 1 (owner default, spec §5 #1): the effective
  // window is min(cancel_window_hours, time since booking) — a same-day
  // booking is no longer instantly inside the fee window.
  describe('inside-window booking grace (window anchored to booking age)', () => {
    const start = new Date('2026-06-24T15:00:00Z'); // visit 3h from `now`
    it('free cancel right after a same-day booking', () => {
      const freshHold = { cancel_window_hours: 24, held_at: new Date('2026-06-24T11:55:00Z') }; // booked 5 min ago
      expect(isWithinCancelWindow({ hold: freshHold, serviceStart: start, now })).toBe(false);
    });
    it('fee applies once the booking has aged past the time remaining', () => {
      const agedHold = { cancel_window_hours: 24, held_at: new Date('2026-06-24T08:00:00Z') }; // booked 4h ago, visit in 3h
      expect(isWithinCancelWindow({ hold: agedHold, serviceStart: start, now })).toBe(true);
    });
    it('booking age never WIDENS the disclosed window', () => {
      const oldHold = { cancel_window_hours: 24, held_at: new Date('2026-06-20T12:00:00Z') }; // booked days ago
      // visit 25h out — outside the 24h disclosed window regardless of age
      expect(isWithinCancelWindow({ hold: oldHold, serviceStart: new Date('2026-06-25T13:00:00Z'), now })).toBe(false);
    });
    it('legacy rows without held_at keep the full disclosed window', () => {
      expect(isWithinCancelWindow({ hold: { cancel_window_hours: 24 }, serviceStart: start, now })).toBe(true);
      expect(isWithinCancelWindow({ hold: { cancel_window_hours: 24, held_at: 'not-a-date' }, serviceStart: start, now })).toBe(true);
    });
    it('a clock-skewed future held_at falls back to the disclosed window', () => {
      const skewed = { cancel_window_hours: 24, held_at: new Date('2026-06-24T12:05:00Z') }; // "booked" 5 min in the future
      expect(isWithinCancelWindow({ hold: skewed, serviceStart: start, now })).toBe(true);
    });
  });
});

describe('cardHoldReminderNote/Line — reminder fee-policy disclosure (spec Phase 1)', () => {
  const HOUR = 3600000;
  it("'' while the flag is off (dark-safe)", async () => {
    delete process.env.ONE_TIME_CARD_HOLD;
    stubDb({ id: 'h1', no_show_fee_amount: 49, cancel_window_hours: 24 });
    expect(await cardHoldReminderLine('svc1')).toBe('');
  });
  it("'' when the visit carries no held card (non-card-hold reminders stay byte-identical)", async () => {
    stubDb(null);
    expect(await cardHoldReminderLine('svc1')).toBe('');
  });
  it('states the FROZEN fee and an exact free-cancel cutoff; rescheduling stays free', async () => {
    stubDb({ id: 'h1', no_show_fee_amount: 39, cancel_window_hours: 48, held_at: new Date(Date.now() - 240 * HOUR) });
    mockApptTime.mockResolvedValue(new Date(Date.now() + 100 * HOUR)); // cutoff = start − 48h, in the future
    const line = await cardHoldReminderLine('svc1');
    expect(line.startsWith('\n\nYour card on file holds this visit - cancel free until ')).toBe(true);
    expect(line).toContain('a $39 fee applies only if you cancel or no one is home');
    expect(line).toContain('Rescheduling is always free.');
    expect(line).not.toContain('reschedule or cancel free'); // fee never attributed to reschedules
  });
  it('booking-age grace: a fresh same-day booking discloses the midpoint cutoff, not "already inside"', async () => {
    stubDb({ id: 'h1', no_show_fee_amount: 49, cancel_window_hours: 24, held_at: new Date(Date.now() - 1 * HOUR) });
    mockApptTime.mockResolvedValue(new Date(Date.now() + 3 * HOUR)); // midpoint = +1h, still free NOW
    const note = await cardHoldReminderNote('svc1');
    expect(note).toContain('cancel free until');
  });
  it('past-cutoff bookings get the generic in-window copy (no stale cutoff)', async () => {
    stubDb({ id: 'h1', no_show_fee_amount: 49, cancel_window_hours: 24, held_at: new Date(Date.now() - 10 * HOUR) });
    mockApptTime.mockResolvedValue(new Date(Date.now() + 1 * HOUR)); // midpoint 4.5h ago
    const note = await cardHoldReminderNote('svc1');
    expect(note).toContain('A $49 fee applies only if you cancel or no one is home');
    expect(note).not.toContain('cancel free until');
  });
  it('a clock-skewed FUTURE held_at falls back to the disclosed-window cutoff (matches the fee check)', async () => {
    stubDb({ id: 'h1', no_show_fee_amount: 49, cancel_window_hours: 24, held_at: new Date(Date.now() + 2 * HOUR) });
    mockApptTime.mockResolvedValue(new Date(Date.now() + 100 * HOUR)); // disclosed cutoff = start − 24h, future
    const note = await cardHoldReminderNote('svc1');
    // Must NOT use the midpoint of a future booking time — the fee check
    // ignores future held_at and charges on the full disclosed window.
    expect(note).toContain('cancel free until');
  });
  it('appointment-time resolution failure degrades to the generic copy, never throws', async () => {
    stubDb({ id: 'h1', no_show_fee_amount: 49, cancel_window_hours: 24 });
    mockApptTime.mockRejectedValue(new Error('appt lookup down'));
    const note = await cardHoldReminderNote('svc1');
    expect(note).toContain('$49 fee applies');
    expect(note).not.toContain('cancel free until');
  });
  it("'' on a lookup error — a reminder must never fail on the policy clause", async () => {
    stubDb(new Error('db down'));
    expect(await cardHoldReminderLine('svc1')).toBe('');
  });
});

describe('recordCardHoldHeld — saved-method holds carry no SetupIntent (spec §3.2)', () => {
  it('records a hold with a null SetupIntent (fresh saved-method hold) without throwing', async () => {
    stubDb([null, null]); // visit lock → no existing SI-less held row → insert path (lane check is table-scoped)
    await expect(recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    })).resolves.toBeUndefined();
  });
  it('updates the existing SI-less held row on a retried accept (no duplicate holds)', async () => {
    stubDb([null, { id: 'hold-existing' }]); // visit lock → existing SI-less held row → update path
    await expect(recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    })).resolves.toBeUndefined();
  });
});

describe('chargeNoShowFee — cross-lane refusal (PR #3496 r19 P0)', () => {
  const HOLD = { id: 'h1', customer_id: 'cust1', stripe_payment_method_id: 'pm_s', no_show_fee_amount: 49, cancel_window_hours: 24 };

  it('refuses the fee, leaves the hold held, and bells the office (deduped) when a /secure row exists', async () => {
    stubDb([HOLD], { laneRows: { id: 'req-1' } });
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', serviceStart: new Date(), now: new Date() });
    expect(r).toEqual({ charged: false, reason: 'competing_consent_review' });
    expect(mockDbUpdates).toEqual([]);
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('Two card consents'),
      expect.stringContaining('Neither card was charged'),
      expect.objectContaining({ dedupeKey: 'competing_consent_fee:h1:svc1' }),
    );
  });

  it('an unreadable lane table refuses the fee (fail closed) without releasing the hold', async () => {
    stubDb([HOLD], { laneRows: new Error('table gone') });
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', serviceStart: new Date(), now: new Date() });
    expect(r).toEqual({ charged: false, reason: 'lane_check_failed' });
    expect(mockDbUpdates).toEqual([]);
  });
});

describe('recordCardHoldHeld — reciprocal /secure lane exclusion (PR #3496 r16 P1)', () => {
  it('NEVER deletes a pending /secure row — its token may already be customer-exposed; the hold records and the conflict is left for the money legs to refuse', async () => {
    let delCalled = false;
    stubDb([
      null, // visit row lock (serialization anchor)
      null, // no existing SI-less held row → insert path
    ], { laneRows: { id: 'req-1', status: 'pending', stripe_setup_intent_id: null } });
    const base = mockDbHandler;
    mockDbHandler = (table) => {
      const chain = base(table);
      chain.del = jest.fn(() => { delCalled = true; return Promise.resolve(1); });
      return chain;
    };
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    });
    expect(delCalled).toBe(false);
    expect(mockDbInserts).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'held' })]));
  });

  it('NEVER destroys a consented /secure row (satisfied) — hold still records, conflict left for the completion rails to surface', async () => {
    let delCalled = false;
    stubDb([
      null,
      null,
    ], { laneRows: { id: 'req-1', status: 'satisfied', stripe_setup_intent_id: null } });
    const base = mockDbHandler;
    mockDbHandler = (table) => {
      const chain = base(table);
      chain.del = jest.fn(() => { delCalled = true; return Promise.resolve(1); });
      return chain;
    };
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    });
    expect(delCalled).toBe(false);
    expect(mockDbInserts).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'held' })]));
  });

  it('a pending row that already minted a SetupIntent is treated as in-flight consent — never deleted', async () => {
    let delCalled = false;
    stubDb([
      null,
      null,
    ], { laneRows: { id: 'req-1', status: 'pending', stripe_setup_intent_id: 'si_live' } });
    const base = mockDbHandler;
    mockDbHandler = (table) => {
      const chain = base(table);
      chain.del = jest.fn(() => { delCalled = true; return Promise.resolve(1); });
      return chain;
    };
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    });
    expect(delCalled).toBe(false);
  });
});

describe('recordCardHoldHeld — lane-creation serialization anchor (PR #3496 r18 P1)', () => {
  it('locks the scheduled_services row BEFORE the lane absence check — same order as the appointment-card writers', async () => {
    stubDb([null, null]);
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    });
    const tables = dbMock.mock.calls.map((c) => c[0]);
    const visitIdx = tables.indexOf('scheduled_services');
    const laneIdx = tables.indexOf('appointment_card_requests');
    expect(visitIdx).toBeGreaterThanOrEqual(0);
    expect(laneIdx).toBeGreaterThan(visitIdx);
  });
});

describe('recordCardHoldHeld — sticky disclosure rides the ACCEPT attestation (Codex #3342 r1 P1)', () => {
  it('a saved-method hold from an attesting accept is sticky-capable — its only consent surface is the accept page', async () => {
    stubDb([null, null]);
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved', disclosureVersion: 'sticky_v1',
    });
    expect(mockDbInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sticky_window_disclosed: true, status: 'held' }),
    ]));
  });
  it('a saved-method hold from a legacy/non-attesting accept stays non-sticky', async () => {
    stubDb([null, null]);
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved',
    });
    expect(mockDbInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sticky_window_disclosed: false, status: 'held' }),
    ]));
  });
  it('the retried-accept update path records the BOOKING accept\'s attestation (the consent trail belongs to the accept that booked)', async () => {
    stubDb([null, { id: 'hold-existing' }]);
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved', disclosureVersion: 'sticky_v1',
    });
    const patch = mockDbUpdates.find((p) => p.status === 'held');
    expect(patch.sticky_window_disclosed).toBe(true);
  });
  it('the SI conflict path carries the accept attestation onto the pending row — acceptance is the sole marker writer', async () => {
    // SI path: visit lock → term lookup first() (lane check is table-scoped).
    stubDb([null, { no_show_fee_amount: 49, cancel_window_hours: 24 }]);
    const merges = [];
    const prevHandler = mockDbHandler;
    mockDbHandler = (table) => {
      const chain = prevHandler(table);
      const origInsert = chain.insert;
      chain.insert = (payload) => {
        origInsert(payload);
        return { onConflict: () => ({ merge: (m) => { merges.push(m); return Promise.resolve(1); } }) };
      };
      return chain;
    };
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: 'si_1', paymentMethodId: 'pm_cap', disclosureVersion: 'sticky_v1',
    });
    expect(merges[0].sticky_window_disclosed).toBe(true);
    // And a NON-attesting accept records false the same way.
    stubDb([null, { no_show_fee_amount: 49, cancel_window_hours: 24 }]);
    const secondBase = mockDbHandler;
    const merges2 = [];
    mockDbHandler = (table) => {
      const chain = secondBase(table);
      const origInsert = chain.insert;
      chain.insert = (payload) => {
        origInsert(payload);
        return { onConflict: () => ({ merge: (m) => { merges2.push(m); return Promise.resolve(1); } }) };
      };
      return chain;
    };
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: 'si_1', paymentMethodId: 'pm_cap',
    });
    expect(merges2[0].sticky_window_disclosed).toBe(false);
  });
});

describe('recordCardHoldHeld — freezes the accepted amount at booking (Codex #2821 P1)', () => {
  it('stamps accepted_amount onto a fresh hold row (insert path)', async () => {
    stubDb([null, null]); // visit lock → no existing SI-less held row → insert path (lane check is table-scoped)
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved', acceptedAmount: 250,
    });
    expect(mockDbInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accepted_amount: 250, status: 'held' }),
    ]));
  });
  it('stamps accepted_amount on the retried-accept update path too', async () => {
    stubDb([null, { id: 'hold-existing' }]);
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved', acceptedAmount: 199.995,
    });
    // Rounded to cents at the stamp, so the cap compares like-for-like.
    expect(mockDbUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ accepted_amount: 200 }),
    ]));
  });
  it('an unreadable/absent accepted amount freezes NULL — the completion cap then fails CLOSED, never open', async () => {
    stubDb([null]);
    await recordCardHoldHeld({
      estimateId: 'est1', customerId: 'cust1', scheduledServiceId: 'svc1',
      setupIntentId: null, paymentMethodId: 'pm_saved', acceptedAmount: 'garbage',
    });
    expect(mockDbInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accepted_amount: null }),
    ]));
  });
});

describe('cardHoldCancelPreview — cancel-UI preview', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  const holdRow = { id: 'h1', cancel_window_hours: 24, no_show_fee_amount: 49 };
  it('no hold → nothing to ask', async () => {
    stubDb(null);
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: false, feeApplies: false });
  });
  it('held + in-window start → fee applies with the hold\'s own fee amount', async () => {
    stubDb(holdRow);
    mockApptTime.mockResolvedValue(new Date('2026-07-06T18:00:00Z'));
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: true, feeApplies: true, feeAmount: 49 });
  });
  it('held but start past the arrival-window grace → no fee, no prompt', async () => {
    stubDb(holdRow);
    mockApptTime.mockResolvedValue(new Date('2026-07-01T12:00:00Z'));
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: true, feeApplies: false, feeAmount: 49 });
  });
  it('feature flag off → fee never applies (chargeNoShowFee would no-op)', async () => {
    process.env.ONE_TIME_CARD_HOLD = 'false';
    stubDb(holdRow);
    mockApptTime.mockResolvedValue(new Date('2026-07-06T18:00:00Z'));
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: true, feeApplies: false, feeAmount: 49 });
  });
});

describe('handleCardHoldCancellation — fee guardrails', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  const holdRow = { id: 'h1', cancel_window_hours: 24 };
  it('releases free (never charges) when the visit start passed beyond the arrival-window grace', async () => {
    stubDb(holdRow);
    const r = await handleCardHoldCancellation({
      scheduledServiceId: 'svc1',
      serviceStart: new Date('2026-07-01T12:00:00Z'),
      now,
    });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });
  it('still charges a same-day post-start cancel — the tech may still arrive inside the 2h arrival window', async () => {
    stubDb([
      { ...holdRow },                                                     // handleCardHoldCancellation hold lookup
      { ...holdRow, customer_id: 'c1', stripe_payment_method_id: 'pm1', no_show_fee_amount: 49, estimate_id: 'e1' }, // chargeNoShowFee's own lookup
      { id: 'pmrow1' },                                                   // attach self-heal: card already on file
    ]);
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    await handleCardHoldCancellation({
      scheduledServiceId: 'svc1',
      serviceStart: new Date('2026-07-06T11:55:00Z'), // started 5 min ago
      now,
    });
    expect(mockChargeOffSession).toHaveBeenCalledTimes(1);
  });
  it('waiveFee releases free even inside the window (business-initiated cancel)', async () => {
    stubDb(holdRow);
    const r = await handleCardHoldCancellation({
      scheduledServiceId: 'svc1',
      serviceStart: new Date('2026-07-06T18:00:00Z'),
      now,
      waiveFee: true,
    });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });
});

// Sticky cancel window (owner ruling 2026-08-10): a reschedule made INSIDE
// the fee window must not launder a later cancel into a free release —
// before this, "reschedule 10 days out at T-2h, then cancel" dodged the fee
// because rebooker overwrites scheduled_date in place and the window check
// only ever saw the new slot.
describe('handleCardHoldCancellation — sticky window (reschedule-then-cancel dodge)', () => {
  beforeEach(() => { process.env.GATE_STICKY_CANCEL_WINDOW = 'true'; });
  afterEach(() => { delete process.env.GATE_STICKY_CANCEL_WINDOW; });
  const now = new Date('2026-07-06T12:00:00Z');
  const farStart = new Date('2026-07-20T14:00:00Z'); // current slot: 14 days out, far outside the window
  // held_at is the CONSENT anchor — only reschedules made after it can
  // stick — and sticky_window_disclosed is the FROZEN policy marker: the
  // row's consent surface stated the sticky rule.
  const holdRow = { id: 'h1', cancel_window_hours: 24, held_at: new Date('2026-06-30T10:00:00Z'), sticky_window_disclosed: true };
  const chargeRow = { ...holdRow, customer_id: 'c1', stripe_payment_method_id: 'pm1', no_show_fee_amount: 49, estimate_id: 'e1' };
  // Original slot 2026-07-01 10:00 ET (14:00Z EDT), customer moved it at
  // 12:00Z — 2 hours' notice, squarely inside the 24h window.
  const lateCustomerMove = {
    original_date: '2026-07-01', original_window: '10:00:00-12:00:00',
    reason_code: 'customer_request', initiated_by: 'customer_self_serve',
    created_at: '2026-07-01T12:00:00Z',
    // Landed on the slot now being cancelled (farStart = 2026-07-20 10:00
    // ET) — the lineage check requires the newest logged move to match.
    new_date: '2026-07-20', new_window: '10:00:00-12:00:00',
  };

  it('charges the late-cancel fee when a customer reschedule was itself made inside the window', async () => {
    stubDb([holdRow, { id: 'pm-live' }, chargeRow, { id: 'pmrow1' }], { rescheduleLog: [lateCustomerMove] });
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ charged: true, amount: 49 }));
    expect(mockChargeOffSession).toHaveBeenCalledTimes(1);
  });

  it('a STAFF-ASSISTED customer reschedule (admin actor, customer_request reason) sticks — the phone-in dodge is closed too', async () => {
    stubDb([holdRow, { id: 'pm-live' }, chargeRow, { id: 'pmrow1' }], {
      rescheduleLog: [{ ...lateCustomerMove, initiated_by: 'admin' }],
    });
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ charged: true, amount: 49 }));
  });

  it('an admin OPS move (route_overload) never sticks — only customer-asked moves count', async () => {
    stubDb(holdRow, {
      rescheduleLog: [{ ...lateCustomerMove, initiated_by: 'admin', reason_code: 'route_overload' }],
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it("a customer's OWN SMS pick sticks even though it inherits the rain-out reason — the actor is authoritative", async () => {
    stubDb([holdRow, { id: 'pm-live' }, chargeRow, { id: 'pmrow1' }], {
      rescheduleLog: [{ ...lateCustomerMove, initiated_by: 'customer_sms', reason_code: 'weather_rain' }],
    });
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ charged: true, amount: 49 }));
  });

  it('a LATER company move supersedes earlier sticky evidence — cancelling the slot WE picked stays free', async () => {
    stubDb(holdRow, {
      rescheduleLog: [
        lateCustomerMove, // customer late-move: sticky evidence...
        { original_date: '2026-07-02', original_window: '09:00:00-11:00:00', reason_code: 'weather_rain', initiated_by: 'weather_auto', created_at: '2026-07-02T10:00:00Z' }, // ...then Waves rain-outs the new slot
      ],
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('a customer late-move AFTER the company move re-arms sticky from scratch', async () => {
    stubDb([holdRow, { id: 'pm-live' }, chargeRow, { id: 'pmrow1' }], {
      rescheduleLog: [
        lateCustomerMove,
        { original_date: '2026-07-02', original_window: '09:00:00-11:00:00', reason_code: 'weather_rain', initiated_by: 'weather_auto', created_at: '2026-07-02T10:00:00Z' },
        // Waves-picked slot 2026-07-03 10:00 ET (14:00Z); customer moves it
        // again at 12:00Z — 2 hours' notice, a fresh late move.
        { ...lateCustomerMove, original_date: '2026-07-03', created_at: '2026-07-03T12:00:00Z' },
      ],
    });
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ charged: true, amount: 49 }));
  });

  it('the WAVES rain-out move itself (weather_auto actor) never sticks — company moves reset the clock', async () => {
    stubDb(holdRow, { rescheduleLog: [{ ...lateCustomerMove, initiated_by: 'weather_auto', reason_code: 'weather_rain' }] });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('a customer reschedule with PLENTY of notice does not stick — the cancel stays free', async () => {
    stubDb(holdRow, {
      rescheduleLog: [{ ...lateCustomerMove, original_date: '2026-07-05' }], // 4 days' notice at reschedule time
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('the booking-age narrowing applies AT RESCHEDULE TIME — a same-day booker who immediately moved the visit stays free', async () => {
    // Booked (held) 11:00Z, moved 12:00Z, original slot 08:00Z next day:
    // 20h notice, but the effective window is min(24h, 1h since booking).
    stubDb({ ...holdRow, held_at: new Date('2026-07-01T11:00:00Z') }, {
      rescheduleLog: [{ ...lateCustomerMove, original_date: '2026-07-02', original_window: '04:00:00-06:00:00' }],
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('DARK by default — gate off, a sticky row exists, the cancel releases free and the log is never even queried', async () => {
    delete process.env.GATE_STICKY_CANCEL_WINDOW;
    stubDb(holdRow, { rescheduleLog: [lateCustomerMove] });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockRescheduleLogChains).toHaveLength(0);
  });

  it('sticky evidence never bills a DEAD slot — a cancel past the arrival grace stays a free cleanup release', async () => {
    stubDb(holdRow, { rescheduleLog: [lateCustomerMove] });
    const r = await handleCardHoldCancellation({
      scheduledServiceId: 'svc1',
      serviceStart: new Date('2026-07-05T12:00:00Z'), // current slot came and went a day ago
      now,
    });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockRescheduleLogChains).toHaveLength(0);
    expect(mockDbUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
  });

  it('the PREVIEW also refuses sticky on a dead slot — no fee prompt for stale-row cleanup', async () => {
    stubDb({ ...holdRow, no_show_fee_amount: 49 }, { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(new Date('2026-07-05T12:00:00Z'));
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: true, feeApplies: false, feeAmount: 49 });
  });

  it('a reschedule made BEFORE fee consent (held_at) can never authorize a fee — terms not yet accepted', async () => {
    stubDb(holdRow, {
      // In-window move, but made the day before the card hold existed.
      rescheduleLog: [{ ...lateCustomerMove, original_date: '2026-06-29', created_at: '2026-06-29T12:00:00Z' }],
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('a hold consented under the OLD copy (no sticky_window_disclosed marker) can NEVER be sticky-charged', async () => {
    stubDb({ ...holdRow, sticky_window_disclosed: false }, { rescheduleLog: [lateCustomerMove] });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockRescheduleLogChains).toHaveLength(0);
  });

  it('sticky evidence with the PARENT card-hold rail off releases free — never a stranded hold a later re-enable could charge (pre-push r8 P1)', async () => {
    // Sticky gate on, ONE_TIME_CARD_HOLD off: the sticky branch must not
    // run (chargeNoShowFee would refuse feature_disabled WITHOUT releasing)
    // — the cancel falls through to the ordinary free release, matching
    // the preview's both-gates condition.
    process.env.ONE_TIME_CARD_HOLD = 'false';
    stubDb(holdRow, { rescheduleLog: [lateCustomerMove] });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockRescheduleLogChains).toHaveLength(0);
    expect(mockDbUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
  });

  it('a legacy pre-marker row keeps its dated reminder cutoff — the promise stays honored', async () => {
    stubDb({ ...holdRow, no_show_fee_amount: 49, sticky_window_disclosed: false }, { rescheduleLog: [lateCustomerMove] });
    // The cutoff clause renders only for a still-future cutoff (real clock).
    mockApptTime.mockResolvedValue(new Date(Date.now() + 100 * 3600000));
    const note = await cardHoldReminderNote('svc1');
    expect(note).toContain('cancel free until');
  });

  it('a legacy hold without held_at has no consent anchor — no sticky at all, the log is never queried', async () => {
    stubDb({ id: 'h1', cancel_window_hours: 24, sticky_window_disclosed: true }, { rescheduleLog: [lateCustomerMove] });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockRescheduleLogChains).toHaveLength(0);
  });

  it('card removal is REVOCATION — a sticky cancel with the local payment_methods row gone releases free with an office alert', async () => {
    stubDb([holdRow, null], { rescheduleLog: [lateCustomerMove] }); // pm-revocation check finds nothing
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('card removed'),
      expect.stringContaining('revocation'),
      expect.anything(),
    );
  });

  it('an UNLOGGED later move (series shift) invalidates sticky — the newest logged move must land on the slot being cancelled', async () => {
    stubDb(holdRow, {
      rescheduleLog: [{ ...lateCustomerMove, new_date: '2026-07-15' }], // customer landed on the 15th; visit now sits on the 20th — something unlogged moved it
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('an unlogged move BETWEEN two logged customer moves clears earlier sticky evidence — adjacency, not just the final landing (pre-push r8 P0)', async () => {
    // Customer late-move lands on the 5th; something UNLOGGED (a direct
    // admin edit — possibly a window-resetting company move) puts the visit
    // on the 10th; the customer then moves the 10th → the 20th with a week's
    // notice. The final logged landing matches the slot being cancelled, so
    // the newest-landing check alone is blind to the seam — the 10th ≠ the
    // 5th is the tell, and unverifiable lineage never charges.
    stubDb(holdRow, {
      rescheduleLog: [
        { ...lateCustomerMove, new_date: '2026-07-05' },
        {
          original_date: '2026-07-10', original_window: '10:00:00-12:00:00',
          reason_code: 'customer_request', initiated_by: 'customer_self_serve',
          created_at: '2026-07-03T12:00:00Z', // a week out — not itself a late move
          new_date: '2026-07-20', new_window: '10:00:00-12:00:00',
        },
      ],
    });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('a fresh LATE customer move after the unlogged seam re-arms sticky on its own strength', async () => {
    // Same seam as above, but the second customer move is itself made 2
    // hours before its slot — new evidence born after the gap, judged on
    // its own terms, still charges.
    stubDb([holdRow, { id: 'pm-live' }, chargeRow, { id: 'pmrow1' }], {
      rescheduleLog: [
        { ...lateCustomerMove, new_date: '2026-07-05' },
        {
          original_date: '2026-07-10', original_window: '10:00:00-12:00:00',
          reason_code: 'customer_request', initiated_by: 'customer_self_serve',
          created_at: '2026-07-10T12:00:00Z', // 10:00 ET slot = 14:00Z — 2 hours' notice
          new_date: '2026-07-20', new_window: '10:00:00-12:00:00',
        },
      ],
    });
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ charged: true, amount: 49 }));
  });

  it('the reminder suppresses its cutoff on EVIDENCE even while the enforcement gate is off — a dark-period promise must survive a later flip', async () => {
    delete process.env.GATE_STICKY_CANCEL_WINDOW;
    stubDb([{ ...holdRow, no_show_fee_amount: 49 }, { id: 'pm-live' }], { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(farStart);
    const note = await cardHoldReminderNote('svc1');
    expect(note).not.toContain('cancel free until');
    expect(note).toContain('fee applies only if you cancel or no one is home');
  });

  it('sticky lookup failure releases free — this rail never charges a fee it cannot justify', async () => {
    stubDb(holdRow, { rescheduleLog: new Error('reschedule_log down') });
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  it('the cancel PREVIEW mirrors the sticky verdict (operator prompt must not lie)', async () => {
    stubDb([{ ...holdRow, no_show_fee_amount: 49 }, { id: 'pm-live' }], { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(farStart);
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: true, feeApplies: true, feeAmount: 49 });
  });

  it('the PREVIEW reports no fee once the card is removed — matching the handler\'s revocation release', async () => {
    stubDb([{ ...holdRow, no_show_fee_amount: 49 }, null], { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(farStart);
    expect(await cardHoldCancelPreview('svc1', now)).toEqual({ held: true, feeApplies: false, feeAmount: 49 });
  });

  it('the mint NEVER writes the sticky marker — acceptance is the sole writer (a pre-consent seed could survive an old-worker accept)', async () => {
    const inserts = [];
    const merges = [];
    mockDbHandler = () => {
      const chain = {};
      for (const m of ['where', 'orderBy', 'count']) chain[m] = jest.fn(() => chain);
      chain.first = jest.fn(() => Promise.resolve(null)); // no reusable pending row; generation count 0
      chain.update = jest.fn(() => Promise.resolve(1));
      chain.insert = jest.fn((payload) => {
        inserts.push(payload);
        return { onConflict: () => ({ merge: (m) => { merges.push(m); return Promise.resolve(1); } }) };
      });
      return chain;
    };
    mockCreateSetupIntent.mockResolvedValue({ id: 'si_mint', client_secret: 'cs_test' });
    await createCardHoldSetupIntentForEstimate({ id: 'est1', customer_id: 'c1' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sticky_window_disclosed).toBeUndefined();
    expect(merges[0].sticky_window_disclosed).toBeUndefined();
  });

  it('pending-intent REUSE never touches the marker — nothing pre-consent does', async () => {
    const updates = [];
    const pendingRow = {
      id: 'p1', stripe_setup_intent_id: 'si_reuse',
      no_show_fee_amount: 49, cancel_window_hours: 24,
    };
    mockDbHandler = () => {
      const chain = {};
      for (const m of ['where', 'orderBy', 'count']) chain[m] = jest.fn(() => chain);
      chain.first = jest.fn(() => Promise.resolve(pendingRow));
      chain.update = jest.fn((payload) => { updates.push(payload); return Promise.resolve(1); });
      return chain;
    };
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'si_reuse', status: 'requires_payment_method', client_secret: 'cs_reuse' });
    await createCardHoldSetupIntentForEstimate({ id: 'est1' });
    expect(updates.pop()).not.toEqual(expect.objectContaining({ sticky_window_disclosed: expect.anything() }));
  });

  it('the reminder drops its free-cancel cutoff promise once a sticky reschedule exists (generic copy stays accurate)', async () => {
    stubDb([{ ...holdRow, no_show_fee_amount: 49 }, { id: 'pm-live' }], { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(farStart);
    const note = await cardHoldReminderNote('svc1');
    expect(note).not.toContain('cancel free until');
    expect(note).toContain('fee applies only if you cancel or no one is home');
  });

  it("the reminder goes SILENT once the card is removed after a sticky reschedule — never threaten a fee the handler releases free (Codex #3342 r8 P2)", async () => {
    // Same evidence as above, but the local payment_methods row is gone:
    // the cancel handler treats that as revocation (free release + office
    // alert) and the preview reports feeApplies:false — the 72h/24h SMS and
    // appointment email must not still claim a card on file or threaten
    // the fee.
    stubDb([{ ...holdRow, no_show_fee_amount: 49 }, null], { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(farStart);
    expect(await cardHoldReminderNote('svc1')).toBe('');
  });

  it('an unverifiable card at reminder time also suppresses the note — same posture as the handler/preview', async () => {
    stubDb([{ ...holdRow, no_show_fee_amount: 49 }, new Error('pm lookup down')], { rescheduleLog: [lateCustomerMove] });
    mockApptTime.mockResolvedValue(farStart);
    expect(await cardHoldReminderNote('svc1')).toBe('');
  });
});

describe('chargeNoShowFee — staleness guard (fee only for a FRESH missed visit)', () => {
  const HOUR = 3600000;
  const HELD = { id: 'h1', customer_id: 'cust1', stripe_payment_method_id: 'pm_s', no_show_fee_amount: 49, estimate_id: 'e1' };

  it('refuses the fee and RELEASES the hold when the visit start is more than 48h past', async () => {
    stubDb([HELD]); // hold lookup; releaseCardHold is an update, not a first()
    mockApptTime.mockResolvedValue(new Date(Date.now() - 72 * HOUR));
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', reason: 'no_show' });
    expect(r).toEqual(expect.objectContaining({ charged: false, reason: 'no_show_stale_start', released: true }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
    expect(mockDbUpdates).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'charging' })]));
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('No-show fee not charged'),
      expect.stringContaining('NOT charged'),
      expect.objectContaining({ link: '/admin/customers/cust1' }),
    );
  });

  it('charges the fee when the visit start is inside the 48h bound', async () => {
    stubDb([HELD, { id: 'pmrow1' }]); // hold, then attach self-heal card-on-file check
    mockApptTime.mockResolvedValue(new Date(Date.now() - 5 * HOUR));
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', reason: 'no_show' });
    expect(r).toEqual(expect.objectContaining({ charged: true, amount: 49 }));
    expect(mockChargeOffSession).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('an unresolvable start refuses the fee (never charge against a timeline we cannot justify)', async () => {
    stubDb([HELD]);
    mockApptTime.mockRejectedValue(new Error('appt lookup down'));
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', reason: 'no_show' });
    expect(r).toEqual(expect.objectContaining({ charged: false, reason: 'no_show_start_unresolved' }));
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('attachSelfHeal:false never resurrects a removed card — the charge simply proceeds against the pm id (Codex #3342 r5)', async () => {
    stubDb([HELD]); // hold lookup only — NO pm row consulted, no attach
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', reason: 'late_cancel', serviceStart: new Date(Date.now() - 3600000), attachSelfHeal: false });
    expect(r).toEqual(expect.objectContaining({ charged: true }));
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  it('a caller-supplied fresh serviceStart skips the lookup and charges', async () => {
    stubDb([HELD, { id: 'pmrow1' }]);
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc1', reason: 'late_cancel', serviceStart: new Date(Date.now() - 1 * HOUR) });
    expect(r).toEqual(expect.objectContaining({ charged: true }));
    expect(mockApptTime).not.toHaveBeenCalled();
  });
});

describe('verifyCardHoldIntent — accept gate', () => {
  it('satisfied directly by an already-held card', async () => {
    stubDb({ id: 'h1', stripe_payment_method_id: 'pm_held', stripe_setup_intent_id: 'si_held' });
    const r = await verifyCardHoldIntent({ estimate: { id: 'EST' }, setupIntentId: 'ignored' });
    expect(r).toEqual(expect.objectContaining({ ok: true, paymentMethodId: 'pm_held', alreadyHeld: true }));
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
  });
  it('verifies a live setup intent when nothing is held yet', async () => {
    stubDb(null);
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_1', status: 'succeeded', payment_method: 'pm_1',
      metadata: { purpose: 'estimate_card_hold', estimate_id: 'EST' },
    });
    const r = await verifyCardHoldIntent({ estimate: { id: 'EST' }, setupIntentId: 'si_1' });
    expect(r).toEqual(expect.objectContaining({ ok: true, paymentMethodId: 'pm_1', setupIntentId: 'si_1' }));
  });
  it('rejects a setup intent pinned to a different estimate', async () => {
    stubDb(null);
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_2', status: 'succeeded', payment_method: 'pm_2',
      metadata: { purpose: 'estimate_card_hold', estimate_id: 'OTHER' },
    });
    const r = await verifyCardHoldIntent({ estimate: { id: 'EST' }, setupIntentId: 'si_2' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('intent_mismatch');
  });
  it('rejects when no setup intent is supplied and nothing is held', async () => {
    stubDb([null, null]); // hasHeldCard miss, then no webhook-captured pending row
    const r = await verifyCardHoldIntent({ estimate: { id: 'EST' }, setupIntentId: '' });
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: 'no_setup_intent' }));
  });
  it('falls back to a webhook-captured pending row when the client sent no id', async () => {
    // hasHeldCard miss, then a pending row the webhook stamped with the pm.
    stubDb([null, { stripe_setup_intent_id: 'si_wh' }]);
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_wh', status: 'succeeded', payment_method: 'pm_wh',
      metadata: { purpose: 'estimate_card_hold', estimate_id: 'EST' },
    });
    const r = await verifyCardHoldIntent({ estimate: { id: 'EST' }, setupIntentId: '' });
    expect(r).toEqual(expect.objectContaining({ ok: true, paymentMethodId: 'pm_wh', setupIntentId: 'si_wh' }));
  });
});

describe('chargeCardHoldForRecapCompletion — recap path closes the no-invoice gap', () => {
  // accepted_amount: the booking-time freeze the completion cap reads from
  // the hold row itself (no scheduled_services read on the charge path).
  const HELD = { id: 'h1', customer_id: 'cust1', stripe_payment_method_id: 'pm_s', stripe_setup_intent_id: 'si', no_show_fee_amount: 49, cancel_window_hours: 24, accepted_amount: 49 };
  const COLLECTIBLE_INVOICE = { id: 'inv_recap', status: 'draft', total: 49, payer_id: null };

  it('no-ops when there is no held card hold', async () => {
    stubDb([null]); // heldCardForScheduledService → none
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
  });

  it('DETECTS a reschedule-orphaned hold (gate ON) on a recap miss — bells the office, charges nothing', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    try {
      // queue: held(miss) → pre-detection prepaid probe → completing visit
      // read → dead linked visit. No repoint, no charge — the ops script
      // is the mover.
      stubDb([
        null,
        { prepaid_amount: null },
        { id: 'ss1', customer_id: 'cust1', source_estimate_id: 'est1', is_recurring: false },
        { status: 'cancelled' },
      ], { holdRows: [{ id: 'h1', scheduled_service_id: 'ss-old' }], visitRows: [] });
      const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
      // Still no_hold: pest-recap's appointment-card fallback keys on
      // no_hold, and a recreated visit with its own /secure consent must
      // keep that rail — the detection is a bell beside the flow.
      expect(r).toEqual({ charged: false, reason: 'no_hold' });
      expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(mockMintWithDeposit).not.toHaveBeenCalled();
      expect(mockDbUpdates).toEqual([]);
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT;
    }
  });

  it('stays SILENT on a recap miss when the visit was field-prepaid — collection would refuse anyway', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    try {
      stubDb([null, { prepaid_amount: 75 }], { holdRows: [{ id: 'h1', scheduled_service_id: 'ss-old' }], visitRows: [] });
      const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
      expect(r).toEqual({ charged: false, reason: 'no_hold' });
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT;
    }
  });

  it('no-ops without a service record', async () => {
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: null });
    expect(r).toEqual({ charged: false, reason: 'no_service_record' });
  });

  it('mints the completion invoice and charges the held card, OMITTING taxRate so create() auto-computes (commercial+business)', async () => {
    // queue: held(recap) → scheduled_service(prepaid check) → invoice-by-SR(none)
    // → scheduled_services(svc) → service_records(sr) → held(charge) → invoice → pm row
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: null }, null, { id: 'ss1', source_estimate_id: null }, { id: 'sr1', customer_id: 'cust1', service_type: 'Pest Control' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    // The mint delegates to the CANONICAL scheduled-invoice-mint helper
    // (Codex #3153 r4/r5): canonical lock + create() on the lock trx.
    expect(mockMintWithDeposit).toHaveBeenCalledTimes(1);
    const params = mockMintWithDeposit.mock.calls[0][0].buildCreateParams();
    expect(params.taxRate).toBeUndefined(); // let create() compute county-aware tax (handles 'business')
    expect(params.serviceRecordId).toBe('sr1');
    expect(params.lineItems.length).toBeGreaterThan(0);
    expect(r).toEqual({ charged: true });
  });

  it('reuses an existing invoice (by service_record_id) instead of minting a duplicate', async () => {
    // held → scheduled_service(prepaid check) → invoice-by-SR FOUND → held(charge) → invoice → pm
    stubDb([HELD, { prepaid_amount: null }, { id: 'inv_recap' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockMintWithDeposit).not.toHaveBeenCalled();
    expect(r).toEqual({ charged: true });
  });

  it('adopts a concurrent/pre-mint invoice via the canonical helper and back-links the service record', async () => {
    // held → scheduled_service(prepaid check) → invoice-by-SR(none) → svc → sr → held → invoice → pm
    stubDb([HELD, { prepaid_amount: null }, null, { id: 'ss1', source_estimate_id: null }, { id: 'sr1', customer_id: 'cust1' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockMintWithDeposit.mockResolvedValueOnce({ invoice: { id: 'inv_premint', service_record_id: null }, reused: true });
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockDbUpdates.some((p) => p.service_record_id === 'sr1')).toBe(true);
    expect(r).toEqual({ charged: true });
  });

  it('bails (no double-charge) + alerts on a prepaid visit BEFORE any invoice lookup', async () => {
    // queue: held → scheduled_service(prepaid > 0). No invoice lookup runs.
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: 75 }]);
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r).toEqual({ charged: false, reason: 'prepaid_visit_manual' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('alerts the office when invoice creation fails', async () => {
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: null }, null, { id: 'ss1', source_estimate_id: null }, { id: 'sr1', customer_id: 'cust1' }]);
    mockMintWithDeposit.mockRejectedValueOnce(new Error('mint boom'));
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r.reason).toBe('invoice_create_failed');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('alerts the office when the card charge fails (stranded draft, no pay-link UI)', async () => {
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: null }, null, { id: 'ss1', source_estimate_id: null }, { id: 'sr1', customer_id: 'cust1' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockRejectedValueOnce(Object.assign(new Error('card_declined'), { type: 'StripeCardError', payment_intent: { id: 'pi_x' } }));
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r.reason).toBe('charge_failed');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('does NOT charge a re-completed NOT-performed visit — routes to review', async () => {
    stubDb([HELD]); // heldCard, then the priorNonPerformed gate fires before any lookup
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1', priorNonPerformed: true });
    expect(r).toEqual({ charged: false, reason: 'prior_non_performed' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED (manual review) when the prepaid lookup errors', async () => {
    stubDb([HELD, new Error('db timeout')]); // heldCard ok, scheduled_services read rejects
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r).toEqual({ charged: false, reason: 'prepaid_lookup_failed' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('settleNoShowFee — refundable fee invoice + receipt', () => {
  const pi = (over = {}) => ({
    id: 'pi_fee', amount_received: 4900, latest_charge: 'ch_1',
    metadata: { waves_customer_id: 'cust1', estimate_id: 'EST', scheduled_service_id: 'ss1', reason: 'no_show' },
    ...over,
  });

  it('no-ops on a missing customer', async () => {
    const r = await settleNoShowFee({ id: 'pi_x', metadata: {} });
    expect(r).toEqual({ settled: false, reason: 'missing_pi_or_customer' });
  });

  it('skips settlement when the charge was FULLY refunded before this event', async () => {
    mockRetrievePaymentIntent.mockResolvedValueOnce({ latest_charge: { refunded: true, amount_refunded: 4900 } });
    const r = await settleNoShowFee(pi());
    expect(r).toEqual({ settled: false, reason: 'refunded_pre_settlement' });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it('still settles a PARTIAL pre-settlement refund (net revenue + refund ledger correct)', async () => {
    mockRetrievePaymentIntent.mockResolvedValueOnce({ latest_charge: { amount: 4900, refunded: false, amount_refunded: 2000 } });
    stubDb([null, { payment_receipt_channel: 'sms' }, { first_name: 'Sam' }]);
    const r = await settleNoShowFee(pi());
    expect(r).toEqual({ settled: true, invoiceId: 'inv1' });
    expect(mockInvoiceCreate).toHaveBeenCalled(); // settles, doesn't skip
  });

  it('throws (so Stripe retries) when the pre-settlement refund lookup fails — never settles gross', async () => {
    mockRetrievePaymentIntent.mockRejectedValueOnce(new Error('stripe unavailable'));
    await expect(settleNoShowFee(pi())).rejects.toThrow('stripe unavailable');
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it('is idempotent — an existing payment row (checked in-txn) = replay; re-attempts receipt only if unsent', async () => {
    // queue: in-txn existence(row) → replay-recovery invoice lookup (receipt already sent)
    stubDb([{ id: 'pay_existing' }, { id: 'inv1', receipt_sent_at: '2026-06-25' }]);
    const r = await settleNoShowFee(pi());
    expect(r).toEqual({ settled: false, replay: true });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
    expect(mockSendReceipt).not.toHaveBeenCalled(); // receipt already sent → no re-send
  });

  it('creates a face-value, self-pay PAID fee invoice and sends the receipt via the CANONICAL path (default sms channel)', async () => {
    // first() queue: in-txn existence(none) → prefs → customer (for admin notify)
    stubDb([null, { payment_receipt_channel: 'sms' }, { first_name: 'Sam' }]);
    const r = await settleNoShowFee(pi());
    expect(r).toEqual({ settled: true, invoiceId: 'inv1' });
    expect(mockInvoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust1', taxRate: 0,
      lineItems: [expect.objectContaining({ unit_price: 49, amount: 49 })],
    }));
    // Uses InvoiceService.sendReceipt (kill switch + receipt_sent_at + location),
    // NOT a hand-rolled sendCustomerMessage/sendSMS.
    expect(mockSendReceipt).toHaveBeenCalledWith('inv1');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendReceiptEmail).not.toHaveBeenCalled(); // sms channel → no email
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('dispatches by payment_receipt_channel: email-only → email, not SMS', async () => {
    stubDb([null, { payment_receipt_channel: 'email', email_enabled: true }, { first_name: 'Sam' }]);
    await settleNoShowFee(pi());
    expect(mockSendReceipt).not.toHaveBeenCalled();
    expect(mockSendReceiptEmail).toHaveBeenCalledWith('inv1', expect.objectContaining({ idempotencyKey: 'receipt_email_auto:inv1' }));
  });

  it('receipt-texts opt-out on the sms channel: the SMS leg is doomed at the consent gate, so the email carries the fee receipt', async () => {
    // payment_confirmation_sms=false (or a STOP sms_enabled=false) blocks the
    // receipt SMS at the messaging policy — NOT the full kill switch, so the
    // charged fee must still leave a receipt via the email leg (Codex P2 on
    // 4263af95; estimate-deposits twin).
    stubDb([null, { payment_receipt_channel: 'sms', payment_confirmation_sms: false, email_enabled: true }, { first_name: 'Sam' }]);
    mockSendReceipt.mockResolvedValueOnce({ sent: false, reason: 'receipt_texts_opted_out' });
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockSendReceiptEmail).toHaveBeenCalledWith('inv1', expect.objectContaining({ idempotencyKey: 'receipt_email_auto:inv1' }));
  });

  it("channel 'both' delivers BOTH legs — the email stamp must not make sendReceipt read already-sent", async () => {
    // Stamping receipt_sent_at before the SMS attempt made the unforced
    // sendReceipt skip the requested text (codex P2 on 6b73a479).
    stubDb([null, { payment_receipt_channel: 'both', email_enabled: true }, { first_name: 'Sam' }]);
    mockSendReceiptEmail.mockResolvedValueOnce({ ok: true });
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockSendReceiptEmail).toHaveBeenCalledWith('inv1', expect.objectContaining({ idempotencyKey: 'receipt_email_auto:inv1' }));
    expect(mockSendReceipt).toHaveBeenCalledWith('inv1');
  });

  it('email-only channel with email messages opted out falls back to the SMS receipt', async () => {
    // The fee was charged — a receipt has to land somewhere (codex P1 on
    // d040aa76; deposit twin).
    stubDb([null, { payment_receipt_channel: 'email', email_enabled: false }, { first_name: 'Sam' }]);
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockSendReceiptEmail).not.toHaveBeenCalled();
    expect(mockSendReceipt).toHaveBeenCalledWith('inv1');
  });

  it('email-only channel with NO recipient email falls back to the SMS receipt; a transient email error does NOT', async () => {
    stubDb([null, { payment_receipt_channel: 'email', email_enabled: true }, { first_name: 'Sam' }]);
    mockSendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'No receipt recipient email' });
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockSendReceipt).toHaveBeenCalledWith('inv1');

    // Transient provider failure: stays email-preferring, invoice unstamped
    // for the admin needs-receipt path — no surprise text.
    mockSendReceipt.mockClear();
    stubDb([null, { payment_receipt_channel: 'email', email_enabled: true }, { first_name: 'Sam' }]);
    mockSendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'provider 500' });
    const r2 = await settleNoShowFee(pi());
    expect(r2.settled).toBe(true);
    expect(mockSendReceipt).not.toHaveBeenCalled();
  });

  it('honors a payment_receipt opt-out — neither channel, just the office notify', async () => {
    stubDb([null, { payment_receipt: false, payment_receipt_channel: 'both' }, { first_name: 'Sam' }]);
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockSendReceipt).not.toHaveBeenCalled();
    expect(mockSendReceiptEmail).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('still settles (durable money) even if the receipt send throws', async () => {
    stubDb([null, { payment_receipt_channel: 'sms' }, { first_name: 'Sam' }]);
    mockSendReceipt.mockRejectedValueOnce(new Error('twilio down'));
    const r = await settleNoShowFee(pi());
    expect(r).toEqual({ settled: true, invoiceId: 'inv1' });
  });

  it("channel 'both' with the SMS held for the send window: queue owns the text — the delivered email must NOT stamp receipt_sent_at", async () => {
    // Stamping off tonight's email while the held SMS sits on the receipt
    // queue makes the queue's unforced 8 AM sendReceipt read 'already-sent'
    // and silently drop the text the customer asked for (codex r15 P2 on
    // 0b64ab5). The queue's SMS leg stamps when it actually delivers.
    stubDb([null, { payment_receipt_channel: 'both', email_enabled: true }, { first_name: 'Sam' }]);
    mockSendReceiptEmail.mockResolvedValueOnce({ ok: true });
    mockSendReceipt.mockRejectedValueOnce(Object.assign(new Error('receipt SMS blocked: QUIET_HOURS_HOLD'), {
      code: 'QUIET_HOURS_HOLD',
      nextAllowedAt: '2026-08-08T12:00:00.000Z',
    }));
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockEnqueueReceiptDelivery).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: 'inv1',
      source: 'no_show_fee_window_hold',
    }));
    expect(mockDbUpdates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ receipt_sent_at: 'NOW' }),
    ]));
  });

  it("channel 'both' with a NON-hold SMS failure still stamps off the delivered email (no queue handoff)", async () => {
    stubDb([null, { payment_receipt_channel: 'both', email_enabled: true }, { first_name: 'Sam' }]);
    mockSendReceiptEmail.mockResolvedValueOnce({ ok: true });
    mockSendReceipt.mockRejectedValueOnce(new Error('twilio down'));
    const r = await settleNoShowFee(pi());
    expect(r.settled).toBe(true);
    expect(mockEnqueueReceiptDelivery).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ receipt_sent_at: 'NOW' }),
    ]));
  });
});

describe('reschedule-orphan DETECTION at completion (GATE_CARD_HOLD_RESCHEDULE_ADOPT)', () => {
  // An operator reschedule composed as cancel + fresh create strands the
  // hold on the dead visit id. With the gate on, a completion whose primary
  // lookup misses DETECTS the customer's surviving same-estimate hold whose
  // linked visit is dead (unambiguous 1:1 shape only) and bells the office.
  // NO money moves and nothing is repointed — the ops script is the mover.
  const visit = { id: 'svc-new', customer_id: 'cust-1', source_estimate_id: 'est-1', is_recurring: false };
  const orphanCandidate = { id: 'hold-1', scheduled_service_id: 'svc-old' };

  afterEach(() => { delete process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT; });

  test('gate OFF (default): a primary-lookup miss stays no_hold — no detection reads, no alert', async () => {
    stubDb([null], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual([]);
    expect(dbMock.mock.calls.map((c) => c[0])).not.toContain('scheduled_services');
  });

  test('gate ON: detects the stranded same-estimate hold, BELLS the office, charges nothing, repoints nothing', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([
      null,                      // primary hold lookup (miss)
      visit,                     // completing visit read
      { status: 'cancelled' },   // the candidate's linked visit is dead
      { status: 'sent' },        // the alert inspects the invoice for honest copy
    ], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'orphan_hold_review' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual([]);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('Stranded card hold'),
      expect.stringContaining('proceeded on the pay-link flow'),
      expect.objectContaining({
        link: '/admin/customers/cust-1',
        metadata: expect.objectContaining({ holdId: 'hold-1', fromScheduledServiceId: 'svc-old', scheduledServiceId: 'svc-new' }),
      }),
    );
  });

  test('gate ON: a candidate whose linked visit is still LIVE stays silent — the hold still owns that visit', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, visit, { status: 'scheduled' }], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: a COMPLETED linked visit keeps its hold (backfill-review posture, already belled) — never re-flagged', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, visit, { status: 'completed' }], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: recurring visits never detect — the hold rail is one-time only', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, { ...visit, is_recurring: true }], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: a visit with no estimate lineage stays silent', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, { ...visit, source_estimate_id: null }], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: TWO held candidates on the estimate → undecidable successor, silent', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, visit], {
      holdRows: [orphanCandidate, { id: 'hold-2', scheduled_service_id: 'svc-other' }],
      visitRows: [],
    });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: a service-identity mismatch with the dead visit → not the successor, silent', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([
      null,
      { ...visit, service_type: 'Pest Control' },
      { status: 'cancelled', service_type: 'Termite Treatment' },
    ], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: another LIVE one-time sibling on the estimate → ambiguous, silent', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, visit, { status: 'cancelled' }], {
      holdRows: [orphanCandidate],
      visitRows: [{ id: 'svc-sibling', status: 'confirmed', is_recurring: false }],
    });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: recurring-lineage, terminal (skipped/no_show/completed), and the dead visit itself do NOT block detection', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, visit, { status: 'cancelled' }, { status: 'sent' }], {
      holdRows: [orphanCandidate],
      visitRows: [
        { id: 'svc-old', status: 'cancelled', is_recurring: false },     // the dead visit itself
        { id: 'svc-rec', status: 'confirmed', is_recurring: true },      // recurring lane — not this rail's
        { id: 'svc-boost', status: 'confirmed', is_recurring: false, recurring_parent_id: 'svc-rec' }, // series booster = recurring lineage
        { id: 'svc-skip', status: 'skipped', is_recurring: false },      // terminal — cannot claim the hold
        { id: 'svc-ns', status: 'no_show', is_recurring: false },        // terminal
        { id: 'svc-done', status: 'completed', is_recurring: false },    // terminal — its own completion already ran
      ],
    });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'orphan_hold_review' });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockDbUpdates).toEqual([]);
  });

  test('gate ON: a series-booster completing visit (recurring_parent_id, is_recurring=false) stays silent', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, { ...visit, recurring_parent_id: 'svc-parent' }], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate ON: an already-settled invoice gets the honest "already settled" bell, never a pay-link claim', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, visit, { status: 'cancelled' }, { status: 'paid' }], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'orphan_hold_review' });
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.anything(),
      expect.stringContaining('already settled'),
      expect.anything(),
    );
    expect(mockNotifyAdmin.mock.calls[0][2]).not.toContain('pay-link flow');
  });

  test('a COMPETING_CARD_CONSENT refusal restores the hold, bells the office (deduped), and returns its own reason', async () => {
    const hold = { id: 'hold-1', customer_id: 'cust-1', stripe_payment_method_id: 'pm-stripe-1', accepted_amount: 100 };
    const invoice = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: 75 };
    stubDb([hold, invoice, { id: 'pm-row-1' }]);
    mockChargeInvoiceWithSavedCard.mockRejectedValueOnce(Object.assign(new Error('competing consent'), { code: 'COMPETING_CARD_CONSENT' }));
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual(expect.objectContaining({ charged: false, reason: 'competing_consent_review' }));
    expect(mockDbUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'charging' }),
      expect.objectContaining({ status: 'held' }),
    ]));
    expect(mockDbUpdates).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'charge_review' })]));
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('Two card consents'),
      expect.stringContaining('Neither rail auto-charged'),
      expect.objectContaining({ dedupeKey: 'competing_consent:hold-1:svc-1' }),
    );
  });

  test('expectedHoldId pins the ops repair charge to the ruled row — a different resolved hold refuses untouched', async () => {
    const hold = { id: 'hold-OTHER', customer_id: 'cust-1', stripe_payment_method_id: 'pm-stripe-1', accepted_amount: 100 };
    stubDb([hold]);
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1', expectedHoldId: 'hold-1' });
    expect(r).toEqual({ charged: false, reason: 'hold_mismatch' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual([]);
  });

  test('gate ON: a detection read error fails toward silence, never an exception into completion', async () => {
    process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true';
    stubDb([null, new Error('db down')], { holdRows: [orphanCandidate], visitRows: [] });
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-new', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('handleCardHoldCancellation — park-on-cancel (GATE_CARD_HOLD_PARK_ON_CANCEL, owner ruling 2026-08-26)', () => {
  const HOLD = { id: 'h1', customer_id: 'cust1', stripe_payment_method_id: 'pm_s', no_show_fee_amount: 49, cancel_window_hours: 24, held_at: new Date('2026-06-01T12:00:00Z') };
  const now = new Date('2026-06-25T12:00:00Z');
  const farStart = new Date('2026-06-28T14:00:00Z'); // outside the 24h window

  // Parking hard-depends on the detection lane (r6 P1): both gates on.
  beforeEach(() => { process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT = 'true'; });
  afterEach(() => {
    delete process.env.GATE_CARD_HOLD_PARK_ON_CANCEL;
    delete process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT;
  });

  it('park gate WITHOUT the detection gate is OFF — parked consents must never be un-surfaceable', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    delete process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT;
    stubDb([HOLD]);
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
  });

  it('gate OFF (default): an outside-window cancel releases exactly as before', async () => {
    stubDb([HOLD]);
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockDbUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
  });

  it('gate ON: an outside-window cancel PARKS with a durable stamp — status stays held, decision recorded', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual({ handled: true, parked: true, reason: 'cancel_outside_window_park' });
    expect(mockDbUpdates).toEqual([expect.objectContaining({ park_reason: 'cancel_outside_window_park' })]);
    expect(mockDbUpdates).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
  });

  it('gate ON: a past-start cleanup cancel PARKS with its own reason', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    const pastStart = new Date('2026-06-20T10:00:00Z');
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: pastStart, now });
    expect(r).toEqual({ handled: true, parked: true, reason: 'cancel_past_start_park' });
    expect(mockDbUpdates).toEqual([expect.objectContaining({ park_reason: 'cancel_past_start_park' })]);
  });

  it('gate ON: a waived (business-initiated) cancel PARKS — the consent survives the sick-day/rain-out', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', waiveFee: true, now });
    expect(r).toEqual({ handled: true, parked: true, reason: 'waived_cancel_park' });
    expect(mockDbUpdates).toEqual([expect.objectContaining({ park_reason: 'waived_cancel_park' })]);
  });

  it('a STAMPED park is the decision of record — an in-window REPLAY returns it verbatim, never a fee (pre-push r2 P0)', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([{ ...HOLD, parked_at: new Date('2026-06-22T10:00:00Z') }]);
    const inWindowStart = new Date('2026-06-25T20:00:00Z'); // replay lands inside the window
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: inWindowStart, now });
    expect(r).toEqual({ handled: true, parked: true, reason: 'already_parked' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual([]);
  });

  it('gate ON: an UNRESOLVED appointment time still fails toward RELEASE, never a park (pre-push r2 P1)', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    mockApptTime.mockRejectedValueOnce(new Error('appt time gone'));
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockDbUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
  });

  it('gate ON: a park stamp that cannot land falls back to RELEASE — a park we cannot make durable is not taken', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD], { updateReturns: [0], });
    // stamp CAS misses → re-read shows the hold moved on concurrently
    const base = mockDbHandler;
    let firstDone = false;
    mockDbHandler = (table) => {
      const chain = base(table);
      const origFirst = chain.first;
      chain.first = jest.fn((...a) => {
        if (!firstDone) { firstDone = true; return Promise.resolve(HOLD); } // cancel's hold lookup
        return Promise.resolve({ status: 'released', parked_at: null });     // post-CAS re-read
      });
      return chain;
    };
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: farStart, now });
    expect(r).toEqual({ handled: false, reason: 'hold_released' });
  });

  it('gate ON: OFFBOARDING always releases — a parked hold has no future visit to follow', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', waiveFee: true, intent: 'offboard', now });
    expect(r).toEqual(expect.objectContaining({ released: true }));
    expect(mockDbUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'released' })]));
  });

  it('gate ON: an IN-WINDOW customer cancel still charges the disclosed fee — parking never blocks the fee', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    // heldCard(cancel) → fee path: heldCard(chargeNoShowFee) → pm row; lane
    // check is table-scoped (no /secure row).
    stubDb([
      HOLD,
      { ...HOLD, estimate_id: 'e1' }, // chargeNoShowFee's own lookup
      { id: 'pmrow1' },
    ]);
    mockChargeOffSession.mockResolvedValue({ id: 'pi_fee', status: 'succeeded' });
    const inWindowStart = new Date('2026-06-25T20:00:00Z'); // 8h out, inside 24h window
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', serviceStart: inWindowStart, now });
    expect(r).toEqual(expect.objectContaining({ charged: true }));
    expect(mockChargeOffSession).toHaveBeenCalled();
  });

  it('an IN-WINDOW reschedule request parks with sticky evidence — distinct reason + deduped office bell', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    mockApptTime.mockResolvedValueOnce(new Date('2026-06-25T20:00:00Z')); // 8h out — inside the 24h window
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', intent: 'reschedule_request', now });
    expect(r).toEqual({ handled: true, parked: true, reason: 'reschedule_request_in_window_park' });
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('Late reschedule request'),
      expect.stringContaining('no fee was charged'),
      expect.objectContaining({ dedupeKey: 'resched_in_window:h1:svc1' }),
    );
  });

  it('the in-window bell NEVER fires when the park did not land (lost CAS → released concurrently)', async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    mockApptTime.mockResolvedValueOnce(new Date('2026-06-25T20:00:00Z')); // inside the window
    stubDb([HOLD], { updateReturns: [0] }); // park CAS misses
    const base = mockDbHandler;
    let firstDone = false;
    mockDbHandler = (table) => {
      const chain = base(table);
      const origFirst = chain.first;
      chain.first = jest.fn((...a) => {
        if (!firstDone) { firstDone = true; return Promise.resolve(HOLD); }
        return Promise.resolve({ status: 'released', parked_at: null }); // post-CAS re-read
      });
      return chain;
    };
    const r = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', intent: 'reschedule_request', now });
    expect(r).toEqual({ handled: false, reason: 'hold_released' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it("reschedule_request intent: gate ON parks; gate OFF is a no-op (the legacy flip's status quo)", async () => {
    process.env.GATE_CARD_HOLD_PARK_ON_CANCEL = 'true';
    stubDb([HOLD]);
    mockApptTime.mockResolvedValueOnce(new Date('2026-06-28T14:00:00Z')); // outside the window
    const parked = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', intent: 'reschedule_request', now });
    expect(parked).toEqual({ handled: true, parked: true, reason: 'reschedule_request_park' });
    expect(mockDbUpdates).toEqual([expect.objectContaining({ park_reason: 'reschedule_request_park' })]);

    delete process.env.GATE_CARD_HOLD_PARK_ON_CANCEL;
    mockDbUpdates.length = 0;
    stubDb([HOLD]);
    const untouched = await handleCardHoldCancellation({ scheduledServiceId: 'svc1', intent: 'reschedule_request', now });
    expect(untouched).toEqual({ handled: false, reason: 'park_gate_off' });
    expect(mockDbUpdates).toEqual([]);
  });
});

describe('attach revocation guard is SELF-HEAL scoped (pre-push r13/r14 P0)', () => {
  it('self_heal: a customerless pm NEVER re-attaches — fail closed with a deduped review bell', async () => {
    stubDb([null]); // no local pm row
    mockRetrievePaymentMethod.mockResolvedValueOnce({ id: 'pm_gone', customer: null });
    const { attachCardHoldPaymentMethod } = require('../services/estimate-card-holds');
    const r = await attachCardHoldPaymentMethod({ customerId: 'cust1', paymentMethodId: 'pm_gone', mode: 'self_heal' });
    expect(r).toEqual({ attached: false, reason: 'payment_method_unattached_review' });
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'billing',
      expect.stringContaining('needs review'),
      expect.stringContaining('Nothing was charged and nothing was re-attached'),
      expect.objectContaining({ dedupeKey: 'hold_pm_review:cust1:pm_gone' }),
    );
  });
  it('self_heal: a pm still attached at Stripe heals as before', async () => {
    stubDb([null]);
    mockRetrievePaymentMethod.mockResolvedValueOnce({ id: 'pm_live', customer: 'cus_9' });
    mockSavePaymentMethod.mockResolvedValueOnce({ id: 'pmrow_new' });
    const { attachCardHoldPaymentMethod } = require('../services/estimate-card-holds');
    const r = await attachCardHoldPaymentMethod({ customerId: 'cust1', paymentMethodId: 'pm_live', mode: 'self_heal' });
    expect(r).toEqual(expect.objectContaining({ attached: true, paymentMethodRowId: 'pmrow_new' }));
  });
  it("INITIAL post-accept attach of a fresh customerless capture (SetupIntent has no Stripe customer) attaches — the guard must not fire", async () => {
    stubDb([null]);
    mockSavePaymentMethod.mockResolvedValueOnce({ id: 'pmrow_fresh' });
    const { attachCardHoldPaymentMethod } = require('../services/estimate-card-holds');
    const r = await attachCardHoldPaymentMethod({ customerId: 'cust1', paymentMethodId: 'pm_fresh' });
    expect(r).toEqual(expect.objectContaining({ attached: true, paymentMethodRowId: 'pmrow_fresh' }));
    expect(mockRetrievePaymentMethod).not.toHaveBeenCalled();
  });
  it('the charge-path self-heals pass the self_heal mode (source pattern)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/estimate-card-holds.js'), 'utf8');
    expect(src.split("mode: 'self_heal'").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('parked holds are un-chargeable until repointed (pre-push r3/r5 P0)', () => {
  const parkedHold = { id: 'hold-1', customer_id: 'cust-1', stripe_payment_method_id: 'pm-stripe-1', accepted_amount: 100, parked_at: new Date('2026-06-22T10:00:00Z') };

  test('completion charge on a PARKED hold returns before ANY mutation — even a non-collectible invoice cannot release it', async () => {
    const paidInvoice = { id: 'inv-1', customer_id: 'cust-1', status: 'paid', total: 75 };
    stubDb([parkedHold, paidInvoice]);
    const r = await chargeCardHoldOnCompletion({ scheduledServiceId: 'svc-1', invoiceId: 'inv-1' });
    expect(r).toEqual({ charged: false, reason: 'parked' });
    expect(mockChargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(mockDbUpdates).toEqual([]);
  });

  test('no-show fee on a PARKED hold returns before the staleness release can touch it', async () => {
    stubDb([parkedHold]);
    const r = await chargeNoShowFee({ scheduledServiceId: 'svc-1', serviceStart: new Date('2020-01-01'), now: new Date() });
    expect(r).toEqual({ charged: false, reason: 'parked' });
    expect(mockDbUpdates).toEqual([]);
  });

  test('recap charge on a PARKED hold returns untouched', async () => {
    stubDb([parkedHold]);
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(r).toEqual({ charged: false, reason: 'parked' });
    expect(mockDbUpdates).toEqual([]);
  });

  test('the claim CAS itself pins parked_at IS NULL (source pattern)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/estimate-card-holds.js'), 'utf8');
    const claim = src.slice(src.indexOf('async function claimHoldForCharge'), src.indexOf('async function claimHoldForCharge') + 700);
    expect(claim).toContain("whereNull('parked_at')");
  });
});

describe('cancel surfaces wire the shared follow-through (source pattern)', () => {
  const fs = require('fs');
  const path = require('path');
  it('the Intelligence Bar cancel tool runs runVisitCancellationFollowThrough on BOTH the main and replay paths', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/tools.js'), 'utf8');
    const hits = src.split('runVisitCancellationFollowThrough').length - 1;
    expect(hits).toBeGreaterThanOrEqual(3); // require ×2 + call ×2 across the two paths, at minimum
  });
  it("the portal reschedule-request legacy flip parks the hold via intent 'reschedule_request'", () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/schedule.js'), 'utf8');
    expect(src).toContain("intent: 'reschedule_request'");
  });
  it('the payment_method.detached webhook releases still-held holds atomically — card removal is revocation', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/stripe-webhook.js'), 'utf8');
    const handler = src.slice(src.indexOf('async function handlePaymentMethodDetached'));
    const block = handler.slice(0, handler.indexOf('async function', 10));
    expect(block).toContain("trx('estimate_card_holds')");
    expect(block).toContain("status: 'released'");
  });

  it("offboarding pins intent 'offboard' so parking can never keep a leaving customer's hold", () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/customer-offboarding.js'), 'utf8');
    expect(src).toContain("intent: 'offboard'");
  });
});
