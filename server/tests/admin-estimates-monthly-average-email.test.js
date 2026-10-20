jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    return data?.result?.quoteRequired === true ||
      data?.quoteRequired === true ||
      data?.result?.specItems?.some((item) => item.quoteRequired === true);
  }),
  estimateDataHasUnresolvedManagerApproval: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    const inputsApproved = data?.inputs?.dethatchingManagerApproved === true &&
      data?.inputs?.dethatchingManagerApprovalTrusted === true &&
      String(data?.inputs?.dethatchingManagerApprovalReason || '').trim().length > 0;
    return !inputsApproved && data?.result?.oneTime?.items?.some((item) => (
      item.requiresManagerApproval === true &&
      item.managerApprovalReason === 'st_augustine_dethatching' &&
      item.managerApprovalSatisfied !== true
    ));
  }),
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
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((gate) => (gate === 'estimateMonthlyAverage' ? mockGate.on : actual.isEnabled(gate))) };
});
const mockBilling = { ctx: { billsPerApplication: true, livePricing: null } };
jest.mock('../services/estimate-proposal-billing', () => ({
  resolveProposalBillingContext: jest.fn(async () => mockBilling.ctx),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));

const router = require('../routes/admin-estimates');
const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');

const { moneySummary, estimateEmailPayload } = router._internals;
const { emailAverageParts } = require('../services/estimate-monthly-average');

const DEFAULT_NEXT = 'When you are ready, open the estimate and accept it online. We will collect the final setup details after that.';

const pestEstimate = {
  id: 'e-pest', category: 'RESIDENTIAL', status: 'sent', address: '1 Sample St', service_interest: 'Pest Control',
  monthly_total: '31.33', annual_total: '376.00', onetime_total: '0',
  estimate_data: { sendSnapshot: { pricingBundle: {
    frequencies: [{ key: 'quarterly', perTreatment: 94, visitsPerYear: 4, monthly: 31.33, annual: 376 }],
  } } },
};

const bundleEstimate = {
  id: 'e-bundle', category: 'RESIDENTIAL', status: 'sent', address: '1 Sample St', service_interest: 'Lawn + Pest',
  monthly_total: '72.30', annual_total: '867.60', onetime_total: '99',
  estimate_data: { sendSnapshot: { pricingBundle: {
    combinedRecurring: { waveGuardDiscountPct: 0.1 },
    frequencies: [{
      key: 'quarterly', monthly: 72.3, annual: 867.6,
      perServiceTreatments: [
        { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 },
        { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 },
      ],
    }],
    oneTimeBreakdown: { items: [{ kind: 'charge', amount: 99, label: 'WaveGuard setup' }] },
  } } },
};

describe('delivery email: monthly average (GATE_ESTIMATE_MONTHLY_AVERAGE)', () => {
  beforeEach(() => {
    mockGate.on = true;
    mockBilling.ctx = { billsPerApplication: true, livePricing: null };
  });

  test('single service: "$94.00 per application · about $31.33 a month" plus the context line', async () => {
    const average = await emailAverageParts(pestEstimate);
    expect(average).toEqual({
      priceLine: '$94.00 per application · about $31.33 a month',
      note: 'Averaged over the year. You pay after each application.',
    });
    const payload = estimateEmailPayload({ estimate: pestEstimate, firstName: 'Pat', viewUrl: 'u', priceLine: moneySummary(pestEstimate), average });
    expect(payload.price_summary).toBe('$94.00 per application · about $31.33 a month');
    expect(payload.next_step_summary).toBe(`Averaged over the year. You pay after each application. ${DEFAULT_NEXT}`);
  });

  test('multi service: the plan average equals the stored monthly total; setup stays out of it', async () => {
    const average = await emailAverageParts(bundleEstimate);
    expect(average).toEqual({
      priceLine: 'Lawn + pest plan · about $72.30 a month',
      note: 'Averaged over the year, bundle savings included. You pay after each application. One-time setup $99.00, not in the average.',
    });
    expect(parseFloat(bundleEstimate.monthly_total)).toBe(72.3);
  });

  // #6360 pre-push P1: billing resolution (reconcileFrozenMembershipSnapshot)
  // mutates nested estimate_data in place; the caller's row is hashed into
  // the review's editVersion, so it must come back untouched.
  test('never mutates the caller row, including nested estimate_data', async () => {
    const billing = require('../services/estimate-proposal-billing');
    billing.resolveProposalBillingContext.mockImplementationOnce(async (row) => {
      row.monthly_total = '1.00';
      row.estimate_data.sendSnapshot.mutatedByReconcile = true;
      return mockBilling.ctx;
    });
    const row = structuredClone(pestEstimate);
    const before = JSON.stringify(row);
    await emailAverageParts(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  test('gate off: no average, and the payload is byte-identical to before', async () => {
    mockGate.on = false;
    expect(await emailAverageParts(pestEstimate)).toBeNull();
    const priceLine = moneySummary(pestEstimate);
    expect(priceLine).toBe('Priced per application — full breakdown inside');
    expect(estimateEmailPayload({ estimate: pestEstimate, firstName: 'Pat', viewUrl: 'u', priceLine, average: null })).toEqual({
      first_name: 'Pat',
      estimate_url: 'u',
      price_summary: 'Priced per application — full breakdown inside',
      service_summary: expect.any(String),
      property_address: '1 Sample St',
      next_step_summary: DEFAULT_NEXT,
    });
  });

  test('plans the gate leaves alone', async () => {
    // Annual prepay / monthly member / unknown lane: the billing authority says not per application.
    mockBilling.ctx = { billsPerApplication: false, livePricing: null };
    expect(await emailAverageParts(pestEstimate)).toBeNull();
    mockBilling.ctx = { billsPerApplication: true, livePricing: null };
    // Commercial.
    expect(await emailAverageParts({ ...pestEstimate, category: 'COMMERCIAL' })).toBeNull();
    // Quote-required.
    expect(await emailAverageParts({ ...pestEstimate, estimate_data: { ...pestEstimate.estimate_data, quoteRequired: true } })).toBeNull();
    // One-time only: no recurring total.
    expect(await emailAverageParts({ ...pestEstimate, monthly_total: '0', annual_total: '0', onetime_total: '250', estimate_data: {} })).toBeNull();
    expect(moneySummary({ monthly_total: '0', onetime_total: '250' }, { average: { priceLine: 'x' } })).toBe('$250.00 one-time');
  });

  test('a commercial proposal keeps its own totals line and ignores the average', () => {
    const proposalLine = moneySummary({ monthly_total: '2361', annual_total: '28332' }, { allowTotals: true, average: { priceLine: 'x' } });
    expect(proposalLine).toBe('$2361.00/mo · $28,332.00/yr');
    const payload = estimateEmailPayload({
      estimate: pestEstimate, firstName: 'Pat', viewUrl: 'u', priceLine: '$2361.00/mo', proposalMode: true,
      average: { priceLine: 'x', note: 'y' },
    });
    expect(payload.price_summary).toBe('$2361.00/mo');
    expect(payload.next_step_summary).not.toContain('Averaged');
  });

  test('a stored total that no longer matches the lines withholds the average', async () => {
    expect(await emailAverageParts({ ...pestEstimate, monthly_total: '40.00' })).toBeNull();
  });
});
