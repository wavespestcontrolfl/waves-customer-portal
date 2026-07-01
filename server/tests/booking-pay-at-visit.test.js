/**
 * Booking "pay per application" price resolution (coverage + customer lookup).
 *
 * Money-path contract:
 *  - AMOUNT = estimate-level NET recurring annual (annual_total, else
 *    monthly_total×12) ÷ cadence — authoritative + shape-independent; line-item
 *    fields are used only for eligibility/service/cadence, never the amount, so
 *    an estimate-level discount is honored;
 *  - price stamped ONLY from the linked estimate, or the customer's recent
 *    quote-wizard drafts, and only when EXACTLY ONE matches the booked service
 *    AND address;
 *  - SERVICE binding via serviceKeyFor on both sides; ADDRESS bind is exact
 *    (street + zip), never substring; both fail closed;
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

// estimate with a single recurring service, priced at the estimate level.
const est = (annual_total, services, extra = {}) => ({ annual_total, estimate_data: { services }, ...extra });
const pest = (o = {}) => ({ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4, ...o });

describe('derivePerApplicationAmount — estimate-level net ÷ cadence', () => {
  test('annual_total ÷ visits, cents preserved', () => {
    expect(derivePerApplicationAmount(est(387.96, [pest()]))).toBe(96.99);
  });

  test('honors an ESTIMATE-LEVEL discount (ignores pre-discount line mo)', () => {
    // line mo=30 → 90 gross; net annual_total 288 → 72 billed.
    expect(derivePerApplicationAmount(est(288, [{ mo: 30, perApp: 90, visitsPerYear: 4 }]))).toBe(72);
  });

  test('falls back to monthly_total × 12 when annual_total absent', () => {
    expect(derivePerApplicationAmount({ monthly_total: 25.25, estimate_data: { services: [pest({ perApp: 99 })] } })).toBe(75.75);
  });

  test('mapped aliases (mo/perTreatment) + string cadence still resolve eligibility', () => {
    expect(derivePerApplicationAmount(est(387.96, [{ mo: 32.33, perTreatment: 96.99, frequency: 'quarterly' }]))).toBe(96.99);
  });

  test('ambiguity / no-perApp / no-cadence / no-total / empty → null', () => {
    expect(derivePerApplicationAmount(est(600, [pest(), pest({ perApp: 60 })]))).toBeNull();
    expect(derivePerApplicationAmount(est(360, [{ monthly: 30, visitsPerYear: 4 }]))).toBeNull();
    expect(derivePerApplicationAmount(est(360, [{ monthly: 30, perApp: 90 }]))).toBeNull();
    expect(derivePerApplicationAmount({ estimate_data: { services: [pest()] } })).toBeNull(); // no total
    expect(derivePerApplicationAmount({ estimate_data: { services: [] } })).toBeNull();
    expect(derivePerApplicationAmount({})).toBeNull();
  });
});

describe('resolveBookingVisitPrice — linked estimate (all shapes, service-bound)', () => {
  test('engineResult shape, service matches', () => {
    const estimate = { id: 'e1', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control' }))
      .toEqual({ amount: 96.99, sourceEstimateId: 'e1', serviceKey: 'pest_control' });
  });

  test('V2 result.recurring.services shape with an estimate-level discount', () => {
    // line mo=40 → 120 gross; net annual_total 288 → 72 (P0: shape-level discount honored).
    const estimate = { id: 'e2', annual_total: 288, estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', mo: 40, perTreatment: 120, visitsPerYear: 4 }] } } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'lawn_care' }).amount).toBe(72);
  });

  test('mapped services shape + string cadence', () => {
    const estimate = { id: 'e3', annual_total: 387.96, estimate_data: { services: [{ service: 'pest_control', mo: 32.33, perTreatment: 96.99, frequency: 'quarterly' }] } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control' }).amount).toBe(96.99);
  });

  test('service MISMATCH / missing serviceKey → null', () => {
    const estimate = { id: 'e4', annual_total: 387.96, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'lawn_care' })).toBeNull();
    expect(resolveBookingVisitPrice({ estimate })).toBeNull();
  });
});

describe('resolveBookingVisitPrice — customer recent-draft fallback (bound)', () => {
  const ADDR = '15715 8th Place East, Bradenton, FL 34212';
  const BOOK_ADDR = { line1: '15715 8th Place East', zip: '34212' };
  const draft = (id, service, { annual_total = 387.96, extra = {}, address = ADDR } = {}) =>
    ({ id, annual_total, address, estimate_data: { services: [{ service, monthly: 32.33, perApp: 96.99, visitsPerYear: 4, ...extra }] } });
  const resolve = (candidateEstimates, serviceKey = 'pest_control', bookingAddress = BOOK_ADDR) =>
    resolveBookingVisitPrice({ candidateEstimates, serviceKey, bookingAddress });

  test('single matching draft (service + address) prices', () => {
    expect(resolve([draft('c1', 'pest_control')]))
      .toEqual({ amount: 96.99, sourceEstimateId: 'c1', serviceKey: 'pest_control' });
  });

  test('filters candidates by booked service (one of two matches)', () => {
    const res = resolve([draft('c1', 'pest_control'), draft('c2', 'lawn_care', { annual_total: 480 })]);
    expect(res.sourceEstimateId).toBe('c1');
  });

  test('two same-service drafts at the booked address → null (ambiguous)', () => {
    expect(resolve([draft('c1', 'pest_control'), draft('c2', 'pest_control', { annual_total: 480 })])).toBeNull();
  });

  test('different property (different street, same zip) → null', () => {
    expect(resolve([draft('c1', 'pest_control', { address: '999 Elsewhere Ave, Bradenton, FL 34212' })])).toBeNull();
  });

  test('substring street is NOT a match ("112 Main" vs booked "12 Main")', () => {
    const res = resolveBookingVisitPrice({
      candidateEstimates: [draft('c1', 'pest_control', { address: '112 Main St, Bradenton, FL 34212' })],
      serviceKey: 'pest_control',
      bookingAddress: { line1: '12 Main St', zip: '34212' },
    });
    expect(res).toBeNull();
  });

  test('missing / empty booking address → null (fail closed)', () => {
    expect(resolveBookingVisitPrice({ candidateEstimates: [draft('c1', 'pest_control')], serviceKey: 'pest_control' })).toBeNull();
    expect(resolveBookingVisitPrice({ candidateEstimates: [draft('c1', 'pest_control')], serviceKey: 'pest_control', bookingAddress: { line1: '', zip: '' } })).toBeNull();
  });

  test('no matching draft → null', () => {
    expect(resolve([draft('c1', 'lawn_care')])).toBeNull();
    expect(resolve([])).toBeNull();
  });

  test('linked estimate takes precedence over candidates (no address bind on linked)', () => {
    const estimate = { id: 'linked', annual_total: 600, estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 50, perApp: 150, visitsPerYear: 4 }] } } };
    const res = resolveBookingVisitPrice({ estimate, candidateEstimates: [draft('c1', 'pest_control')], serviceKey: 'pest_control', bookingAddress: BOOK_ADDR });
    expect(res.sourceEstimateId).toBe('linked');
    expect(res.amount).toBe(150); // 600 / 4
  });
});
