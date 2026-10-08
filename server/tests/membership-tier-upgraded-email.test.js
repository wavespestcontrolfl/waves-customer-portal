/**
 * membership.tier_upgraded: the "your WaveGuard plan moved up" email
 * (owner-approved copy 2026-10-08).
 *
 * Behavior under test: what a customer reads. The sender's payload is
 * rendered through the REAL template library against the seeded template
 * (migration 20261008100000), so these assert the finished text:
 *   - every figure comes from the pricing constants (a changed constant
 *     changes the email; nothing is typed in the template or the sender);
 *   - the per-palm credit line shows only from the tier that earns it;
 *   - a monthly figure shows only to a customer billed monthly, and a
 *     previous monthly figure only when both sides were billed monthly;
 *   - the sender refuses anything that is not a move to a higher tier.
 * Regression this guards: a "% off" or "$ a month" line the customer's
 * account does not back.
 */

const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const sentTemplates = [];
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(async (args) => { sentTemplates.push(args); return { sent: true, message: {} }; }),
}));

const EmailTemplates = require('../services/email-template-library');
const { WAVEGUARD, PALM } = require('../services/pricing-engine/constants');
const seed = require('../models/migrations/20261008100000_membership_tier_upgraded_email_template');
const { sendMembershipTierUpgraded } = require('../services/account-membership-email');

const { TEMPLATE, templateRow } = seed._private;

function stubCustomer(row) {
  mockDb.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: () => ({ select: () => ({ first: async () => row }) }) };
    }
    const chain = {
      where: () => chain,
      insert: async () => [],
      first: async () => null,
      select: () => chain,
    };
    return chain;
  });
}

const BASE = {
  id: 'c1',
  first_name: 'Taylor',
  last_name: 'Example',
  email: 'taylor@example.invalid',
  waveguard_tier: 'Silver',
  monthly_rate: 90,
  billing_mode: 'monthly_membership',
  pipeline_stage: 'active_customer',
  active: true,
};

// The email as the customer gets it: the sender's payload through the real
// renderer and the seeded template.
function render(payload) {
  const row = templateRow(TEMPLATE);
  return EmailTemplates.renderTemplate({
    template: {
      id: 'tmpl-tier-upgraded',
      ...row,
      allowed_variables: JSON.parse(row.allowed_variables),
      required_variables: JSON.parse(row.required_variables),
      optional_variables: JSON.parse(row.optional_variables),
    },
    version: { id: 'ver-1', subject: TEMPLATE.subject, preview_text: TEMPLATE.preview, blocks: TEMPLATE.blocks, text_body: '' },
    payload,
  });
}

async function sendAndRender({ customer = BASE, before, after }) {
  stubCustomer({ ...customer, ...after });
  const res = await sendMembershipTierUpgraded({ customerId: 'c1', before, after, idempotencyKey: 'k1' });
  expect(res.ok).toBe(true);
  expect(sentTemplates).toHaveLength(1);
  expect(sentTemplates[0].templateKey).toBe('membership.tier_upgraded');
  return render(sentTemplates[0].payload);
}

const pct = (fraction) => String(Number((fraction * 100).toFixed(1)));

beforeEach(() => {
  jest.clearAllMocks();
  sentTemplates.length = 0;
});

describe('membership.tier_upgraded template seed', () => {
  test('is a publishable transactional membership template: every variable it uses is allowed, every required one is used', () => {
    const row = templateRow(TEMPLATE);
    expect(row).toMatchObject({
      template_key: 'membership.tier_upgraded',
      mode: 'service',
      purpose: 'membership',
      audience: 'customer',
      send_stream: 'transactional_required',
      suppression_group_key: 'transactional_required',
      from_name: 'Waves Pest Control',
      status: 'active',
    });
    const rendered = render(TEMPLATE.fixture.payload);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.validation.disallowed_variables).toEqual([]);
    expect(rendered.validation.missing_required_in_template).toEqual([]);
    expect(rendered.missingPayload).toEqual([]);
  });

  test('the fixture renders the owner-approved text, in order', () => {
    const { subject, text } = render(TEMPLATE.fixture.payload);
    expect(subject).toBe('Your WaveGuard plan is now Gold');
    const body = text.slice(text.indexOf('Hi Taylor,'), text.indexOf('Questions? Just reply to this email.') + 'Questions? Just reply to this email.'.length);
    expect(body).toBe([
      'Hi Taylor,',
      'Good news: your WaveGuard plan moved up from Bronze to Gold.',
      'WHAT GOLD INCLUDES',
      [
        '- 15% off each recurring service in your plan (pest control, lawn care, tree & shrub, mosquito, termite bait and rodent bait)',
        "- 15% off one-time services, like a roach clean-out or a special treatment, because you're a recurring customer",
        '- A $10 per palm credit each year on palm injections',
      ].join('\n'),
      'Your monthly rate: $85.00 (was $100.00)',
      'Nothing else changes. Same technician, same schedule.',
      'Questions? Just reply to this email.',
    ].join('\n\n'));
    expect(text).not.toMatch(/& Lawn Care/);
  });

  // The template names the services that take the tier discount. If the
  // pricing constants gain or lose one, this copy must be re-approved.
  test('the recurring services named in the copy are exactly the WaveGuard qualifying services', () => {
    expect([...WAVEGUARD.qualifyingServices].sort()).toEqual(
      ['lawn_care', 'mosquito', 'pest_control', 'rodent_bait', 'termite_bait', 'tree_shrub'],
    );
  });
});

describe('sendMembershipTierUpgraded: benefit lines come from the pricing constants', () => {
  test.each([
    ['Bronze', 'Silver'],
    ['Silver', 'Gold'],
    ['Bronze', 'Platinum'],
  ])('%s to %s shows that tier\'s recurring discount and the one-time perk', async (from, to) => {
    const { subject, text } = await sendAndRender({
      before: { waveguard_tier: from, monthly_rate: 100, billing_mode: 'monthly_membership' },
      after: { waveguard_tier: to, monthly_rate: 90, billing_mode: 'monthly_membership' },
    });
    expect(subject).toBe(`Your WaveGuard plan is now ${to}`);
    expect(text).toContain(`your WaveGuard plan moved up from ${from} to ${to}.`);
    expect(text).toContain(`- ${pct(WAVEGUARD.tiers[to.toLowerCase()].discount)}% off each recurring service in your plan`);
    expect(text).toContain(`- ${pct(WAVEGUARD.recurringCustomerOneTimePerk)}% off one-time services`);
  });

  test('the per-palm credit line shows from the tier that earns it, and not below it', async () => {
    const line = `- A $${PALM.flatCreditPerPalm} per palm credit each year on palm injections`;
    expect(PALM.flatCreditMinTier).toBe('gold');

    const silver = await sendAndRender({
      before: { waveguard_tier: 'Bronze', monthly_rate: 100 }, after: { waveguard_tier: 'Silver', monthly_rate: 90 },
    });
    expect(silver.text).not.toMatch(/palm/i);

    for (const to of ['Gold', 'Platinum']) {
      sentTemplates.length = 0;
      const rendered = await sendAndRender({
        before: { waveguard_tier: 'Silver', monthly_rate: 100 }, after: { waveguard_tier: to, monthly_rate: 90 },
      });
      expect(rendered.text).toContain(line);
    }
  });

  test('a changed constant changes the email (no typed figures)', async () => {
    const saved = { silver: WAVEGUARD.tiers.silver.discount, perk: WAVEGUARD.recurringCustomerOneTimePerk };
    WAVEGUARD.tiers.silver.discount = 0.125;
    WAVEGUARD.recurringCustomerOneTimePerk = 0.2;
    try {
      const { text } = await sendAndRender({
        before: { waveguard_tier: 'Bronze', monthly_rate: 100 }, after: { waveguard_tier: 'Silver', monthly_rate: 90 },
      });
      expect(text).toContain('- 12.5% off each recurring service in your plan');
      expect(text).toContain('- 20% off one-time services');
    } finally {
      WAVEGUARD.tiers.silver.discount = saved.silver;
      WAVEGUARD.recurringCustomerOneTimePerk = saved.perk;
    }
  });

  test('a tier with no recurring discount sends nothing: the "% off" line would be untrue', async () => {
    const saved = WAVEGUARD.tiers.silver.discount;
    WAVEGUARD.tiers.silver.discount = 0;
    try {
      stubCustomer(BASE);
      const res = await sendMembershipTierUpgraded({
        customerId: 'c1', before: { waveguard_tier: 'Bronze', monthly_rate: 100 }, after: { waveguard_tier: 'Silver', monthly_rate: 90 },
      });
      expect(res).toMatchObject({ ok: false, skipped: true, reason: 'tier_benefit_unavailable' });
      expect(sentTemplates).toHaveLength(0);
    } finally {
      WAVEGUARD.tiers.silver.discount = saved;
    }
  });
});

describe('sendMembershipTierUpgraded: the rate sentence follows the billing lane', () => {
  test('billed monthly before and after: the new rate and the old one', async () => {
    const { text } = await sendAndRender({
      before: { waveguard_tier: 'Bronze', monthly_rate: 100, billing_mode: 'monthly_membership' },
      after: { waveguard_tier: 'Silver', monthly_rate: 90, billing_mode: 'monthly_membership' },
    });
    expect(text).toContain('Your monthly rate: $90.00 (was $100.00)');
  });

  test('moved INTO monthly billing: the new charge, and no previous monthly figure', async () => {
    const { text } = await sendAndRender({
      before: { waveguard_tier: 'Bronze', monthly_rate: 100, billing_mode: 'per_application' },
      after: { waveguard_tier: 'Silver', monthly_rate: 90, billing_mode: 'monthly_membership' },
    });
    expect(text).toContain('Your plan is now billed monthly at $90.00.');
    expect(text).not.toMatch(/100/);
    expect(text).not.toMatch(/\(was /);
  });

  test.each([
    ['per_application', /you are billed per application/],
    ['annual_prepay', /prepaid for the year/],
    ['per_visit', /each service is billed after it is completed/],
  ])('a %s customer never sees a monthly figure', async (lane, wording) => {
    const { text } = await sendAndRender({
      customer: { ...BASE, billing_mode: lane },
      before: { waveguard_tier: 'Bronze', monthly_rate: 100, billing_mode: lane },
      after: { waveguard_tier: 'Silver', monthly_rate: 90, billing_mode: lane },
    });
    expect(text).toMatch(wording);
    expect(text).not.toMatch(/monthly/i);
    expect(text).not.toMatch(/\$\s?\d/);
  });

  test('no rate change: no rate sentence at all', async () => {
    const { text } = await sendAndRender({
      before: { waveguard_tier: 'Bronze', monthly_rate: 90, billing_mode: 'monthly_membership' },
      after: { waveguard_tier: 'Silver', monthly_rate: 90, billing_mode: 'monthly_membership' },
    });
    expect(text).not.toMatch(/monthly rate|billed monthly|pricing was updated/i);
    expect(text).toContain('Nothing else changes. Same technician, same schedule.');
  });
});

describe('sendMembershipTierUpgraded: only a move to a higher WaveGuard tier', () => {
  test.each([
    ['a downgrade', 'Gold', 'Silver'],
    ['the same tier', 'Silver', 'Silver'],
    ['a first tier from blank', '', 'Silver'],
    ['a first tier from None', 'None', 'Gold'],
    ['a tier that is not a WaveGuard tier', 'Bronze', 'Commercial'],
  ])('%s sends nothing', async (_label, from, to) => {
    stubCustomer(BASE);
    const res = await sendMembershipTierUpgraded({
      customerId: 'c1', before: { waveguard_tier: from, monthly_rate: 100 }, after: { waveguard_tier: to, monthly_rate: 90 },
    });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: 'not_a_tier_upgrade' });
    expect(sentTemplates).toHaveLength(0);
  });

  test('uses the caller\'s idempotency key, and the shared sendTemplate path (transactional group, customer recipient)', async () => {
    await sendAndRender({
      before: { waveguard_tier: 'Bronze', monthly_rate: 100 }, after: { waveguard_tier: 'Silver', monthly_rate: 90 },
    });
    expect(sentTemplates[0]).toMatchObject({
      idempotencyKey: 'k1',
      to: 'taylor@example.invalid',
      recipientType: 'customer',
      recipientId: 'c1',
      suppressionGroupKey: 'transactional_required',
    });
  });

  test('a customer with no email on file gets nothing (sendTemplate stays the authority)', async () => {
    stubCustomer({ ...BASE, email: '' });
    const res = await sendMembershipTierUpgraded({
      customerId: 'c1', before: { waveguard_tier: 'Bronze', monthly_rate: 100 }, after: { waveguard_tier: 'Silver', monthly_rate: 90 },
    });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: 'missing_email' });
    expect(sentTemplates).toHaveLength(0);
  });
});

// The seed migration against a recording knex stand-in: what it writes, that
// a re-run writes nothing, and that every jsonb column reaches the driver as
// JSON text (a raw JS array is sent by pg as a Postgres array literal, which
// aborts the migration).
describe('migration 20261008100000 seeds membership.tier_upgraded once', () => {
  function fakeKnex({ tables = ['email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log'] } = {}) {
    const store = { email_templates: [], email_template_versions: [], email_template_fixtures: [], audit_log: [] };
    let seq = 0;
    const knex = (table) => {
      let filter = () => true;
      const rows = () => store[table].filter(filter);
      const q = {
        where(cond) { filter = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
        first: async () => rows()[0],
        max() { return { first: async () => ({ max: rows().reduce((m, r) => Math.max(m, r.version_number), 0) || null }) }; },
        insert(row) {
          const saved = { id: `${table}-${seq += 1}`, ...row };
          store[table].push(saved);
          const done = Promise.resolve([saved]);
          done.returning = async () => [saved];
          return done;
        },
        update: async (patch) => { rows().forEach((r) => Object.assign(r, patch)); return 1; },
      };
      return q;
    };
    knex.schema = { hasTable: async (name) => tables.includes(name) };
    knex.store = store;
    return knex;
  }

  test('writes one active template, one published version and one fixture; a second run changes nothing', async () => {
    const knex = fakeKnex();
    await seed.up(knex);
    const snapshot = JSON.stringify(knex.store);
    await seed.up(knex);
    expect(JSON.stringify(knex.store)).toBe(snapshot);

    const [template] = knex.store.email_templates;
    const [version] = knex.store.email_template_versions;
    expect(knex.store.email_templates).toHaveLength(1);
    expect(knex.store.email_template_versions).toHaveLength(1);
    expect(knex.store.email_template_fixtures).toHaveLength(1);
    expect(template).toMatchObject({ template_key: 'membership.tier_upgraded', status: 'active', active_version_id: version.id });
    expect(version).toMatchObject({ template_id: template.id, version_number: 1, status: 'active', subject: TEMPLATE.subject });
    for (const value of [template.allowed_variables, template.required_variables, template.optional_variables, version.blocks, knex.store.email_template_fixtures[0].payload]) {
      expect(typeof value).toBe('string');
      expect(() => JSON.parse(value)).not.toThrow();
    }
    expect(JSON.parse(version.blocks)).toEqual(TEMPLATE.blocks);
    // One audit event for the seed, and none for the no-op re-run.
    expect(knex.store.audit_log).toHaveLength(1);
    expect(knex.store.audit_log[0]).toMatchObject({
      actor_type: 'system', action: 'email_template.seeded', resource_type: 'email_template', resource_id: template.id,
      metadata: { templateKey: 'membership.tier_upgraded', versionId: version.id },
    });
  });

  test('a database with no audit_log table still seeds', async () => {
    const knex = fakeKnex({ tables: ['email_templates', 'email_template_versions'] });
    await seed.up(knex);
    expect(knex.store.email_templates[0].active_version_id).toBe(knex.store.email_template_versions[0].id);
    expect(knex.store.email_template_fixtures).toHaveLength(0);
    expect(knex.store.audit_log).toHaveLength(0);
  });

  test('an operator-edited template (it already has an active version) is left alone', async () => {
    const knex = fakeKnex();
    knex.store.email_templates.push({ id: 't-edited', template_key: 'membership.tier_upgraded', active_version_id: 'v-edited' });
    await seed.up(knex);
    expect(knex.store.email_template_versions).toHaveLength(0);
    expect(knex.store.audit_log).toHaveLength(0);
    expect(knex.store.email_templates[0].active_version_id).toBe('v-edited');
  });

  test('a database without the template tables is a no-op, and down() never deletes', async () => {
    const knex = fakeKnex({ tables: [] });
    await expect(seed.up(knex)).resolves.toBeUndefined();
    expect(knex.store.email_templates).toHaveLength(0);
    await expect(seed.down(knex)).resolves.toBeUndefined();
  });
});
