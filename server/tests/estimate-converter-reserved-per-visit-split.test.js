/**
 * Multi-program slot-reserved accepts: the reserved row carries the accept
 * route's SAME-DAY total (every program's first application on one trip) and
 * the seeder copies the parent price onto every child — so the reserved
 * series repeated the combined figure and the promoted series carried NULL
 * (prod 2026-09-04: pest children at $151.80 = $91.80 pest + $60.00 lawn,
 * eight lawn children unpriced). reservedAcceptPerVisitSplit hands each
 * series its own per-visit amount, and only when the split reproduces the
 * reserved price to the cent.
 */
const { reservedAcceptPerVisitSplit } = require('../services/estimate-converter');
const { buildRecurringFollowUpRows } = require('../services/recurring-appointment-seeder');

const pestLine = {
  service: 'pest_control', name: 'Pest Control', annualAfterDiscount: 367.2, visitsPerYear: 4,
};
const lawnLine = {
  service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', annualAfterDiscount: 540, visitsPerYear: 9,
};

describe('reservedAcceptPerVisitSplit', () => {
  test('pest + lawn reserved at the same-day total splits into each line\'s own per-visit amount (prod 2026-09-04)', () => {
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.8,
      reservedService: pestLine,
      promotedServices: [lawnLine],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 91.8, promoted: [60] });
  });

  test('a pest line with no visit count of its own bills at the ACCEPTED cadence', () => {
    const countlessPest = { service: 'pest_control', name: 'Pest Control', annualAfterDiscount: 367.2 };
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.8,
      reservedService: countlessPest,
      promotedServices: [lawnLine],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 91.8, promoted: [60] });
  });

  test('the mapped estimate blob (monthly only, no annual field) splits the same way', () => {
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.8,
      reservedService: { service: 'pest_control', name: 'Pest Control', mo: 30.6 },
      promotedServices: [{ service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', mo: 45, visitsPerYear: 9 }],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 91.8, promoted: [60] });
  });

  test('a reserved price the lines do not reproduce to the cent (plan-credit slice, manual discount) returns null', () => {
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 141.8,
      reservedService: pestLine,
      promotedServices: [lawnLine],
      acceptedPlanFrequency: 'quarterly',
    })).toBeNull();
  });

  test('an unknown visit count on any line returns null — never an invented price', () => {
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.8,
      reservedService: pestLine,
      promotedServices: [{ service: 'lawn_care', name: 'Lawn Care', annualAfterDiscount: 540 }],
      acceptedPlanFrequency: 'quarterly',
    })).toBeNull();
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.8,
      reservedService: { service: 'pest_control', name: 'Pest Control', annualAfterDiscount: 367.2 },
      promotedServices: [lawnLine],
      acceptedPlanFrequency: null,
    })).toBeNull();
  });

  test('single-program accepts (nothing promoted) and unpriced reserved rows are untouched', () => {
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 91.8, reservedService: pestLine, promotedServices: [], acceptedPlanFrequency: 'quarterly',
    })).toBeNull();
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: null, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly',
    })).toBeNull();
  });
});

describe('seeded follow-ups take an explicit per-visit price over the parent copy', () => {
  const parent = {
    id: 'parent-1',
    customer_id: 'cust-1',
    scheduled_date: '2026-09-12',
    service_type: 'Quarterly Pest Control Service',
    estimated_price: 151.8,
  };

  test('an explicit estimatedPrice lands on every child', () => {
    const rows = buildRecurringFollowUpRows(parent, { pattern: 'quarterly', estimatedPrice: 91.8 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.estimated_price).toBe(91.8);
  });

  test('no explicit price keeps the parent-copy behavior', () => {
    const rows = buildRecurringFollowUpRows(parent, { pattern: 'quarterly', estimatedPrice: undefined });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.estimated_price).toBe(151.8);
  });
});

describe('reservedAcceptPerVisitSplit — codex #3938 r1', () => {
  test('a pest line priced at one cadence and ACCEPTED at another declines (its annual is quote-time)', () => {
    const quarterlyBuiltPest = { service: 'pest_control', name: 'Pest Control', annualAfterDiscount: 367.2, visitsPerYear: 4 };
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 90.6,
      reservedService: quarterlyBuiltPest,
      promotedServices: [lawnLine],
      acceptedPlanFrequency: 'monthly',
    })).toBeNull();
  });

  test('per-visit amounts follow the per-application rule (annual / visits, rounded) — parity with single-program children', () => {
    // 46/mo lawn, 9 visits: 552 / 9 = 61.33 — the same figure a single-program
    // accept stamps on every child via perApplicationChargeAmount.
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 153.13,
      reservedService: pestLine,
      promotedServices: [{ service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', mo: 46, visitsPerYear: 9 }],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 91.8, promoted: [61.33] });
  });

  test('a termite line beside a reserved pest accept prices from its own annual', () => {
    const bait = { service: 'termite_bait', name: 'Termite Bait Stations', annualAfterDiscount: 480, visitsPerYear: 4 };
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 211.8,
      reservedService: pestLine,
      promotedServices: [bait],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 91.8, promoted: [120] });
  });
});
