// 10-30 estimate audit F4. A one-time estimate saved with member pricing whose
// plan lapses before send: the link reconciles membership and shows the
// non-member amount, so the email's price_summary and the SMTP preheader must
// show that same amount, not the stored member amount. Fakes only: no email,
// no text, no database.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
// The link's reconcile: a lapsed member's one-time amount goes from the
// member price to the non-member price, in place, like the real one.
const mockReconcile = jest.fn(async (row) => {
  row.onetime_total = 150;
  return { ok: true };
});
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  bookingServiceFor: jest.fn(),
  reconcileFrozenMembershipSnapshot: (...args) => mockReconcile(...args),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));

const router = require('../routes/admin-estimates');

const { currentQuoteMoneySummary, moneySummary, estimateEmailPayload, estimateSmtpContent } = router._internals;

const memberPricedOneTime = () => ({
  id: 'e-lapsed', token: 'tok', category: 'RESIDENTIAL', status: 'draft', address: '1 Sample St',
  service_interest: 'One-Time Pest', customer_id: 'cust-1',
  monthly_total: '0', annual_total: '0', onetime_total: '127.50',
  estimate_data: { inputs: { isRecurringCustomer: 'YES' } },
});

beforeEach(() => {
  mockReconcile.mockClear();
  mockReconcile.mockImplementation(async (row) => { row.onetime_total = 150; return { ok: true }; });
});

describe('send price line reads the current quote (F4)', () => {
  test('the stored line is the member price; the current line is the one the link shows', async () => {
    const estimate = memberPricedOneTime();
    expect(moneySummary(estimate)).toBe('$127.50 one-time');
    const priceLine = await currentQuoteMoneySummary(estimate);
    expect(priceLine).toBe('$150.00 one-time');
  });

  test('the email price_summary and the SMTP preheader both carry the current amount', async () => {
    const estimate = memberPricedOneTime();
    const priceLine = await currentQuoteMoneySummary(estimate);
    const payload = estimateEmailPayload({ estimate, firstName: 'Sam', viewUrl: 'https://example.invalid/e', priceLine });
    expect(payload.price_summary).toBe('$150.00 one-time');
    const smtp = estimateSmtpContent({ firstName: 'Sam', viewUrl: 'https://example.invalid/e', priceLine, proposalMode: false });
    expect(smtp.html + smtp.text).toContain('$150.00 one-time');
    expect(smtp.html + smtp.text).not.toContain('$127.50');
  });

  test('never changes the caller row (it is hashed into the review version)', async () => {
    const estimate = memberPricedOneTime();
    const before = JSON.stringify(estimate);
    await currentQuoteMoneySummary(estimate);
    expect(JSON.stringify(estimate)).toBe(before);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  test('an active member (nothing to reconcile) keeps the stored amount', async () => {
    mockReconcile.mockImplementation(async () => undefined);
    expect(await currentQuoteMoneySummary(memberPricedOneTime())).toBe('$127.50 one-time');
  });

  test('a reconcile failure falls back to the stored line, as before', async () => {
    mockReconcile.mockRejectedValue(new Error('lookup down'));
    expect(await currentQuoteMoneySummary(memberPricedOneTime())).toBe('$127.50 one-time');
  });
});
