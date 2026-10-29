/**
 * Top Dressing is quote-only everywhere the portal prices it (owner
 * 2026-10-29, top dressing scope option A). The engine formula is a $250 floor
 * that loses money on larger lawns, so the office prices every job by hand.
 *
 * The line keeps its formula number for audit but carries the existing
 * custom-quote contract, which the send, accept and public-quote gates read.
 * No migration, no gate.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
const { estimateDataHasQuoteRequirement } = require('../services/estimate-delivery-options');
const { _internals } = require('../routes/public-quote');

const FEATURES = { shrubs: 'moderate', trees: 'moderate', complexity: 'moderate' };
const MEASURED = {
  homeSqFt: 2000, stories: 1, lotSqFt: 16000, measuredTurfSf: 16000,
  propertyType: 'single_family', zone: 'A', features: FEATURES,
};
// A lot-only property: turf comes from the lot fallback, a LOW-confidence basis.
const LOT_ONLY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1 };

const topDressingLine = (estimate) => estimate.lineItems.find((l) => l.service === 'top_dressing');

describe('server engine: every top dressing line is quote-only', () => {
  test('whole-lawn line on measured turf carries the custom-quote markers', () => {
    const line = topDressingLine(generateEstimate({ ...MEASURED, services: { topDressing: { depth: 'eighth' } } }));
    expect(line.requiresCustomQuote).toBe(true);
    expect(line.requiresManualReview).toBe(true);
    expect(line.customQuoteReason).toBe('top_dressing_quote_only');
    expect(line.manualReviewReasons).toEqual(['top_dressing_quote_only']);
  });

  test('an explicit top-dress area is quote-only too (it was exempt before)', () => {
    const line = topDressingLine(generateEstimate({
      ...MEASURED, services: { topDressing: { depth: 'eighth', lawnSqFt: 4000 } },
    }));
    expect(line.requiresCustomQuote).toBe(true);
    expect(line.customQuoteReason).toBe('top_dressing_quote_only');
    expect(line.detail).toBe('Covers 4,000 sq ft');
  });

  test('both depths are quote-only', () => {
    for (const depth of ['eighth', 'quarter']) {
      const line = topDressingLine(generateEstimate({ ...MEASURED, services: { topDressing: { depth } } }));
      expect({ depth, quoteOnly: line.requiresCustomQuote === true }).toEqual({ depth, quoteOnly: true });
    }
  });

  test('low-confidence turf keeps its turf reason first and lists both reasons', () => {
    const line = topDressingLine(generateEstimate({ ...LOT_ONLY, services: { topDressing: { depth: 'eighth' } } }));
    expect(line.requiresCustomQuote).toBe(true);
    expect(line.customQuoteReason).toBe('low_confidence_turf_requires_field_verification');
    expect(line.manualReviewReasons).toEqual(expect.arrayContaining([
      'low_confidence_turf_requires_field_verification',
      'top_dressing_quote_only',
    ]));
  });

  test('low-confidence turf with an explicit area drops only the turf reason', () => {
    const line = topDressingLine(generateEstimate({
      ...LOT_ONLY, services: { topDressing: { depth: 'eighth', lawnSqFt: 2000 } },
    }));
    expect(line.requiresCustomQuote).toBe(true);
    expect(line.customQuoteReason).toBe('top_dressing_quote_only');
    expect(line.manualReviewReasons).toEqual(['top_dressing_quote_only']);
  });

  test('the reasons reach the estimate-level review metadata', () => {
    const estimate = generateEstimate({ ...MEASURED, services: { topDressing: { depth: 'eighth' } } });
    expect(estimate.pricingMetadata.manualReviewReasons).toContain('top_dressing_quote_only');
  });

  test('a bundled recurring lawn does not make top dressing priceable', () => {
    const line = topDressingLine(generateEstimate({
      ...MEASURED,
      services: { lawn: { track: 'st_augustine', tier: 'enhanced' }, topDressing: { depth: 'eighth' } },
    }));
    expect(line.requiresCustomQuote).toBe(true);
  });

  test('the saved estimate data trips the send gate (deep quote scan)', () => {
    const estimate = generateEstimate({ ...MEASURED, services: { topDressing: { depth: 'eighth' } } });
    expect(estimateDataHasQuoteRequirement({ engineResult: estimate })).toBe(true);
    expect(estimateDataHasQuoteRequirement(mapV1ToLegacyShape(estimate))).toBe(true);
  });
});

describe('public paths never show a formula price for top dressing', () => {
  test('the mapped estimate row is Quote Required with no amount and no tier', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate({
      ...MEASURED, services: { topDressing: { depth: 'quarter' } },
    }));
    const row = mapped.oneTime.specItems.find((item) => item.service === 'top_dressing');
    expect(row).toMatchObject({ price: null, quoteRequired: true, customQuoteReason: 'top_dressing_quote_only' });
    expect(mapped.oneTime.total).toBe(0);
    expect(mapped.results.td).toBeUndefined();
    expect(mapped.results.tdTiers).toBeUndefined();
  });

  test('the public pricing range feed no longer publishes top dressing', () => {
    const payload = computePublicPricingRanges({ refresh: true });
    expect(payload.services.map((s) => s.key)).not.toContain('top_dressing');
    expect(payload.errors).toEqual([]);
  });

  test('the public quote route parks the line as a manual quote and reuses the quote-on-request copy', () => {
    const estimate = generateEstimate({ ...MEASURED, services: { topDressing: { depth: 'eighth' } } });
    const line = topDressingLine(estimate);
    // The route filters lineItems with isManualQuoteLine, then reads the reason.
    expect(_internals.isManualQuoteLine(line)).toBe(true);
    const reason = line.reason || line.customQuoteReason || line.manualReviewReasons?.[0];
    expect(reason).toBe('top_dressing_quote_only');
    expect(_internals.isPricedByTeamReason(reason)).toBe(true);
    expect(_internals.isPricedByTeamReason('quote_on_request')).toBe(true);
    // Other manual-quote reasons keep their own copy.
    expect(_internals.isPricedByTeamReason('low_confidence_turf_requires_field_verification')).toBe(false);
    expect(_internals.isPricedByTeamReason('commercial_property_manual_quote_required')).toBe(false);
  });
});
