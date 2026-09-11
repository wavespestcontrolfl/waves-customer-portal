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
  frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 92, annual: 1104, perVisit: 141, oneTimeTotal: null, annualPrepayEligible: true }],
  services: [
    { key: 'pest_control', label: 'Pest Control', defaultFrequencyKey: 'bi_monthly', frequencies: [
      { key: 'quarterly', label: 'Quarterly', monthly: 47, annual: 564, perTreatment: 141, visitsPerYear: 4 },
      { key: 'bi_monthly', label: 'Bi-monthly', monthly: 55, annual: 660, perTreatment: 110, visitsPerYear: 6 },
    ] },
    { key: 'lawn_care', label: 'Lawn Care', defaultFrequencyKey: 'enhanced', frequencies: [
      { key: 'standard', label: 'Standard', monthly: 45, annual: 540, visitsPerYear: 6 },
      { key: 'enhanced', label: 'Enhanced', monthly: 51.98, annual: 623.76, visitsPerYear: 9, quoteRequired: true },
    ] },
  ],
  serviceCadenceCombos: [{
    key: 'lawn_care:enhanced|pest_control:quarterly', selection: { lawn_care: 'enhanced', pest_control: 'quarterly' },
    monthly: 98.98, annual: 1187.76,
    perServiceTreatments: { pest_control: { perTreatment: 131, treatments: 4 }, lawn_care: { perTreatment: 60.45, treatments: 9 } },
    manualDiscount: { amountAnnual: 40, capped: false }, manualDiscountSuppressed: true,
  }],
  oneTimeBreakdown: { items: [{ service: 'pest_initial_roach', label: 'Cockroach Treatment Service', amount: 150, detail: '2 treatments' }, { service: null, label: 'Custom exclusion', amount: null, quoteRequired: true }], total: 150, quoteRequired: true },
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
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties.estimate_id.format).toBe('uuid');
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties.customer_id.format).toBe('uuid');
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.required).toBeUndefined();
});

test('offered pricing is the public bundle verbatim in shape: cadences, ladders, combos with per-service allocations + manual-discount state, one-time breakdown, fees (Codex r4)', async () => {
  mockBuildPricingBundle.mockResolvedValue(BUNDLE);
  const row = estimateRow();
  const shaped = await shapeEstimate(row);
  expect(mockBuildPricingBundle).toHaveBeenCalledWith(row);
  expect(shaped.offered_pricing).toEqual({
    default_service_mode: 'recurring',
    waveguard_tier: 'Silver',
    plan_frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 92, annual: 1104, per_visit: 141, visits_per_year: null, annual_prepay_eligible: true }],
    services: [
      { key: 'pest_control', label: 'Pest Control', default_frequency_key: 'bi_monthly', frequencies: [
        { key: 'quarterly', label: 'Quarterly', monthly: 47, annual: 564, per_visit: 141, visits_per_year: 4 },
        { key: 'bi_monthly', label: 'Bi-monthly', monthly: 55, annual: 660, per_visit: 110, visits_per_year: 6 },
      ] },
      { key: 'lawn_care', label: 'Lawn Care', default_frequency_key: 'enhanced', frequencies: [
        { key: 'standard', label: 'Standard', monthly: 45, annual: 540, per_visit: null, visits_per_year: 6 },
        { key: 'enhanced', label: 'Enhanced', monthly: 51.98, annual: 623.76, per_visit: null, visits_per_year: 9, quote_required: true },
      ] },
    ],
    combos: [{
      key: 'lawn_care:enhanced|pest_control:quarterly', selection: { lawn_care: 'enhanced', pest_control: 'quarterly' },
      monthly: 98.98, annual: 1187.76,
      per_service_treatments: { pest_control: { perTreatment: 131, treatments: 4 }, lawn_care: { perTreatment: 60.45, treatments: 9 } },
      manual_discount: { amountAnnual: 40, capped: false }, manual_discount_suppressed: true,
    }],
    one_time_breakdown: { items: [
      { service: 'pest_initial_roach', label: 'Cockroach Treatment Service', amount: 150, detail: '2 treatments' },
      { service: null, label: 'Custom exclusion', amount: null, detail: null, quote_required: true },
    ], total: 150, quote_required: true },
    anchor_one_time_price: 125,
    first_visit_fees: [
      { service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, waived_with_prepay: true },
      { service: 'pest_initial_roach', label: 'Cockroach Treatment Service', amount: 150, waived_with_prepay: false, treatments: 2 },
    ],
    setup_fee: { service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, waived_with_prepay: true },
    rodent_bait_setup_fee: { service: 'rodent_bait_setup', label: 'Bait Station Setup', amount: 250, waived_with_prepay: false },
    manual_discount: { amountAnnual: 40 },
    source: 'engine_invocation',
  });
  expect(shaped.offered_pricing_unavailable).toBeUndefined();
  // No hand-itemized reading of estimate_data rides on the response.
  expect(shaped.recurring_services).toBeUndefined();
  expect(shaped.one_time_items).toBeUndefined();
  expect(JSON.stringify(shaped)).not.toMatch(/internal only/);
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
  expect(shaped).toMatchObject({ customer: 'Avery Example', tier: 'silver', customer_link: 'https://portal.wavespestcontrol.com/estimate/xydejpzuxx', link_state: 'customer_viewable', view_count: 2 });
});

test('a lapsed membership is reconciled BEFORE totals and the bundle, on the same row object the public renderers mutate (Codex r4 P1)', async () => {
  mockReconcile.mockImplementation(async (estimate) => {
    // The reconciler reprices in memory: stored totals and the requote flag change on the row it was handed.
    estimate.monthly_total = '61.00';
    estimate.annual_total = '732.00';
    estimate.estimate_data = JSON.stringify({ ...JSON.parse(estimate.estimate_data), membershipSnapshot: null, requoteRequired: true });
  });
  mockBuildPricingBundle.mockImplementation(async (estimate) => ({ frequencies: [{ key: 'quarterly', monthly: Number(estimate.monthly_total) }] }));
  const row = estimateRow();
  const shaped = await shapeEstimate(row);
  expect(calls).toEqual(['reconcile', 'bundle']);
  expect(mockReconcile).toHaveBeenCalledWith(row);
  expect(shaped.totals).toEqual({ monthly: 61, annual: 732, one_time: 125 });
  expect(shaped.offered_pricing.plan_frequencies[0].monthly).toBe(61);
  expect(shaped.requote_required).toBe(true);
  expect(shaped.reconciliation_error).toBeUndefined();
});

test('a reconciler or bundle failure is reported on the response, never thrown and never silently a stale answer', async () => {
  mockReconcile.mockRejectedValue(new Error('plan lookup down'));
  mockBuildPricingBundle.mockRejectedValue(new Error('no customer row'));
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.reconciliation_error).toMatch(/plan lookup down/);
  expect(shaped.offered_pricing).toBeNull();
  expect(shaped.offered_pricing_unavailable).toMatch(/no customer row/);
  mockReconcile.mockResolvedValue(undefined);
  mockBuildPricingBundle.mockResolvedValue(null);
  expect((await shapeEstimate(estimateRow())).offered_pricing_unavailable).toMatch(/no pricing bundle/);
});

test('totals come from the stored columns; the one-time total falls back to the bundle breakdown; bad JSON still answers', async () => {
  mockBuildPricingBundle.mockResolvedValue({ frequencies: [], oneTimeBreakdown: { items: [], total: 300 } });
  const fromBundle = await shapeEstimate(estimateRow({ monthly_total: null, annual_total: null, onetime_total: null }));
  expect(fromBundle.totals).toEqual({ monthly: null, annual: null, one_time: 300 });
  const broken = await shapeEstimate(estimateRow({ estimate_data: '{not json', monthly_total: '12.5', annual_total: null, onetime_total: '0' }));
  expect(broken.totals).toEqual({ monthly: 12.5, annual: null, one_time: 0 });
  expect(broken.requote_required).toBe(false);
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
    ? [{ estimate_id: 'est-1', amount: '100', credited_amount: '100', refunded_amount: null, status: 'credited', received_at: '2026-09-06T00:00:00Z' }]
    : [estimateRow()]);
  const one = await getEstimateDetail({ estimate_id: 'est-1' });
  expect(one.count).toBe(1);
  expect(one.estimates[0].id).toBe('est-1');
  expect(one.estimates[0].deposits).toEqual([{ amount: 100, credited: 100, refunded: null, status: 'credited', received_at: '2026-09-06T00:00:00Z' }]);
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
