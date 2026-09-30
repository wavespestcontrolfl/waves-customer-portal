// The "Your plan" section of the one-signup-email (GATE_SIGNUP_SINGLE_EMAIL) is
// built by the SAME payload builder membership.started sends with — so the two
// can never state different plan facts — and is withheld exactly where
// membership.started would not have been sent.

const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const sentTemplates = [];
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async (args) => { sentTemplates.push(args); return { sent: true, message: {} }; }),
}));

const { sendMembershipStarted, buildMembershipStartedSection } = require('../services/account-membership-email');

const CUSTOMER = {
  id: 'c1', first_name: 'Pat', last_name: 'Tester', email: 'pat@example.com',
  address_line1: '1 Example Way', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: 'Primary',
  waveguard_tier: 'Gold', monthly_rate: 89, billing_mode: 'monthly_membership', pipeline_stage: 'active_customer', active: true,
};

function stub({ customer = CUSTOMER, prefs = null, prefsError = null } = {}) {
  mockDb.mockImplementation((table) => {
    if (table === 'customers') return { where: () => ({ select: () => ({ first: async () => customer }) }) };
    if (table === 'notification_prefs') {
      return { where: () => ({ first: async () => { if (prefsError) throw prefsError; return prefs; } }) };
    }
    const chain = { where: () => chain, insert: async () => [], first: async () => null, select: () => chain, orderBy: () => chain, limit: () => chain };
    return chain;
  });
}

const ARGS = {
  customerId: 'c1',
  effectiveDate: new Date('2026-10-06T16:00:00Z'),
  sourceId: 'estimate:e1',
  membershipTier: 'Gold',
  monthlyRate: 89,
  billingCadence: 'monthly',
  includedServices: 'Quarterly Pest Control, Lawn Care',
  // The onboarding email's resolved recipient (ignored by sendMembershipStarted).
  recipientEmail: 'pat@example.com',
};

beforeEach(() => { jest.clearAllMocks(); sentTemplates.length = 0; });

test('the section carries the same plan facts membership.started sends', async () => {
  stub();
  const section = await buildMembershipStartedSection(ARGS);
  await sendMembershipStarted(ARGS);
  const sent = sentTemplates[0].payload;
  expect(section.planName).toBe(sent.membership_name);
  expect(section.variables).toEqual({
    plan_heading: 'Your plan',
    plan_name: sent.membership_name,
    plan_effective_date: sent.effective_date,
    plan_rate: sent.monthly_rate,
    plan_billing: sent.billing_cadence,
    plan_services: sent.included_services,
  });
  expect(section.variables.plan_name).toBe('WaveGuard Gold');
  expect(section.variables.plan_rate).toBe('$89.00');
});

test.each([
  ['per_application', { billingLane: 'per_application', perApplicationAmount: 91 }, '$91.00', 'per application'],
  ['annual_prepay', { billingLane: 'annual_prepay' }, '', '12 months prepaid'],
  ['per_visit', { billingLane: 'per_visit' }, '', 'billed after each service'],
])('%s lane: the same lane-gated rate and cadence as the membership email', async (_lane, extra, rate, cadence) => {
  stub();
  const section = await buildMembershipStartedSection({ ...ARGS, ...extra });
  await sendMembershipStarted({ ...ARGS, ...extra });
  expect(section.variables.plan_rate).toBe(rate);
  expect(section.variables.plan_billing).toBe(cadence);
  expect(section.variables.plan_rate).toBe(sentTemplates[0].payload.monthly_rate);
});

test('a one_time lane has no membership, so no plan section (and no membership email)', async () => {
  stub();
  expect(await buildMembershipStartedSection({ ...ARGS, billingLane: 'one_time' })).toBe(null);
});

test('no customer: no section', async () => {
  stub({ customer: null });
  expect(await buildMembershipStartedSection(ARGS)).toBe(null);
});

test('the customer opted out of email (notification_prefs.email_enabled = false): no section, so nothing is folded into an email they opted out of', async () => {
  stub({ prefs: { email_enabled: false } });
  expect(await buildMembershipStartedSection(ARGS)).toBe(null);
});

test('an unreadable preference fails closed (no section); membership.started then decides for itself', async () => {
  stub({ prefsError: new Error('db down') });
  expect(await buildMembershipStartedSection(ARGS)).toBe(null);
});

// GH Codex r6 P1: the onboarding email can fall back to the estimate's own
// contact (a tenant); the account holder's plan must never go to that address.
describe('plan section only for the customer\'s own email', () => {
  test('a different recipient (the estimate contact) gets no plan section', async () => {
    stub();
    expect(await buildMembershipStartedSection({ ...ARGS, recipientEmail: 'tenant@example.com' })).toBe(null);
  });

  test('no recipient email → no plan section', async () => {
    stub();
    expect(await buildMembershipStartedSection({ ...ARGS, recipientEmail: undefined })).toBe(null);
  });

  test('a customer with no email of their own → no plan section', async () => {
    stub({ customer: { ...CUSTOMER, email: '' } });
    expect(await buildMembershipStartedSection({ ...ARGS, recipientEmail: '' })).toBe(null);
  });

  test('the same address in another case and with spaces still matches', async () => {
    stub();
    const section = await buildMembershipStartedSection({ ...ARGS, recipientEmail: '  PAT@Example.com ' });
    expect(section?.variables?.plan_name).toBeTruthy();
  });
});
