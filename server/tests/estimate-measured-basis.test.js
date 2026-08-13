/**
 * Estimate view — the treatable lawn area next to the lawn price (owner ask
 * 2026-08-12: "showcase the estimated treatable area by the price, because
 * this dictates how much solution and what we charge per application").
 *
 * The number already existed on the estimate, but only inside the Waves AI
 * property card further down the page. This surfaces it on the lawn PriceCard
 * itself, reading the SAME provenance the engine priced with (lawnMeta.lsf +
 * turfBasis) so the line can never disagree with the charge.
 *
 * Invariants:
 *   - lawn only (the service priced per treatable sq ft)
 *   - never on the synthetic 'bundle' section (combined total — one member's
 *     area would read as the whole plan's basis)
 *   - a county seed is labelled county, NEVER a satellite measurement
 *   - an unrecognized basis falls to verify wording, not a definite claim
 */

const estimatePublic = require('../routes/estimate-public');

const { measuredBasisForSection, attachMeasuredBasis } = estimatePublic;

const lawnData = (lawnMeta) => ({ lawnMeta });

describe('measuredBasisForSection', () => {
  test('returns null for every non-lawn section', () => {
    const data = lawnData({ lsf: 7500, turfBasis: 'estimatedTurfSf' });
    for (const key of ['pest_control', 'mosquito', 'termite_bait', 'tree_shrub', 'bundle']) {
      expect(measuredBasisForSection(key, data)).toBeNull();
    }
  });

  test('formats the priced area with a thousands separator', () => {
    const result = measuredBasisForSection('lawn_care', lawnData({ lsf: 7500, turfBasis: 'estimatedTurfSf' }));
    expect(result).toEqual({
      label: 'Treatable lawn',
      value: '7,500 sq ft',
      source: 'AI satellite measurement',
    });
  });

  test('reads the v1 nested shape (results.lawnMeta) as well as the flat one', () => {
    const nested = { results: { lawnMeta: { lsf: 6200, turfBasis: 'measuredTurfSf' } } };
    expect(measuredBasisForSection('lawn_care', nested)).toEqual({
      label: 'Treatable lawn',
      value: '6,200 sq ft',
      source: 'Measured on site',
    });
  });

  test('a county seed is labelled county records, never satellite', () => {
    const result = measuredBasisForSection('lawn_care', lawnData({ lsf: 2721, turfBasis: 'countyPrior' }));
    expect(result.source).toBe('County records (estimated)');
    expect(result.source).not.toMatch(/satellite/i);
  });

  test('an unrecognized basis falls back to verify wording, not a claim', () => {
    const result = measuredBasisForSection('lawn_care', lawnData({ lsf: 4793, turfBasis: 'someNewBasis' }));
    expect(result.source).toMatch(/verify/i);
    expect(result.source).not.toMatch(/satellite|measured on site/i);
  });

  test('capped and fallback bases do not claim a measurement', () => {
    for (const basis of ['plausibleMaxTurfCap', 'lotFallback', 'legacyHardscapeEstimate']) {
      const result = measuredBasisForSection('lawn_care', lawnData({ lsf: 4793, turfBasis: basis }));
      expect(result.source).toMatch(/verify/i);
    }
  });

  test('no area yields no line at all (never a zero or a guess)', () => {
    expect(measuredBasisForSection('lawn_care', lawnData({ lsf: 0 }))).toBeNull();
    expect(measuredBasisForSection('lawn_care', lawnData({}))).toBeNull();
    expect(measuredBasisForSection('lawn_care', {})).toBeNull();
  });
});

describe('attachMeasuredBasis', () => {
  const sections = () => ([
    { key: 'lawn_care', intelligence: { metrics: [], chips: [] } },
    { key: 'pest_control', intelligence: { metrics: [], chips: [] } },
    { key: 'bundle', intelligence: { metrics: [], chips: [] } },
  ]);

  test('stamps only the lawn section', () => {
    const services = sections();
    attachMeasuredBasis(services, lawnData({ lsf: 7500, turfBasis: 'estimatedTurfSf' }));
    expect(services[0].intelligence.measuredBasis.value).toBe('7,500 sq ft');
    expect(services[1].intelligence.measuredBasis).toBeUndefined();
  });

  test('never stamps the combined bundle card', () => {
    const services = sections();
    attachMeasuredBasis(services, lawnData({ lsf: 7500, turfBasis: 'estimatedTurfSf' }));
    expect(services[2].intelligence.measuredBasis).toBeUndefined();
  });

  test('is a no-op on malformed sections rather than throwing', () => {
    expect(() => attachMeasuredBasis([null, {}, { key: 'lawn_care' }], lawnData({ lsf: 5000 }))).not.toThrow();
    expect(() => attachMeasuredBasis([], {})).not.toThrow();
    expect(() => attachMeasuredBasis(undefined, {})).not.toThrow();
  });
});
