/**
 * GATE_DISCOUNT_STACKING dark (the default): every surface computes exactly
 * as it did before the multi-discount lane, and the new request fields are
 * refused rather than silently dropped.
 *
 * This file deliberately does NOT set the gate env — the route and service
 * modules snapshot it at load, so requiring them here gives the dark build.
 */
delete process.env.GATE_DISCOUNT_STACKING;

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const { stackDiscounts, stackVisitDiscounts } = require('../services/discount-stack');
const { isEnabled } = require('../config/feature-gates');
const {
  buildAppointmentPricing,
  calculateVisitFinancialsForAddons,
} = require('../routes/admin-schedule')._test;

const SILVER = { id: 'silver', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false };
const GOLD = { id: 'gold', name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false };
const CREDIT = { id: 'credit', name: 'Referral Credit', discount_type: 'fixed_amount', amount: 30, is_stackable: true };

function discountQuery(discount) {
  return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(discount) };
}

beforeEach(() => jest.clearAllMocks());

describe('the gate itself', () => {
  test('ships dark — only the exact string "true" turns it on', () => {
    expect(isEnabled('discountStacking')).toBe(false);
  });
});

describe('legacy math (compound: false)', () => {
  test('every discount resolves against the full base, so two percentages are additive', () => {
    const result = stackDiscounts(111, [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'percentage', amount: 5 },
    ], { compound: false });
    expect(result.items.map((i) => i.dollars)).toEqual([11.1, 5.55]);
    expect(result.net).toBe(94.35);
  });

  test('a visit applies its line discounts first, then the appointment discount over the eligible nets', () => {
    const legacy = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: { discountType: 'percentage', amount: 10 }, eligible: true }],
      appointmentDiscount: { discountType: 'fixed_amount', amount: 30 },
      compound: false,
    });
    // $100 − 10% = $90, then the $30 credit → $60. (Compounded it is $63.)
    expect(legacy.lines[0]).toEqual({ lineDiscountDollars: 10, net: 90, appointmentDiscountDollars: 0 });
    expect(legacy.appointmentDiscountDollars).toBe(30);
    expect(legacy.total).toBe(60);

    const compounded = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: { discountType: 'percentage', amount: 10 }, eligible: true }],
      appointmentDiscount: { discountType: 'fixed_amount', amount: 30 },
    });
    expect(compounded.total).toBe(63);
  });

  test('a single discount is identical either way — the flip never moves a one-discount total', () => {
    for (const discount of [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'fixed_amount', amount: 25 },
      { discountType: 'free_service', amount: 0 },
      { discountType: 'percentage', amount: 50, maxDiscountDollars: 20 },
    ]) {
      expect(stackDiscounts(111, [discount], { compound: false }).net)
        .toBe(stackDiscounts(111, [discount]).net);
    }
  });
});

describe('the visit path while dark', () => {
  test('refuses a posted "Applies to" line scope instead of dropping it', async () => {
    await expect(buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 111 },
      primaryLinePrice: 111,
      serviceAddons: [],
      discountId: SILVER.id,
      discountType: SILVER.discount_type,
      discountServiceKeyFilter: 'pest_general_quarterly',
      customer: { id: 'customer-1' },
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/GATE_DISCOUNT_STACKING/),
    });
  });

  test('accepts two tier discounts on one visit, as it did before the lane', async () => {
    db.mockReturnValueOnce(discountQuery(SILVER));
    db.mockReturnValueOnce(discountQuery(GOLD));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 100 },
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: SILVER.id },
      serviceAddons: [],
      discountId: GOLD.id,
      discountType: GOLD.discount_type,
      customer: { id: 'customer-1', waveguard_tier: 'Gold' },
    });
    // Silver off the line, then Gold over the net — no refusal, no
    // fixed-first reordering.
    expect(pricing.primaryDiscount.discountDollars).toBe(10);
    expect(pricing.appointmentDiscount.discountDollars).toBe(13.5);
    expect(pricing.finalPrice).toBe(76.5);
  });

  test('a fixed appointment credit still lands after the line discount', async () => {
    db.mockReturnValueOnce(discountQuery(SILVER));
    db.mockReturnValueOnce(discountQuery(CREDIT));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 100 },
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: SILVER.id },
      serviceAddons: [],
      discountId: CREDIT.id,
      discountType: CREDIT.discount_type,
      customer: { id: 'customer-1' },
    });
    expect(pricing.primaryDiscount.discountDollars).toBe(10);
    expect(pricing.appointmentDiscount.discountDollars).toBe(30);
    expect(pricing.finalPrice).toBe(60);
  });

  test('calculateVisitFinancialsForAddons keeps the legacy order for stored line slots', () => {
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 90,
      primaryGross: 100,
      primaryLineDiscount: { discountType: 'percentage', discountAmount: 10 },
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, []);
    expect(financials.lines[0]).toEqual({ lineDiscountDollars: 10, net: 90, appointmentDiscountDollars: 0 });
    expect(financials.price).toBe(60);
  });
});

describe('the invoice path while dark', () => {
  // Re-require the invoice service under the dark gate; its module-level
  // `gates` snapshot is what stackLineItemDiscounts consults.
  const InvoiceService = require('../services/invoice');

  test('stackLineItemDiscounts reproduces the pre-lane math: each discount off the FULL line', () => {
    const { stackLineItemDiscounts } = InvoiceService._internals;
    const parent = { client_id: 'line-1', amount: 111 };
    const entries = [
      { item: { client_id: 'd1', discount_for: 'line-1' }, parent, row: { discount_type: 'percentage', amount: 10 } },
      { item: { client_id: 'd2', discount_for: 'line-1' }, parent, row: { discount_type: 'percentage', amount: 5 } },
    ];
    const dark = stackLineItemDiscounts(entries, false);
    expect([...dark.values()].map((v) => v.dollars)).toEqual([11.1, 5.55]);
    const lit = stackLineItemDiscounts(entries, true);
    expect([...lit.values()].map((v) => v.dollars)).toEqual([11.1, 5]);
  });
});
