// The composer's per-customer link builders: pay-balance anchor selection
// across account siblings (oldest open invoice wins; incomplete reads
// suppress the amount, never understate it), the estimate pick honoring
// isEstimateCustomerViewable, and the review builder's already-reviewed
// short-circuit. Route-level resolution is covered by
// admin-communications-customer-link.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (longUrl) => longUrl),
  invoiceShortCodePrefix: jest.fn(() => 'wpc-test'),
}));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/referral-engine', () => ({ enrollPromoter: jest.fn() }));
jest.mock('../routes/estimate-public', () => ({ isEstimateCustomerViewable: jest.fn() }));
jest.mock('../services/review-request', () => ({ createInline: jest.fn() }));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

const { openBalanceSummary } = require('../services/open-balance');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const ReviewService = require('../services/review-request');
const {
  buildPayBalanceLink,
  buildLatestEstimateLink,
  buildReviewRequestLink,
} = require('../services/composer-customer-links');

function chainBuilder({ firstRow = null, rows = [] } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereIn = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.orderByRaw = jest.fn(() => b);
  b.limit = jest.fn(async () => rows);
  b.first = jest.fn(async () => firstRow);
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockClear();
});

describe('buildPayBalanceLink', () => {
  test('anchors on the oldest open invoice across siblings and sums the balance', async () => {
    openBalanceSummary
      .mockResolvedValueOnce({
        total: 100,
        count: 1,
        invoices: [{ id: 'inv-new', due_date: '2026-08-20', created_at: '2026-08-01' }],
      })
      .mockResolvedValueOnce({
        total: 84,
        count: 1,
        invoices: [{ id: 'inv-old', due_date: '2026-07-01', created_at: '2026-06-15' }],
      });
    mockBuilders = {
      invoices: chainBuilder({ firstRow: { id: 'inv-old', token: 'tok-old', customer_id: 'c2' } }),
    };

    const r = await buildPayBalanceLink(['c1', 'c2']);
    expect(r.url).toContain('/pay/tok-old');
    expect(r.line).toContain(r.url);
    expect(r.balance).toEqual({ total: 184, count: 2 });
  });

  test('an incomplete read keeps the link but suppresses the amount', async () => {
    openBalanceSummary.mockImplementationOnce(async (_id, { onResolveFailure }) => {
      onResolveFailure(new Error('payer resolve failed'));
      return { total: 50, count: 1, invoices: [{ id: 'inv-1', due_date: '2026-08-01', created_at: '2026-08-01' }] };
    });
    mockBuilders = {
      invoices: chainBuilder({ firstRow: { id: 'inv-1', token: 'tok-1', customer_id: 'c1' } }),
    };
    const r = await buildPayBalanceLink(['c1']);
    expect(r.url).toContain('/pay/tok-1');
    expect(r.balance).toBeNull();
  });

  test('no open balance answers a plain reason, not a link', async () => {
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, invoices: [] });
    const r = await buildPayBalanceLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No open balance/);
  });
});

describe('buildLatestEstimateLink', () => {
  test('skips newer rows the customer cannot view and links the first viewable one', async () => {
    const rows = [
      { id: 'e-new', token: 'tk-new', customer_id: 'c1', status: 'sent', service_type: 'Termite' },
      { id: 'e-ok', token: 'tk-ok', customer_id: 'c1', status: 'viewed', service_type: 'Quarterly Pest Control' },
    ];
    mockBuilders = { estimates: chainBuilder({ rows }) };
    isEstimateCustomerViewable.mockImplementation((row) => row.id === 'e-ok');

    const r = await buildLatestEstimateLink(['c1']);
    expect(r.url).toContain('/estimate/tk-ok');
    expect(r.estimate).toEqual({ id: 'e-ok', serviceType: 'Quarterly Pest Control', status: 'viewed' });
  });

  test('no viewable open estimate answers a plain reason', async () => {
    mockBuilders = { estimates: chainBuilder({ rows: [] }) };
    const r = await buildLatestEstimateLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No open estimate/);
  });
});

describe('buildReviewRequestLink', () => {
  test('already-reviewed customers short-circuit before any mint', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: true } }) };
    const r = await buildReviewRequestLink('c1');
    expect(r.url).toBeNull();
    expect(ReviewService.createInline).not.toHaveBeenCalled();
  });

  test('a successful inline mint returns the url, clause, and requestId', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: false } }) };
    ReviewService.createInline.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/l/rv123',
      requestId: 'rr-1',
      token: 'tok',
    });
    const r = await buildReviewRequestLink('c1');
    expect(r.url).toContain('/l/rv123');
    expect(r.requestId).toBe('rr-1');
    expect(r.line).toContain(r.url);
  });
});
