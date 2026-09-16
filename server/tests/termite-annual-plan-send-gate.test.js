process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn();
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
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
  reviseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(() => 'https://example.test/estimate/tok'),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-clarify-asks', () => ({ clearEstimateRepricePending: jest.fn(async () => ({})) }));
jest.mock('../routes/estimate-public', () => ({ acceptanceServiceLists: jest.fn(), bookingServiceFor: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));

// Gate values are fixed at module load; this passthrough flips the one gate
// under test per case.
const mockGateState = { sendRequiresServerPricing: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => (gate === 'sendRequiresServerPricing'
      ? mockGateState.sendRequiresServerPricing
      : actual.isEnabled(gate)),
  };
});

const adminEstimatesRouter = require('../routes/admin-estimates');

const { selectedTermiteAnnualPlanRows } = require('../services/estimate-termite-program-rows');
const { assertEstimateSendable, annualPlanOfferFingerprint, publishedSiblingDeliveryPatch } = adminEstimatesRouter._internals;

const PLAN_LINE = { service: 'termite_bait', plan: 'annual_protection', stations: 15 };
const QUARTERLY_LINE = { ...PLAN_LINE, plan: 'quarterly' };
const row = (data = { result: { lineItems: [PLAN_LINE] } }) => ({
  id: 'synthetic-annual', status: 'draft', token: 'synthetic-token', pricing_authority: 'SERVER',
  monthly_total: 0, annual_total: 299, onetime_total: 450, estimate_data: data,
});
const delivered = () => {
  const estimate = row();
  estimate.status = 'sent';
  estimate.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z',
    annualPlanOfferFingerprint: annualPlanOfferFingerprint(estimate) };
  return estimate;
};
const caught = (estimate) => { try { assertEstimateSendable(estimate); return null; } catch (error) { return error; } };
const prior = [process.env.GATE_TERMITE_ANNUAL_PLAN, process.env.GATE_CANCEL_FLOW_V2];
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TERMITE_ANNUAL_PLAN = process.env.GATE_CANCEL_FLOW_V2 = 'false';
});
afterAll(() => {
  ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'].forEach((key, index) => {
    if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
  });
});

test.each([
  [{ result: { lineItems: [PLAN_LINE] } }, 1],
  [{ engineResult: { lineItems: [PLAN_LINE] } }, 1],
  [{ result: { results: { tmBait: { plan: 'annual_protection' } } } }, 1],
  [{ result: { oneTime: { items: [{ service: 'termite_bait_installation', kind: 'setup' }] } } }, 1],
  [{ result: { oneTime: { items: [{ service: 'termite_bait_installation' }] } } }, 0],
  [{ result: { results: { tmBait: { plan: 'quarterly' } } }, engineResult: { lineItems: [PLAN_LINE] } }, 0],
  [{ result: { lineItems: [QUARTERLY_LINE] } }, 0],
  [{ result: { lineItems: 'junk' } }, 0], [null, 0],
])('stored shape %j selects %s annual rows', (data, count) => {
  expect(selectedTermiteAnnualPlanRows(data)).toHaveLength(count);
  expect(caught(row(data))?.code || null).toBe(count ? 'TERMITE_ANNUAL_PLAN_DISABLED' : null);
});

test.each([[false, false], [false, true], [true, false], [true, true]])(
  'annual=%s cancellation=%s distinguish fresh and issued offers', (annual, cancel) => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = String(annual);
    process.env.GATE_CANCEL_FLOW_V2 = String(cancel);
    expect(caught(row())?.code || null).toBe(annual && cancel ? null : 'TERMITE_ANNUAL_PLAN_DISABLED');
    expect(caught(delivered())).toBeNull();
  },
);

test.each([
  ['notes', 'changed'], ['customer_id', 'other'], ['property_id', 'other'], ['estimate_group_id', 'other'],
  ['customer_phone', '9415550101'], ['customer_email', 'other@example.test'], ['customer_name', 'Other'],
  ['address', 'Other synthetic property'], ['show_one_time_option', true], ['bill_by_invoice', true],
  ['annual_total', 399],
])('a changed %s cannot reuse delivery authority', (key, value) => {
  const estimate = delivered(); estimate[key] = value;
  expect(caught(estimate)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
});

test('pricing changes and quarterly or suppressed handoffs cannot issue the annual offer', () => {
  const estimate = delivered();
  estimate.estimate_data.result.lineItems = [{ ...PLAN_LINE, annual: 399 }];
  expect(caught(estimate)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  delete estimate.estimate_data.deliveryState.annualPlanOfferFingerprint;
  expect(caught(estimate)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  delete estimate.estimate_data.deliveryState;
  estimate.sent_at = '2026-01-01T12:00:00Z';
  estimate.estimate_data = JSON.stringify(estimate.estimate_data);
  expect(caught(estimate)).toMatchObject({ statusCode: 422, code: 'TERMITE_ANNUAL_PLAN_DISABLED' });
});

test('operational metadata and database representations preserve the issued offer', () => {
  const estimate = delivered(); const fingerprint = annualPlanOfferFingerprint(estimate);
  for (const estimatorEngine of [{ delivering_at: 'now', delivering_token: 'claim' }, {}]) {
    estimate.estimate_data.estimatorEngine = estimatorEngine;
    expect(annualPlanOfferFingerprint(estimate)).toBe(fingerprint);
  }
  Object.assign(estimate.estimate_data, { viewedMonthlyTotal: 299, followupOwnershipFrom: 'sibling',
    leadServiceHandoffAttempt: { at: 'now', parkId: 'synthetic-park' },
    groupLinkViewableThrough: '2099-01-01T00:00:00Z', automation: { autoSend: { at: 'now' } } });
  estimate.annual_total = '299.00';
  estimate.estimate_data.result.lineItems = [{ stations: 15, plan: 'annual_protection', service: 'termite_bait' }];
  expect(caught(estimate)).toBeNull();
  expect(annualPlanOfferFingerprint(estimate)).toBe(fingerprint);
});

test('a published sibling receives its own fingerprint and bounded delivery history', () => {
  const sibling = delivered();
  const history = Array.from({ length: 26 }, (_, i) => `synthetic-time-${i}`);
  sibling.estimate_data.deliveryState.deliveredAt = history;
  const at = '2026-01-02T12:00:00Z';
  const patch = publishedSiblingDeliveryPatch(sibling, { annualPlanOfferFingerprint: 'anchor' }, at);
  expect(patch.deliveryState).toMatchObject({ firstDeliveredAt: '2026-01-01T12:00:00Z', lastDeliveredAt: at,
    deliveredAt: [...history.slice(-24), at], annualPlanOfferFingerprint: annualPlanOfferFingerprint(sibling) });
  Object.assign(sibling.estimate_data, patch, { groupPublishedByEstimateId: 'anchor' });
  expect(caught(sibling)).toBeNull();
});
