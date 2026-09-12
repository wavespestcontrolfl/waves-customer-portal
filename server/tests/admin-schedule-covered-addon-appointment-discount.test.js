/**
 * Covered-member add-on stamp must carry the appointment-level discount
 * (Codex #4405 r1 P1, correctly re-anchored to server/routes/admin-schedule.js
 * and server/services/discount-stack.js — the Codex finding named
 * client/src/components/schedule/CreateAppointmentModal.jsx:648, but every
 * identifier it cites (buildAppointmentPricing, addonOnlyTotal,
 * memberSeriesCovered) lives here).
 *
 * Repro: a monthly-billed member books a recurring visit with a billable
 * add-on and an appointment-level discount scoped to that add-on (the new
 * "Applies to" line GATE_DISCOUNT_STACKING adds). buildAppointmentPricing
 * resolves the discount correctly, but the add-on's own `net`
 * (stackVisitDiscounts' per-line field) never carried the appointment-level
 * dollars — those land on the visit TOTAL, not any one line — so
 * addonOnlyTotal(pricing.addonLines), the total a covered member's series
 * stamps (the base is dropped; dues cover it), summed the pre-discount
 * price. Real money: a member was charged the undiscounted add-on.
 *
 * Fix: stackVisitDiscounts now also returns each line's pro-rata SHARE of
 * the appointment discount (`appointmentDiscountDollars`, additive —
 * `lineDiscountDollars`/`net`/`subtotal`/the scalar/`total` are all
 * unchanged); buildAppointmentPricing stashes it on each add-on line
 * alongside `price`; addonOnlyTotal nets it out before summing.
 */
process.env.GATE_DISCOUNT_STACKING = 'true';

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
const { buildAppointmentPricing, addonOnlyTotal } = require('../routes/admin-schedule')._test;

function rowQuery(row) {
  return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) };
}

const ADDON_SERVICE = { service_key: 'mosquito_addon', category: 'mosquito', base_price: 50 };

beforeEach(() => {
  jest.clearAllMocks();
  DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);
});

describe('the exact reported scenario: a FIXED appointment discount scoped to the add-on', () => {
  test('the add-on-only total (what a covered member is billed) nets out the appointment discount, not just the add-on price', async () => {
    const discount = { id: 'promo-fixed', name: '$20 add-on credit', discount_type: 'fixed_amount', amount: 20 };
    db.mockReturnValueOnce(rowQuery(ADDON_SERVICE)); // addon service lookup
    db.mockReturnValueOnce(rowQuery(discount)); // appointment-level discount

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 100 },
      primaryLinePrice: 100,
      serviceAddons: [{ serviceId: 'addon-1', name: 'Mosquito add-on', price: 50 }],
      discountId: discount.id,
      discountType: discount.discount_type,
      // The new "Applies to" line, scoped to the add-on and NOT the plan.
      discountServiceKeyFilter: 'mosquito_addon',
      customer: { id: 'customer-1' },
    });

    expect(pricing.addonLines).toHaveLength(1);
    // The add-on's OWN net is unaffected — it never had its own line
    // discount, so price stays the full $50 (this is the field the bug
    // read directly, and it is correctly unchanged: the appointment
    // discount was never supposed to live in `price` itself).
    expect(pricing.addonLines[0].price).toBe(50);
    // But its pro-rata share of the appointment discount is now surfaced.
    expect(pricing.addonLines[0].appointmentDiscountDollars).toBe(20);
    // The primary line was NOT in scope — it carries no share.
    expect(pricing.primaryDiscount).toBeNull();

    // This is what memberSeriesCovered actually stamps and bills.
    expect(addonOnlyTotal(pricing.addonLines)).toBe(30);
    // Sanity: the OLD (buggy) computation — summing raw `price` with no
    // netting — is exactly the reported $50 overcharge.
    const buggyTotal = pricing.addonLines.reduce((sum, a) => sum + (a.price || 0), 0);
    expect(buggyTotal).toBe(50);
  });
});

describe('a PERCENTAGE appointment discount scoped to the add-on', () => {
  test('the add-on-only total nets out the percentage share too', async () => {
    const discount = { id: 'promo-pct', name: '20% add-on discount', discount_type: 'percentage', amount: 20 };
    db.mockReturnValueOnce(rowQuery(ADDON_SERVICE));
    db.mockReturnValueOnce(rowQuery(discount));

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 100 },
      primaryLinePrice: 100,
      serviceAddons: [{ serviceId: 'addon-1', name: 'Mosquito add-on', price: 50 }],
      discountId: discount.id,
      discountType: discount.discount_type,
      discountServiceKeyFilter: 'mosquito_addon',
      customer: { id: 'customer-1' },
    });

    expect(pricing.addonLines[0].price).toBe(50);
    expect(pricing.addonLines[0].appointmentDiscountDollars).toBe(10); // 20% of $50
    expect(addonOnlyTotal(pricing.addonLines)).toBe(40);
  });
});

describe('an UNSCOPED appointment discount spread pro rata over the primary AND the add-on', () => {
  test('only the add-on share is netted from the add-on-only stamp — the primary share is irrelevant to it (the base is dropped for a covered member either way)', async () => {
    const discount = { id: 'promo-visit', name: '$30 visit credit', discount_type: 'fixed_amount', amount: 30 };
    db.mockReturnValueOnce(rowQuery(ADDON_SERVICE));
    db.mockReturnValueOnce(rowQuery(discount));

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'pest_general_quarterly', category: 'pest_control', base_price: 100 },
      primaryLinePrice: 100,
      serviceAddons: [{ serviceId: 'addon-1', name: 'Mosquito add-on', price: 50 }],
      discountId: discount.id,
      discountType: discount.discount_type,
      // No discountServiceKeyFilter: the $30 spreads pro rata over BOTH
      // eligible lines ($100 + $50 = $150 pool → $20 off primary, $10 off
      // the add-on).
      customer: { id: 'customer-1' },
    });

    expect(pricing.addonLines[0].appointmentDiscountDollars).toBe(10);
    expect(addonOnlyTotal(pricing.addonLines)).toBe(40);
  });
});

describe('addonOnlyTotal — allocation arithmetic', () => {
  test('sums (price − appointmentDiscountDollars) per line, clamped at 0, with no rounding drift across several lines', () => {
    const lines = [
      { price: 33.34, appointmentDiscountDollars: 10.91 },
      { price: 10, appointmentDiscountDollars: 1.41 },
      { price: 5, appointmentDiscountDollars: 0 },
    ];
    const rawSum = lines.reduce((sum, l) => sum + Math.max(0, Math.round((l.price - l.appointmentDiscountDollars) * 100) / 100), 0);
    // The function re-rounds the final sum (binary float summation of
    // already-cents-rounded numbers can land a hair off a clean value).
    expect(addonOnlyTotal(lines)).toBe(Math.round(rawSum * 100) / 100);
    expect(addonOnlyTotal(lines)).toBe(36.02);
  });

  test('never goes negative for a single line even if a share somehow exceeded the price', () => {
    expect(addonOnlyTotal([{ price: 10, appointmentDiscountDollars: 25 }])).toBe(0);
  });

  test('a line with no appointmentDiscountDollars field at all (legacy shape) is treated as a zero share', () => {
    expect(addonOnlyTotal([{ price: 20 }])).toBe(20);
  });

  test('a zero-or-negative price line contributes nothing, discount share or not', () => {
    expect(addonOnlyTotal([{ price: 0, appointmentDiscountDollars: 0 }, { price: -5, appointmentDiscountDollars: 0 }])).toBe(0);
  });

  test('empty/missing input is 0', () => {
    expect(addonOnlyTotal([])).toBe(0);
    expect(addonOnlyTotal(null)).toBe(0);
    expect(addonOnlyTotal(undefined)).toBe(0);
  });
});
