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
  };
});
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
        { key: 'monthly', label: 'Monthly', monthly: 200, annual: 2400, visits_per_year: 12, billing_unit: 'per_application', per_application: 200, ...noRows,
          // price ± price × fraction × pct (PriceCard): 200 × 0.5 × 0.2 = 20
          low_confidence_range: { pct: 0.2, fraction: 0.5, monthly: [180, 220], annual: [2160, 2640] } },
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
  // totals.one_time is the composer's corrected page figure, not the raw column
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
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
    frequencies: [{ key: 'quarterly', monthly: Number(estimate.monthly_total) }],
    quoteRequired: JSON.parse(estimate.estimate_data).membershipLapsedRequote === true,
    quoteRequiredReason: 'membership_lapsed_requote',
    quoteRequiredItems: [],
  }));
  const row = estimateRow();
  const shaped = await shapeEstimate(row);
  expect(calls).toEqual(['reconcile', 'bundle']);
  expect(mockReconcile).toHaveBeenCalledWith(row);
  expect(shaped.totals).toEqual({ monthly: 61, annual: 732, one_time: 125 });
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
  expect(shaped.offered_pricing_unavailable).toMatch(/no customer row/);
  expect(shaped.requote_required).toBeNull(); // unknown without the bundle — never a confident "no"
  expect(shaped.requote_reason).toBeNull();
  mockReconcile.mockResolvedValue(undefined);
  mockBuildPricingBundle.mockResolvedValue(null);
  expect((await shapeEstimate(estimateRow())).offered_pricing_unavailable).toMatch(/no pricing bundle/);
});

test('totals: monthly/annual from the stored columns; one_time is the composer\'s corrected figure when the bundle built, the column otherwise; bad JSON still answers', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], anchorOneTimePrice: 26 }); // legacy V1 row: stored 125 still carries a setup fee the page subtracts
  const corrected = await shapeEstimate(estimateRow({ monthly_total: null, annual_total: null }));
  expect(corrected.totals).toEqual({ monthly: null, annual: null, one_time: 26 });
  mockBuildPricingBundle.mockRejectedValue(new Error('no bundle'));
  const broken = await shapeEstimate(estimateRow({ estimate_data: '{not json', monthly_total: '12.5', annual_total: null, onetime_total: '0' }));
  expect(broken.totals).toEqual({ monthly: 12.5, annual: null, one_time: 0 });
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
  expect(one.estimates[0].deposits).toEqual([{ amount: 100, card_surcharge: 3.5, total_paid: 103.5, credited: 100, refunded: null, refunded_surcharge: null, status: 'credited', received_at: '2026-09-06T00:00:00Z' }]);
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
