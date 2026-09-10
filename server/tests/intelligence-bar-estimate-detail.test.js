// get_estimate_detail: the amounts inside a sent estimate, per line.
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
// The converter's own readers are exercised for real (alias handling is
// theirs); only the container extractors are stubbed to keep fixtures small.
jest.mock('../services/estimate-converter', () => {
  const actual = jest.requireActual('../services/estimate-converter');
  return {
    recurringServiceKey: actual.recurringServiceKey,
    recurringLineAnnualAmount: actual.recurringLineAnnualAmount,
    visitsPerYearForRecurringService: actual.visitsPerYearForRecurringService,
    recurringServicesFromEstimateData: jest.fn((data) => data.recurring?.services || []),
    estimateOneTimeItemsFromData: jest.fn((data) => {
      const result = data.result && typeof data.result === 'object' ? data.result : data;
      return data.oneTime?.items || result.oneTime?.items || [];
    }),
  };
});
const mockDeriveCorrectiveWork = jest.fn(() => ({ correctiveWork: null, warning: 'not reconciled' }));
jest.mock('../services/estimate-proposal-generate', () => ({ deriveCorrectiveWork: (...a) => mockDeriveCorrectiveWork(...a) }));
jest.mock('../routes/estimate-public', () => {
  const unpublished = ['draft', 'scheduled'];
  return {
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
  view_count: 2, notes: 'Includes exterior perimeter treatment', pricing_version: 'v2', bill_by_invoice: false,
  accepted_service_mode: null, accepted_frequency_key: null, disposition: null, disposition_note: null, decline_reason: null,
  created_at: '2026-09-05T14:00:00Z', updated_at: '2026-09-05T15:00:00Z',
  estimate_data: JSON.stringify({
    recurring: { services: [
      { name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4, monthly: 47, annual: 564 },
      { key: 'lawn_care', frequency: 'every_6_weeks', visits: 8, quoteRequired: true },
    ] },
    oneTime: { items: [{ label: 'Initial cleanup', price: 200, priceAfterDiscount: 150 }, { name: 'Referral credit', amount: -25 }] },
    result: { summary: { recurringMonthlyAfterDiscount: 47, recurringAnnualAfterDiscount: 564, oneTimeTotal: 125 } },
    agentDraftReview: { reasoning: 'internal only' },
  }),
  ...overrides,
});

beforeEach(() => {
  mockDeriveCorrectiveWork.mockReset();
  mockDeriveCorrectiveWork.mockReturnValue({ correctiveWork: null, warning: 'not reconciled' });
});

test('tool definition names the per-application use, takes either selector, types the ids', () => {
  expect(GET_ESTIMATE_DETAIL_TOOL.name).toBe('get_estimate_detail');
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/per-application/);
  const props = GET_ESTIMATE_DETAIL_TOOL.input_schema.properties;
  expect(Object.keys(props).sort()).toEqual(['customer_id', 'estimate_id', 'limit']);
  expect(props.estimate_id.format).toBe('uuid');
  expect(props.customer_id.format).toBe('uuid');
});

test('shapes recurring lines with per-visit prices, extracted one-time discounts and credits, totals, customer link', () => {
  const shaped = shapeEstimate(estimateRow(), [{ amount: '50.00', credited_amount: '0', refunded_amount: '0', status: 'received', received_at: '2026-09-06T10:00:00Z' }]);
  expect(shaped.recurring_services).toEqual([
    { service: 'Quarterly Pest Control', frequency: 'quarterly', visits_per_year: 4, monthly: 47, annual: 564, per_visit: 141 },
    { service: 'lawn_care', frequency: 'every_6_weeks', visits_per_year: 8, monthly: null, annual: null, per_visit: null, quote_required: true },
  ]);
  expect(shaped.one_time_items).toEqual([
    { item: 'Initial cleanup', amount: 150, source: 'extracted' },
    { item: 'Referral credit', amount: -25, source: 'extracted' },
  ]);
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
  expect(shaped.deposits).toEqual([{ amount: 50, credited: 0, refunded: 0, status: 'received', received_at: '2026-09-06T10:00:00Z' }]);
  expect(shaped.customer_link).toBe('https://portal.wavespestcontrol.com/estimate/xydejpzuxx');
  expect(shaped.link_state).toBe('customer_viewable');
  expect(shaped.customer_notes).toBe('Includes exterior perimeter treatment');
  expect(JSON.stringify(shaped)).not.toContain('internal only');
});

test('operator-accepted finals outrank engine figures on recurring and one-time lines (Codex r1 P1 ×2)', () => {
  const shaped = shapeEstimate(estimateRow({
    estimate_data: JSON.stringify({
      recurring: { services: [
        // legacy aliases: mo / ann, package visits under `apps`
        { label: 'Bi-monthly Pest', mo: 40, ann: 480, apps: 6 },
        // adjusted after the engine ran: the accepted net wins
        { name: 'Mosquito', annualAfterDiscount: 600, visitsPerYear: 8, manualFinalAnnual: 480 },
        // fully comped line: explicit zero, not "unpriced"
        { name: 'Flea treatment', annual: 300, visitsPerYear: 3, manualFinalAnnual: 0 },
      ] },
      oneTime: { items: [{ label: 'Bed bug prep', price: 900, priceAfterDiscount: 800, manualFinalOneTime: 650 }, { label: 'Comped inspection', price: 95, manualFinalOneTime: 0 }] },
    }),
  }));
  expect(shaped.recurring_services).toEqual([
    { service: 'Bi-monthly Pest', frequency: null, visits_per_year: 6, monthly: 40, annual: 480, per_visit: 80 },
    { service: 'Mosquito', frequency: null, visits_per_year: 8, monthly: 40, annual: 480, per_visit: 60 },
    { service: 'Flea treatment', frequency: null, visits_per_year: 3, monthly: 0, annual: 0, per_visit: 0, comped: true },
  ]);
  expect(shaped.one_time_items).toEqual([
    { item: 'Bed bug prep', amount: 650, source: 'extracted' },
    { item: 'Comped inspection', amount: 0, source: 'extracted' },
  ]);
});

test('one-time work comes from the corrective-work deriver when it reconciles; engineResult shapes feed both readers (Codex r1 P1, P2)', () => {
  mockDeriveCorrectiveWork.mockReturnValue({ correctiveWork: [{ label: 'Bed bug treatment', amount: 1200, service: 'bed_bug' }], warning: null });
  const row = estimateRow({
    monthly_total: null, annual_total: null, onetime_total: null,
    estimate_data: JSON.stringify({ engineResult: { summary: { recurringMonthlyAfterDiscount: 0, recurringAnnualAfterDiscount: 0, oneTimeTotal: 1200 }, lineItems: [{ name: 'Bed bug treatment', price: 1200 }] } }),
  });
  const shaped = shapeEstimate(row);
  expect(mockDeriveCorrectiveWork).toHaveBeenCalledWith(expect.objectContaining({ engineResult: expect.any(Object) }), row);
  expect(shaped.one_time_items).toEqual([{ item: 'Bed bug treatment', amount: 1200, source: 'reconciled' }]);
  // totals fallback selects engineResult, not the outer object
  expect(shaped.totals).toEqual({ monthly: 0, annual: 0, one_time: 1200 });

  // deriver cannot reconcile → extractor fallback still descends engineResult
  mockDeriveCorrectiveWork.mockReturnValue({ correctiveWork: null, warning: 'nope' });
  const fallback = shapeEstimate(estimateRow({
    estimate_data: JSON.stringify({ engineResult: { oneTime: { items: [{ name: 'Exclusion work', price: 450 }] } } }),
  }));
  expect(fallback.one_time_items).toEqual([{ item: 'Exclusion work', amount: 450, source: 'extracted' }]);
});

test('links follow the public route: customer link only when viewable, staff preview for drafts, nothing for expired or archived (Codex r1 P2)', () => {
  expect(shapeEstimate(estimateRow({ status: 'draft' }))).toMatchObject({ customer_link: null, staff_preview_link: 'https://portal.wavespestcontrol.com/estimate/xydejpzuxx?adminPreview=1', link_state: 'staff_preview_only' });
  expect(shapeEstimate(estimateRow({ status: 'expired' }))).toMatchObject({ customer_link: null, staff_preview_link: null, link_state: 'not_openable' });
  expect(shapeEstimate(estimateRow({ status: 'draft', archived_at: '2026-09-01T00:00:00Z' }))).toMatchObject({ customer_link: null, staff_preview_link: null, link_state: 'not_openable' });
  expect(shapeEstimate(estimateRow({ status: 'accepted', accepted_at: '2026-09-07T00:00:00Z' }))).toMatchObject({ link_state: 'customer_viewable', accepted: { at: '2026-09-07T00:00:00Z', service_mode: null, frequency: null } });
  expect(shapeEstimate(estimateRow({ token: null }))).toMatchObject({ customer_link: null, link_state: 'no_token' });
});

test('totals fall back to the engine summary when the columns are empty, and bad JSON still answers', () => {
  const fromSummary = shapeEstimate(estimateRow({ monthly_total: null, annual_total: null, onetime_total: null }));
  expect(fromSummary.totals).toEqual({ monthly: 47, annual: 564, one_time: 125 });
  const broken = shapeEstimate(estimateRow({ estimate_data: '{not json', monthly_total: '12.5', annual_total: null, onetime_total: null }));
  expect(broken.recurring_services).toEqual([]);
  expect(broken.one_time_items).toEqual([]);
  expect(broken.totals).toEqual({ monthly: 12.5, annual: 0, one_time: 0 });
});

test('estimate_id reads one row; customer_id reads latest live estimates with a bounded limit', async () => {
  db.__queries = [];
  db.__rows = (q) => (q.sql.includes('"estimate_deposits"') ? [] : [estimateRow()]);
  const one = await getEstimateDetail({ estimate_id: 'est-1' });
  expect(one.count).toBe(1);
  expect(one.estimates[0].id).toBe('est-1');
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
