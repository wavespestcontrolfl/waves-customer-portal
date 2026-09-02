/**
 * check_existing_estimates hands the lead agent ONLY rows the customer can
 * open (#3750, uncapped codex P1 r33): expired / send-failed / unpublished /
 * invalidated rows are refused by the public page, so their price, bearer
 * token, and URL never reach the agent. Viewability is applied BEFORE the
 * five-row limit by paging the candidates, so newer hidden rows cannot mask
 * an older estimate the customer still holds.
 */

const mockGate = { applies: false, deliverable: true };
jest.mock('../services/pricing-authority-gate', () => ({
  gatedSendAuthorityPredicateApplies: () => mockGate.applies,
  estimateDeliverableUnderGate: jest.fn(async () => mockGate.deliverable),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: jest.fn(),
  withAutomatedEstimatePhoneLock: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  isEstimateCustomerViewable: (row, now = new Date()) => {
    if (!row || row.archived_at) return false;
    if (['accepted', 'declined'].includes(row.status)) return true;
    if (['draft', 'scheduled', 'expired', 'send_failed'].includes(row.status)) return false;
    if (row.expires_at && new Date(row.expires_at) < now) return false;
    return true;
  },
}));

const pages = [];
const builder = {
  where: jest.fn(() => builder),
  orWhere: jest.fn(() => builder),
  orderBy: jest.fn(() => builder),
  offset: jest.fn(() => builder),
  limit: jest.fn(async () => pages.shift() || []),
};
const mockDb = jest.fn(() => builder);
jest.mock('../models/db', () => mockDb);

const { executeLeadTool } = require('../services/lead-response-tools');

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const row = (over = {}) => ({
  id: over.id || 'e1', token: 'tk-' + (over.id || 'e1'), status: 'sent', customer_id: 'c1',
  sent_at: PAST, viewed_at: null, expires_at: FUTURE, monthly_total: 149, total_amount: 149,
  service_interest: 'Pest', archived_at: null, ...over,
});

beforeEach(() => {
  pages.length = 0;
  builder.offset.mockClear();
  builder.limit.mockClear();
  mockGate.applies = false;
  mockGate.deliverable = true;
});

describe('check_existing_estimates viewability', () => {
  test('an expired newest row is hidden; the older open estimate still links', async () => {
    pages.push([row({ id: 'e-new', status: 'expired' }), row({ id: 'e-old' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' });
    expect(out.hasEstimates).toBe(true);
    expect(out.estimates.map((e) => e.id)).toEqual(['e-old']);
    expect(out.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-old');
    expect(out.estimates[0].token).toBe('tk-e-old');
    expect(out.unviewableEstimates).toBe(1);
  });

  test('a past expires_at, a draft, and a send-failed row never surface a price, token, or URL', async () => {
    pages.push([
      row({ id: 'e-stale', expires_at: PAST }),
      row({ id: 'e-draft', status: 'draft', sent_at: null }),
      row({ id: 'e-failed', status: 'send_failed' }),
    ]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' });
    expect(out).toEqual({ hasEstimates: false, estimates: [], unviewableEstimates: 3 });
    expect(JSON.stringify(out)).not.toMatch(/tk-|149/);
  });

  test('pages past a full page of hidden rows so they cannot mask an older open estimate', async () => {
    const hidden = Array.from({ length: 15 }, (_, i) => row({ id: `h${i}`, status: 'expired' }));
    pages.push(hidden, [row({ id: 'e-old' })]);
    const out = await executeLeadTool('check_existing_estimates', { phone: '(941) 555-0100' });
    expect(out.estimates.map((e) => e.id)).toEqual(['e-old']);
    expect(builder.offset).toHaveBeenNthCalledWith(1, 0);
    expect(builder.offset).toHaveBeenNthCalledWith(2, 15);
    expect(out.unviewableEstimates).toBe(15);
  });

  test('stops at five viewable rows', async () => {
    pages.push(Array.from({ length: 15 }, (_, i) => row({ id: `v${i}` })));
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' });
    expect(out.estimates).toHaveLength(5);
    expect(builder.limit).toHaveBeenCalledTimes(1);
  });

  test('gate on: a viewable row the verdict refuses lists without price, token, or URL', async () => {
    mockGate.applies = true;
    mockGate.deliverable = false;
    pages.push([row({ id: 'e-fallback' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' });
    expect(out.estimates[0]).toMatchObject({
      id: 'e-fallback', token: null, viewUrl: null,
      totalWithheld: 'pricing-authority-not-server', viewUrlWithheld: 'pricing-authority-not-server',
    });
    expect(out.estimates[0].total).toBeUndefined();
  });

  test('no candidates at all', async () => {
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' });
    expect(out).toEqual({ hasEstimates: false, estimates: [] });
  });
});
