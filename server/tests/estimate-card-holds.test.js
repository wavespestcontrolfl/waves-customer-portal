// One-time card-on-file hold service. Mirrors the estimate-deposits test
// harness: db + stripe + logger mocked, the pure decision logic exercised
// directly, and the trust-boundary verify path checked against Stripe.

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.transaction = jest.fn((cb) => cb(mock)); // run the txn body against the same mock
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// No-show fee settlement + recap completion-invoice dependencies (lazy-required).
const mockInvoiceCreate = jest.fn(async () => ({ id: 'inv1', token: 'tok1' }));
const mockSendReceipt = jest.fn(async () => ({ sent: true }));
const mockCreateFromService = jest.fn(async () => ({ id: 'inv_recap', token: 'tokr' }));
jest.mock('../services/invoice', () => ({
  create: (...a) => mockInvoiceCreate(...a),
  sendReceipt: (...a) => mockSendReceipt(...a),
  createFromService: (...a) => mockCreateFromService(...a),
}));
const mockSendSMS = jest.fn();
jest.mock('../services/twilio', () => ({ sendSMS: (...a) => mockSendSMS(...a) }));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendCustomerMessage(...a) }));
const mockSendReceiptEmail = jest.fn(async () => ({ ok: true }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: (...a) => mockSendReceiptEmail(...a) }));
const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../utils/datetime-et', () => ({ etDateString: jest.fn(() => '2026-06-25'), addETDays: jest.fn() }));

const mockRetrievePaymentIntent = jest.fn(async () => ({ latest_charge: { refunded: false, amount_refunded: 0 } }));
const mockRetrieveSetupIntent = jest.fn();
const mockCreateSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
const mockChargeInvoiceWithSavedCard = jest.fn();
const mockChargeOffSession = jest.fn();
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  retrievePaymentIntent: (...a) => mockRetrievePaymentIntent(...a),
  createEstimateCardHoldSetupIntent: (...a) => mockCreateSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
  chargeInvoiceWithSavedCard: (...a) => mockChargeInvoiceWithSavedCard(...a),
  chargeSavedPaymentMethodOffSession: (...a) => mockChargeOffSession(...a),
}));

const {
  isCardHoldEnabled,
  cardHoldNoShowFee,
  cardHoldCancelWindowHours,
  resolveCardHoldPolicy,
  verifyCardHoldIntent,
  isWithinCancelWindow,
  chargeCardHoldForRecapCompletion,
  settleNoShowFee,
  _private: { cardHoldIntentMatchesEstimate },
} = require('../services/estimate-card-holds');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ONE_TIME_CARD_HOLD = 'true';
});
afterEach(() => {
  delete process.env.ONE_TIME_CARD_HOLD;
});

// Chainable db stub. Each db() call returns a fresh chain; terminal .first()
// calls consume `firstResults` in order (so hasHeldCard's lookup and the
// webhook-pending fallback lookup can return different rows).
function stubDb(firstResults) {
  const queue = Array.isArray(firstResults) ? [...firstResults] : [firstResults];
  mockDbHandler = () => {
    const chain = {};
    for (const m of ['where', 'whereNot', 'whereNotNull', 'whereIn', 'andWhere', 'orWhere', 'orderBy', 'modify', 'select']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.first = jest.fn(() => {
      const v = queue.length ? queue.shift() : null;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    });
    chain.update = jest.fn(() => Promise.resolve(1));
    chain.insert = jest.fn(() => Promise.resolve([{}]));
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

describe('cardHoldNoShowFee / cardHoldCancelWindowHours', () => {
  it('default to $49 / 24h', () => {
    expect(cardHoldNoShowFee()).toBe(49);
    expect(cardHoldCancelWindowHours()).toBe(24);
  });
  it('read constants.CARD_HOLD (pricing_config-authoritative) and fall back on junk', () => {
    const { CARD_HOLD } = require('../services/pricing-engine/constants');
    const original = { ...CARD_HOLD };
    try {
      CARD_HOLD.noShowFeeAmount = 75; CARD_HOLD.cancelWindowHours = 48;
      expect(cardHoldNoShowFee()).toBe(75);
      expect(cardHoldCancelWindowHours()).toBe(48);
      CARD_HOLD.noShowFeeAmount = -5; CARD_HOLD.cancelWindowHours = 'junk';
      expect(cardHoldNoShowFee()).toBe(49);
      expect(cardHoldCancelWindowHours()).toBe(24);
    } finally {
      Object.assign(CARD_HOLD, original);
    }
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
    expect(p.noShowFeeAmount).toBe(49);
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
  it('false when the visit start is already past — stale-row cleanup must not charge (P0: past-visit $49)', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T11:59:59Z'), now })).toBe(false);
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-19T08:00:00Z'), now })).toBe(false);
  });
  it('true at the exact start instant (cancelling as the tech arrives is still a late cancel)', () => {
    expect(isWithinCancelWindow({ hold, serviceStart: new Date('2026-06-24T12:00:00Z'), now })).toBe(true);
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
  const HELD = { id: 'h1', customer_id: 'cust1', stripe_payment_method_id: 'pm_s', stripe_setup_intent_id: 'si', no_show_fee_amount: 49, cancel_window_hours: 24 };
  const COLLECTIBLE_INVOICE = { id: 'inv_recap', status: 'draft', total: 49, payer_id: null };

  it('no-ops when there is no held card hold', async () => {
    stubDb([null]); // heldCardForScheduledService → none
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r).toEqual({ charged: false, reason: 'no_hold' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
  });

  it('no-ops without a service record', async () => {
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: null });
    expect(r).toEqual({ charged: false, reason: 'no_service_record' });
  });

  it('mints the completion invoice and charges the held card, OMITTING taxRate so create() auto-computes (commercial+business)', async () => {
    // queue: held(recap) → scheduled_service(prepaid check) → invoice-by-SR(none)
    // → invoice-by-SS(none) → held(charge) → invoice → pm row
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: null }, null, null, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    const arg = mockCreateFromService.mock.calls[0][1];
    expect(arg.useScheduledReplay).toBe(true);
    expect(arg.taxRate).toBeUndefined(); // let create() compute county-aware tax (handles 'business')
    expect(r).toEqual({ charged: true });
  });

  it('reuses an existing invoice (by service_record_id) instead of minting a duplicate', async () => {
    // held → scheduled_service(prepaid check) → invoice-by-SR FOUND → held(charge) → invoice → pm
    stubDb([HELD, { prepaid_amount: null }, { id: 'inv_recap' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(r).toEqual({ charged: true });
  });

  it('reuses a pre-mint invoice linked only by scheduled_service_id (back-links it)', async () => {
    // held → scheduled_service(prepaid check) → invoice-by-SR(none) → invoice-by-SS FOUND → held → invoice → pm
    stubDb([HELD, { prepaid_amount: null }, null, { id: 'inv_premint', service_record_id: null }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
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
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: null }, null, null]);
    mockCreateFromService.mockRejectedValueOnce(new Error('createFromService boom'));
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r.reason).toBe('invoice_create_failed');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('alerts the office when the card charge fails (stranded draft, no pay-link UI)', async () => {
    stubDb([HELD, { service_type: 'Pest Control', prepaid_amount: null }, null, null, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
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
    expect(mockSendReceiptEmail).toHaveBeenCalledWith('inv1', expect.objectContaining({ idempotencyKey: 'no_show_fee_receipt:inv1' }));
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
});
