// The public estimate page sells a plan-start quote exactly as frozen (codex
// pre-push P0s on the plan-start build). The mint publishes only what the
// page's own sentSnapshotServesAsIs serves, so the page and the mint share one
// predicate. A quarterly pest quote is the case the generic totals check
// misses: its opening entry's yearly figure is 37.67 x 12 = 452.04 while the
// quote bills 4 x 113 = 452. Real page builders here, fixed numbers (the
// stored engine result shape serverRecomputeFromEstimateData returns), no DB.
const { buildPricingBundle, sentSnapshotServesAsIs } = require('../routes/estimate-public');
const {
  pricingBundleMatchesEstimateTotals,
  openingEntryForService,
  displayedPerApplication,
} = require('../services/estimate-pricing-bundle-utils');

function pestResult({ pa, ann, mo }) {
  return {
    hasRecurring: true,
    hasOneTime: true,
    quoteRequired: false,
    fieldVerify: [],
    engineVersion: 'test',
    recurring: {
      serviceCount: 1, tier: 'Bronze', waveGuardTier: 'Bronze', discount: 0, monthlyTotal: mo, annualTotal: ann, annualAfterDiscount: ann,
      services: [{ name: 'Pest Control', service: 'pest_control', mo, monthly: mo, perTreatment: pa, visitsPerYear: 4, annualAfterDiscount: ann, pricingVersion: 'v2' }],
    },
    oneTime: { items: [], specItems: [], total: 99, tmInstall: 0, membershipFee: 99, otSubtotal: 99 },
    totals: { monthlyTotal: mo, annualTotal: ann, onetimeTotal: 99 },
    results: {
      pestTiers: [
        { label: 'Quarterly', pa, apps: 4, ann, mo, init: 99, recommended: true, pricingVersion: 'v2' },
        { label: 'Bi-Monthly', pa: 99.44, apps: 6, ann: 596.64, mo: 49.72, init: 99, recommended: false, dimmed: true, pricingVersion: 'v2' },
        { label: 'Monthly', pa: 88.14, apps: 12, ann: 1057.68, mo: 88.14, init: 99, recommended: false, dimmed: true, pricingVersion: 'v2' },
      ],
    },
  };
}
// The estimate_data the plan-start mint stores for a quarterly pest start, before its snapshot.
const planStartData = (tier) => ({
  engineInputs: { homeSqFt: 2100, lotSqFt: 9000, stories: 1, propertyType: 'single_family', services: { pest: { frequency: 'quarterly', version: 'v2' } } },
  noEngagementAutomation: true,
  planStart: { families: ['pest_control'], serviceKey: 'pest_control', optionId: 'pest-quarterly', mintedAt: '2026-11-19T12:00:00.000Z' },
  result: pestResult(tier),
});
// Each row gets its own id: the page's pricing cache is keyed by estimate.
const planStartRow = (id, estimateData, extra = {}) => ({
  id, source: 'plan_start', status: 'sent', sent_at: '2026-11-19T12:00:00.000Z', customer_id: null, waveguard_tier: 'Bronze',
  monthly_total: 37.67, annual_total: 452, onetime_total: 99, estimate_data: JSON.stringify(estimateData), ...extra,
});
const MINTED = { pa: 113, ann: 452, mo: 37.67 };
const page = (row) => buildPricingBundle(row, { monthlyBilled: false });
const opening = (bundle) => openingEntryForService(bundle, 'pest_control');

describe('a plan-start quote reopens on its frozen snapshot', () => {
  let frozen;
  let sentData;
  beforeAll(async () => {
    // What the mint freezes: the page's own bundle for the fresh row.
    frozen = await page(planStartRow('ps-freeze', planStartData(MINTED)));
    sentData = { ...planStartData(MINTED), sendSnapshot: { pricingBundle: frozen } };
  });

  test('the opening entry shows the minted price, and no entry carries both totals (the gap)', () => {
    expect(opening(frozen)).toMatchObject({ key: 'quarterly', monthly: 37.67, annual: 452.04 });
    expect(displayedPerApplication(opening(frozen))).toEqual({ amount: 113, visits: 4 });
    expect(pricingBundleMatchesEstimateTotals(frozen, planStartRow('ps-gap', sentData))).toBe(false);
  });

  test('the page serves the snapshot as is for a plan start, and only for a plan start', () => {
    expect(sentSnapshotServesAsIs(frozen, planStartRow('ps-serve', sentData), sentData)).toBe(true);
    expect(sentSnapshotServesAsIs(frozen, planStartRow('ps-other', sentData, { source: null }), sentData)).toBe(false);
  });

  test.each([
    ['monthly total', { monthly_total: 38.5 }],
    ['yearly total', { annual_total: 460 }],
  ])('a row whose %s no longer matches its snapshot is rebuilt, not served', (_label, moved) => {
    expect(sentSnapshotServesAsIs(frozen, planStartRow('ps-moved', sentData, moved), sentData)).toBe(false);
  });

  test('the mint\'s own check passes this page at the card\'s amounts and catches moved one-time money', () => {
    // The card shows the quarterly price and the $99 WaveGuard setup fee (the line's initialFee);
    // the page itemizes the fee on its own line (result.oneTime.membershipFee).
    const CARD = { monthly: 37.67, perVisit: 113, dueAtStart: null, oneTime: null, setupFee: 99 };
    const { planStartQuoteMismatch } = require('../services/cancellation-resolution/restart')._test;
    const check = (row, { bundle = frozen, shown = CARD } = {}) => planStartQuoteMismatch({
      bundle, row, data: sentData, family: 'pest_control', shown, servesAsIs: sentSnapshotServesAsIs,
    });
    expect(frozen.oneTimeBreakdown).toMatchObject({ total: 99, items: [expect.objectContaining({ service: 'waveguard_setup', amount: 99, kind: 'charge' })] });
    expect(check(planStartRow('ps-check', sentData))).toBeNull();
    expect(check(planStartRow('ps-check-row', sentData, { onetime_total: 0 }))).toBe('one-time charges differ from the card');
    expect(check(planStartRow('ps-check-card', sentData), { shown: { ...CARD, dueAtStart: 50 } })).toBe('one-time charges differ from the card');
    expect(check(planStartRow('ps-check-fee', sentData), { shown: { ...CARD, setupFee: null } })).toBe('one-time charges differ from the card');
    expect(check(planStartRow('ps-check-price', sentData), { shown: { ...CARD, perVisit: 112 } })).toBe('opening entry quarterly shows another price');
    expect(check(planStartRow('ps-check-gone', sentData), { bundle: null })).toBe('no page snapshot');
  });

  test('after the price behind it moves, the page still opens on the frozen price', async () => {
    // A rebuild now prices $125 per application; the row and its snapshot stay as minted.
    const movedData = planStartData({ pa: 125, ann: 500, mo: 41.67 });
    const reopened = await page(planStartRow('ps-reopen', { ...movedData, sendSnapshot: { pricingBundle: frozen } }));
    expect(reopened.snapshotHit).toBe(true);
    expect(opening(reopened)).toMatchObject({ key: 'quarterly', monthly: 37.67 });
    expect(displayedPerApplication(opening(reopened))).toEqual({ amount: 113, visits: 4 });
    // The lever is real: with no snapshot, the same page prices the moved tier.
    const rebuilt = await page(planStartRow('ps-rebuild', movedData));
    expect(rebuilt.snapshotHit).not.toBe(true);
    expect(displayedPerApplication(opening(rebuilt))).toEqual({ amount: 125, visits: 4 });
  });
});

// The server copy of the price card's per-application headline (client PriceCard
// perApplicationNetForFrequency, with the card's quote and range guards).
describe('displayedPerApplication reads the price card\'s per-application headline', () => {
  test.each([
    ['the one priced row\'s net price, over its visits', { key: 'quarterly', perTreatment: 120, perServiceTreatments: [{ perTreatment: 120, displayPrice: 113, visitsPerYear: 4 }] }, { amount: 113, visits: 4 }],
    ['no priced row: the entry\'s own price over its visits', { key: 'seasonal9', perTreatment: 77, visitsPerYear: 9, perServiceTreatments: [] }, { amount: 77, visits: 9 }],
    ['no priced row and no visits: the cadence\'s visits', { key: 'quarterly', perTreatment: 113 }, { amount: 113, visits: 4 }],
    ['several priced rows: no single price', { key: 'quarterly', perServiceTreatments: [{ displayPrice: 113, visitsPerYear: 4 }, { displayPrice: 65, visitsPerYear: 9 }] }, null],
    ['a quote-required entry', { key: 'quarterly', perTreatment: 113, visitsPerYear: 4, quoteRequired: true }, null],
    ['a price range in place of the price', { key: 'quarterly', perTreatment: 113, visitsPerYear: 4, lowConfidenceRangePct: 0.1 }, null],
  ])('%s', (_label, entry, expected) => {
    expect(displayedPerApplication(entry)).toEqual(expected);
  });
});
