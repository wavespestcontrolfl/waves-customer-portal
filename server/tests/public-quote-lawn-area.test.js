/**
 * Public quote wizard — the measured basis behind a lawn price (owner ask,
 * 2026-08-12: "showcase the estimated treatable area by the price, because
 * this dictates how much solution and what we charge per application").
 *
 * The widget renders "Priced for N sq ft" ONLY when `lawn_area` is present,
 * so this block is a pricing CLAIM. Two invariants it must never break:
 *
 *   1. The figure is the one the engine PRICED FROM (the lawn line's
 *      lawnSqFt), not the raw vision number — the engine caps implausible
 *      measurements (plausibleMaxTurfCap / TURF_CAPPED_TO_PARCEL), and
 *      shipping the pre-cap number would state a basis that was never used.
 *
 *   2. Only a tech measurement or an uncapped vision figure earns a definite
 *      source label. Estimated/capped/fallback bases map to the "verified on
 *      your first visit" family, mirroring how the estimate page labels a
 *      county seed "County records (estimated)" rather than satellite.
 */

const { generateEstimate } = require('../services/pricing-engine');
const { _internals } = require('../routes/public-quote');

const { deriveLawnArea } = _internals;

const BASE_PROPERTY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };
const LAWN_SERVICE = { lawn: { track: 'st_augustine', tier: 'enhanced' } };

describe('deriveLawnArea', () => {
  test('returns null when the quote has no lawn line (pest-only)', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { pest: { frequency: 'quarterly' } },
    });
    expect(deriveLawnArea(estimate)).toBeNull();
  });

  test('a lawn quote exposes the priced area with a source label', () => {
    const estimate = generateEstimate({ ...BASE_PROPERTY, services: LAWN_SERVICE });
    const result = deriveLawnArea(estimate);
    expect(result).not.toBeNull();
    expect(result.turf_sqft).toBeGreaterThan(0);
    expect(typeof result.source).toBe('string');
  });

  test('the exposed figure is the engine-priced area, not the raw input', () => {
    // measuredTurfSf is the HIGH-confidence tech measurement path; the engine
    // prices from it directly, so the response must echo it exactly.
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      measuredTurfSf: 5200,
      services: LAWN_SERVICE,
    });
    const lawnLine = estimate.lineItems.find((l) => l.service === 'lawn_care');
    const result = deriveLawnArea(estimate);
    expect(result.turf_sqft).toBe(Math.round(Number(lawnLine.lawnSqFt)));
    expect(result.turf_sqft).toBe(5200);
    expect(result.source).toBe('measured');
  });

  test('a parcel-capped vision figure does NOT claim a satellite measurement', () => {
    // An implausible vision number relative to the parcel gets capped by the
    // engine. The customer must not be told the satellite measured the
    // post-cap figure — it maps to the verify family instead.
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      estimatedTurfSf: 400000,
      turfSource: 'vision',
      services: LAWN_SERVICE,
    });
    const lawnLine = estimate.lineItems.find((l) => l.service === 'lawn_care');
    const result = deriveLawnArea(estimate);
    expect(result.turf_sqft).toBe(Math.round(Number(lawnLine.lawnSqFt)));
    // Observed 2026-08-12: 400,000 in → engine prices 4,793. Shipping the raw
    // vision figure would have claimed a basis ~83x the one actually charged.
    expect(result.turf_sqft).toBeLessThan(400000);
    expect(result.source).not.toBe('ai_satellite');
    expect(result.source).not.toBe('measured');
  });

  test('a county-prior seed is labelled county, never satellite', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      estimatedTurfSf: 2721,
      turfSource: 'county_prior',
      services: LAWN_SERVICE,
    });
    const result = deriveLawnArea(estimate);
    expect(result.turf_sqft).toBe(2721);
    expect(result.source).toBe('county');
  });

  test('an unrecognized basis falls back to the verify family, not a claim', () => {
    // Guards the mapping table: a basis added to the engine later must not
    // inherit a satellite/measured label by default.
    const fake = { lineItems: [{ service: 'lawn_care', lawnSqFt: 6000, turfBasis: 'someNewBasis' }] };
    expect(deriveLawnArea(fake)).toEqual({ turf_sqft: 6000, source: 'lot_estimate' });
  });

  test('a zero or missing area yields no block at all (no bare claim)', () => {
    expect(deriveLawnArea({ lineItems: [{ service: 'lawn_care', lawnSqFt: 0 }] })).toBeNull();
    expect(deriveLawnArea({ lineItems: [{ service: 'lawn_care' }] })).toBeNull();
    expect(deriveLawnArea({ lineItems: [] })).toBeNull();
    expect(deriveLawnArea({})).toBeNull();
  });

  test('a commercial lawn line carries the basis too (codex #3376 r1+r2)', () => {
    // priceCommercialLawn stores the priced area as turfSf, NOT lawnSqFt
    // (codex r2: an earlier fake used the residential field name and masked
    // the regression) — assert against the REAL commercial field shape.
    const commercialShape = { lineItems: [{ service: 'commercial_lawn', turfSf: 22000, turfBasis: 'measuredTurfSf' }] };
    expect(deriveLawnArea(commercialShape)).toEqual({ turf_sqft: 22000, source: 'measured' });
    // And through the real commercial pricer end-to-end.
    const { priceCommercialLawn } = require('../services/pricing-engine/service-pricing');
    if (typeof priceCommercialLawn === 'function') {
      const line = priceCommercialLawn({ measuredTurfSf: 22000, lotSqFt: 40000, homeSqFt: 5000 }, {});
      if (line && line.service === 'commercial_lawn') {
        expect(deriveLawnArea({ lineItems: [line] })).not.toBeNull();
      }
    }
  });

  test('a parcel-capped vision figure is demoted from the satellite claim (codex #3376 r1)', () => {
    // computeTurfArea keeps turfBasis 'estimatedTurfSf' on a parcel clamp —
    // the flag rides on property.turfFlags. Verified against the real engine:
    // estimatedTurfSf + turfCappedToParcel:true → basis 'estimatedTurfSf',
    // property.turfFlags ['TURF_CAPPED_TO_PARCEL'].
    const capped = {
      lineItems: [{ service: 'lawn_care', lawnSqFt: 4200, turfBasis: 'estimatedTurfSf' }],
      property: { turfFlags: ['TURF_CAPPED_TO_PARCEL'] },
    };
    expect(deriveLawnArea(capped)).toEqual({ turf_sqft: 4200, source: 'lot_estimate' });
    // Same shape through the real engine end-to-end.
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      estimatedTurfSf: 4200,
      turfSource: 'vision',
      turfCappedToParcel: true,
      services: LAWN_SERVICE,
    });
    const result = deriveLawnArea(estimate);
    expect(result.source).not.toBe('ai_satellite');
  });
});
