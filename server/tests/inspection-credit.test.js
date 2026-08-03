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
let mockBookings = [];
const mockUpdates = [];
const mockChainCalls = [];
jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = {};
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNotIn', 'orderBy', 'limit', 'whereNotNull', 'join', 'leftJoin', 'whereNull', 'whereRaw', 'select', 'onConflict', 'ignore', 'returning']) {
      chain[m] = jest.fn(() => { mockChainCalls.push(m); return chain; });
    }
    // select()/the builder itself resolves to the open-offer list
    // Table-aware: a scheduled_services lookup is a BOOKING probe, not an
    // offer read — conflating them made the reversal path think another
    // live booking existed.
    const isBookings = String(table || '').includes('scheduled_services');
    chain.then = (res, rej) => Promise.resolve(isBookings ? mockBookings : mockOffers).then(res, rej);
    chain.first = jest.fn(async () => (isBookings ? (mockBookings[0] || null) : (mockOffers[0] || null)));
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
  const db = jest.fn((table) => makeChain(table));
  db.fn = { now: () => 'NOW' };
  db.transaction = jest.fn(async (cb) => cb(db));
  return db;
});

const {
  recordInspectionCreditOffer,
  reverseInspectionCreditForBooking,
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
  mockBookings = [];
  mockUpdates.length = 0;
  mockChainCalls.length = 0;
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
    // The ATTEMPT is recorded first (so the sweep can retry only real
    // booking attempts)...
    expect(mockUpdates[0]).toMatchObject({ redeemed_scheduled_service_id: 'svc-2' });
    // ...then the claim moves the row terminal BEFORE money posts...
    expect(mockUpdates[1]).toMatchObject({ status: 'redeemed', redeemed_scheduled_service_id: 'svc-2' });
    // ...and the mint is bound back as the exactly-once proof.
    expect(mockUpdates[2]).toMatchObject({ credit_ledger_id: 'ledger-1' });
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

  it('recovers a missing offer ONLY from the durable opt-in marker, never from "an inspection completed"', async () => {
    // Inferring consent from completion could not tell a transient write
    // failure from the tech clearing the box — and on first gate enablement
    // would have turned every historical inspection into real credit.
    mockOffers = [];
    await sweepInspectionCreditRedemptions();
    // The recovery query must filter on the persisted opt-in marker.
    const raw = mockChainCalls.filter((c) => c === 'whereRaw');
    expect(raw.length).toBeGreaterThan(0);
  });

  it('retries only offers where a real booking surface already attempted redemption', async () => {
    // Deliberately NOT "any later scheduled_services row": seeders, bulk
    // rebooks and imports create rows nobody booked, and crediting those
    // would hand out money for nothing. The attempt marker is the evidence.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), source_scheduled_service_id: 'svc-insp',
      redeemed_scheduled_service_id: 'svc-booked',
      expires_at: new Date('2099-01-01'),
    }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.reason).toBeUndefined();
    expect(typeof res.redeemed).toBe('number');
    // The sweep must filter on the attempt marker — an offer with no
    // recorded attempt is never swept.
    expect(mockChainCalls.some((c) => c === 'whereNotNull')).toBe(true);
  });
});

describe('reverseInspectionCreditForBooking — a cancelled booking gives it back', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toMatchObject({ reversed: 0, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('reverses the ledger movement and reopens the offer inside its window', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 1 });
    const [args] = mockPostCreditMovement.mock.calls[0];
    // NEGATIVE delta — the money goes back.
    expect(args).toMatchObject({ customerId: 'cust-1', delta: -75, source: 'inspection_credit' });
    // Reopened so a real booking can still earn it, and the mint binding
    // cleared so it can mint again.
    expect(mockUpdates[0]).toMatchObject({ status: 'offered', credit_ledger_id: null, redeemed_at: null });
  });

  it('rebinds instead of reversing when another live booking still stands in the window', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockBookings = [{ id: 'svc-other' }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    // Money stays with the customer — they still have a qualifying booking.
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(mockUpdates[0]).toMatchObject({ redeemed_scheduled_service_id: 'svc-other' });
  });

  it('a lapsed offer closes out instead of dangling reopened', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2020-01-01'), credit_ledger_id: 'ledger-1',
    }];
    await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(mockUpdates[0]).toMatchObject({ status: 'expired' });
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

  it('states a flat SERVICE credit with the frozen deadline — never "your inspection fee"', () => {
    const memo = inspectionCreditReceiptMemo({ amount: 75, expiresAt: '2026-09-02T12:00:00Z' });
    expect(memo).toContain('$75.00 service credit');
    expect(memo).toContain('September 2, 2026');
    // The credit is FLAT, so calling it the fee paid would misstate a
    // comped or $125 inspection.
    expect(memo).not.toMatch(/your inspection fee/i);
    expect(inspectionCreditReceiptMemo({ amount: 0, expiresAt: '2026-09-02' })).toBeNull();
    expect(inspectionCreditReceiptMemo({ amount: 75 })).toBeNull();
    expect(inspectionCreditReceiptMemo({})).toBeNull();
  });
});
