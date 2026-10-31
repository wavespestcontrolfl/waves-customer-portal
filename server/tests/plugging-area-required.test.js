/**
 * Lawn plugging is priced only from the area to plug (owner 2026-10-31). A
 * blank area used to price the whole lawn, so a few bare patches on a large
 * lawn quoted the whole yard. With no area the line now carries no dollars and
 * the measurement contract, so the send, accept and public-quote gates hold it.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { pricePlugging, PLUGGING_AREA_REQUIRED_REASON } = require('../services/pricing-engine/service-pricing');
const { estimateDataHasQuoteRequirement } = require('../services/estimate-delivery-options');
const { _internals } = require('../routes/public-quote');

const FEATURES = { shrubs: 'moderate', trees: 'moderate', complexity: 'moderate' };
// A measured 12,000 sq ft lawn: before the rule a blank area priced all of it.
const MEASURED = {
  homeSqFt: 2000, stories: 1, lotSqFt: 16000, measuredTurfSf: 12000,
  propertyType: 'single_family', zone: 'A', features: FEATURES,
};
const pluggingLine = (estimate) => estimate.lineItems.find((l) => l.service === 'plugging');

describe('server engine: plugging needs the area to plug', () => {
  test.each([
    [{ spacing: 12 }],
    [{ spacing: 12, area: '' }],
    [{ spacing: 12, area: null }],
    [{ spacing: 12, area: 0 }],
    [{ spacing: '9', area: '0' }],
  ])('no area prices nothing, never the whole lawn: %j', (plugging) => {
    const line = pluggingLine(generateEstimate({ ...MEASURED, services: { plugging } }));
    expect(line).toMatchObject({
      price: null,
      quoteRequired: true,
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons: [PLUGGING_AREA_REQUIRED_REASON],
      lawnSqFt: null,
    });
  });

  test('an entered area prices that area only, whatever the lawn size', () => {
    const small = pluggingLine(generateEstimate({ ...MEASURED, services: { plugging: { spacing: 12, area: 400 } } }));
    const bigLawn = pluggingLine(generateEstimate({
      ...MEASURED, measuredTurfSf: 30000, services: { plugging: { spacing: 12, area: '400' } },
    }));
    expect(small.price).toBe(pricePlugging(400, 12).price);
    expect(bigLawn.price).toBe(small.price);
    expect(small.lawnSqFt).toBe(400);
    expect(small.quoteRequired).toBeUndefined();
  });

  test('a bad area or spacing still fails loudly', () => {
    for (const plugging of [{ spacing: 12, area: -50 }, { spacing: 18 }]) {
      expect(() => generateEstimate({ ...MEASURED, services: { plugging } }))
        .toThrow(expect.objectContaining({ code: 'PRICING_VALIDATION_ERROR' }));
    }
  });
});

describe('downstream gates hold a plugging line with no area', () => {
  const estimate = generateEstimate({ ...MEASURED, services: { plugging: { spacing: 12 } } });

  test('the mapped estimate row is Quote Required with no amount', () => {
    const mapped = mapV1ToLegacyShape(estimate);
    const row = mapped.oneTime.specItems.find((item) => item.service === 'plugging');
    expect(row).toMatchObject({ price: null, quoteRequired: true, requiresMeasurement: true });
    expect(mapped.oneTime.total).toBe(0);
  });

  test('the saved estimate data trips the send gate', () => {
    expect(estimateDataHasQuoteRequirement({ engineResult: estimate })).toBe(true);
    expect(estimateDataHasQuoteRequirement(mapV1ToLegacyShape(estimate))).toBe(true);
  });

  test('the public quote route parks it with the plugging reason, not the priced-by-team copy', () => {
    const line = pluggingLine(estimate);
    expect(_internals.isManualQuoteLine(line)).toBe(true);
    // Same reason chain the /calculate route reads for its 202 copy and office notice.
    const reason = line.reason || line.customQuoteReason || line.manualReviewReasons?.[0];
    expect(reason).toBe(PLUGGING_AREA_REQUIRED_REASON);
    expect(_internals.isPricedByTeamReason(reason)).toBe(false);
  });
});
