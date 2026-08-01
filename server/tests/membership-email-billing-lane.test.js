/**
 * membership.updated must not tell a per-application customer their "Monthly
 * rate" changed ("per month" audit 2026-08-01): monthly_rate is stored for
 * almost every recurring customer, but only a monthly_membership lane is
 * billed monthly — 157 of 159 per-application customers carry a rate they are
 * never charged. The summary line is gated on resolveBillingLane, the same
 * predicate the billing cron and card-enrollment email use.
 *
 * The gate needs billing_mode/pipeline_stage on the loaded customer row —
 * loadCustomer originally omitted both, which would have dropped every
 * customer into NULL-mode inference (tier + rate ⇒ "member") and shown the
 * monthly line to exactly the audience the gate exists for.
 */

const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const sentTemplates = [];
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async (args) => { sentTemplates.push(args); return { sent: true, message: {} }; }),
  hasTemplate: jest.fn(() => true),
}));

const { sendMembershipUpdated } = require('../services/account-membership-email');

function stubCustomer(row) {
  mockDb.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: () => ({ select: () => ({ first: async () => row }) }) };
    }
    // Idempotency / lifecycle logging tables — accept everything quietly.
    const chain = {
      where: () => chain,
      insert: async () => [],
      first: async () => null,
      select: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      update: async () => 1,
      onConflict: () => ({ ignore: async () => [] }),
    };
    return chain;
  });
}

const BASE = {
  id: 'c1',
  first_name: 'Pat',
  last_name: 'Tester',
  email: 'pat@example.com',
  waveguard_tier: 'Bronze',
  monthly_rate: 45,
  active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  sentTemplates.length = 0;
});

async function summaryFor(customerRow) {
  stubCustomer(customerRow);
  const res = await sendMembershipUpdated({
    customerId: 'c1',
    before: { waveguard_tier: 'Bronze', monthly_rate: 40 },
    after: { waveguard_tier: 'Bronze', monthly_rate: 45 },
  });
  expect(res.ok).toBe(true);
  expect(sentTemplates).toHaveLength(1);
  return String(sentTemplates[0].payload.membership_change_summary || '');
}

describe('membership.updated billing-lane gate', () => {
  test('a true monthly member still sees the monthly-rate line', async () => {
    const summary = await summaryFor({ ...BASE, billing_mode: 'monthly_membership', pipeline_stage: 'active_customer' });
    expect(summary).toMatch(/Monthly rate: .*40.* to .*45/);
  });

  test('a per-application customer never sees a monthly rate', async () => {
    const summary = await summaryFor({ ...BASE, billing_mode: 'per_application', pipeline_stage: 'active_customer' });
    expect(summary).not.toMatch(/Monthly rate/i);
    expect(summary).toMatch(/per application/i);
  });

  // Codex #3128 r1: each non-monthly lane gets its own billing terms — the
  // per-application wording is wrong for prepaid and invoice-on-complete lanes.
  test('an annual-prepay customer sees prepaid wording, never a monthly rate', async () => {
    const summary = await summaryFor({ ...BASE, billing_mode: 'annual_prepay', pipeline_stage: 'active_customer' });
    expect(summary).not.toMatch(/Monthly rate/i);
    expect(summary).toMatch(/prepaid for the year/i);
    expect(summary).not.toMatch(/per application/i);
  });

  test('a per-visit customer sees invoice-on-complete wording, not per application', async () => {
    const summary = await summaryFor({ ...BASE, billing_mode: 'per_visit', pipeline_stage: 'active_customer' });
    expect(summary).not.toMatch(/Monthly rate/i);
    expect(summary).toMatch(/billed after it is completed/i);
    expect(summary).not.toMatch(/per application/i);
  });

  // The NULL-mode legacy inference: a real tier + positive rate IS the
  // 8AM-dues audience, so the monthly line remains truthful for them.
  test('a NULL-mode inferred member keeps the monthly-rate line', async () => {
    const summary = await summaryFor({ ...BASE, billing_mode: null, pipeline_stage: 'active_customer' });
    expect(summary).toMatch(/Monthly rate/);
  });
});
