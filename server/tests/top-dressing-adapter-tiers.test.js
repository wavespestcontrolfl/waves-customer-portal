const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { priceTopDressing } = require('../services/pricing-engine/service-pricing');

const features = {
  shrubs: 'moderate',
  trees: 'moderate',
  complexity: 'moderate',
  pool: false,
  poolCage: false,
  largeDriveway: false,
  nearWater: false,
};
const BASE = {
  homeSqFt: 2000,
  stories: 1,
  lotSqFt: 8000,
  measuredTurfSf: 8000,
  propertyType: 'single_family',
  zone: 'A',
  features,
  recurringCustomer: false,
  paymentMethod: 'card',
};

// Top dressing is quote-only (owner 2026-10-29): the adapter maps the engine
// line to a null-price Quote Required row and never builds numeric depth tiers.
describe('top dressing adapter (quote-only)', () => {
  test('maps the line to a Quote Required row with no depth tiers', () => {
    const estimate = generateEstimate({
      ...BASE,
      services: {
        lawn: { track: 'st_augustine', tier: 'standard' },
        topDressing: { depth: 'eighth' },
      },
    });

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.items.find((item) => item.service === 'top_dressing')).toBeUndefined();
    const row = mapped.oneTime.specItems.find((item) => item.service === 'top_dressing');

    expect(row).toMatchObject({
      name: 'Lawn Top Dressing Service',
      price: null,
      quoteRequired: true,
      requiresCustomQuote: true,
      customQuoteReason: 'top_dressing_quote_only',
    });
    expect(mapped.oneTime.total).toBe(0);
    expect(mapped.quoteRequired).toBe(true);
    expect(mapped.quoteRequiredItems.map((item) => item.service)).toContain('top_dressing');
    // No tier may carry a number the office could read as a sendable price.
    expect(mapped.results.td).toBeUndefined();
    expect(mapped.results.tdTiers).toBeUndefined();
  });

  test('a recurring customer discount does not turn it back into a priced row', () => {
    const estimate = generateEstimate({
      ...BASE,
      services: {
        lawn: { track: 'st_augustine', tier: 'standard' },
        topDressing: { depth: 'eighth' },
      },
      recurringCustomer: true,
    });

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.isRecurringCustomer).toBe(true);
    expect(mapped.oneTime.items.find((item) => item.service === 'top_dressing')).toBeUndefined();
    const row = mapped.oneTime.specItems.find((item) => item.service === 'top_dressing');
    expect(row.price).toBeNull();
    expect(row.quoteRequired).toBe(true);
    expect(mapped.oneTime.total).toBe(0);
    expect(mapped.results.tdTiers).toBeUndefined();
  });

  test('a stored pre-rule line (no quote flag) keeps its server-authoritative tiers', () => {
    const estimate = generateEstimate({
      ...BASE,
      services: {
        lawn: { track: 'st_augustine', tier: 'standard' },
        topDressing: { depth: 'eighth' },
      },
    });
    for (const line of estimate.lineItems) {
      if (line.service !== 'top_dressing') continue;
      delete line.requiresCustomQuote;
      delete line.requiresManualReview;
      delete line.customQuoteReason;
      delete line.manualReviewReasons;
    }

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.items.find((item) => item.service === 'top_dressing')).toMatchObject({
      name: 'Lawn Top Dressing Service',
      price: 271,
    });
    expect(mapped.results.tdTiers).toEqual([
      { name: '1/8" Depth', price: 271, detail: 'St. Augustine standard' },
      { name: '1/4" Depth', price: 543, detail: 'Bermuda / leveling — 2x material' },
    ]);
  });

  test('an explicit top-dress area still prices the engine line as-is, scoped in the detail', () => {
    const base = { ...BASE, lotSqFt: 16000, measuredTurfSf: 16000 };
    const fullLawn = generateEstimate({ ...base, services: { topDressing: { depth: 'eighth' } } });
    const partial = generateEstimate({ ...base, services: { topDressing: { depth: 'eighth', lawnSqFt: 8000 } } });

    const fullLine = fullLawn.lineItems.find((line) => line.service === 'top_dressing');
    const partialLine = partial.lineItems.find((line) => line.service === 'top_dressing');

    // The audit number stays on the raw engine line: the explicit area is used
    // as-is, bypassing the 0.65 non-recurring reduction of the full-lawn path.
    expect(partialLine.price).toBe(priceTopDressing(8000, 'eighth', true).price);
    expect(partialLine.price).toBeLessThan(fullLine.price);
    expect(partialLine.detail).toBe('Covers 8,000 sq ft');
    expect(fullLine.detail || '').not.toMatch(/Covers/);
    // Both are quote-only, partial or whole.
    expect(partialLine.requiresCustomQuote).toBe(true);
    expect(fullLine.requiresCustomQuote).toBe(true);
    const mappedPartial = mapV1ToLegacyShape(partial).oneTime.specItems
      .find((item) => item.service === 'top_dressing');
    expect(mappedPartial.price).toBeNull();
  });
});
