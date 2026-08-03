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

const mockNotifyAdmin = jest.fn(async () => ({ id: 'notif-1' }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...a) => mockNotifyAdmin(...a),
}));

let mockOffers = [];
let mockInsertResult = [{ id: 'offer-new', amount: '75.00', expires_at: new Date() }];
let mockClaimResult = 1;
let mockBookings = [];
let mockAlternates = [];
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
    const t = String(table || '');
    const isAlternateProbe = t.includes('inspection_credit_booking_events');
    const isBookings = t.includes('scheduled_services') && !isAlternateProbe;
    const rows = isAlternateProbe ? mockAlternates : (isBookings ? mockBookings : mockOffers);
    chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    chain.first = jest.fn(async () => rows[0] || null);
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
  // Savepoint support: a nested transaction on the same handle.
  db.transaction.bind = db.transaction.bind;
  return db;
});

const {
  recordInspectionCreditOffer,
  markBookingForInspectionCredit,
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
  // Default: the booking being redeemed against exists and is live. The
  // service reads its authoritative created_at/status rather than
  // trusting the caller.
  mockBookings = [{ id: 'svc-2', created_at: new Date('2026-08-10'), status: 'confirmed' }];
  mockAlternates = [];
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
    // The deadline is the END of the ET day 30 days out — the receipt
    // prints a calendar date, so that whole day must remain bookable.
    // Asserted on the ET DATE (en-CA is ISO and stable across ICU builds),
    // never on a formatted clock string: the bug this pins was masked
    // locally because en-US renders midnight as "00:00" here and "24:00"
    // on CI.
    const etDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // The last bookable second is still the named day...
    expect(etDay(new Date(res.expiresAt.getTime() - 1000))).toBe('2026-09-02');
    // ...and the expiry instant itself has rolled over to the next.
    expect(etDay(res.expiresAt)).toBe('2026-09-03');
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
    // 'rescheduled' deliberately absent: the customer reschedule endpoint
    // stamps it while the visit simply MOVES — they are still booked.
    for (const status of ['cancelled', 'no_show', 'skipped']) {
      mockBookings = [{ id: 'svc-2', created_at: new Date('2026-08-10'), status }];
      const res = await redeemInspectionCreditForBooking({
        customerId: 'cust-1', scheduledServiceId: 'svc-2',
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

  it('credits an open offer ONLY when a proven booking event exists in its window', async () => {
    // Deliberately NOT "any later scheduled_services row": seeders, bulk
    // rebooks and imports create rows nobody booked, and prod data shows
    // no provenance column separates them. The booking EVENT is the proof.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), source_scheduled_service_id: 'svc-insp',
      expires_at: new Date('2099-01-01'),
    }];
    mockAlternates = [{ id: 'svc-booked', created_at: new Date('2026-08-05') }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.redeemed).toBe(1);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);

    // With NO booking event the same offer earns nothing.
    jest.clearAllMocks();
    mockAlternates = [];
    const none = await sweepInspectionCreditRedemptions();
    expect(none.redeemed).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });
});

describe('reverseInspectionCreditForBooking — a cancelled booking gives it back', () => {
  it('still reverses while the gate is dark — minted money must come back', async () => {
    // Turning the gate off stops new promises; it must NOT strand credit
    // already in a customer's balance for a booking they cancelled.
    mockGateOn = false;
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 1 });
    expect(mockPostCreditMovement).toHaveBeenCalledWith(
      expect.objectContaining({ delta: -75 }), expect.anything(),
    );
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
    // Reopened so a real booking can still earn it, the mint binding
    // cleared so it can mint again, and the alert marker cleared so the
    // reopened offer gets a fresh alert cycle (a stale marker from an
    // earlier failed attempt would suppress a future spent-credit alert).
    expect(mockUpdates[0]).toMatchObject({
      status: 'offered', credit_ledger_id: null, redeemed_at: null, reversal_alerted_at: null,
    });
  });

  it('rebinds instead of reversing when another live booking still stands in the window', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    // A PROVEN booking (another offer's marker points at a live visit),
    // not merely any live scheduled_services row.
    mockAlternates = [{ id: 'svc-other' }];
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

  it('spent credit raises the office alert atomically with the marker claim', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    // The credit was already spent: the ledger refuses to go negative.
    mockPostCreditMovement.mockRejectedValueOnce(new Error('insufficient balance'));
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, , , opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(opts.metadata).toMatchObject({ offerId: 'offer-1', reason: 'credit_already_spent' });
    // The insert rides the SAME transaction as the marker claim, so a
    // crash between the two can't split them.
    expect(opts.connection).toBeDefined();
    // The claim itself: marker stamped, guarded on being unset.
    expect(mockUpdates.some((p) => p.reversal_alerted_at instanceof Date)).toBe(true);
  });

  it('a swallowed notification failure releases the marker claim for the next sweep', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    mockPostCreditMovement.mockRejectedValueOnce(new Error('insufficient balance'));
    // notifyAdmin returns null instead of throwing when its insert fails.
    mockNotifyAdmin.mockResolvedValueOnce(null);
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    // The claim is thrown back (transaction rollback) and logged for retry
    // — never marked as alerted when nothing landed.
    const logger = require('../services/logger');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('will retry next sweep'));
  });
});

describe('kill-switch posture — what must keep working while dark', () => {
  it('records booking EVIDENCE while dark, so a later gate-on can honor it', async () => {
    mockGateOn = false;
    const db = require('../models/db');
    const n = await markBookingForInspectionCredit(db, {
      customerId: 'cust-1', scheduledServiceId: 'svc-2', source: 'self_book',
    });
    // The event is a fact, not money — skipping it while dark would make an
    // offer promised beforehand unprovable and silently expire it.
    expect(n).toBe(1);
  });

  it('sweeps REVERSALS while dark but credits nothing', async () => {
    mockGateOn = false;
    const res = await sweepInspectionCreditRedemptions();
    // Crediting is paused...
    expect(res.redeemed).toBe(0);
    expect(res.reason).toBe('feature_disabled');
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    // ...but the reversal half still ran (a cancelled booking's credit must
    // not stay spendable through a kill-switch period).
    expect(res).toHaveProperty('reversed');
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
