/**
 * Booking "pay per application" price resolution (coverage + customer lookup).
 *
 * Money-path contract:
 *  - AMOUNT = estimate-level NET recurring annual (annual_total, else
 *    monthly_total×12) ÷ the BOOKING'S cadence — and only when the estimate's
 *    cadence equals the booking series cadence (else fail closed, so a monthly
 *    quote isn't billed onto a quarterly series);
 *  - price stamped ONLY from the linked estimate, or the customer's recent
 *    quote-wizard drafts, and only when EXACTLY ONE matches service + address
 *    (ambiguity counted BEFORE priceability);
 *  - fail closed on any supplemental recurring program (rodent/palm) in EITHER
 *    recurring container, since annual_total would cover it;
 *  - service binding via serviceKeyFor on both sides; address bind exact
 *    (street + zip) with suffix/ZIP+4 canonicalization; all fail closed.
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

  test('numeric-frequency cadence (lawn) when it matches booking visits', () => {
    expect(derivePerApplicationAmount(est(600, [{ monthly: 50, perApp: 60, frequency: 10 }]), 10)).toBe(60);
  });

  test('CADENCE MISMATCH → null (monthly quote, quarterly booking)', () => {
    expect(derivePerApplicationAmount(est(387.96, [pest({ visitsPerYear: 12 })]), Q)).toBeNull();
  });

  test('no booking cadence → null (fail closed)', () => {
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

  test('service MISMATCH / missing serviceKey → null', () => {
    const estimate = { id: 'e4', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'lawn_care', bookingVisits: Q })).toBeNull();
    expect(resolveBookingVisitPrice({ estimate, bookingVisits: Q })).toBeNull();
  });

  test('supplemental program in EITHER recurring container → null', () => {
    const rootOnly = { id: 'e5', annual_total: 500, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] }, recurring: { rodentBaitMo: 49 } } };
    const nestedOnly = { id: 'e6', annual_total: 500, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] }, recurring: {}, result: { recurring: { palmInjectionMo: 39 } } } };
    expect(resolveBookingVisitPrice({ estimate: rootOnly, serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
    expect(resolveBookingVisitPrice({ estimate: nestedOnly, serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
  });
});

describe('resolveBookingVisitPrice — customer recent-draft fallback (bound)', () => {
  const ADDR = '15715 8th Place East, Bradenton, FL 34212';
  const BOOK_ADDR = { line1: '15715 8th Place East', zip: '34212' };
  const draft = (id, service, { annual_total = 387.96, extra = {}, address = ADDR } = {}) =>
    ({ id, annual_total, address, estimate_data: { services: [{ service, monthly: 32.33, perApp: 96.99, visitsPerYear: 4, ...extra }] } });
  const resolve = (candidateEstimates, opts = {}) =>
    resolveBookingVisitPrice({ candidateEstimates, serviceKey: 'pest_control', bookingAddress: BOOK_ADDR, bookingVisits: Q, ...opts });

  test('single matching draft (service + address + cadence) prices', () => {
    expect(resolve([draft('c1', 'pest_control')]))
      .toEqual({ amount: 96.99, sourceEstimateId: 'c1', serviceKey: 'pest_control' });
  });

  test('filters candidates by booked service (one of two matches)', () => {
    expect(resolve([draft('c1', 'pest_control'), draft('c2', 'lawn_care', { annual_total: 480 })]).sourceEstimateId).toBe('c1');
  });

  test('suffix + ZIP+4 variants still match ("8th Pl" vs "8th Place East", 34212-1234)', () => {
    expect(resolve([draft('c1', 'pest_control')], { bookingAddress: { line1: '15715 8th Pl East', zip: '34212-1234' } }).sourceEstimateId).toBe('c1');
  });

  test('substring street is NOT a match ("112 Main" vs booked "12 Main")', () => {
    expect(resolve([draft('c1', 'pest_control', { address: '112 Main St, Bradenton, FL 34212' })], { bookingAddress: { line1: '12 Main St', zip: '34212' } })).toBeNull();
  });

  test('cadence-mismatched single candidate → null', () => {
    expect(resolve([draft('c1', 'pest_control', { extra: { visitsPerYear: 12 } })])).toBeNull();
  });

  test('two same-service/same-address drafts → null even if one is unpriceable (ambiguity before priceability)', () => {
    // c2 is unpriceable (supplemental) but still counts for ambiguity, so we do
    // NOT silently price c1.
    const c2 = draft('c2', 'pest_control');
    c2.estimate_data.result = { recurring: { rodentBaitMo: 49 } };
    expect(resolve([draft('c1', 'pest_control'), c2])).toBeNull();
  });

  test('different property / no match / missing address → null (fail closed)', () => {
    expect(resolve([draft('c1', 'pest_control', { address: '999 Elsewhere Ave, Bradenton, FL 34212' })])).toBeNull();
    expect(resolve([draft('c1', 'lawn_care')])).toBeNull();
    expect(resolve([])).toBeNull();
    expect(resolveBookingVisitPrice({ candidateEstimates: [draft('c1', 'pest_control')], serviceKey: 'pest_control', bookingVisits: Q })).toBeNull();
  });

  test('linked estimate takes precedence over candidates', () => {
    const estimate = { id: 'linked', annual_total: 600, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 50, perApp: 150, visitsPerYear: 4 }] } } };
    const res = resolveBookingVisitPrice({ estimate, candidateEstimates: [draft('c1', 'pest_control')], serviceKey: 'pest_control', bookingAddress: BOOK_ADDR, bookingVisits: Q });
    expect(res.sourceEstimateId).toBe('linked');
    expect(res.amount).toBe(150); // 600 / 4
  });
});
