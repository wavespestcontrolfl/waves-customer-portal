// get_estimate_detail: what an estimate offered, read through the public
// route's own composer (membership reconciliation first, then the pricing
// bundle), never a hand-itemized reading of estimate_data.
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__queries = [];
  db.__rows = () => [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    db.__queries.push(query);
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
const mockCallSideBlock = jest.fn(async () => null);
jest.mock('../utils/estimate-claim-sql', () => ({ callSideBlockForEstimateData: (...a) => mockCallSideBlock(...a) }));
const calls = [];
const mockBuildPricingBundle = jest.fn(async () => ({ frequencies: [] }));
const mockReconcile = jest.fn(async () => undefined);
jest.mock('../routes/estimate-public', () => {
  const unpublished = ['draft', 'scheduled'];
  return {
    buildPricingBundle: (...a) => { calls.push('bundle'); return mockBuildPricingBundle(...a); },
    reconcileFrozenMembershipSnapshot: (...a) => { calls.push('reconcile'); return mockReconcile(...a); },
    resolveEstimateInvoiceMode: (e, data) => e.bill_by_invoice === true || data?.rodentGuaranteeOnly === true,
    isEstimateCustomerViewable: (e) => !e.archived_at && !unpublished.includes(e.status) && !['expired', 'send_failed'].includes(e.status),
    adminDraftPreviewEligible: (e, p) => p === '1' && !e.archived_at && unpublished.includes(e.status),
    // Real defaultFrequencyFromList: selected/recommended row first, else the
    // first entry — same fallback order the route itself uses.
    defaultFrequencyFromList: (frequencies = []) => {
      if (!Array.isArray(frequencies) || frequencies.length === 0) return null;
      return frequencies.find((f) => f?.selected === true || f?.recommended === true || f?.isRecommended === true) || frequencies[0] || null;
    },
  };
});
const mockBillingContext = jest.fn(async () => ({ billsPerApplication: false, livePricing: null }));
jest.mock('../services/estimate-proposal-billing', () => ({
  resolveProposalBillingContext: (...a) => mockBillingContext(...a),
  // Real predicate mirrored (estimate-proposal-billing.js): committed statuses
  // or an explicit price_locked_at stamp freeze the document.
  estimateIsPriceLocked: (estimate) => new Set(['accepted', 'declined']).has(String(estimate?.status || '').trim().toLowerCase()) || !!estimate?.price_locked_at,
}));
const db = require('../models/db');
const { getEstimateDetail, shapeEstimate, GET_ESTIMATE_DETAIL_TOOL } = require('../services/intelligence-bar/estimate-detail');

const estimateRow = (overrides = {}) => ({
  id: 'est-1', customer_id: 'cust-1', customer_name: 'Avery Example', address: '100 Test St',
  status: 'sent', category: 'RESIDENTIAL', service_interest: 'Quarterly Pest Control', waveguard_tier: 'silver',
  monthly_total: '47.00', annual_total: '564.00', onetime_total: '125.00', token: 'xydejpzuxx',
  sent_at: '2026-09-05T15:00:00Z', viewed_at: null, accepted_at: null, declined_at: null, expires_at: null, archived_at: null,
  view_count: 2, notes: 'Includes exterior perimeter treatment', pricing_version: 'v2', bill_by_invoice: false, show_one_time_option: false,
  accepted_service_mode: null, accepted_frequency_key: null, disposition: null, disposition_note: null, decline_reason: null,
  created_at: '2026-09-05T14:00:00Z', updated_at: '2026-09-05T15:00:00Z',
  estimate_data: JSON.stringify({
    recurring: { services: [{ name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4, monthly: 47, annual: 564 }] },
    membershipSnapshot: { isExistingCustomer: true },
    agentDraftReview: { reasoning: 'internal only' },
  }),
  ...overrides,
});

const BUNDLE = {
  defaultServiceMode: 'recurring',
  waveGuardTier: 'Silver',
  frequencies: [{
    key: 'quarterly', label: 'Quarterly', monthly: 92, annual: 1104, perVisit: 141, visitsPerYear: 4, oneTimeTotal: null, annualPrepayEligible: true, billedPerApplication: true,
    // one allocated treatment row: its NET displayPrice is the per-application figure the page shows, not the outer anchor
    perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', perTreatment: 141, displayPrice: 131, visitsPerYear: 4, waveGuardDiscountEligible: true }],
    manualDiscount: { amount: 40, recurringAmount: 40 },
  }],
  services: [
    { key: 'pest_control', label: 'Pest Control', defaultFrequencyKey: 'bi_monthly', frequencies: [
      { key: 'quarterly', label: 'Quarterly', monthly: 47, annual: 564, perTreatment: 141, visitsPerYear: 4, billedPerApplication: true, manualDiscountSuppressed: true },
      { key: 'bi_monthly', label: 'Bi-monthly', monthly: 55, annual: 660, perTreatment: 110, visitsPerYear: 6, billedPerApplication: true },
    ] },
    { key: 'lawn_care', label: 'Lawn Care', defaultFrequencyKey: 'enhanced', frequencies: [
      { key: 'standard', label: 'Standard', monthly: 45, annual: 540, visitsPerYear: 6 },
      { key: 'enhanced', label: 'Enhanced', monthly: 51.98, annual: 623.76, visitsPerYear: 9, quoteRequired: true },
    ] },
    { key: 'commercial_pest', label: 'Commercial Pest', defaultFrequencyKey: 'monthly', frequencies: [
      { key: 'monthly', label: 'Monthly', monthly: 200, annual: 2400, perTreatment: 200, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 0.5 },
    ] },
  ],
  serviceCadenceCombos: [{
    key: 'lawn_care:enhanced|pest_control:quarterly', selection: { lawn_care: 'enhanced', pest_control: 'quarterly' },
    monthly: 98.98, annual: 1187.76,
    perServiceTreatments: { pest_control: { perTreatment: 131, treatments: 4 }, lawn_care: { perTreatment: 60.45, treatments: 9 } },
    manualDiscount: { amountAnnual: 40, capped: false }, manualDiscountSuppressed: true,
  }],
  // the roach fee recurs inside the breakdown (compatibility alias) — the page renders it once, as a fee card
  oneTimeBreakdown: { items: [{ service: 'pest_initial_roach', label: 'Cockroach Treatment Service', amount: 150, detail: '2 treatments' }, { service: 'exclusion', label: 'Exclusion work', amount: 450, detail: null }, { service: null, label: 'Custom exclusion', amount: null, quoteRequired: true }], total: 600, quoteRequired: true },
  anchorOneTimePrice: 125,
  firstVisitFees: [{ service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true }, { service: 'pest_initial_roach', amount: 150, label: 'Cockroach Treatment Service', treatments: 2, waivedWithPrepay: false }],
  setupFee: { service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true },
  rodentBaitSetupFee: { service: 'rodent_bait_setup', amount: 250, label: 'Bait Station Setup', waivedWithPrepay: false },
  manualDiscount: { amountAnnual: 40 },
  source: 'engine_invocation',
};

beforeEach(() => {
  calls.length = 0;
  mockBuildPricingBundle.mockReset();
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [] });
  mockReconcile.mockReset();
  mockReconcile.mockResolvedValue(undefined);
  mockCallSideBlock.mockReset();
  mockCallSideBlock.mockResolvedValue(null);
  mockBillingContext.mockReset();
  mockBillingContext.mockResolvedValue({ billsPerApplication: false, livePricing: null });
  db.__rows = () => [];
});

test('tool definition names the per-application use, takes either selector, types the ids, and says what it does not itemize', () => {
  expect(GET_ESTIMATE_DETAIL_TOOL.name).toBe('get_estimate_detail');
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/per-application/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/exactly as the customer's estimate page prices it/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/does not itemize the internal engine rows/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/monthly-billed plan reports billing_unit monthly/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/never the same fee twice/);
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties.estimate_id.format).toBe('uuid');
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties.customer_id.format).toBe('uuid');
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.required).toBeUndefined();
});

test('offered pricing is the public bundle verbatim in shape: cadences, ladders, combos with per-service allocations + manual-discount state, one-time breakdown, fees (Codex r4)', async () => {
  mockBuildPricingBundle.mockResolvedValue(BUNDLE);
  const row = estimateRow();
  const shaped = await shapeEstimate(row);
  expect(mockBuildPricingBundle).toHaveBeenCalledWith(row);
  const noRows = { per_service_treatments: [], manual_discount: null };
  expect(shaped.offered_pricing).toEqual({
    default_service_mode: 'recurring',
    waveguard_tier: 'Silver',
    price_locked: false,
    // BUNDLE never sets snapshotHit (the route only stamps it on the frozen-
    // snapshot fast path) — its absence means this bundle was rebuilt, so
    // the rebuilt bundle's own default sellable cadence rides here too
    // (Codex r-head P1: totals must come from it, not the stale columns).
    snapshot_hit: false,
    rebuilt_default_frequency: { key: 'quarterly', monthly: 92, annual: 1104 },
    plan_frequencies: [{
      key: 'quarterly', label: 'Quarterly', monthly: 92, annual: 1104, visits_per_year: 4, billing_unit: 'per_application',
      per_application: 131, // the single treatment row's net displayPrice, not the outer 141 anchor (PriceCard rule)
      per_service_treatments: [{ service: 'pest_control', label: 'Pest Control', per_treatment: 141, display_price: 131, visits_per_year: 4, waveguard_discount_eligible: true }],
      manual_discount: { amount: 40, recurringAmount: 40 }, annual_prepay_eligible: true,
    }],
    services: [
      { key: 'pest_control', label: 'Pest Control', default_frequency_key: 'bi_monthly', frequencies: [
        { key: 'quarterly', label: 'Quarterly', monthly: 47, annual: 564, visits_per_year: 4, billing_unit: 'per_application', per_application: 141, ...noRows, manual_discount_suppressed: true },
        { key: 'bi_monthly', label: 'Bi-monthly', monthly: 55, annual: 660, visits_per_year: 6, billing_unit: 'per_application', per_application: 110, ...noRows },
      ] },
      { key: 'lawn_care', label: 'Lawn Care', default_frequency_key: 'enhanced', frequencies: [
        { key: 'standard', label: 'Standard', monthly: 45, annual: 540, visits_per_year: 6, billing_unit: 'monthly', per_application: null, ...noRows },
        { key: 'enhanced', label: 'Enhanced', monthly: 51.98, annual: 623.76, visits_per_year: 9, billing_unit: 'monthly', per_application: null, ...noRows, quote_required: true },
      ] },
      { key: 'commercial_pest', label: 'Commercial Pest', default_frequency_key: 'monthly', frequencies: [
        // per_application is null: the page shows the RANGE and no exact per-application headline (PriceCard perAppNet rule, Codex r7 P1).
        // monthly/annual are also null: PriceCard's headline renders the range string, never the raw monthly figure (pre-push audit P1).
        { key: 'monthly', label: 'Monthly', monthly: null, annual: null, visits_per_year: 12, billing_unit: 'per_application', per_application: null, ...noRows,
          // price ± price × fraction × pct (PriceCard): 200 × 0.5 × 0.2 = 20
          low_confidence_range: { pct: 0.2, fraction: 0.5, range_unit: 'monthly', cadence: [180, 220], annual: [2160, 2640] } },
      ] },
    ],
    combos: [{
      key: 'lawn_care:enhanced|pest_control:quarterly', selection: { lawn_care: 'enhanced', pest_control: 'quarterly' },
      monthly: 98.98, annual: 1187.76,
      per_service_treatments: { pest_control: { perTreatment: 131, treatments: 4 }, lawn_care: { perTreatment: 60.45, treatments: 9 } },
      manual_discount: { amountAnnual: 40, capped: false }, manual_discount_suppressed: true,
    }],
    one_time_total: 125,
    upfront_fees: [
      { service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, waived_with_prepay: true },
      { service: 'pest_initial_roach', label: 'Cockroach Treatment Service', amount: 150, waived_with_prepay: false, treatments: 2 },
      { service: 'rodent_bait_setup', label: 'Bait Station Setup', amount: 250, waived_with_prepay: false },
    ],
    setup_fee_service: 'waveguard_setup',
    one_time_breakdown: {
      items: [
        { service: 'exclusion', label: 'Exclusion work', amount: 450, detail: null },
        { service: null, label: 'Custom exclusion', amount: null, detail: null, quote_required: true },
      ],
      excluded_upfront_fee_services: ['waveguard_setup', 'pest_initial_roach', 'rodent_bait_setup'],
      total: 450, // recomputed from the remaining items once a fee was excluded (OneTimeBreakdownCard rule), not the composer's 600
      quote_required: true,
    },
    manual_discount: { amountAnnual: 40 },
    quote_required: false,
    quote_required_reason: null,
    quote_required_items: [],
    source: 'engine_invocation',
  });
  // totals.one_time is the composer's corrected page figure, not the raw
  // column; monthly/annual come from the rebuilt bundle's own default
  // cadence too (92/1104), not the stale row columns (47/564) — a rebuilt
  // bundle's prices no longer match the frozen columns (Codex r-head P1).
  expect(shaped.totals).toEqual({ monthly: 92, annual: 1104, one_time: 125, source: 'rebuilt_bundle_default' });
  expect(shaped.requote_required).toBe(false);
  expect(shaped.offered_pricing_unavailable).toBeUndefined();
  // No hand-itemized reading of estimate_data rides on the response.
  expect(shaped.recurring_services).toBeUndefined();
  expect(shaped.one_time_items).toBeUndefined();
  expect(JSON.stringify(shaped)).not.toMatch(/internal only/);
  expect(shaped).toMatchObject({ customer: 'Avery Example', tier: 'silver', bill_by_invoice: false, customer_link: 'https://portal.wavespestcontrol.com/estimate/xydejpzuxx', link_state: 'customer_viewable', view_count: 2 });
});

test('per-application follows PriceCard\'s full resolver: priced treatment row first, else perTreatment with visits from the cadence, a single visit row, or the cadence key', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [
    { key: 'quarterly', perTreatment: 140, billedPerApplication: true }, // legacy: no visitsPerYear → 4 from the key
    { key: 'bi_monthly', perTreatment: 110, billedPerApplication: true, perServiceTreatments: [{ service: 'pest_control', visitsPerYear: 6 }] }, // one visit-bearing unpriced row
    { key: 'custom', perTreatment: 90, billedPerApplication: true }, // unknown key, no visits anywhere → no figure
    { key: 'monthly', perTreatment: 50, billedPerApplication: true, perServiceTreatments: [{ service: 'a', displayPrice: 30, visitsPerYear: 12 }, { service: 'b', displayPrice: 20, visitsPerYear: 12 }] }, // two priced rows → ambiguous
    { key: 'quarterly', perTreatment: 140, billedPerApplication: true, perServiceTreatments: [{ service: 'a', monthly: 40, visitsPerYear: 4 }] }, // one row priced only monthly → no per-app figure
  ] });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.offered_pricing.plan_frequencies.map((f) => f.per_application)).toEqual([140, 110, null, null, null]);
  const breakdownOnly = await shapeEstimate(estimateRow());
  expect(breakdownOnly.offered_pricing.one_time_breakdown).toBeNull();
});

test('a breakdown with nothing excluded keeps the composer\'s total', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], firstVisitFees: [], oneTimeBreakdown: { items: [{ service: 'exclusion', label: 'Exclusion', amount: 450 }], total: 455.5 } });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.offered_pricing.one_time_breakdown).toMatchObject({ total: 455.5, excluded_upfront_fee_services: [] });
});

test('a legacy monthly-billed member (composer strips billedPerApplication) reports a monthly charge, never an invented per-application price; bill_by_invoice is the effective mode', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [{ key: 'monthly', label: 'Monthly', monthly: 60, annual: 720, perTreatment: 180, visitsPerYear: 4, perServiceTreatments: [{ service: 'pest_control', perTreatment: 180, displayPrice: 180, visitsPerYear: 4 }] }] });
  const shaped = await shapeEstimate(estimateRow({ estimate_data: JSON.stringify({ rodentGuaranteeOnly: true }) }));
  expect(shaped.offered_pricing.plan_frequencies[0]).toMatchObject({ billing_unit: 'monthly', per_application: null, monthly: 60 });
  expect(shaped.offered_pricing.plan_frequencies[0].per_service_treatments[0]).toMatchObject({ per_treatment: 180, display_price: 180 });
  expect(shaped.bill_by_invoice).toBe(true); // column false, resolver true
});

test('a lapsed membership is reconciled BEFORE totals and the bundle, on the same row object the public renderers mutate (Codex r4 P1)', async () => {
  mockReconcile.mockImplementation(async (estimate) => {
    // The reconciler reprices in memory: stored totals and the requote flag change on the row it was handed.
    estimate.monthly_total = '61.00';
    estimate.annual_total = '732.00';
    // The real reconciler's marker when no replayable engine input exists; the composer turns it into quoteRequired.
    estimate.estimate_data = JSON.stringify({ ...JSON.parse(estimate.estimate_data), membershipSnapshot: null, membershipLapsedRequote: true });
  });
  mockBuildPricingBundle.mockImplementation(async (estimate) => ({
    frequencies: [{ key: 'quarterly', monthly: Number(estimate.monthly_total), annual: Number(estimate.annual_total) }],
    quoteRequired: JSON.parse(estimate.estimate_data).membershipLapsedRequote === true,
    quoteRequiredReason: 'membership_lapsed_requote',
    quoteRequiredItems: [],
  }));
  const row = estimateRow();
  const shaped = await shapeEstimate(row);
  expect(calls).toEqual(['reconcile', 'bundle']);
  expect(mockReconcile).toHaveBeenCalledWith(row);
  // No sendSnapshot on this row's estimate_data → the bundle is rebuilt
  // (snapshot_hit false), so totals come from its own reconciled frequency,
  // which happens to equal the just-reconciled columns here.
  expect(shaped.totals).toEqual({ monthly: 61, annual: 732, one_time: 125, source: 'rebuilt_bundle_default' });
  expect(shaped.offered_pricing.plan_frequencies[0].monthly).toBe(61);
  // Quote-required state is the bundle's verdict, surfaced twice: on offered_pricing and as the top-level flag + reason.
  expect(shaped.offered_pricing).toMatchObject({ quote_required: true, quote_required_reason: 'membership_lapsed_requote', quote_required_items: [] });
  expect(shaped.requote_required).toBe(true);
  expect(shaped.requote_reason).toBe('membership_lapsed_requote');
  expect(shaped.reconciliation_error).toBeUndefined();
});

test('a reconciler or bundle failure is reported on the response, never thrown and never silently a stale answer', async () => {
  mockReconcile.mockRejectedValue(new Error('plan lookup down'));
  mockBuildPricingBundle.mockRejectedValue(new Error('no customer row'));
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.reconciliation_error).toMatch(/plan lookup down/);
  expect(shaped.offered_pricing).toBeNull();
  expect(shaped.offered_pricing_unavailable).toMatch(/withheld: membership reconciliation failed: plan lookup down/);
  expect(shaped.requote_required).toBeNull(); // unknown without the bundle — never a confident "no"
  expect(shaped.requote_reason).toBeNull();
  expect(shaped.totals).toEqual({ monthly: null, annual: null, one_time: null, withheld: true });
  mockReconcile.mockResolvedValue(undefined);
  mockBuildPricingBundle.mockResolvedValue(null);
  const noBundle = await shapeEstimate(estimateRow());
  expect(noBundle.offered_pricing_unavailable).toMatch(/no pricing bundle/);
  // No bundle at all: the stored columns are not the quote this tool
  // reports — withheld, same as a failed reconciliation (pre-push audit P1).
  expect(noBundle.totals).toEqual({ monthly: null, annual: null, one_time: null, withheld: true });
  mockBuildPricingBundle.mockRejectedValue(new Error('no customer row'));
  const bundleThrew = await shapeEstimate(estimateRow());
  expect(bundleThrew.offered_pricing_unavailable).toMatch(/no customer row/);
  expect(bundleThrew.totals).toEqual({ monthly: null, annual: null, one_time: null, withheld: true });
});

test('the real reconciler never throws — it REPORTS { ok: false }: pricing and totals are withheld, the bundle is not even built (Codex r7 P1)', async () => {
  mockReconcile.mockResolvedValue({ ok: false, error: 'membership lookup timed out' });
  mockBuildPricingBundle.mockResolvedValue(BUNDLE);
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.reconciliation_error).toBe('membership reconciliation failed: membership lookup timed out');
  expect(shaped.offered_pricing).toBeNull();
  expect(shaped.offered_pricing_unavailable).toMatch(/withheld/);
  expect(shaped.totals).toEqual({ monthly: null, annual: null, one_time: null, withheld: true });
  expect(shaped.requote_required).toBeNull();
  expect(mockBuildPricingBundle).not.toHaveBeenCalled();
  // { ok: true } and undefined (nothing to reconcile) both price normally
  for (const result of [{ ok: true }, undefined]) {
    mockReconcile.mockResolvedValue(result);
    const ok = await shapeEstimate(estimateRow());
    expect(ok.reconciliation_error).toBeUndefined();
    expect(ok.offered_pricing.plan_frequencies[0].per_application).toBe(131);
    // BUNDLE has no snapshotHit → rebuilt; totals follow its own default
    // cadence (92/1104), not the stale row columns (47/564).
    expect(ok.totals).toEqual({ monthly: 92, annual: 1104, one_time: 125, source: 'rebuilt_bundle_default' });
  }
});

test('a ranged LOW-confidence cadence reports the range and NO exact per-application figure; a quote-required cadence reports neither (PriceCard, Codex r7 P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [
    { key: 'monthly', monthly: 200, annual: 2400, perTreatment: 200, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2 },
    { key: 'monthly', monthly: 200, annual: 2400, perTreatment: 200, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2, quoteRequired: true }, // PriceCard zeroes the range when quote-required
    { key: 'quarterly', monthly: 0, annual: 0, perTreatment: 0, visitsPerYear: 4, billedPerApplication: true, lowConfidenceRangePct: 0.2 }, // no positive price → no range (PriceCard showLowConfidenceRange)
    { key: 'quarterly', monthly: 47, annual: 564, perTreatment: 141, visitsPerYear: 4, billedPerApplication: true, quoteRequired: true },
  ] });
  const [ranged, rangedQuote, zero, quoteOnly] = (await shapeEstimate(estimateRow())).offered_pricing.plan_frequencies;
  // key 'monthly' → interval ×1, so the cadence band equals the raw monthly band.
  // monthly/annual are also null: PriceCard's headline shows the range string,
  // never the raw $200 figure the bundle carries (pre-push audit P1).
  expect(ranged).toMatchObject({ monthly: null, annual: null, per_application: null, low_confidence_range: { pct: 0.2, fraction: 1, range_unit: 'monthly', cadence: [160, 240], annual: [1920, 2880] } });
  // treatment rows on a ranged cadence: PriceCard hides them, so no exact amount rides here either (Codex r8 P1)
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [
    { key: 'monthly', monthly: 200, annual: 2400, perTreatment: 200, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2,
      perServiceTreatments: [{ service: 'commercial_pest', label: 'Commercial Pest', perTreatment: 200, displayPrice: 200, monthly: 200, monthlyBase: 210, visitsPerYear: 12 }] },
  ] });
  const [withheld] = (await shapeEstimate(estimateRow())).offered_pricing.plan_frequencies;
  expect(withheld.per_service_treatments).toEqual([{ service: 'commercial_pest', label: 'Commercial Pest', visits_per_year: 12, prices_withheld: 'low_confidence_range' }]);
  expect(JSON.stringify(withheld.per_service_treatments)).not.toMatch(/200|210/);
  expect(withheld.monthly).toBeNull();
  expect(withheld.annual).toBeNull();
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [
    { key: 'monthly', monthly: 200, annual: 2400, perTreatment: 200, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2 },
    { key: 'monthly', monthly: 200, annual: 2400, perTreatment: 200, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2, quoteRequired: true },
    { key: 'quarterly', monthly: 0, annual: 0, perTreatment: 0, visitsPerYear: 4, billedPerApplication: true, lowConfidenceRangePct: 0.2 },
    { key: 'quarterly', monthly: 47, annual: 564, perTreatment: 141, visitsPerYear: 4, billedPerApplication: true, quoteRequired: true },
  ] });
  expect(rangedQuote.per_application).toBeNull();
  expect(rangedQuote.low_confidence_range).toBeUndefined();
  expect(rangedQuote.quote_required).toBe(true);
  expect(zero.low_confidence_range).toBeUndefined();
  expect(quoteOnly.per_application).toBeNull();
});

test('a narrow low-confidence range on a quarterly or bi-monthly cadence bands the DISPLAYED cadence price (monthly × interval), matching PriceCard, not the raw monthly figure (Codex r-head P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [
    // $100/mo quarterly: PriceCard shows/bands $300/quarter (100 × 3), not $100/mo.
    { key: 'quarterly', monthly: 100, annual: 1200, perTreatment: 100, visitsPerYear: 4, billedPerApplication: true, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 1 },
    // $60/mo bi_monthly: PriceCard shows/bands $120/bi-monthly (60 × 2).
    { key: 'bi_monthly', monthly: 60, annual: 720, perTreatment: 60, visitsPerYear: 6, billedPerApplication: true, lowConfidenceRangePct: 0.5, lowConfidenceFraction: 1 },
  ] });
  const [quarterly, biMonthly] = (await shapeEstimate(estimateRow())).offered_pricing.plan_frequencies;
  // cadencePrice = 100 × 3 = 300; band = 300 × 1 × 0.2 = 60 → [240, 360], not [80, 120].
  expect(quarterly.low_confidence_range).toEqual({ pct: 0.2, fraction: 1, range_unit: 'quarterly', cadence: [240, 360], annual: [960, 1440] });
  // cadencePrice = 60 × 2 = 120; band = 120 × 1 × 0.5 = 60 → [60, 180], not [30, 90].
  expect(biMonthly.low_confidence_range).toEqual({ pct: 0.5, fraction: 1, range_unit: 'bi_monthly', cadence: [60, 180], annual: [360, 1080] });
});

test('a combo carries its OWN annualPrepayEligible boolean, taking precedence over the section ladder on the customer page (EstimateViewPage annualPrepayEligibleEffective, Codex r-head P2)', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], serviceCadenceCombos: [
    // finalizePricingBundle hard-disables prepay on a mosquito-axis combo
    // (multi-service prepay is unsupported) even when the section ladder alone allows it.
    { key: 'lawn_care:enhanced|mosquito:monthly12', selection: { lawn_care: 'enhanced', mosquito: 'monthly12' }, monthly: 150, annual: 1800, annualPrepayEligible: false },
    // A combo can also RESTORE eligibility the estimate-level flag alone would hide.
    { key: 'lawn_care:enhanced|pest_control:quarterly', selection: { lawn_care: 'enhanced', pest_control: 'quarterly' }, monthly: 90, annual: 1080, annualPrepayEligible: true },
    // No flag at all (not a mosquito-axis combo, composer never stamped it): key omitted, not defaulted to false.
    { key: 'lawn_care:enhanced|tree_shrub:quarterly', selection: { lawn_care: 'enhanced', tree_shrub: 'quarterly' }, monthly: 80, annual: 960 },
  ] });
  const [mosquitoAxis, restored, unstamped] = (await shapeEstimate(estimateRow())).offered_pricing.combos;
  expect(mosquitoAxis.annual_prepay_eligible).toBe(false);
  expect(restored.annual_prepay_eligible).toBe(true);
  expect(unstamped.annual_prepay_eligible).toBeUndefined();
});

test('a VALID snapshot (snapshotHit true) keeps the stored monthly_total/annual_total columns — only a rejected-and-rebuilt bundle overrides them (Codex r-head P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({
    frequencies: [{ key: 'quarterly', monthly: 999, annual: 11988 }], // deliberately different from the row columns
    snapshotHit: true,
  });
  const shaped = await shapeEstimate(estimateRow({ monthly_total: '47.00', annual_total: '564.00' }));
  expect(shaped.offered_pricing.snapshot_hit).toBe(true);
  expect(shaped.offered_pricing.rebuilt_default_frequency).toBeUndefined();
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
});

test('a rebuilt bundle (snapshotHit not true) with no sellable cadence — every frequency quote_required — falls back to the stored columns rather than reporting no total at all (Codex r-head P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({
    frequencies: [{ key: 'quarterly', monthly: 999, annual: 11988, quoteRequired: true }],
  });
  const shaped = await shapeEstimate(estimateRow({ monthly_total: '47.00', annual_total: '564.00' }));
  expect(shaped.offered_pricing.snapshot_hit).toBe(false);
  expect(shaped.offered_pricing.rebuilt_default_frequency).toBeUndefined();
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
});

test('an ACCEPTED (price-locked) estimate never has its committed totals overridden by a rebuilt bundle\'s today-priced default cadence, even when the bundle has no snapshotHit (pre-push audit P1)', async () => {
  // buildPricingBundle carries no price-lock guard itself (only
  // resolveLivePricing gates on estimateIsPriceLocked before calling it), so
  // a bundle for an accepted row can still come back rebuilt/re-priced —
  // today's default cadence (999/11988) must not eclipse what the customer
  // actually accepted (47/564, accepted_frequency_key quarterly).
  mockBuildPricingBundle.mockResolvedValue({
    frequencies: [{ key: 'monthly', monthly: 999, annual: 11988 }], // today's re-priced default differs from what was accepted
  });
  const accepted = await shapeEstimate(estimateRow({
    status: 'accepted', accepted_at: '2026-09-01T00:00:00Z', accepted_frequency_key: 'quarterly',
    monthly_total: '47.00', annual_total: '564.00',
  }));
  expect(accepted.offered_pricing.snapshot_hit).toBe(false);
  expect(accepted.offered_pricing.rebuilt_default_frequency).toBeUndefined();
  expect(accepted.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
  // Same for a price_locked_at stamp with no 'accepted' status (declined stays locked too).
  const declined = await shapeEstimate(estimateRow({
    status: 'declined', price_locked_at: '2026-09-01T00:00:00Z', monthly_total: '47.00', annual_total: '564.00',
  }));
  expect(declined.offered_pricing.rebuilt_default_frequency).toBeUndefined();
  expect(declined.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
});

test('a price-locked estimate also keeps its committed ONE-TIME total — the rebuilt bundle\'s anchorOneTimePrice (today\'s setup-fee rules) does not override the accepted onetime_total column (pre-push audit P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], anchorOneTimePrice: 300 }); // today's setup-fee rules differ from what was accepted
  const shaped = await shapeEstimate(estimateRow({
    status: 'accepted', accepted_at: '2026-09-01T00:00:00Z', monthly_total: '47.00', annual_total: '564.00', onetime_total: '125.00',
  }));
  expect(shaped.offered_pricing.price_locked).toBe(true);
  expect(shaped.offered_pricing.one_time_total).toBe(300); // still reported on offered_pricing, for reference
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 }); // but totals stay the committed figure
});

test('a rebuilt bundle whose default sellable cadence is itself a narrow LOW-confidence line withholds the exact total and carries the range instead — PriceCard shows a range, never a midpoint (pre-push audit P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [
    { key: 'monthly', monthly: 500, annual: 6000, perTreatment: 500, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 1 },
  ] });
  const shaped = await shapeEstimate(estimateRow());
  // Ranged: no numeric override rides on rebuilt_default_frequency — the
  // range lives on default_cadence_low_confidence_range instead, which
  // applies independent of snapshot_hit (see the snapshotHit:true test below).
  expect(shaped.offered_pricing.rebuilt_default_frequency).toBeUndefined();
  expect(shaped.offered_pricing.default_cadence_low_confidence_range).toEqual(
    { pct: 0.2, fraction: 1, range_unit: 'monthly', cadence: [400, 600], annual: [4800, 7200] },
  );
  expect(shaped.totals).toEqual({
    monthly: null, annual: null, one_time: 125,
    low_confidence_range: { pct: 0.2, fraction: 1, range_unit: 'monthly', cadence: [400, 600], annual: [4800, 7200] },
    source: 'rebuilt_bundle_default_range',
  });
});

test('a VALID snapshot (snapshotHit true) whose default sellable cadence is a narrow LOW-confidence line ALSO withholds the exact total — the frozen column can itself be that range\'s midpoint, which PriceCard never showed either (Codex r-head P1, cover snapshotHit:true)', async () => {
  mockBuildPricingBundle.mockResolvedValue({
    frequencies: [{ key: 'monthly', monthly: 500, annual: 6000, perTreatment: 500, visitsPerYear: 12, billedPerApplication: true, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 1 }],
    snapshotHit: true,
  });
  // The frozen columns literally ARE the range's midpoint (500/mo, 6000/yr) —
  // exactly what a send-time low-confidence cadence would have stored.
  const shaped = await shapeEstimate(estimateRow({ monthly_total: '500.00', annual_total: '6000.00' }));
  expect(shaped.offered_pricing.snapshot_hit).toBe(true);
  expect(shaped.offered_pricing.rebuilt_default_frequency).toBeUndefined();
  expect(shaped.offered_pricing.default_cadence_low_confidence_range).toEqual(
    { pct: 0.2, fraction: 1, range_unit: 'monthly', cadence: [400, 600], annual: [4800, 7200] },
  );
  expect(shaped.totals).toEqual({
    monthly: null, annual: null, one_time: 125,
    low_confidence_range: { pct: 0.2, fraction: 1, range_unit: 'monthly', cadence: [400, 600], annual: [4800, 7200] },
    source: 'default_cadence_range',
  });
});

test('section-level price selectors ride the service section with the composer\'s amounts: bond terms, station rental, the commercial interior toggle (Codex r7 P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], services: [
    { key: 'termite_bait', label: 'Termite', defaultFrequencyKey: 'quarterly', frequencies: [{ key: 'quarterly', monthly: 35, annual: 420, perTreatment: 105, visitsPerYear: 4, billedPerApplication: true }],
      bondOptions: [{ key: 'bond_1yr', label: '1-year bond', years: 1, perApplicationAdd: 45, monthlyAdd: 15, annualAdd: 180 }, { key: 'none', label: 'No bond', years: 0, perApplicationAdd: 0, monthlyAdd: 0, annualAdd: 0 }],
      selectedBondTerm: 'bond_1yr',
      stationRental: { label: 'Termite Station Rental', detail: 'Waves owns the in-ground stations — $0 install.', perApplicationAdd: 20, monthlyAdd: 6.67, annualAdd: 80 } },
    { key: 'commercial_pest', label: 'Commercial Pest', defaultFrequencyKey: 'monthly', frequencies: [{ key: 'monthly', monthly: 200, annual: 2400 }],
      interiorScopeExcluded: true,
      interiorOption: { selected: false, label: 'Interior service', perApplicationAdd: 25, monthlyAdd: 25, annualAdd: 300, detail: 'Interior treatment on every visit.' } },
    { key: 'pest_control', label: 'Pest Control', defaultFrequencyKey: 'quarterly', frequencies: [] },
  ] });
  const [termite, commercial, pest] = (await shapeEstimate(estimateRow())).offered_pricing.services;
  expect(termite).toMatchObject({
    bond_options: [
      { key: 'bond_1yr', label: '1-year bond', years: 1, per_application_add: 45, monthly_add: 15, annual_add: 180 },
      { key: 'none', label: 'No bond', years: null, per_application_add: 0, monthly_add: 0, annual_add: 0 },
    ],
    selected_bond_term: 'bond_1yr',
    station_rental: { label: 'Termite Station Rental', detail: 'Waves owns the in-ground stations — $0 install.', per_application_add: 20, monthly_add: 6.67, annual_add: 80, price_itemized: false },
  });
  expect(termite.interior_option).toBeUndefined();
  expect(commercial).toMatchObject({ interior_scope_excluded: true, interior_option: { selected: false, label: 'Interior service', per_application_add: 25, monthly_add: 25, annual_add: 300, detail: 'Interior treatment on every visit.' } });
  expect(commercial.bond_options).toBeUndefined();
  // a section without selectors gains no selector keys at all
  expect(Object.keys(pest).sort()).toEqual(['default_frequency_key', 'frequencies', 'key', 'label']);
});

test('an enabled, itemized proposal is the pricing authority: authored lines, programs, corrective work and computed totals, never the engine bundle (Codex r7 P1)', async () => {
  mockBuildPricingBundle.mockResolvedValue(BUNDLE);
  const row = estimateRow({
    category: 'COMMERCIAL', monthly_total: '92.00', annual_total: '1104.00', onetime_total: '125.00',
    estimate_data: JSON.stringify({
      recurring: { services: [{ name: 'Engine row', frequency: 'monthly', monthly: 92, annual: 1104 }] },
      proposal: {
        enabled: true, title: 'Commercial Service Proposal', preparedFor: 'Harbor Plaza LLC', propertyAddress: '9 Dock Rd', taxRate: 0.07, taxLabel: 'FL sales tax', terms: 'Net 30',
        buildings: [{ name: 'Building A', lineItems: [
          { description: 'Monthly pest service', quantity: 1, unitPrice: 250, frequency: 'monthly', taxable: false },
          { description: 'Initial clean-out', quantity: 2, unitPrice: 100, frequency: 'one_time', taxable: true },
        ] }],
        correctiveWork: [{ label: 'Door sweeps', amount: 300, taxable: false }],
        commercialTerms: { paymentTerms: 'net_30', initialTermMonths: 12, renewal: 'Auto-renews annually' },
      },
    }),
  });
  const shaped = await shapeEstimate(row);
  expect(mockBillingContext).toHaveBeenCalledWith(row);
  expect(mockBuildPricingBundle).not.toHaveBeenCalled();
  expect(shaped.offered_pricing).toMatchObject({
    pricing_authority: 'authored_proposal', bills_per_application: false, source: 'authored_proposal',
    proposal: {
      title: 'Commercial Service Proposal', prepared_for: 'Harbor Plaza LLC', property_address: '9 Dock Rd', tax_rate: 0.07, tax_label: 'FL sales tax', terms: 'Net 30',
      buildings: [{ name: 'Building A', line_items: [
        { description: 'Monthly pest service', quantity: 1, unit_price: 250, amount: 250, frequency: 'monthly', visits_per_year: null, taxable: false },
        { description: 'Initial clean-out', quantity: 2, unit_price: 100, amount: 200, frequency: 'one_time', taxable: true },
      ] }],
      programs: null,
      corrective_work: [{ label: 'Door sweeps', amount: 300, taxable: false }],
      commercial_terms: { payment_terms: 'net30', initial_term_months: 12, renewal: 'Auto-renews annually' }, // the normalizer's canonical term key
    },
    // 250 × 12 = 3000 recurring; 200 + 300 one-time; tax 7% on the taxable 200 = 14
    totals: { annual_recurring: 3000, monthly_equivalent: 250, one_time: 500, recurring_tax: 0, one_time_tax: 14, total_tax: 14, first_year_total: 3514 },
  });
  expect(shaped.offered_pricing.plan_frequencies).toBeUndefined();
  expect(shaped.totals).toEqual({ monthly: 250, annual: 3000, one_time: 500, total_tax: 14, first_year_total: 3514, source: 'authored_proposal' });
  expect(shaped.requote_required).toBeNull();
  expect(JSON.stringify(shaped)).not.toMatch(/Engine row/);

  // enabled flag with NO itemization normalizes to the synthesized fallback → the page prices from the bundle, and so does the tool
  mockBuildPricingBundle.mockClear();
  const bare = await shapeEstimate(estimateRow({ estimate_data: JSON.stringify({ proposal: { enabled: true } }) }));
  expect(mockBuildPricingBundle).toHaveBeenCalledTimes(1);
  expect(bare.offered_pricing.pricing_authority).toBeUndefined();
  expect(bare.offered_pricing.plan_frequencies).toHaveLength(1);

  // a proposal projection failure withholds — never a fall-through to engine cadences
  mockBillingContext.mockRejectedValue(new Error('billing lane down'));
  const failed = await shapeEstimate(row);
  expect(failed.offered_pricing).toBeNull();
  expect(failed.offered_pricing_unavailable).toMatch(/authored proposal failed: billing lane down/);
  // ...and totals are withheld too, not the row's stale monthly_total/annual_total
  // columns (92/1104) this tool explicitly does not treat as the billed quote
  // for a proposal estimate (pre-push audit P1).
  expect(failed.totals).toEqual({ monthly: null, annual: null, one_time: null, withheld: true });
});

test('a pending or failed deposit intent collected nothing: total_paid null, the requested face amount kept (Codex r7 P2, r8 P2)', async () => {
  db.__rows = (q) => (q.sql.includes('"estimate_deposits"')
    ? [
      { estimate_id: 'est-1', amount: '100', card_surcharge: null, credited_amount: null, refunded_amount: null, refunded_surcharge: null, status: 'pending', received_at: null },
      { estimate_id: 'est-1', amount: '100', card_surcharge: null, credited_amount: null, refunded_amount: null, refunded_surcharge: null, status: 'failed', received_at: null },
      { estimate_id: 'est-1', amount: '100', card_surcharge: '3.50', credited_amount: null, refunded_amount: '100', refunded_surcharge: '3.50', status: 'refunded', received_at: '2026-09-06T00:00:00Z' },
    ]
    : [estimateRow()]);
  const { estimates: [one] } = await getEstimateDetail({ estimate_id: 'est-1' });
  expect(one.deposits).toEqual([
    { amount: 100, card_surcharge: null, collected: false, total_paid: null, credited: null, refunded: null, refunded_surcharge: null, status: 'pending', received_at: null },
    { amount: 100, card_surcharge: null, collected: false, total_paid: null, credited: null, refunded: null, refunded_surcharge: null, status: 'failed', received_at: null },
    { amount: 100, card_surcharge: 3.5, collected: true, total_paid: 103.5, credited: null, refunded: 100, refunded_surcharge: 3.5, status: 'refunded', received_at: '2026-09-06T00:00:00Z' },
  ]);
});

test('totals: monthly/annual from the stored columns; one_time is the composer\'s corrected figure when the bundle built, the column otherwise; bad JSON still answers', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], anchorOneTimePrice: 26 }); // legacy V1 row: stored 125 still carries a setup fee the page subtracts
  const corrected = await shapeEstimate(estimateRow({ monthly_total: null, annual_total: null }));
  expect(corrected.totals).toEqual({ monthly: null, annual: null, one_time: 26 });
  // A failed bundle build means offered_pricing is unavailable — the stored
  // columns are never trusted as the quote on their own (that's the whole
  // point of this tool), so totals are withheld too, exactly like a failed
  // reconciliation (pre-push audit P1).
  mockBuildPricingBundle.mockRejectedValue(new Error('no bundle'));
  const broken = await shapeEstimate(estimateRow({ estimate_data: '{not json', monthly_total: '12.5', annual_total: null, onetime_total: '0' }));
  expect(broken.totals).toEqual({ monthly: null, annual: null, one_time: null, withheld: true });
  expect(broken.offered_pricing_unavailable).toMatch(/no bundle/);
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [] });
  expect(broken.requote_required).toBeNull(); // no bundle → unknown
});

test('links follow the public route: call-side block, viewable, staff preview, expired, archived (Codex r1/r3 P2)', async () => {
  expect(await shapeEstimate(estimateRow({ status: 'draft' }))).toMatchObject({ customer_link: null, staff_preview_link: 'https://portal.wavespestcontrol.com/estimate/xydejpzuxx?adminPreview=1', link_state: 'staff_preview_only' });
  expect(await shapeEstimate(estimateRow({ status: 'expired' }))).toMatchObject({ customer_link: null, staff_preview_link: null, link_state: 'not_openable' });
  expect(await shapeEstimate(estimateRow({ status: 'draft', archived_at: '2026-09-01T00:00:00Z' }))).toMatchObject({ customer_link: null, staff_preview_link: null, link_state: 'not_openable' });
  expect(await shapeEstimate(estimateRow({ status: 'accepted', accepted_at: '2026-09-07T00:00:00Z' }))).toMatchObject({ link_state: 'customer_viewable', accepted: { at: '2026-09-07T00:00:00Z', service_mode: null, frequency: null } });
  expect(await shapeEstimate(estimateRow({ token: null }))).toMatchObject({ customer_link: null, link_state: 'no_token' });
  mockCallSideBlock.mockResolvedValue({ blocked: true });
  const blocked = await shapeEstimate(estimateRow());
  expect(mockCallSideBlock).toHaveBeenCalledWith(db, expect.objectContaining({ recurring: expect.any(Object) }));
  expect(blocked).toMatchObject({ customer_link: null, staff_preview_link: null, link_state: 'blocked' });
  mockCallSideBlock.mockRejectedValue(new Error('db down'));
  expect((await shapeEstimate(estimateRow())).link_state).toBe('blocked');
});

test('estimate_id reads one full row; customer_id reads latest live estimates with a bounded limit; deposits ride along', async () => {
  db.__queries = [];
  db.__rows = (q) => (q.sql.includes('"estimate_deposits"')
    ? [{ estimate_id: 'est-1', amount: '100', card_surcharge: '3.50', credited_amount: '100', refunded_amount: null, refunded_surcharge: null, status: 'credited', received_at: '2026-09-06T00:00:00Z' }]
    : [estimateRow()]);
  const one = await getEstimateDetail({ estimate_id: 'est-1' });
  expect(one.count).toBe(1);
  expect(one.estimates[0].id).toBe('est-1');
  // face amount + the card surcharge actually collected on top of it (and how much of that fee was refunded)
  expect(one.estimates[0].deposits).toEqual([{ amount: 100, card_surcharge: 3.5, collected: true, total_paid: 103.5, credited: 100, refunded: null, refunded_surcharge: null, status: 'credited', received_at: '2026-09-06T00:00:00Z' }]);
  expect(db.__queries[1].sql).toContain('"card_surcharge"');
  expect(db.__queries[1].sql).toContain('"refunded_surcharge"');
  expect(db.__queries[0].sql).toMatch(/^select \* from "estimates"/); // the reconciler/bundle read the row the public handlers load
  expect(db.__queries[0].sql).toContain('"id" = ');
  expect(db.__queries[0].sql).toContain('limit');
  expect(db.__queries[1].sql).toContain('"estimate_deposits"');

  db.__queries = [];
  await getEstimateDetail({ customer_id: 'cust-1', limit: 500 });
  const sql = db.__queries[0].sql;
  expect(sql).toContain('"customer_id" = ');
  expect(sql).toContain('"archived_at" is null');
  expect(sql).toContain('order by "created_at" desc');
  expect(db.__queries[0].bindings).toContain(10);
});

test('missing selectors and missing rows answer with an error, not a throw', async () => {
  expect((await getEstimateDetail({})).error).toMatch(/estimate_id or customer_id/);
  db.__rows = () => [];
  expect((await getEstimateDetail({ estimate_id: 'nope' })).error).toMatch(/No estimate matches/);
  expect((await getEstimateDetail({ customer_id: 'cust-9' })).error).toMatch(/No estimates on file/);
});
