/**
 * Booking "pay per application" price resolution.
 *
 * Pins the money-path contract that keeps this safe:
 *  - a billable price is stamped ONLY from the estimate the booking is
 *    explicitly linked to (never guessed from other quotes);
 *  - and ONLY when that estimate's recurring line is the SAME service that was
 *    booked (service binding — service_type is client-influenced);
 *  - the amount is the NET (after-discount) annual ÷ cadence — NEVER the gross
 *    `perApp` the quote stores raw, so a discounted plan is never overbilled;
 *  - only an UNAMBIGUOUS single recurring, per-application-billable line prices;
 *  - cents are preserved (this is the billable estimated_price, not a display);
 *  - production estimate_data shapes (engineResult/result) are read.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Stub the seeder helpers so the binding + cadence logic is exercised without
// pulling the real seeder (and its deps) into scope.
jest.mock('../services/recurring-appointment-seeder', () => ({
  serviceKeyFor: (v) => v?.service || v?.service_type || null,
  normalizeRecurringPattern: (v) => {
    const s = String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (s === 'quarterly') return 'quarterly';
    if (s === 'monthly') return 'monthly';
    if (s === 'bimonthly') return 'bimonthly';
    if (s === 'annual' || s === 'yearly') return 'annual';
    return null;
  },
}));

const { derivePerApplicationAmount, resolveBookingVisitPrice } = require('../services/booking-pay-at-visit');

describe('derivePerApplicationAmount', () => {
  test('single recurring line → net monthly × 12 ÷ cadence, cents preserved', () => {
    expect(derivePerApplicationAmount([{ monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }])).toBe(96.99);
  });

  test('bills NET, not gross perApp — a discount on the line is honored', () => {
    expect(derivePerApplicationAmount([
      { monthly: 30, monthlyAfterDiscount: 24, perApp: 90, visitsPerYear: 4 },
    ])).toBe(72); // 24*12/4, not gross 90
  });

  test('prefers net annual (annualAfterCredits → annualAfterDiscount → annual)', () => {
    expect(derivePerApplicationAmount([
      { monthly: 30, annual: 360, annualAfterDiscount: 320, annualAfterCredits: 300, perApp: 100, visitsPerYear: 4 },
    ])).toBe(75);
    expect(derivePerApplicationAmount([{ monthly: 30, annual: 360, perApp: 100, visitsPerYear: 4 }])).toBe(90);
  });

  test('never whole-dollar rounds a billable amount', () => {
    expect(derivePerApplicationAmount([{ monthly: 25.25, perApp: 99, visitsPerYear: 4 }])).toBe(75.75);
  });

  test('uses numeric frequency when no visitsPerYear (lawn)', () => {
    expect(derivePerApplicationAmount([{ monthlyAfterDiscount: 50, perApp: 60, frequency: 10 }])).toBe(60);
  });

  test('normalizes a STRING cadence — quarterly pest line (no numeric visitsPerYear)', () => {
    expect(derivePerApplicationAmount([{ monthly: 32.33, perApp: 96.99, frequency: 'quarterly' }])).toBe(96.99);
  });

  test('unrecognized string cadence → null (no guess)', () => {
    expect(derivePerApplicationAmount([{ monthly: 30, perApp: 90, frequency: 'whenever' }])).toBeNull();
  });

  test('multiple recurring lines → null', () => {
    expect(derivePerApplicationAmount([
      { monthly: 30, perApp: 90, visitsPerYear: 4 },
      { monthly: 20, perApp: 60, visitsPerYear: 4 },
    ])).toBeNull();
  });

  test('no per-app caption (monthly-billed tier) → null', () => {
    expect(derivePerApplicationAmount([{ monthly: 30, annual: 360, visitsPerYear: 4 }])).toBeNull();
  });

  test('per-app caption but no cadence → null', () => {
    expect(derivePerApplicationAmount([{ monthly: 30, perApp: 90 }])).toBeNull();
  });

  test('one-time-only / empty / missing → null', () => {
    expect(derivePerApplicationAmount([{ monthly: 0, perApp: 150 }])).toBeNull();
    expect(derivePerApplicationAmount([])).toBeNull();
    expect(derivePerApplicationAmount(undefined)).toBeNull();
  });
});

describe('resolveBookingVisitPrice', () => {
  const lineFor = (service, extra = {}) => ({ service, monthly: 32.33, perApp: 96.99, visitsPerYear: 4, ...extra });

  test('prices from engineResult.lineItems when the service matches the booking', () => {
    const estimate = { id: 'est-1', estimate_data: { engineResult: { lineItems: [lineFor('pest_control')] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control' }))
      .toEqual({ amount: 96.99, sourceEstimateId: 'est-1', serviceKey: 'pest_control' });
  });

  test('also reads estimate_data.result.lineItems and a live .lineItems object', () => {
    const viaResult = { id: 'r', estimate_data: { result: { lineItems: [lineFor('lawn_care', { monthly: 40, perApp: 120 })] } } };
    expect(resolveBookingVisitPrice({ estimate: viaResult, serviceKey: 'lawn_care' }).amount).toBe(120);
    const live = { id: 'L', lineItems: [lineFor('pest_control')] };
    expect(resolveBookingVisitPrice({ estimate: live, serviceKey: 'pest_control' }).amount).toBe(96.99);
  });

  test('service MISMATCH → null (price is bound to the booked service)', () => {
    const estimate = { id: 'est-2', estimate_data: { engineResult: { lineItems: [lineFor('pest_control')] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'lawn_care' })).toBeNull();
  });

  test('missing booked serviceKey → null (fail closed)', () => {
    const estimate = { id: 'est-3', estimate_data: { engineResult: { lineItems: [lineFor('pest_control')] } } };
    expect(resolveBookingVisitPrice({ estimate })).toBeNull();
  });

  test('no linked estimate → null (never guesses from other quotes)', () => {
    expect(resolveBookingVisitPrice({ estimate: null, serviceKey: 'pest_control' })).toBeNull();
    expect(resolveBookingVisitPrice({})).toBeNull();
  });

  test('unpriceable linked estimate → null (stays price-less)', () => {
    const estimate = { id: 'x', estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', monthly: 30, annual: 360 }] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control' })).toBeNull();
  });

  test('multi-service linked estimate → null (ambiguous)', () => {
    const estimate = { id: 'm', estimate_data: { engineResult: { lineItems: [
      lineFor('pest_control'),
      lineFor('lawn_care', { monthly: 20, perApp: 60 }),
    ] } } };
    expect(resolveBookingVisitPrice({ estimate, serviceKey: 'pest_control' })).toBeNull();
  });
});
