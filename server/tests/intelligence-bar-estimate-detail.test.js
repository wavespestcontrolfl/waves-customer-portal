// get_estimate_detail: what an estimate offered, read through the customer
// page's OWN projection (estimate-public.composeEstimateDataPayload) — the
// re-cut after #4345 rounds 1-5, where a hand re-projection of the page's
// pricing shape kept diverging from it. These tests assert the tool no
// longer projects anything: it reconciles membership strictly, decides what
// may be disclosed, and passes the composer's payload through verbatim.
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
jest.mock('../utils/estimate-claim-sql', () => ({
  ...jest.requireActual('../utils/estimate-claim-sql'),
  callSideBlockForEstimateData: (...a) => mockCallSideBlock(...a),
}));
const calls = [];
const mockCompose = jest.fn(async () => ({}));
const mockReconcile = jest.fn(async () => undefined);
jest.mock('../routes/estimate-public', () => {
  const unpublished = ['draft', 'scheduled'];
  return {
    composeEstimateDataPayload: (...a) => { calls.push('compose'); return mockCompose(...a); },
    reconcileFrozenMembershipSnapshot: (...a) => { calls.push('reconcile'); return mockReconcile(...a); },
    isEstimateCustomerViewable: (e) => !e.archived_at && !unpublished.includes(e.status) && !['expired', 'send_failed'].includes(e.status),
    // Real parser (estimate-public.js parseEstimateDataSafe) — the tool feeds
    // the provenance gate through the route's own copy, not a second one.
    parseEstimateDataSafe: (e = {}) => {
      const raw = e.estimate_data;
      if (!raw) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw) || {}; } catch { return {}; } }
      return raw || {};
    },
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
  price_locked_at: null, view_count: 2, notes: 'Includes exterior perimeter treatment', pricing_version: 'v2',
  bill_by_invoice: false, show_one_time_option: false,
  accepted_service_mode: null, accepted_frequency_key: null, disposition: null, disposition_note: null, decline_reason: null,
  created_at: '2026-09-05T14:00:00Z', updated_at: '2026-09-05T15:00:00Z',
  estimate_data: JSON.stringify({
    recurring: { services: [{ name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4, monthly: 47, annual: 564 }] },
    membershipSnapshot: { isExistingCustomer: true },
    agentDraftReview: { reasoning: 'internal only' },
  }),
  ...overrides,
});

// A stand-in for a real /:token/data body: the shapes the page actually
// renders prices from, plus the three things this tool must strip.
const PAGE_PAYLOAD = {
  estimate: {
    id: 'est-1',
    token: 'xydejpzuxx',
    askToken: 'eyJhbGciOiJIUzI1NiJ9.SECRET.bearer',
    status: 'sent',
    customerName: 'Avery Example',
    billByInvoice: true,
    membership: { active: false, lapsed: true },
    acceptance: { required: true },
    satelliteUrl: 'https://maps.googleapis.com/x.png',
    licenseNumber: 'JB1234',
    notes: 'Includes exterior perimeter treatment',
    intelligence: { narrative: 'internal only' },
  },
  pricing: {
    defaultServiceMode: 'recurring',
    frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 92, annual: 1104, perTreatment: 141 }],
    services: [{ key: 'pest_control', ladder: [{ key: 'quarterly', monthly: 92 }] }],
    oneTimeBreakdown: { items: [{ service: 'exclusion', amount: 450 }], total: 455.5 },
    firstVisitFees: [{ service: 'waveguard_setup', amount: 99 }],
  },
  cta: { canAccept: true, quoteRequired: false, quoteRequiredReason: null, monthlyBilled: false },
  proposal: null,
  propertyGroup: [
    { token: 'sib-a', address: '100 Test St', status: 'sent', monthlyTotal: 92, annualTotal: 1104, onetimeTotal: 0, isCurrent: true },
    { token: 'sib-b', address: '200 Test St', status: 'sent', monthlyTotal: 0, annualTotal: 0, onetimeTotal: 450, isCurrent: false },
  ],
  depositPolicy: { required: true, amount: 75, recurringAmount: 75, oneTimeAmount: 125 },
  cardHoldPolicy: { enforced: true, requiredForOneTime: true, noShowFeeAmount: 85, cancelWindowHours: 24 },
  showYourWork: { steps: ['internal only'] },
  meta: { generatedAt: '2026-09-11T22:00:00Z', engineVersion: 'v2', cacheHit: false },
};

beforeEach(() => {
  calls.length = 0;
  mockCompose.mockReset();
  mockCompose.mockResolvedValue(JSON.parse(JSON.stringify(PAGE_PAYLOAD)));
  mockReconcile.mockReset();
  mockReconcile.mockResolvedValue(undefined);
  mockCallSideBlock.mockReset();
  mockCallSideBlock.mockResolvedValue(null);
  db.__rows = () => [];
});

test('tool definition points at the page projection, takes either selector, and types the ids', () => {
  expect(GET_ESTIMATE_DETAIL_TOOL.name).toBe('get_estimate_detail');
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/as the customer's own estimate page prices it/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/page\.pricing/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/page\.cta/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/page_unavailable/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/committed_totals/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/withheld = quote_required/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/declined estimate with no price-lock stamp has no committed figure/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/unselected_alternative/);
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/page\.propertyGroup/);
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties.estimate_id.format).toBe('uuid');
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties.customer_id.format).toBe('uuid');
  expect(GET_ESTIMATE_DETAIL_TOOL.input_schema.required).toBeUndefined();
});

// ── The whole point of the re-cut ───────────────────────────────────
test('every priced section is the composer\'s own output, byte-for-byte — nothing reshaped, renamed, rounded or re-derived', async () => {
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.pricing).toEqual(PAGE_PAYLOAD.pricing);
  expect(shaped.page.cta).toEqual(PAGE_PAYLOAD.cta);
  expect(shaped.page.depositPolicy).toEqual(PAGE_PAYLOAD.depositPolicy);
  expect(shaped.page.cardHoldPolicy).toEqual(PAGE_PAYLOAD.cardHoldPolicy);
  expect(shaped.page.meta).toEqual(PAGE_PAYLOAD.meta);
  expect(shaped.page.proposal).toBeNull();
  expect(shaped.page_unavailable).toBeUndefined();
});

test('a priced section the page adds later needs no change here — the passthrough is a denylist', async () => {
  mockCompose.mockResolvedValue({ ...JSON.parse(JSON.stringify(PAGE_PAYLOAD)), brandNewPricedThing: { monthly: 31.5, band: [30, 40] } });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.brandNewPricedThing).toEqual({ monthly: 31.5, band: [30, 40] });
});

test('credentials and narrative are the only things dropped: no askToken, no link token, no generated copy', async () => {
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.estimate.askToken).toBeUndefined();
  expect(shaped.page.estimate.token).toBeUndefined();
  expect(shaped.page.estimate.intelligence).toBeUndefined();
  expect(shaped.page.showYourWork).toBeUndefined();
  expect(shaped.page.estimate.satelliteUrl).toBeUndefined();
  expect(shaped.page.estimate.licenseNumber).toBeUndefined();
  expect(JSON.stringify(shaped)).not.toMatch(/SECRET/);
  expect(JSON.stringify(shaped)).not.toMatch(/internal only/);
  // …and the priced/state fields in the same block survive.
  expect(shaped.page.estimate).toMatchObject({ status: 'sent', billByInvoice: true, membership: { lapsed: true }, acceptance: { required: true } });
});

test('no hand projection survives: the tool exposes no re-derived pricing keys of its own', async () => {
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.offered_pricing).toBeUndefined();
  expect(shaped.totals).toBeUndefined();
  expect(shaped.requote_required).toBeUndefined();
  expect(shaped.bill_by_invoice).toBeUndefined();
  expect(shaped.recurring_services).toBeUndefined();
});

// ── Where the payload is not the pixels (round 6) ───────────────────
test('a quote-required bundle reports NO amounts: the page exits to the terminal card before rendering pricing', async () => {
  mockCompose.mockResolvedValue({
    ...JSON.parse(JSON.stringify(PAGE_PAYLOAD)),
    cta: { canAccept: false, quoteRequired: true, quoteRequiredReason: 'manager_approval', monthlyBilled: false },
  });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.pricing).toEqual({
    withheld: 'quote_required',
    reason: 'manager_approval',
    note: expect.stringMatching(/shows no amounts/),
  });
  expect(JSON.stringify(shaped.page.pricing)).not.toMatch(/1104|455\.5|99/);
  expect(shaped.page.depositPolicy).toBeUndefined();
  expect(shaped.page.cardHoldPolicy).toBeUndefined();
  // …and the verdict itself still rides along, so the bar can say why.
  expect(shaped.page.cta).toMatchObject({ quoteRequired: true, quoteRequiredReason: 'manager_approval' });
});

test('an authored proposal is quote-required by design and keeps its proposal block — that IS the billed quote', async () => {
  mockCompose.mockResolvedValue({
    ...JSON.parse(JSON.stringify(PAGE_PAYLOAD)),
    cta: { canAccept: false, quoteRequired: true, quoteRequiredReason: 'commercial_proposal', monthlyBilled: false },
    proposal: { enabled: true, totals: { firstYearTotal: 9600 }, lines: [{ label: 'Monthly service', amount: 800 }] },
  });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.proposal).toEqual({ enabled: true, totals: { firstYearTotal: 9600 }, lines: [{ label: 'Monthly service', amount: 800 }] });
  expect(shaped.page.pricing.withheld).toBe('quote_required');
});

test('floor-clamped lawn tiers retained for stale accept requests are not reported as offered prices', async () => {
  mockCompose.mockResolvedValue({
    ...PAGE_PAYLOAD,
    pricing: {
      frequencies: [{ key: 'enhanced', serviceCategory: 'lawn_care', monthly: 75, annual: 900 }],
      hiddenLawnFrequencies: [{ key: 'standard', serviceCategory: 'lawn_care', monthly: 50, annual: 600, floorApplied: true }],
    },
  });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.pricing.frequencies).toEqual([{ key: 'enhanced', serviceCategory: 'lawn_care', monthly: 75, annual: 900 }]);
  expect(shaped.page.pricing.hiddenLawnFrequencies).toBeUndefined();
  expect(JSON.stringify(shaped.page.pricing)).not.toMatch(/standard|600/);
});

test('sibling estimates report only the one-time figure the switcher displays, never their stored recurring totals', async () => {
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.propertyGroup).toEqual([
    { address: '100 Test St', status: 'sent', isCurrent: true, displayed_one_time_total: null, has_recurring_plan: true },
    { link: 'https://portal.wavespestcontrol.com/estimate/sib-b', address: '200 Test St', status: 'sent', isCurrent: false, displayed_one_time_total: 450, has_recurring_plan: false },
  ]);
  expect(JSON.stringify(shaped.page.propertyGroup)).not.toMatch(/1104/);
  // A sibling's raw bearer token never rides along, same rule as the primary.
  expect(JSON.stringify(shaped.page.propertyGroup)).not.toMatch(/"token"/);
});

test('a RANGED cadence loses its exact figures at whatever depth it sits — the page shows a confirmed-on-site band, never the number', async () => {
  mockCompose.mockResolvedValue({
    ...JSON.parse(JSON.stringify(PAGE_PAYLOAD)),
    pricing: {
      frequencies: [
        { key: 'quarterly', label: 'Quarterly', monthly: 920, annual: 11040, perTreatment: 2760, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 1 },
        { key: 'monthly', label: 'Monthly', monthly: 1000, annual: 12000 },
      ],
      services: [{
        key: 'commercial_pest',
        frequencies: [{
          key: 'quarterly', monthly: 920, annual: 11040, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 0.5,
          perServiceTreatments: [{ service: 'commercial_pest', perTreatment: 2760, displayPrice: 2760 }],
        }],
      }],
      combinedRecurring: { monthlySubtotal: 920, annualSubtotal: 11040, lowConfidenceRangePct: 0.2, lowConfidenceFraction: 1 },
    },
  });
  const shaped = await shapeEstimate(estimateRow());
  const ranged = shaped.page.pricing.frequencies[0];
  expect(ranged).toMatchObject({ key: 'quarterly', label: 'Quarterly', ranged: 'low_confidence_confirmed_on_site', lowConfidenceRangePct: 0.2, lowConfidenceFraction: 1 });
  expect(ranged.monthly).toBeUndefined();
  expect(ranged.annual).toBeUndefined();
  expect(ranged.perTreatment).toBeUndefined();
  // Aggregate fallback cadences contain the ranged combined amount too.
  expect(shaped.page.pricing.frequencies[1].monthly).toBeUndefined();
  // nested inside a service ladder, and on the combined card
  const nested = shaped.page.pricing.services[0].frequencies[0];
  expect(nested.ranged).toBe('low_confidence_confirmed_on_site');
  expect(nested.perServiceTreatments).toBeUndefined();
  expect(shaped.page.pricing.combinedRecurring).toMatchObject({ ranged: 'low_confidence_confirmed_on_site' });
  expect(shaped.page.pricing.combinedRecurring.monthlySubtotal).toBeUndefined();
  expect(JSON.stringify(shaped.page.pricing)).not.toMatch(/920|11040|2760/);
});

test('real commercial range contracts withhold aggregate and base amounts while preserving healthy service pricing', async () => {
  const { attachPublicPricingContract } = jest.requireActual('../routes/estimate-public');
  const estimateData = {
    result: { recurring: { services: [{
      service: 'commercial_lawn', name: 'Commercial Turf Treatment Program',
      pricingConfidence: 'LOW', mo: 400, annual: 4800, estimatedPricing: true,
    }] } },
  };
  const pricing = attachPublicPricingContract({
    frequencies: [{ key: 'monthly', label: 'Commercial Turf Treatment Program', monthly: 400, annual: 4800 }],
  }, {}, estimateData);
  expect(pricing.services[0].frequencies[0].lowConfidenceRangePct).toBeGreaterThan(0);
  expect(pricing.frequencies[0].monthly).toBe(400);
  pricing.serviceCadenceCombos = [{ selection: { commercial_lawn: 'monthly' }, monthly: 400, annual: 4800 }];
  pricing.services.push({ key: 'pest_control', frequencies: [{ key: 'quarterly', monthly: 47, annual: 564 }] });
  mockCompose.mockResolvedValue({ ...PAGE_PAYLOAD, pricing });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.pricing.services[1].frequencies[0]).toMatchObject({ monthly: 47, annual: 564 });
  expect(shaped.page.pricing.frequencies[0].ranged).toBe('low_confidence_confirmed_on_site');
  expect(shaped.page.pricing.serviceCadenceCombos[0]).toMatchObject({ selection: { commercial_lawn: 'monthly' }, ranged: 'low_confidence_confirmed_on_site' });
  expect(JSON.stringify(shaped.page.pricing)).not.toMatch(/400|4800/);
});

test('a quote-required cadence needs no range stripping — PriceCard zeroes the band for it and the bundle gate already applies', async () => {
  mockCompose.mockResolvedValue({
    ...JSON.parse(JSON.stringify(PAGE_PAYLOAD)),
    pricing: { frequencies: [{ key: 'quarterly', monthly: 920, quoteRequired: true, lowConfidenceRangePct: 0.2 }] },
  });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page.pricing.frequencies[0]).toMatchObject({ quoteRequired: true, monthly: 920 });
  expect(shaped.page.pricing.frequencies[0].ranged).toBeUndefined();
});

// ── Membership: strict here, never for the page ─────────────────────
test('the reconciler runs BEFORE the composer, on the same row object, and opts INTO strict membership', async () => {
  mockReconcile.mockImplementation(async (estimate) => {
    estimate.monthly_total = '61.00';
    return { ok: true };
  });
  const row = estimateRow();
  await shapeEstimate(row);
  expect(calls).toEqual(['reconcile', 'compose']);
  expect(mockReconcile).toHaveBeenCalledWith(row, { strictMembership: true });
  expect(mockCompose.mock.calls[0][0].monthly_total).toBe('61.00');
});

test('the call-side block reads the POST-reconcile estimate_data, the same row state the public route checks', async () => {
  mockReconcile.mockImplementation(async (estimate) => {
    const parsed = JSON.parse(estimate.estimate_data);
    estimate.estimate_data = JSON.stringify({ ...parsed, estimatorEngine: { callLogId: 'call-after-reconcile' } });
    return { ok: true };
  });
  await shapeEstimate(estimateRow());
  expect(mockCallSideBlock.mock.calls[0][1]).toMatchObject({ estimatorEngine: { callLogId: 'call-after-reconcile' } });
});

test('an unverifiable membership withholds the whole projection — the composer is never even called', async () => {
  mockReconcile.mockResolvedValue({ ok: false, error: 'customers lookup timed out' });
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page).toBeNull();
  expect(shaped.page_unavailable).toMatch(/withheld: membership reconciliation failed: customers lookup timed out/);
  expect(shaped.reconciliation_error).toMatch(/customers lookup timed out/);
  expect(mockCompose).not.toHaveBeenCalled();
});

test('a rejecting reconciler is handled the same way', async () => {
  mockReconcile.mockRejectedValue(new Error('connection reset'));
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page).toBeNull();
  expect(shaped.page_unavailable).toMatch(/connection reset/);
  expect(mockCompose).not.toHaveBeenCalled();
});

test('an accepted row is never reconciled: a later lapse must not reprice a committed deal', async () => {
  const shaped = await shapeEstimate(estimateRow({ status: 'accepted', accepted_at: '2026-09-06T12:00:00Z' }));
  expect(mockReconcile).not.toHaveBeenCalled();
  expect(shaped.price_locked).toBe(true);
  // No stored mode (legacy accept): the lanes cannot be split, so every column
  // is reported with the mode explicitly null.
  expect(shaped.committed_totals).toEqual({ monthly: 47, annual: 564, one_time: 125, accepted_service_mode: null, locked_at: '2026-09-06T12:00:00Z' });
  // The page still reports what it would price today; the two are separate answers.
  expect(shaped.page.pricing).toEqual(PAGE_PAYLOAD.pricing);
});

test('a price_locked_at stamp freezes it the same way, whatever the status', async () => {
  const shaped = await shapeEstimate(estimateRow({ price_locked_at: '2026-09-07T09:00:00Z' }));
  expect(mockReconcile).not.toHaveBeenCalled();
  expect(shaped.committed_totals).toMatchObject({ monthly: 47, locked_at: '2026-09-07T09:00:00Z' });
});

// The skip and committed_totals use the reconciler's OWN frozen test, so a
// declined-but-unstamped row — one the real reconciler would reprice — is
// reconciled here too and reports no committed figure.
// A mixed estimate keeps BOTH lanes' stored columns after acceptance, so the
// lane the customer declined must not read as part of the committed deal.
test('committed_totals reports the accepted lane and names the other as the unselected alternative', async () => {
  const recurring = await shapeEstimate(estimateRow({ status: 'accepted', accepted_at: '2026-09-06T12:00:00Z', accepted_service_mode: 'recurring' }));
  expect(recurring.committed_totals).toEqual({
    monthly: 47, annual: 564, accepted_service_mode: 'recurring',
    locked_at: '2026-09-06T12:00:00Z', unselected_alternative: { one_time: 125 },
  });
  const oneTime = await shapeEstimate(estimateRow({ status: 'accepted', accepted_at: '2026-09-06T12:00:00Z', accepted_service_mode: 'one_time' }));
  expect(oneTime.committed_totals).toEqual({
    one_time: 125, accepted_service_mode: 'one_time',
    locked_at: '2026-09-06T12:00:00Z', unselected_alternative: { monthly: 47, annual: 564 },
  });
});

test('a DECLINED unstamped row is reconciled like any other and commits nothing', async () => {
  const row = estimateRow({ status: 'declined', declined_at: '2026-09-07T10:00:00Z' });
  const shaped = await shapeEstimate(row);
  expect(mockReconcile).toHaveBeenCalledWith(row, { strictMembership: true });
  expect(shaped.price_locked).toBe(false);
  expect(shaped.committed_totals).toBeUndefined();
  expect(shaped.page.pricing).toEqual(PAGE_PAYLOAD.pricing);
});

test('an unlocked row has no committed figure at all — the stored columns are not the quote', async () => {
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.price_locked).toBe(false);
  expect(shaped.committed_totals).toBeUndefined();
  expect(JSON.stringify(shaped)).not.toMatch(/"564"|564\.00/);
});

// ── Disclosure gates ────────────────────────────────────────────────
test('a call-side block suppresses the WHOLE record — identity and money may belong to another customer', async () => {
  mockCallSideBlock.mockResolvedValue('wrong_identity');
  const shaped = await shapeEstimate(estimateRow({ status: 'accepted', accepted_at: '2026-09-06T12:00:00Z' }), [
    { status: 'received', amount: '100.00', card_surcharge: '3.00', credited_amount: null, refunded_amount: null, refunded_surcharge: null, received_at: '2026-09-06T00:00:00Z' },
  ]);
  expect(shaped).toEqual({
    id: 'est-1',
    withheld: 'provenance_blocked',
    page: null,
    page_unavailable: expect.stringMatching(/estimate or call-side hold/),
    customer_link: null,
    staff_preview_link: null,
    link_state: 'blocked',
  });
  // Nothing attributable survives: no name, address, notes, deposits or committed figure.
  expect(JSON.stringify(shaped)).not.toMatch(/Avery Example|100 Test St|perimeter|103|564/);
  expect(mockCompose).not.toHaveBeenCalled();
});

test('an unverifiable call-side block fails closed the same way', async () => {
  mockCallSideBlock.mockRejectedValue(new Error('call_log unreachable'));
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.withheld).toBe('provenance_blocked');
  expect(shaped.customer).toBeUndefined();
});

test.each(['linkage_invalidated_at', 'invalidation_pending_at'])('an estimate-side %s marker withholds the record even after call processing settles', async (marker) => {
  for (const token of ['invalidated-token', null]) {
    const row = estimateRow({
      status: 'accepted',
      token,
      estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'settled-call', [marker]: new Date().toISOString() } }),
    });
    const shaped = await shapeEstimate(row, [{ status: 'received', amount: '100.00', card_surcharge: '3.00' }]);
    expect(shaped).toMatchObject({ id: row.id, withheld: 'provenance_blocked', page: null, link_state: 'blocked' });
    expect(shaped.customer_id).toBeUndefined();
    expect(shaped.deposits).toBeUndefined();
    expect(shaped.committed_totals).toBeUndefined();
    expect(JSON.stringify(shaped)).not.toMatch(/Avery Example|100 Test St|perimeter/);
  }
  expect(mockCompose).not.toHaveBeenCalled();
});

test.each(['expired', 'send_failed'])('a %s estimate reports amounts without a broken current-property link', async (status) => {
  const shaped = await shapeEstimate(estimateRow({ status }));
  expect(shaped.link_state).toBe('not_openable');
  expect(shaped.customer_link).toBeNull();
  expect(shaped.page.propertyGroup.find((sibling) => sibling.isCurrent).link).toBeUndefined();
  expect(shaped.page.propertyGroup.find((sibling) => !sibling.isCurrent).link).toBeDefined();
  expect(shaped.page.pricing).toEqual(PAGE_PAYLOAD.pricing);
  expect(mockCompose.mock.calls[0][1]).toMatchObject({ adminDraftPreview: false, isPdfRenderPass: false });
});

test('a draft is composed the way staff "Customer View" renders it, and offers only the preview link', async () => {
  const shaped = await shapeEstimate(estimateRow({ status: 'draft' }));
  expect(shaped.link_state).toBe('staff_preview_only');
  expect(shaped.staff_preview_link).toBe('https://portal.wavespestcontrol.com/estimate/xydejpzuxx?adminPreview=1');
  expect(mockCompose.mock.calls[0][1]).toMatchObject({ adminDraftPreview: true, isPdfRenderPass: false, docRenderPin: null });
});

test('links come from the canonical portal-origin helper, so a preview deployment gets its own origin', async () => {
  const prior = process.env.PUBLIC_PORTAL_URL;
  process.env.PUBLIC_PORTAL_URL = 'https://preview-123.up.railway.app';
  try {
    const sent = await shapeEstimate(estimateRow());
    expect(sent.customer_link).toBe('https://preview-123.up.railway.app/estimate/xydejpzuxx');
    const draft = await shapeEstimate(estimateRow({ status: 'draft' }));
    expect(draft.staff_preview_link).toBe('https://preview-123.up.railway.app/estimate/xydejpzuxx?adminPreview=1');
  } finally {
    if (prior === undefined) delete process.env.PUBLIC_PORTAL_URL;
    else process.env.PUBLIC_PORTAL_URL = prior;
  }
});

test('a sent estimate gets the customer\'s own projection, not the staff one', async () => {
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.link_state).toBe('customer_viewable');
  expect(shaped.customer_link).toBe('https://portal.wavespestcontrol.com/estimate/xydejpzuxx');
  expect(mockCompose.mock.calls[0][1].adminDraftPreview).toBe(false);
});

test('a composer failure says so and never falls back to the stored columns', async () => {
  mockCompose.mockRejectedValue(new Error('pricing engine unavailable'));
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page).toBeNull();
  expect(shaped.page_unavailable).toMatch(/could not be composed: pricing engine unavailable/);
  expect(shaped.committed_totals).toBeUndefined();
});

test('a composer that returns nothing usable is reported, not treated as an empty quote', async () => {
  mockCompose.mockResolvedValue(null);
  const shaped = await shapeEstimate(estimateRow());
  expect(shaped.page).toBeNull();
  expect(shaped.page_unavailable).toMatch(/composed no payload/);
});

// ── Deposits + record scope ─────────────────────────────────────────
test('deposits report the face amount and surcharge, and only a captured status counts as collected', async () => {
  const shaped = await shapeEstimate(estimateRow(), [
    { status: 'received', amount: '100.00', card_surcharge: '3.00', credited_amount: null, refunded_amount: null, refunded_surcharge: null, received_at: '2026-09-06T00:00:00Z' },
    { status: 'pending', amount: '100.00', card_surcharge: '3.00', credited_amount: null, refunded_amount: null, refunded_surcharge: null, received_at: null },
    { status: 'failed', amount: '50.00', card_surcharge: null, credited_amount: null, refunded_amount: null, refunded_surcharge: null, received_at: null },
  ]);
  expect(shaped.deposits[0]).toMatchObject({ amount: 100, card_surcharge: 3, collected: true, total_paid: 103 });
  expect(shaped.deposits[1]).toMatchObject({ collected: false, total_paid: null });
  expect(shaped.deposits[2]).toMatchObject({ collected: false, total_paid: null });
});

test('getEstimateDetail needs a selector, reports an empty result, and caps the per-customer count', async () => {
  expect(await getEstimateDetail({})).toEqual({ error: 'Provide estimate_id or customer_id' });
  db.__rows = () => [];
  expect(await getEstimateDetail({ estimate_id: 'missing' })).toMatchObject({ count: 0, estimates: [], error: 'No estimate matches that id' });
  expect(await getEstimateDetail({ customer_id: 'cust-1' })).toMatchObject({ count: 0, estimates: [], error: 'No estimates on file for that customer' });
  db.__queries.length = 0;
  db.__rows = (q) => (/estimate_deposits/.test(q.sql) ? [] : [estimateRow()]);
  const many = await getEstimateDetail({ customer_id: 'cust-1', limit: 99 });
  expect(many.count).toBe(1);
  const estimatesQuery = db.__queries.find((q) => /from "estimates"/.test(q.sql));
  expect(estimatesQuery.sql).toMatch(/limit \$\d/);
  expect(estimatesQuery.bindings).toContain(10); // MAX_PER_CUSTOMER
  expect(estimatesQuery.sql).toMatch(/"archived_at" is null/);
});

test('one estimate by id carries its deposits and the page projection', async () => {
  db.__rows = (q) => (/estimate_deposits/.test(q.sql)
    ? [{ estimate_id: 'est-1', status: 'received', amount: '100.00', card_surcharge: '3.00', credited_amount: null, refunded_amount: null, refunded_surcharge: null, received_at: '2026-09-06T00:00:00Z' }]
    : [estimateRow()]);
  const out = await getEstimateDetail({ estimate_id: 'est-1' });
  expect(out.count).toBe(1);
  expect(out.estimates[0].deposits).toHaveLength(1);
  expect(out.estimates[0].page.pricing).toEqual(PAGE_PAYLOAD.pricing);
  expect(out.estimates[0]).toMatchObject({ customer: 'Avery Example', tier: 'silver', view_count: 2, customer_notes: 'Includes exterior perimeter treatment' });
});
