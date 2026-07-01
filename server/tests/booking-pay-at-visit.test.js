/**
 * Booking "pay per application" — LINKED-estimate price resolution.
 *
 * Money-path contract:
 *  - AMOUNT = estimate-level NET recurring annual (annual_total, else
 *    monthly_total×12) ÷ the BOOKING'S cadence — and only when the estimate's
 *    cadence equals the booking series cadence (else fail closed, so a monthly
 *    quote isn't billed onto a quarterly series, and non-pest/no-series bookings
 *    stay price-less);
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
  recurringServicesFromEstimateData: (data = {}) => (
    Array.isArray(data.services) ? data.services
      : Array.isArray(data.engineResult?.lineItems) ? data.engineResult.lineItems
        : Array.isArray(data.result?.recurring?.services) ? data.result.recurring.services
          : []
  ),
}));

const { derivePerApplicationAmount, resolveBookingVisitPrice } = require('../services/booking-pay-at-visit');

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
      .toEqual({ amount: 96.99, sourceEstimateId: 'e1', serviceKey: 'pest_control' });
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

// The quote→book handoff mint gate (public-quote.js) calls
// resolveBookingVisitPrice({ estimate: {estimate_data, annual_total,
// monthly_total}, serviceKey: 'pest_control', bookingVisits: 4 }) over the
// wizard-mirror shape it just stored, and mints a token only when that prices —
// so a token is never minted for a shape /booking/confirm can't price. These
// pin that predicate over the STORED wizard shape (services is an OBJECT in the
// wizard payload, so engineResult.lineItems is the only recurring source).
describe('quote→book handoff mint gate — wizard-mirror shape priceability', () => {
  const wizardEst = (lineItems, annual, monthly = null) => ({
    annual_total: annual,
    monthly_total: monthly,
    estimate_data: { services: { pest: true }, engineResult: { lineItems } },
  });
  const mintGate = (estimate) => !!resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control', bookingVisits: 4 });

  test('single quarterly pest line (stored frequency:4) → mints', () => {
    expect(mintGate(wizardEst([{ service: 'pest_control', monthly: 32.33, perApp: 96.99, frequency: 4 }], 387.96))).toBe(true);
  });

  test('lawn-only quote → NO token (confirm only prices quarterly pest)', () => {
    expect(mintGate(wizardEst([{ service: 'lawn_care', monthly: 40, perApp: 120, frequency: 4 }], 480))).toBe(false);
  });

  test('pest+lawn (two priced recurring lines) → NO token (ambiguous total)', () => {
    expect(mintGate(wizardEst([
      { service: 'pest_control', monthly: 32.33, perApp: 96.99, frequency: 4 },
      { service: 'lawn_care', monthly: 40, perApp: 120, frequency: 4 },
    ], 867.96))).toBe(false);
  });

  test('monthly pest quote → NO token (cadence ≠ the quarterly series confirm seeds)', () => {
    expect(mintGate(wizardEst([{ service: 'pest_control', monthly: 32.33, perApp: 32.33, frequency: 12 }], 387.96))).toBe(false);
  });
});
