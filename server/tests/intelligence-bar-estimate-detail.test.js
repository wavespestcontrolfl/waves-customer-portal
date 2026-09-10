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
jest.mock('../services/estimate-converter', () => ({
  recurringServiceKey: (svc) => svc.key || null,
  recurringServicesFromEstimateData: jest.fn((data) => data.recurring?.services || []),
  estimateOneTimeItemsFromData: jest.fn((data) => data.oneTime?.items || []),
}));
const db = require('../models/db');
const { getEstimateDetail, shapeEstimate, GET_ESTIMATE_DETAIL_TOOL } = require('../services/intelligence-bar/estimate-detail');

const estimateRow = (overrides = {}) => ({
  id: 'est-1', customer_id: 'cust-1', customer_name: 'Avery Example', address: '100 Test St',
  status: 'sent', category: 'RESIDENTIAL', service_interest: 'Quarterly Pest Control', waveguard_tier: 'silver',
  monthly_total: '47.00', annual_total: '564.00', onetime_total: '150.00', token: 'xydejpzuxx',
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
    result: { summary: { recurringMonthlyAfterDiscount: 47, recurringAnnualAfterDiscount: 564, oneTimeTotal: 150 } },
    agentDraftReview: { reasoning: 'internal only' },
  }),
  ...overrides,
});

test('tool definition names the per-application use and takes either selector', () => {
  expect(GET_ESTIMATE_DETAIL_TOOL.name).toBe('get_estimate_detail');
  expect(GET_ESTIMATE_DETAIL_TOOL.description).toMatch(/per-application/);
  expect(Object.keys(GET_ESTIMATE_DETAIL_TOOL.input_schema.properties).sort()).toEqual(['customer_id', 'estimate_id', 'limit']);
});

test('shapes recurring lines with per-visit prices, one-time discounts and credits, totals, link', () => {
  const shaped = shapeEstimate(estimateRow(), [{ amount: '50.00', credited_amount: '0', refunded_amount: '0', status: 'received', received_at: '2026-09-06T10:00:00Z' }]);
  expect(shaped.recurring_services).toEqual([
    { service: 'Quarterly Pest Control', frequency: 'quarterly', visits_per_year: 4, monthly: 47, annual: 564, per_visit: 141 },
    { service: 'lawn_care', frequency: 'every_6_weeks', visits_per_year: 8, monthly: null, annual: null, per_visit: null, quote_required: true },
  ]);
  expect(shaped.one_time_items).toEqual([{ item: 'Initial cleanup', amount: 150 }, { item: 'Referral credit', amount: -25 }]);
  expect(shaped.totals).toEqual({ monthly: 47, annual: 564, one_time: 150 });
  expect(shaped.deposits).toEqual([{ amount: 50, credited: 0, refunded: 0, status: 'received', received_at: '2026-09-06T10:00:00Z' }]);
  expect(shaped.link).toBe('https://portal.wavespestcontrol.com/estimate/xydejpzuxx');
  expect(shaped.customer_notes).toBe('Includes exterior perimeter treatment');
  expect(JSON.stringify(shaped)).not.toContain('internal only');
});

test('totals fall back to the engine summary when the columns are empty, and bad JSON still answers', () => {
  const fromSummary = shapeEstimate(estimateRow({ monthly_total: null, annual_total: null, onetime_total: null }));
  expect(fromSummary.totals).toEqual({ monthly: 47, annual: 564, one_time: 150 });
  const broken = shapeEstimate(estimateRow({ estimate_data: '{not json', monthly_total: '12.5', annual_total: null, onetime_total: null }));
  expect(broken.recurring_services).toEqual([]);
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
