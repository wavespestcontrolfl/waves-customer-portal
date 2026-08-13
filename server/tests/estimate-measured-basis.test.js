/**
 * Estimate view — the treatable lawn area next to the lawn price (owner ask
 * 2026-08-12: "showcase the estimated treatable area by the price, because
 * this dictates how much solution and what we charge per application").
 *
 * The number already existed on the estimate (show-your-work AI card); this
 * surfaces it on the lawn PriceCard itself. Invariants:
 *
 *   - measuredBasisForSection takes the RESOLVED estResult — the same object
 *     the price ladder is built from — never raw estData. ui-verify caught
 *     the card showing 3,410 sq ft beside a price computed from 4,793 when
 *     the two reads used different objects.
 *   - lawn_care + commercial_lawn only; never the synthetic 'bundle' card.
 *   - engine-backed shape ({engineResult.lineItems}) is read when lawnMeta
 *     is absent (codex #3376 r1); slim wizard lines fall through to null.
 *   - a county seed is county, never satellite; a PARCEL-CAPPED vision
 *     figure keeps turfBasis 'estimatedTurfSf' but must NOT claim satellite
 *     (codex #3376 r1 — the cap rides on fieldVerify/property.turfFlags).
 *   - no verify-on-first-visit wording anywhere (owner ruling 2026-08-12 —
 *     it writes a work order for the field tech).
 */

const estimatePublic = require('../routes/estimate-public');

const { measuredBasisForSection, attachMeasuredBasis } = estimatePublic;

const v1Result = (lawnMeta, extra = {}) => ({ results: { lawnMeta }, ...extra });

describe('measuredBasisForSection', () => {
  test('returns null for non-lawn sections and the bundle card', () => {
    const result = v1Result({ lsf: 7500, turfBasis: 'estimatedTurfSf' });
    for (const key of ['pest_control', 'mosquito', 'termite_bait', 'tree_shrub', 'bundle']) {
      expect(measuredBasisForSection(key, result)).toBeNull();
    }
  });

  test('formats the priced area from v1 lawnMeta with a source label', () => {
    expect(measuredBasisForSection('lawn_care', v1Result({ lsf: 7500, turfBasis: 'estimatedTurfSf' }))).toEqual({
      label: 'Treatable lawn',
      value: '7,500 sq ft',
      source: 'AI satellite measurement',
    });
  });

  test('reads the flattened legacy shape (lawnMeta at top level)', () => {
    expect(measuredBasisForSection('lawn_care', { lawnMeta: { lsf: 6200, turfBasis: 'measuredTurfSf' } })).toEqual({
      label: 'Treatable lawn',
      value: '6,200 sq ft',
      source: 'On-file measurement',
    });
  });

  test('falls back to the engine-shape lawn line when lawnMeta is absent', () => {
    const engineShape = { lineItems: [{ service: 'lawn_care', lawnSqFt: 5100, turfBasis: 'estimatedTurfSf' }] };
    expect(measuredBasisForSection('lawn_care', engineShape)).toEqual({
      label: 'Treatable lawn',
      value: '5,100 sq ft',
      source: 'AI satellite measurement',
    });
  });

  test('commercial_lawn sections read the commercial line', () => {
    const engineShape = { lineItems: [{ service: 'commercial_lawn', lawnSqFt: 22000, turfBasis: 'measuredTurfSf' }] };
    expect(measuredBasisForSection('commercial_lawn', engineShape)).toEqual({
      label: 'Treatable lawn',
      value: '22,000 sq ft',
      source: 'On-file measurement',
    });
  });

  test('slim wizard lines (no lawnSqFt) yield no line at all', () => {
    const slim = { lineItems: [{ service: 'lawn_care', perApp: 65.33 }] };
    expect(measuredBasisForSection('lawn_care', slim)).toBeNull();
  });

  test('a parcel-capped vision figure does NOT claim a satellite measurement', () => {
    // computeTurfArea keeps turfBasis 'estimatedTurfSf' on a parcel clamp;
    // the flag rides on fieldVerify (v1) / property.turfFlags (engine).
    const capped = v1Result(
      { lsf: 4200, turfBasis: 'estimatedTurfSf' },
      { fieldVerify: ['TURF_CAPPED_TO_PARCEL'] }
    );
    expect(measuredBasisForSection('lawn_care', capped).source).toBe('Estimated from your property records');

    const cappedEngine = {
      lineItems: [{ service: 'lawn_care', lawnSqFt: 4200, turfBasis: 'estimatedTurfSf' }],
      property: { turfFlags: ['TURF_CAPPED_TO_PARCEL'] },
    };
    expect(measuredBasisForSection('lawn_care', cappedEngine).source).toBe('Estimated from your property records');
  });

  test('county seed is county, never satellite; unknown bases fall to the estimate family', () => {
    expect(measuredBasisForSection('lawn_care', v1Result({ lsf: 2721, turfBasis: 'countyPrior' })).source)
      .toBe('County records (estimated)');
    expect(measuredBasisForSection('lawn_care', v1Result({ lsf: 6000, turfBasis: 'someNewBasis' })).source)
      .toBe('Estimated from your property records');
  });

  test('no label anywhere promises tech verification (owner ruling 2026-08-12)', () => {
    for (const basis of ['measuredTurfSf', 'lawnSqFt', 'estimatedTurfSf', 'countyPrior', 'plausibleMaxTurfCap', 'lotFallback', 'legacyHardscapeEstimate', 'unknown']) {
      const out = measuredBasisForSection('lawn_care', v1Result({ lsf: 5000, turfBasis: basis }));
      expect(out.source).not.toMatch(/verify|verified|first visit|tech/i);
    }
  });

  test('zero or missing area yields no block (never a bare or guessed claim)', () => {
    expect(measuredBasisForSection('lawn_care', v1Result({ lsf: 0 }))).toBeNull();
    expect(measuredBasisForSection('lawn_care', v1Result({}))).toBeNull();
    expect(measuredBasisForSection('lawn_care', {})).toBeNull();
  });
});

describe('attachMeasuredBasis', () => {
  const sections = () => ([
    { key: 'lawn_care', intelligence: { metrics: [], chips: [] } },
    { key: 'pest_control', intelligence: { metrics: [], chips: [] } },
    { key: 'bundle', intelligence: { metrics: [], chips: [] } },
  ]);

  test('stamps only the lawn section, never the bundle card', () => {
    const services = sections();
    attachMeasuredBasis(services, v1Result({ lsf: 7500, turfBasis: 'estimatedTurfSf' }));
    expect(services[0].intelligence.measuredBasis.value).toBe('7,500 sq ft');
    expect(services[1].intelligence.measuredBasis).toBeUndefined();
    expect(services[2].intelligence.measuredBasis).toBeUndefined();
  });

  test('is a no-op on malformed input rather than throwing', () => {
    expect(() => attachMeasuredBasis([null, {}, { key: 'lawn_care' }], v1Result({ lsf: 5000 }))).not.toThrow();
    expect(() => attachMeasuredBasis([], {})).not.toThrow();
    expect(() => attachMeasuredBasis(undefined, {})).not.toThrow();
  });
});
