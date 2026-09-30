jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  billingEmailDetailsLive: () => process.env.GATE_BILLING_EMAIL_DETAILS === 'true',
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => null),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => null),
}));
// Lazy-required inside paymentStepStillRequiresCard — mocking the route
// module keeps the 15k-line router out of the test process entirely.
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: jest.fn(() => true),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  resolveEstimateInvoiceMode: jest.fn(() => false),
  matchAcceptCustomerByPhone: jest.fn(async () => ({ match: null })),
  buildPricingBundle: jest.fn(async () => ({})),
  resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
  estimateTrenchingReviewRequired: jest.fn(() => false),
  reconcileFrozenMembershipSnapshot: jest.fn(async () => {}),
  resolveAcceptOneTimeTotal: jest.fn(() => 149),
  commercialAcceptDepositExempt: jest.fn(() => false),
  isCommercialAutoAcceptEstimate: jest.fn(() => false),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  commercialLowConfidenceRange: jest.fn(() => ({ hasLowConfidence: false, forceSiteQuote: false })),
}));
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: jest.fn(async () => null),
}));
jest.mock('../services/recurring-card-on-file', () => ({
  resolveRecurringCardPolicyForEstimate: jest.fn(async () => ({ required: true })),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: true })),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({})),
}));


const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const { _private } = require('../services/estimate-follow-up');

/**
 * Property row on the estimate follow-up emails (GATE_BILLING_EMAIL_DETAILS,
 * dark, owner-approved 2026-09-29). The payload already carried
 * `property_address`; the audit found 203 follow-ups where no block showed it.
 * The templates now render `property_full_address`, filled only here and only
 * under the gate.
 */

function rowsFor(table) {
  const b = {};
  for (const m of ['where', 'select', 'whereRaw']) b[m] = jest.fn(() => b);
  b.first = jest.fn(async () => (typeof table === 'function' ? table() : table));
  return b;
}

const est = (overrides = {}) => ({
  id: 'est-1',
  customer_email: 'lead@example.com',
  customer_phone: null,
  customer_id: null,
  address: '123 Example Street, Bradenton, FL 34205',
  ...overrides,
});

const emailLeg = (payload = {}) => ({
  templateKey: 'estimate.engage_gone_quiet',
  stage: 'engage_viewed_gone_quiet_72h',
  payload: { first_name: 'Sam', property_address: '123 Example Street, Bradenton, FL 34205', ...payload },
});

const sentPayload = () => EmailTemplateLibrary.sendTemplate.mock.calls.at(-1)[0].payload;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BILLING_EMAIL_DETAILS;
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  db.mockReset();
});
afterEach(() => { delete process.env.GATE_BILLING_EMAIL_DETAILS; });

test('gate off: the payload is exactly what the builder made - no new variable, no lookup', async () => {
  const payload = { first_name: 'Sam', property_address: '123 Example Street, Bradenton, FL 34205' };
  await _private.sendDualChannel(est(), { email: emailLeg() });
  expect(sentPayload()).toEqual(payload);
  expect(db).not.toHaveBeenCalled();
});

test('gate on: the estimate\'s own address is the Property row, and the original variable is untouched', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  await _private.sendDualChannel(est(), { email: emailLeg() });
  expect(sentPayload()).toEqual({
    first_name: 'Sam',
    property_address: '123 Example Street, Bradenton, FL 34205',
    property_full_address: '123 Example Street, Bradenton, FL 34205',
  });
  expect(db).not.toHaveBeenCalled();
});

test('gate on: an estimate address with no street number is a nickname, so the saved property\'s street address is used', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  db.mockImplementation((table) => {
    if (table === 'customer_properties') {
      return rowsFor({ address_line1: '77 Saved Street', city: 'Parrish', state: 'FL', zip: '34219' });
    }
    throw new Error(`Unexpected db table ${table}`);
  });
  await _private.sendDualChannel(est({ address: 'Primary', customer_id: 'cust-1', property_id: 'prop-1' }), { email: emailLeg() });
  expect(sentPayload().property_full_address).toBe('77 Saved Street, Parrish, FL 34219');
});

test('gate on: with no usable estimate address the customer\'s street address is used, never their profile label', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return rowsFor({ address_line1: '1 Main Street', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: 'Primary' });
    }
    throw new Error(`Unexpected db table ${table}`);
  });
  await _private.sendDualChannel(est({ address: '', customer_id: 'cust-1' }), { email: emailLeg({ property_address: '' }) });
  expect(sentPayload().property_full_address).toBe('1 Main Street, Bradenton, FL 34205');
});

test.each(['Rental 2', 'Property #2', 'Unit 4', 'Additional property'])(
  'gate on: the nickname %p in estimates.address is not a street address; the linked property\'s structured address is used',
  async (nickname) => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') {
        return rowsFor({ address_line1: '77 Saved Street', city: 'Parrish', state: 'FL', zip: '34219' });
      }
      throw new Error(`Unexpected db table ${table}`);
    });
    await _private.sendDualChannel(est({ address: nickname, customer_id: 'cust-1', property_id: 'prop-1' }), { email: emailLeg({ property_address: nickname }) });
    expect(sentPayload().property_full_address).toBe('77 Saved Street, Parrish, FL 34219');
  },
);

test('gate on: a street-shaped estimate address with a digit-led house number is used as is', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  await _private.sendDualChannel(est({ address: '5A Palm Ave, Parrish, FL 34219' }), { email: emailLeg() });
  expect(sentPayload().property_full_address).toBe('5A Palm Ave, Parrish, FL 34219');
  expect(db).not.toHaveBeenCalled();
});

test('gate on: nothing known is no row at all (the variable is absent, so the template drops the block)', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  await _private.sendDualChannel(est({ address: 'Primary' }), { email: emailLeg({ property_address: 'Primary' }) });
  expect(sentPayload()).not.toHaveProperty('property_full_address');
});

test('gate on: the send key and categories are unchanged', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  await _private.sendDualChannel(est(), { email: emailLeg() });
  const args = EmailTemplateLibrary.sendTemplate.mock.calls.at(-1)[0];
  expect(args.idempotencyKey).toBe('estimate_followup_engage_viewed_gone_quiet_72h:est-1');
  expect(args.categories).toEqual(['estimate_followup', 'estimate_followup_engage_viewed_gone_quiet_72h']);
});
