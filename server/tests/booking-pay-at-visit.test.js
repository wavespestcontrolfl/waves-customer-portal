/**
 * Booking "pay per application" — LINKED-estimate price resolution.
 *
 * Money-path contract:
 *  - AMOUNT = estimate-level NET recurring annual (annual_total, else
 *    monthly_total×12) ÷ the BOOKING'S cadence — and only when the estimate's
 *    cadence equals the booking series cadence (else fail closed, so a monthly
 *    quote isn't billed onto a quarterly series, and non-pest/no-series bookings
 *    stay price-less);
 *  - ANCHORED to the annual: follow-ups bill the floored quotient, the first
 *    visit absorbs the remainder cents, so first + (visits−1)×followUp equals
 *    the quoted annual to the cent (no per-visit-rounding drift);
 *  - service binding via serviceKeyFor; fail closed on any supplemental
 *    recurring program (rodent/palm) in EITHER recurring container;
 *  - all estimate shapes read via the converter's extractor.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/recurring-appointment-seeder', () => ({
  serviceKeyFor: (v) => v?.service || v?.service_type || null,
  normalizeRecurringPattern: (v) => {
    const s = String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (s === 'quarterly') return 'quarterly';
    if (s === 'monthly') return 'monthly';
    if (s === 'bimonthly') return 'bimonthly';
    return null;
  },
}));
jest.mock('../services/estimate-converter', () => ({
  // Real-enough mirror of the fee-mix rule (solo pest / solo mosquito only)
  // so estimate-public's breakdown/fee gates work under this module mock.
  recurringMixHasMembershipFeeService: (services = []) => {
    const keys = Array.from(new Set((Array.isArray(services) ? services : [])
      .map((s) => s && s.service).filter(Boolean)));
    return keys.length === 1 && ['pest_control', 'mosquito'].includes(keys[0]);
  },
  // Real-enough mirrors of the per-estimate stamps the fee/clamp gates read
  // (operator setup-fee waiver + acknowledged floor breach, #2947).
  estimateOperatorSetupFeeWaived: (estData = {}) => (
    estData?.operatorPriceAdjustment?.waiveSetupFee === true
  ),
  estimateManualDiscountFloorBreachAcknowledged: (estData = {}) => (
    (estData?.result?.pricingMetadata?.manualDiscountFloorBreach
      ?? estData?.engineResult?.pricingMetadata?.manualDiscountFloorBreach)?.acknowledged === true
    || (estData?.result?.manualDiscount ?? estData?.result?.summary?.manualDiscount
      ?? estData?.summary?.manualDiscount)?.floorBreach?.acknowledged === true
  ),
  recurringServicesFromEstimateData: (data = {}) => (
    Array.isArray(data.services) ? data.services
      : Array.isArray(data.engineResult?.lineItems) ? data.engineResult.lineItems
        : Array.isArray(data.result?.recurring?.services) ? data.result.recurring.services
          : []
  ),
}));

const { derivePerApplicationAmount, resolveBookingVisitPrice, wizardDraftSelfServeBookable } = require('../services/booking-pay-at-visit');

const Q = 4; // quarterly visits/yr
const est = (annual_total, services, extra = {}) => ({ annual_total, estimate_data: { services }, ...extra });
const pest = (o = {}) => ({ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4, ...o });

describe('derivePerApplicationAmount — estimate-level net ÷ booking cadence', () => {
  test('annual_total ÷ visits at matching cadence, cents preserved', () => {
    expect(derivePerApplicationAmount(est(387.96, [pest()]), Q)).toBe(96.99);
  });

  test('honors an ESTIMATE-LEVEL discount (ignores pre-discount line mo)', () => {
    expect(derivePerApplicationAmount(est(288, [{ mo: 30, perApp: 90, visitsPerYear: 4 }]), Q)).toBe(72);
  });

  test('falls back to monthly_total × 12 when annual_total absent', () => {
    expect(derivePerApplicationAmount({ monthly_total: 25.25, estimate_data: { services: [pest({ perApp: 99 })] } }, Q)).toBe(75.75);
  });

  test('mapped aliases (mo/perTreatment, monthlyTotal/perVisit/pa) + string cadence', () => {
    expect(derivePerApplicationAmount(est(387.96, [{ mo: 32.33, perTreatment: 96.99, frequency: 'quarterly' }]), Q)).toBe(96.99);
    expect(derivePerApplicationAmount(est(387.96, [{ monthlyTotal: 32.33, perVisit: 96.99, visitsPerYear: 4 }]), Q)).toBe(96.99);
    expect(derivePerApplicationAmount(est(387.96, [{ monthly_total: 32.33, pa: 96.99, visitsPerYear: 4 }]), Q)).toBe(96.99);
  });

  test('CADENCE MISMATCH → null (monthly quote, quarterly booking)', () => {
    expect(derivePerApplicationAmount(est(387.96, [pest({ visitsPerYear: 12 })]), Q)).toBeNull();
  });

  test('no booking cadence → null (fail closed — non-pest / no series seeded)', () => {
    expect(derivePerApplicationAmount(est(387.96, [pest()]))).toBeNull();
    expect(derivePerApplicationAmount(est(387.96, [pest()]), 0)).toBeNull();
  });

  test('ambiguity / no-perApp / no-cadence / no-total / empty → null', () => {
    expect(derivePerApplicationAmount(est(600, [pest(), pest({ perApp: 60 })]), Q)).toBeNull();
    expect(derivePerApplicationAmount(est(360, [{ monthly: 30, visitsPerYear: 4 }]), Q)).toBeNull();
    expect(derivePerApplicationAmount(est(360, [{ monthly: 30, perApp: 90 }]), Q)).toBeNull();
    expect(derivePerApplicationAmount({ estimate_data: { services: [pest()] } }, Q)).toBeNull();
    expect(derivePerApplicationAmount({ estimate_data: { services: [] } }, Q)).toBeNull();
    expect(derivePerApplicationAmount({}, Q)).toBeNull();
  });
});

describe('resolveBookingVisitPrice — linked estimate (shapes, service + cadence)', () => {
  test('engineResult shape, service + cadence match', () => {
    const estimate = { id: 'e1', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control', bookingVisits: Q }))
      .toEqual({ amount: 96.99, followUpAmount: 96.99, sourceEstimateId: 'e1', serviceKey: 'pest_control' });
  });

  test('ANCHOR: non-divisible annual — first visit absorbs the remainder, series sums to the cent', () => {
    const estimate = { id: 'e8', annual_total: 387.97, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 97, visitsPerYear: 4 }] } } };
    const priced = resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control', bookingVisits: Q });
    expect(priced.amount).toBe(97.00);
    expect(priced.followUpAmount).toBe(96.99);
    const totalCents = Math.round(priced.amount * 100) + (Q - 1) * Math.round(priced.followUpAmount * 100);
    expect(totalCents).toBe(38797);
  });

  test('ANCHOR: the old rounded-quotient drift case (500.02/4) no longer overbills', () => {
    // round(500.02/4) = 125.01 → ×4 = 500.04, 2¢ over the quote. Anchored:
    // 125.02 + 3×125.00 = 500.02 exactly.
    const estimate = { id: 'e9', annual_total: 500.02, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 41.67, perApp: 125, visitsPerYear: 4 }] } } };
    const priced = resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control', bookingVisits: Q });
    expect(priced.amount).toBe(125.02);
    expect(priced.followUpAmount).toBe(125.00);
  });

  test('V2 result.recurring.services with an estimate-level discount', () => {
    const estimate = { id: 'e2', annual_total: 288, estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', mo: 40, perTreatment: 120, visitsPerYear: 4 }] } } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'lawn_care', bookingVisits: Q }).amount).toBe(72);
  });

  test('cadence MISMATCH on linked estimate → null', () => {
    const estimate = { id: 'e3', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 12 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
  });

  test('no booking cadence (non-pest / no series) → null', () => {
    const estimate = { id: 'e4', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control' })).toBeNull();
  });

  test('service MISMATCH / missing serviceKey / no estimate → null', () => {
    const estimate = { id: 'e5', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'lawn_care', bookingVisits: Q })).toBeNull();
    expect(resolveBookingVisitPrice({ estimate, bookingVisits: Q })).toBeNull();
    expect(resolveBookingVisitPrice({ serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
  });

  test('supplemental program in EITHER recurring container → null', () => {
    const rootOnly = { id: 'e6', annual_total: 500, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] }, recurring: { rodentBaitMo: 49 } } };
    const nestedOnly = { id: 'e7', annual_total: 500, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] }, recurring: {}, result: { recurring: { palmInjectionMo: 39 } } } };
    expect(resolveBookingVisitPrice({ estimate: rootOnly, serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
    expect(resolveBookingVisitPrice({ estimate: nestedOnly, serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
  });
});

// /booking/confirm's pricing branch calls resolveBookingVisitPrice({
// estimate: {estimate_data, annual_total, monthly_total}, serviceKey:
// 'pest_control', bookingVisits: 4 }) over the STORED wizard-mirror shape
// (services is an OBJECT in the wizard payload, so engineResult.lineItems is
// the only recurring source). The handoff token now mints for EVERY
// self-bookable shape (it doubles as the customers-only gate pass), so this
// predicate is what decides pay-at-visit STAMPING at confirm — an unpriceable
// shape carries a token, passes the gate, and books price-less. These pin
// that confirm-side predicate.
describe('confirm-side pricing predicate — wizard-mirror shape priceability', () => {
  const wizardEst = (lineItems, annual, monthly = null) => ({
    annual_total: annual,
    monthly_total: monthly,
    estimate_data: { services: { pest: true }, engineResult: { lineItems } },
  });
  const confirmPrices = (estimate) => !!resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control', bookingVisits: 4 });

  test('single quarterly pest line (stored frequency:4) → prices', () => {
    expect(confirmPrices(wizardEst([{ service: 'pest_control', monthly: 32.33, perApp: 96.99, frequency: 4 }], 387.96))).toBe(true);
  });

  test('lawn-only quote → books price-less (confirm only prices quarterly pest)', () => {
    expect(confirmPrices(wizardEst([{ service: 'lawn_care', monthly: 40, perApp: 120, frequency: 4 }], 480))).toBe(false);
  });

  test('pest+lawn (two priced recurring lines) → books price-less (ambiguous total)', () => {
    expect(confirmPrices(wizardEst([
      { service: 'pest_control', monthly: 32.33, perApp: 96.99, frequency: 4 },
      { service: 'lawn_care', monthly: 40, perApp: 120, frequency: 4 },
    ], 867.96))).toBe(false);
  });

  test('monthly pest quote → books price-less (cadence ≠ the quarterly series confirm seeds)', () => {
    expect(confirmPrices(wizardEst([{ service: 'pest_control', monthly: 32.33, perApp: 32.33, frequency: 12 }], 387.96))).toBe(false);
  });
});

// The wizard refreshes drafts in place, so /booking/confirm re-checks the
// stored row's CURRENT shape with this one predicate before honoring a
// handoff token — as the customers-only gate pass AND before pay-at-visit
// pricing. Row-shape mirror of public-quote's mint conditions.
describe('wizardDraftSelfServeBookable — current-shape re-check for stored handoff drafts', () => {
  const draft = (overrides = {}, data = {}) => ({
    id: 'pe-1', source: 'quote_wizard', status: 'draft', estimate_data: data, ...overrides,
  });

  test('live self-bookable wizard draft → eligible', () => {
    expect(wizardDraftSelfServeBookable(draft())).toBe(true);
    expect(wizardDraftSelfServeBookable(draft({}, {
      annual: 480,
      engineResult: { summary: { recurringAnnualAfterDiscount: 480, oneTimeTotal: 0 }, lineItems: [{ service: 'lawn_care', annual: 480 }] },
    }))).toBe(true);
  });

  test('missing row / wrong source / promoted status → not eligible', () => {
    expect(wizardDraftSelfServeBookable(null)).toBe(false);
    expect(wizardDraftSelfServeBookable(draft({ source: 'admin' }))).toBe(false);
    expect(wizardDraftSelfServeBookable(draft({ status: 'sent' }))).toBe(false);
    expect(wizardDraftSelfServeBookable(draft({ status: 'accepted' }))).toBe(false);
  });

  test('commercial / manual-review shapes → not eligible', () => {
    expect(wizardDraftSelfServeBookable(draft({}, { commercialEstimatedPricing: true }))).toBe(false);
    expect(wizardDraftSelfServeBookable(draft({}, { quoteRequired: true }))).toBe(false);
  });

  test('mixed recurring + one-time → not eligible (summary first, top-level fallback)', () => {
    expect(wizardDraftSelfServeBookable(draft({}, {
      engineResult: { summary: { recurringAnnualAfterDiscount: 388, oneTimeTotal: 150 } },
    }))).toBe(false);
    expect(wizardDraftSelfServeBookable(draft({}, { annual: 388, oneTimeTotal: 150 }))).toBe(false);
    // One-time-ONLY stays eligible (no recurring side of the mix).
    expect(wizardDraftSelfServeBookable(draft({}, { annual: 0, oneTimeTotal: 150 }))).toBe(true);
  });

  test('bed-bug line → not eligible (no right-sized bookable slot)', () => {
    expect(wizardDraftSelfServeBookable(draft({}, {
      engineResult: { lineItems: [{ service: 'bed_bug', price: 500 }] },
    }))).toBe(false);
  });
});
