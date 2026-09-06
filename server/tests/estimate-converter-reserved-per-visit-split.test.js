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

describe('reservedAcceptPerVisitSplit — codex #3938 r2', () => {
  const bait = { service: 'termite_bait', name: 'Termite Bait Stations', annualAfterDiscount: 480, visitsPerYear: 4 };

  test('a reserved row the combined route rewrites (pest + bait) takes the pair\'s sum; the lawn promotion its own', () => {
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 271.8,
      reservedService: [pestLine, bait],
      promotedServices: [lawnLine],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 211.8, promoted: [60] });
  });

  test('a promoted COMBO unit (gate on) prices the two lines it performs', () => {
    const tree = { service: 'tree_shrub', name: 'Tree & Shrub', annualAfterDiscount: 360, visitsPerYear: 9 };
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 191.8,
      reservedService: pestLine,
      promotedServices: [[lawnLine, tree]],
      acceptedPlanFrequency: 'quarterly',
    })).toEqual({ reserved: 91.8, promoted: [100] });
  });

  test('the accept route\'s per-row amounts are the authority when present (preference credit on pest)', () => {
    // Customer declined interior spraying: the route priced the pest row at
    // 81.80, not the line's 91.80 — the reserved total is 141.80.
    const rowAmounts = [
      { service: 'pest_control', name: 'Pest Control', amount: 81.8 },
      { service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', amount: 60 },
    ];
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 141.8,
      reservedService: pestLine,
      promotedServices: [lawnLine],
      acceptedPlanFrequency: 'quarterly',
      rowAmounts,
    })).toEqual({ reserved: 81.8, promoted: [60] });
    // Reconstruction alone would have declined this shape.
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 141.8, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly',
    })).toBeNull();
  });

  test('route rows must map one-to-one onto the seeded lines — an unmatched row or a missing row declines', () => {
    const extra = [
      { service: 'pest_control', name: 'Pest Control', amount: 91.8 },
      { service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', amount: 60 },
      { service: 'mosquito', name: 'Mosquito', amount: 40 },
    ];
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 191.8, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly', rowAmounts: extra,
    })).toBeNull();
    const missingLawn = [{ service: 'pest_control', name: 'Pest Control', amount: 91.8 }];
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 91.8, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly', rowAmounts: missingLawn,
    })).toBeNull();
    // Sub-cent route figures reconcile as the STORED (rounded) amounts — a
    // drift the rounding cannot reproduce declines rather than stamping
    // prices that no longer add up to the reserved figure.
    const cents = [
      { service: 'pest_control', name: 'Pest Control', amount: 91.804 },
      { service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', amount: 60.004 },
    ];
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.81, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly', rowAmounts: cents,
    })).toBeNull();
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 151.8, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly', rowAmounts: cents,
    })).toEqual({ reserved: 91.8, promoted: [60] });
  });
});

describe('reservedAcceptPerVisitSplit — codex #3938 r3', () => {
  const bait = { service: 'termite_bait', name: 'Termite Bait Stations', annualAfterDiscount: 480, visitsPerYear: 4 };

  test('a station-rental route row folds into the bait share (the converter bills it on the bait visit)', () => {
    const rowAmounts = [
      { service: 'pest_control', name: 'Pest Control', amount: 91.8 },
      { service: 'termite_bait', name: 'Termite Bait Stations', amount: 120 },
      { service: 'termite_station_rental', name: 'Station rental', amount: 15 },
    ];
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 226.8, reservedService: pestLine, promotedServices: [bait], acceptedPlanFrequency: 'quarterly', rowAmounts,
    })).toEqual({ reserved: 91.8, promoted: [135] });
  });

  test('a rental row with no bait line to carry it declines', () => {
    const rowAmounts = [
      { service: 'pest_control', name: 'Pest Control', amount: 91.8 },
      { service: 'lawn_care', name: 'Every 6 Weeks Lawn Care Service', amount: 60 },
      { service: 'termite_station_rental', name: 'Station rental', amount: 15 },
    ];
    expect(reservedAcceptPerVisitSplit({
      reservedPrice: 166.8, reservedService: pestLine, promotedServices: [lawnLine], acceptedPlanFrequency: 'quarterly', rowAmounts,
    })).toBeNull();
  });
});
