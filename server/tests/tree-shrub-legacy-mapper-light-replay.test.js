/**
 * codex pre-push P1 (2026-09-24, T&S quarterly retirement): replaying a
 * grandfathered customer's stored Light (4x/quarterly) engine result
 * through the v1 legacy mapper must NOT relabel it as "Standard" while
 * still carrying Light's visit count and price. TREE_SHRUB_LEGACY_TIERS no
 * longer includes 'light', so treeShrubLegacyTierRows' selected-tier
 * display fallback (to 'standard', mirroring the lawn ladder's "no
 * matching option" precedent) must not also gate reusing the priced line
 * item's raw pa/v/ann/mo fields — only the tier that ACTUALLY matches what
 * was priced may reuse them; every other row (including the display
 * fallback) must be freshly computed for its own tier.
 */
const { treeShrubLegacyTierRows } = require('../services/pricing-engine/v1-legacy-mapper');
const { priceTreeShrub } = require('../services/pricing-engine/service-pricing');

const PROPERTY = { bedArea: 2000, features: { access: 'easy' } };

function lightLineItem() {
  // Mirrors what a stored/replayed engine result for the grandfathered
  // quarterly customer looks like: tier 'light', 4 visits/yr, priced at
  // Light's (lower) rate — includeHiddenTiers lets the pricer still
  // compute it explicitly, exactly as a real replay would.
  const quote = priceTreeShrub(PROPERTY, { tier: 'light', access: 'easy', includeHiddenTiers: true });
  return {
    tier: 'light',
    perApp: quote.perApp,
    frequency: quote.frequency,
    annual: quote.annual,
    monthly: quote.monthly,
    access: 'easy',
  };
}

describe('treeShrubLegacyTierRows — replaying a retired Light selection', () => {
  test('the Standard row is freshly priced at 6x, never Light\'s 4x price under the Standard label', () => {
    const tsLI = lightLineItem();
    const rows = treeShrubLegacyTierRows({ property: PROPERTY }, tsLI);
    const standardRow = rows.find((r) => r.tier === 'standard');
    const enhancedRow = rows.find((r) => r.tier === 'enhanced');
    expect(rows.map((r) => r.tier)).toEqual(['standard', 'enhanced']);

    // Display fallback: Standard is marked selected (Light is off the
    // ladder), but its NUMBERS are its own — never Light's 4-visit figures.
    expect(standardRow.selected).toBe(true);
    expect(standardRow.v).toBe(6);
    expect(standardRow.v).not.toBe(tsLI.frequency);
    expect(standardRow.mo).not.toBe(tsLI.monthly);

    // Sanity: Standard's freshly computed price matches an independent
    // direct priceTreeShrub('standard') call — not derived from Light's row.
    // (roundedTreeShrubTierQuote rounds annual to whole dollars FIRST, then
    // derives monthly — mirror that exact order rather than the raw annual.)
    const freshStandard = priceTreeShrub(PROPERTY, { tier: 'standard', access: 'easy' });
    const freshStandardAnnual = Math.round(freshStandard.annual);
    expect(standardRow.mo).toBe(Math.round(freshStandardAnnual / 12 * 100) / 100);
    expect(standardRow.ann).toBe(freshStandardAnnual);
    expect(enhancedRow.v).toBe(9);
    expect(enhancedRow.selected).toBe(false);
  });

  test('a live standard selection still takes the fast path (reuses the priced line item verbatim)', () => {
    const quote = priceTreeShrub(PROPERTY, { tier: 'standard', access: 'easy' });
    const tsLI = { tier: 'standard', perApp: quote.perApp, frequency: quote.frequency, annual: quote.annual, monthly: quote.monthly, access: 'easy' };
    const rows = treeShrubLegacyTierRows({ property: PROPERTY }, tsLI);
    const standardRow = rows.find((r) => r.tier === 'standard');
    expect(standardRow.selected).toBe(true);
    expect(standardRow.mo).toBe(tsLI.monthly);
    expect(standardRow.v).toBe(tsLI.frequency);
  });
});
