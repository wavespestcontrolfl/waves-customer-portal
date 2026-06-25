// One-time card-on-file hold service. Mirrors the estimate-deposits test
// harness: db + stripe + logger mocked, the pure decision logic exercised
// directly, and the trust-boundary verify path checked against Stripe.

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Completion-invoice factory (lazy-required by chargeCardHoldForRecapCompletion).
const mockCreateFromService = jest.fn(async () => ({ id: 'inv_recap', token: 'tokr' }));
jest.mock('../services/invoice', () => ({ createFromService: (...a) => mockCreateFromService(...a) }));
const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));

const mockRetrieveSetupIntent = jest.fn();
const mockCreateSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
const mockChargeInvoiceWithSavedCard = jest.fn();
const mockChargeOffSession = jest.fn();
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
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
    chain.first = jest.fn(() => Promise.resolve(queue.length ? queue.shift() : null));
    chain.update = jest.fn(() => Promise.resolve(1));
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

  it('mints the completion invoice (residential → no tax) and charges the held card', async () => {
    // queue: held(recap) → invoice-by-SR(none) → invoice-by-SS(none) →
    // scheduled_service → customer(property_type) → held(charge) → invoice → pm row
    stubDb([HELD, null, null, { service_type: 'Pest Control', prepaid_amount: null, customer_id: 'cust1' }, { property_type: 'residential' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockCreateFromService).toHaveBeenCalledWith('sr1', expect.objectContaining({ taxRate: 0, useScheduledReplay: true }));
    expect(r).toEqual({ charged: true });
  });

  it('reads property_type from CUSTOMERS (commercial → 7% tax), not scheduled_services', async () => {
    stubDb([HELD, null, null, { service_type: 'Pest Control', prepaid_amount: null, customer_id: 'cust1' }, { property_type: 'commercial' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockCreateFromService).toHaveBeenCalledWith('sr1', expect.objectContaining({ taxRate: 0.07 }));
  });

  it('reuses an existing invoice (by service_record_id) instead of minting a duplicate', async () => {
    // held(recap) → invoice-by-SR FOUND → held(charge) → invoice → pm row
    stubDb([HELD, { id: 'inv_recap' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(r).toEqual({ charged: true });
  });

  it('reuses a pre-mint invoice linked only by scheduled_service_id (back-links it)', async () => {
    // held → invoice-by-SR(none) → invoice-by-SS FOUND (no SR link) → held(charge) → invoice → pm
    stubDb([HELD, null, { id: 'inv_premint', service_record_id: null }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockResolvedValueOnce({ paymentIntentId: 'pi_c', amount: 49 });
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(r).toEqual({ charged: true });
  });

  it('bails (no double-charge) + alerts when the visit was prepaid in the field', async () => {
    // held → invoice-by-SR(none) → invoice-by-SS(none) → scheduled_service(prepaid)
    stubDb([HELD, null, null, { service_type: 'Pest Control', prepaid_amount: 75, customer_id: 'cust1' }]);
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r).toEqual({ charged: false, reason: 'prepaid_visit_manual' });
    expect(mockCreateFromService).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('alerts the office when the card charge fails (stranded draft, no pay-link UI)', async () => {
    stubDb([HELD, null, null, { service_type: 'Pest Control', prepaid_amount: null, customer_id: 'cust1' }, { property_type: 'residential' }, HELD, COLLECTIBLE_INVOICE, { id: 'pmrow1' }]);
    mockChargeInvoiceWithSavedCard.mockRejectedValueOnce(Object.assign(new Error('card_declined'), { type: 'StripeCardError', payment_intent: { id: 'pi_x' } }));
    const r = await chargeCardHoldForRecapCompletion({ scheduledServiceId: 'ss1', serviceRecordId: 'sr1' });
    expect(r.reason).toBe('charge_failed');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });
});
