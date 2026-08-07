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

const { sendMembershipUpdated, sendMembershipStarted } = require('../services/account-membership-email');

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
    // Codex #3128 r2: the template's "Previous rate"/"New rate" detail rows
    // render from these fields and the renderer drops empty-valued rows —
    // they must be blank outside the monthly lane.
    expect(sentTemplates[0].payload.old_monthly_rate).toBe('');
    expect(sentTemplates[0].payload.new_monthly_rate).toBe('');
  });

  test('a monthly member keeps the rate detail rows populated', async () => {
    await summaryFor({ ...BASE, billing_mode: 'monthly_membership', pipeline_stage: 'active_customer' });
    expect(sentTemplates[0].payload.old_monthly_rate).not.toBe('');
    expect(sentTemplates[0].payload.new_monthly_rate).not.toBe('');
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

// Codex #3128 r8: an admin can change the lane AND the rate in one save.
// Resolving only the post-update lane presented the old stored figure as
// "your previous monthly rate" for a customer who was never billed monthly.
describe('membership.updated resolves BOTH sides of a lane transition', () => {
  async function transition({ from, to, beforeRate = 40, afterRate = 45 }) {
    stubCustomer({ ...BASE, billing_mode: to, pipeline_stage: 'active_customer' });
    const res = await sendMembershipUpdated({
      customerId: 'c1',
      before: { waveguard_tier: 'Bronze', monthly_rate: beforeRate, billing_mode: from },
      after: { waveguard_tier: 'Bronze', monthly_rate: afterRate, billing_mode: to },
    });
    expect(res.ok).toBe(true);
    expect(sentTemplates).toHaveLength(1);
    return sentTemplates[0].payload;
  }

  test('moving INTO the monthly lane states the new charge and invents no previous rate', async () => {
    const payload = await transition({ from: 'per_application', to: 'monthly_membership' });
    const summary = String(payload.membership_change_summary || '');
    // The old $40 was a stored per-application artifact, never a monthly charge.
    expect(summary).not.toMatch(/40/);
    expect(summary).toMatch(/now billed monthly at .*45/);
    expect(payload.old_monthly_rate).toBe('');
    expect(payload.new_monthly_rate).not.toBe('');
  });

  test('moving OUT of the monthly lane shows no monthly figures at all', async () => {
    const payload = await transition({ from: 'monthly_membership', to: 'per_application' });
    const summary = String(payload.membership_change_summary || '');
    expect(summary).not.toMatch(/Monthly rate/i);
    expect(summary).toMatch(/per application/i);
    expect(payload.old_monthly_rate).toBe('');
    expect(payload.new_monthly_rate).toBe('');
  });

  test('a rate change WITHIN the monthly lane still shows both figures', async () => {
    const payload = await transition({ from: 'monthly_membership', to: 'monthly_membership' });
    expect(String(payload.membership_change_summary)).toMatch(/Monthly rate: .*40.* to .*45/);
    expect(payload.old_monthly_rate).not.toBe('');
    expect(payload.new_monthly_rate).not.toBe('');
  });
});

// membership.started was the LAST lane-ungated monthly_rate reader (#3140
// resolution 2026-08-07): three welcome emails since 08-01 told
// per-application customers a monthly figure they are never charged
// ("$30.33 / quarter" for a real $91-per-application plan). The rate/cadence
// rows now gate on the billing lane, and the estimate converter passes the
// lane EXPLICITLY because the send is fire-and-forget and can race the
// still-uncommitted accept transaction (the pool read sees the PRE-accept
// row).
describe('membership.started billing-lane gate', () => {
  async function startedPayload(customerRow, args = {}) {
    stubCustomer({ pipeline_stage: 'active_customer', ...customerRow });
    const res = await sendMembershipStarted({ customerId: 'c1', ...args });
    expect(res.ok).toBe(true);
    expect(sentTemplates).toHaveLength(1);
    return sentTemplates[0].payload;
  }

  test('RACE PATH: the explicit lane wins over a stale customer row', async () => {
    // The row still shows the PRE-accept state (NULL mode + tier + rate —
    // resolves monthly_membership); the converter knows the accept stamps
    // per_application. The explicit param must win or the welcome email
    // quotes a monthly charge that will never bill.
    const payload = await startedPayload(
      { ...BASE, billing_mode: null, monthly_rate: 30.33 },
      { billingLane: 'per_application', perApplicationAmount: 91, monthlyRate: 30.33, billingCadence: 'quarter' },
    );
    expect(payload.monthly_rate).toBe('$91.00');
    expect(payload.billing_cadence).toBe('per application');
  });

  test('per-application multi-service accepts render a BLANK fee (row drops)', async () => {
    // A multi-service accept intentionally stamps NO customer-level fee —
    // the whole-plan monthly figure must not leak in as a substitute.
    const payload = await startedPayload(
      { ...BASE, billing_mode: null, per_application_fee: null },
      { billingLane: 'per_application', perApplicationAmount: null, monthlyRate: 150 },
    );
    expect(payload.monthly_rate).toBe('');
    expect(payload.billing_cadence).toBe('per application');
  });

  test('an EXPLICIT null fee is preserved even over a stale positive row fee', async () => {
    // Codex #3271: the send races the accept transaction, so the pool read
    // can still see a pre-accept row carrying an old per-application fee
    // (e.g. a per_visit/one_time customer converting via a multi-service
    // accept that CLEARS the fee). An explicitly passed null must not fall
    // back to that obsolete amount — the row stays blank and drops.
    const payload = await startedPayload(
      { ...BASE, billing_mode: 'per_visit', per_application_fee: 91 },
      { billingLane: 'per_application', perApplicationAmount: null, monthlyRate: 150 },
    );
    expect(payload.monthly_rate).toBe('');
    expect(payload.billing_cadence).toBe('per application');
  });

  test('an OMITTED fee argument still falls back to the customer row fee', async () => {
    // Only undefined (the admin-route callers, which never pass the key)
    // rides the row fallback — distinct from the converter's explicit null.
    const payload = await startedPayload(
      { ...BASE, billing_mode: 'per_application', per_application_fee: 91 },
      { billingLane: 'per_application', monthlyRate: 150 },
    );
    expect(payload.monthly_rate).toBe('$91.00');
    expect(payload.billing_cadence).toBe('per application');
  });

  test('without an explicit lane, the fee falls back to the customer row', async () => {
    const payload = await startedPayload(
      { ...BASE, billing_mode: 'per_application', per_application_fee: 109 },
      { monthlyRate: 36.33 },
    );
    expect(payload.monthly_rate).toBe('$109.00');
    expect(payload.billing_cadence).toBe('per application');
  });

  test('annual prepay renders no rate and prepaid wording', async () => {
    const payload = await startedPayload(
      { ...BASE, billing_mode: null },
      { billingLane: 'annual_prepay', monthlyRate: 55, billingCadence: 'annual prepay' },
    );
    expect(payload.monthly_rate).toBe('');
    expect(payload.billing_cadence).toBe('12 months prepaid');
  });

  test('a true monthly member is unchanged', async () => {
    const payload = await startedPayload(
      { ...BASE, billing_mode: 'monthly_membership' },
      { billingLane: 'monthly_membership', monthlyRate: 45, billingCadence: 'month' },
    );
    expect(payload.monthly_rate).toBe('$45.00');
    expect(payload.billing_cadence).toBe('month');
  });

  test('a NULL-mode inferred member still sees the monthly rate (fallback resolution)', async () => {
    const payload = await startedPayload(
      { ...BASE, billing_mode: null },
      { monthlyRate: 45 },
    );
    expect(payload.monthly_rate).toBe('$45.00');
  });

  test('invoice-on-complete lanes show no rate and no banned phrasing', async () => {
    const payload = await startedPayload(
      { ...BASE, billing_mode: 'per_visit' },
      { monthlyRate: 55 },
    );
    expect(payload.monthly_rate).toBe('');
    expect(payload.billing_cadence).toBe('billed after each service');
  });

  test('HARD RULE: no lane ever renders the phrase "per visit"', async () => {
    for (const lane of ['per_application', 'annual_prepay', 'per_visit', 'one_time', 'monthly_membership']) {
      sentTemplates.length = 0;
      const payload = await startedPayload(
        { ...BASE, billing_mode: lane === 'monthly_membership' ? 'monthly_membership' : null },
        { billingLane: lane, monthlyRate: 45, perApplicationAmount: 91 },
      );
      expect(JSON.stringify(payload)).not.toMatch(/per visit/i);
    }
  });
});
