/**
 * Inspection credit — money invariants.
 *
 * The promise is recorded at closeout and mints ONLY at redemption, so the
 * tests that matter are the ones proving money never appears from nothing:
 * no offer without a billable amount, no mint without a won claim, no
 * second mint, no redemption after expiry, and nothing at all while dark.
 */
let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => (g === 'inspectionCredit' ? mockGateOn : false),
  gates: {},
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockPostCreditMovement = jest.fn(async () => ({ balanceAfter: 75, entry: { id: 'ledger-1' } }));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: (...a) => mockPostCreditMovement(...a),
}));

let mockOffers = [];
let mockInsertResult = [{ id: 'offer-new', amount: '75.00', expires_at: new Date() }];
let mockClaimResult = 1;
const mockUpdates = [];
jest.mock('../models/db', () => {
  const makeChain = () => {
    const chain = {};
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNotIn', 'orderBy', 'limit', 'select', 'onConflict', 'ignore', 'returning']) {
      chain[m] = jest.fn(() => chain);
    }
    // select()/the builder itself resolves to the open-offer list
    chain.then = (res, rej) => Promise.resolve(mockOffers).then(res, rej);
    chain.first = jest.fn(async () => mockOffers[0] || null);
    chain.insert = jest.fn(() => {
      const ins = {};
      ins.onConflict = jest.fn(() => ins);
      ins.ignore = jest.fn(() => ins);
      ins.returning = jest.fn(async () => mockInsertResult);
      return ins;
    });
    chain.update = jest.fn(async (patch) => { mockUpdates.push(patch); return mockClaimResult; });
    return chain;
  };
  const db = jest.fn(() => makeChain());
  db.fn = { now: () => 'NOW' };
  db.transaction = jest.fn(async (cb) => cb(db));
  return db;
});

const {
  recordInspectionCreditOffer,
  sweepInspectionCreditRedemptions,
  redeemInspectionCreditForBooking,
  inspectionCreditReceiptMemo,
  creditWindowDaysForServiceKey,
  DEFAULT_CREDIT_WINDOW_DAYS,
} = require('../services/inspection-credit');

beforeEach(() => {
  jest.clearAllMocks();
  mockGateOn = true;
  mockOffers = [];
  mockInsertResult = [{ id: 'offer-new', amount: '75.00', expires_at: new Date() }];
  mockClaimResult = 1;
  mockUpdates.length = 0;
});

describe('recordInspectionCreditOffer — the promise, not the money', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res).toEqual({ recorded: false, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('credits the FLAT configured amount, not what the inspection was billed (owner ruling 2026-08-03)', async () => {
    // A comped or discounted inspection still earns the full credit — the
    // promise is "the inspection is worth $75 toward service", not a refund
    // of what was paid. No amount is passed: config decides.
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res.recorded).toBe(true);
    expect(res.amount).toBe(75);
  });

  it('freezes the amount and expiry, and mints NOTHING at closeout', async () => {
    const now = new Date('2026-08-03T12:00:00Z');
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1', now,
    });
    expect(res.recorded).toBe(true);
    expect(res.amount).toBe(75);
    expect(res.windowDays).toBe(DEFAULT_CREDIT_WINDOW_DAYS);
    // +30 days, frozen — not a live config read at redemption.
    expect(res.expiresAt.toISOString()).toBe('2026-09-02T12:00:00.000Z');
    // The whole point: no ledger movement happens at closeout.
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('a completion replay reports the EXISTING terms rather than re-promising', async () => {
    mockInsertResult = []; // unique conflict → ignored
    mockOffers = [{ id: 'offer-existing', amount: '75.00', expires_at: new Date('2026-09-01'), status: 'offered' }];
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe('already_offered');
    // The receipt must state what the customer was ACTUALLY promised.
    expect(res.amount).toBe(75);
  });

  it('never throws — a credit failure must not fail the completion', async () => {
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe('error');
  });
});

describe('redeemInspectionCreditForBooking — exactly-once minting', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('does not redeem against a cancelled/no-show booking', async () => {
    for (const status of ['cancelled', 'no_show', 'rescheduled']) {
      const res = await redeemInspectionCreditForBooking({
        customerId: 'cust-1', scheduledServiceId: 'svc-2', bookingStatus: status,
      });
      expect(res).toEqual({ redeemed: 0, reason: 'booking_not_live' });
    }
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('no open offer → nothing minted', async () => {
    mockOffers = [];
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, reason: 'no_open_offer' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('mints once, with the frozen amount and the inspection_credit source, and binds the ledger id', async () => {
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 1, amount: 75 });
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);
    const [args] = mockPostCreditMovement.mock.calls[0];
    expect(args).toMatchObject({ customerId: 'cust-1', delta: 75, source: 'inspection_credit' });
    // The claim moves the row terminal BEFORE money posts...
    expect(mockUpdates[0]).toMatchObject({ status: 'redeemed', redeemed_scheduled_service_id: 'svc-2' });
    // ...and the mint is bound back as the exactly-once proof.
    expect(mockUpdates[1]).toMatchObject({ credit_ledger_id: 'ledger-1' });
  });

  it('a lost claim race mints NOTHING (the other booking won)', async () => {
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    mockClaimResult = 0; // status-guarded update matched no row
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, amount: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('a failed mint leaves nothing double-counted and never throws', async () => {
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    mockPostCreditMovement.mockRejectedValueOnce(new Error('ledger down'));
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, amount: 0 });
  });
});

describe('sweepInspectionCreditRedemptions — the durable guarantee', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await sweepInspectionCreditRedemptions();
    expect(res).toMatchObject({ redeemed: 0, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('redeems an open offer whose customer booked through ANY surface, and never throws', async () => {
    // The sweep re-derives redemption from persisted state, so a booking
    // path that never called redeem still gets the credit.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), source_scheduled_service_id: 'svc-insp',
      expires_at: new Date('2099-01-01'),
    }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.reason).toBeUndefined();
    expect(typeof res.redeemed).toBe('number');
  });
});

describe('window + receipt copy', () => {
  it('honors the existing rodent precedent, defaults everything else', () => {
    // rodent_inspection carries creditable_within_days in pricing_config.
    expect(creditWindowDaysForServiceKey('rodent_inspection')).toBeGreaterThan(0);
    expect(creditWindowDaysForServiceKey('wdo_inspection')).toBe(DEFAULT_CREDIT_WINDOW_DAYS);
    expect(creditWindowDaysForServiceKey(null)).toBe(DEFAULT_CREDIT_WINDOW_DAYS);
  });

  it('validates the admin-editable credit like every other money config', () => {
    const { validatePricingConfigData } = require('../routes/admin-pricing-config');
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 30 }).ok).toBe(true);
    expect(validatePricingConfigData('inspection_credit', { amount: 750, creditableWithinDays: 30 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 0, creditableWithinDays: 30 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75.001, creditableWithinDays: 30 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 0 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 400 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 1.5 }).ok).toBe(false);
  });

  it('states the exact promise, and says nothing when there is nothing to promise', () => {
    expect(inspectionCreditReceiptMemo({ amount: 75, windowDays: 30 }))
      .toBe('Your $75.00 inspection fee is credited toward any service you book within 30 days.');
    expect(inspectionCreditReceiptMemo({ amount: 0, windowDays: 30 })).toBeNull();
    expect(inspectionCreditReceiptMemo({})).toBeNull();
  });
});
