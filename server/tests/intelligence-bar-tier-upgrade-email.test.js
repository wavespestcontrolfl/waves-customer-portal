/**
 * The tier-upgrade email of an Intelligence Bar update_customer card
 * (owner 2026-10-08, GATE_IB_TIER_UPGRADE_EMAIL, dark).
 *
 * Behavior under test: WHEN the card may promise the email (proposal) and
 * when the commit really starts it (afterCommit, and the update_customer
 * executor that calls it).
 * Regressions this guards: an email to a customer whose plan did not move up
 * or whose price did not change; an email the card never showed; two emails
 * for one card; a failed email undoing or failing the customer update.
 * All sends are mocked.
 */
jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.whereIn = jest.fn(() => qb);
  qb.whereNull = jest.fn(() => qb);
  qb.forUpdate = jest.fn(() => qb);
  qb.first = jest.fn();
  qb.select = jest.fn(() => Promise.resolve([]));
  qb.update = jest.fn(() => Promise.resolve(1));
  qb.distinct = jest.fn(() => Promise.resolve([]));
  const db = jest.fn((table) => { db.__tables.push(table); db.__table = table; return qb; });
  db.__tables = [];
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn(async (cb) => cb(db));
  db.raw = jest.fn(() => Promise.resolve());
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-lifecycle-guard', () => ({
  churnGuardOrRepair: jest.fn(async () => ({ blocked: false })),
  describeLiveVisit: jest.fn(() => 'a visit'),
}));
jest.mock('../services/plan-rate-ledger', () => ({
  ...jest.requireActual('../services/plan-rate-ledger'),
  loadComponents: jest.fn(async () => []),
  setLineForScalarWrite: jest.fn(async () => undefined),
  syncScalarWriteToLedger: jest.fn(async () => undefined),
}));
const mockSendTierUpgraded = jest.fn(async () => ({ ok: true }));
jest.mock('../services/account-membership-email', () => ({
  ...jest.requireActual('../services/account-membership-email'),
  sendMembershipTierUpgraded: (...a) => mockSendTierUpgraded(...a),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const TierUpgradeEmail = require('../services/intelligence-bar/tier-upgrade-email');
const { executeTool } = require('../services/intelligence-bar/tools');

const CUSTOMER_ID = 'cust-1';
const ACTION_ID = '7e1c2f7a-1111-2222-3333-deadbeef0001';
// A real monthly member: Bronze at $100 a month.
const MEMBER = {
  id: CUSTOMER_ID,
  first_name: 'Taylor',
  last_name: 'Example',
  email: 'taylor@example.invalid',
  waveguard_tier: 'Bronze',
  waveguard_tier_source: 'manual',
  monthly_rate: '100.00',
  billing_mode: 'monthly_membership',
  pipeline_stage: 'active_customer',
  active: true,
  deleted_at: null,
};
const UPGRADE = { waveguard_tier: 'Silver', monthly_rate: 90 };
const PIN = { from: 'bronze', to: 'silver' };

// customers reads return `customer`; notification_prefs reads return `prefs`.
function stubRows({ customer = MEMBER, prefs = null } = {}) {
  db.__qb.first.mockImplementation(async () => (db.__table === 'notification_prefs' ? prefs : (customer ? { ...customer } : customer)));
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  db.__tables.length = 0;
  db.transaction.mockImplementation(async (cb) => cb(db));
  mockSendTierUpgraded.mockImplementation(async () => ({ ok: true }));
  process.env.GATE_IB_TIER_UPGRADE_EMAIL = 'true';
  stubRows();
});
afterAll(() => { delete process.env.GATE_IB_TIER_UPGRADE_EMAIL; });

describe('eligibility: the send rules on a before/after pair of customer rows', () => {
  const after = (patch) => ({ ...MEMBER, waveguard_tier: 'Silver', monthly_rate: 90, ...patch });

  test('a higher tier with a changed monthly rate, for an active monthly member, is eligible', () => {
    expect(TierUpgradeEmail.eligibility(MEMBER, after())).toEqual({ eligible: true, from: 'bronze', to: 'silver' });
    expect(TierUpgradeEmail.eligibility({ ...MEMBER, waveguard_tier: 'Silver' }, after({ waveguard_tier: 'Platinum' })))
      .toEqual({ eligible: true, from: 'silver', to: 'platinum' });
  });

  test.each([
    ['a downgrade', { ...MEMBER, waveguard_tier: 'Gold' }, after(), 'not_an_upgrade'],
    ['the same tier', { ...MEMBER, waveguard_tier: 'Silver' }, after(), 'not_an_upgrade'],
    ['a first tier from blank', { ...MEMBER, waveguard_tier: null }, after(), 'first_tier'],
    ['a first tier from None', { ...MEMBER, waveguard_tier: 'None' }, after(), 'first_tier'],
    ['a tier cleared', MEMBER, after({ waveguard_tier: null }), 'not_a_waveguard_tier'],
    ['a tier change with no price change', MEMBER, after({ monthly_rate: '100.00' }), 'price_unchanged'],
    ['a stored rate the customer is not billed (per application)', { ...MEMBER, billing_mode: 'per_application' }, after({ billing_mode: 'per_application' }), 'rate_not_billed'],
    ['a monthly customer whose new rate is zero (no dues are charged)', MEMBER, after({ monthly_rate: 0 }), 'rate_not_billed'],
    ['a stored rate the customer is not billed (annual prepay)', { ...MEMBER, billing_mode: 'annual_prepay' }, after({ billing_mode: 'annual_prepay' }), 'rate_not_billed'],
    ['an auto-derived tier label before the change', { ...MEMBER, waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: null }, after({ billing_mode: null }), 'not_a_member_before'],
    ['an inactive customer', MEMBER, after({ active: false }), 'inactive'],
    ['a churned customer', MEMBER, after({ pipeline_stage: 'churned' }), 'inactive'],
    ['a deleted customer', MEMBER, after({ deleted_at: new Date() }), 'inactive'],
  ])('%s is not eligible', (_label, beforeRow, afterRow, reason) => {
    expect(TierUpgradeEmail.eligibility(beforeRow, afterRow)).toEqual({ eligible: false, reason });
  });
});

describe('proposal: what the card may promise', () => {
  test('gate on: pins the tier move and gives the card its line', async () => {
    const result = await TierUpgradeEmail.proposal(CUSTOMER_ID, UPGRADE);
    expect(result.pin).toEqual(PIN);
    expect(result.display).toMatchObject({ first_name: 'Taylor', from_tier: 'Bronze', to_tier: 'Silver' });
    expect(TierUpgradeEmail.cardLine(result.display))
      .toBe("Emails Taylor the Silver upgrade notice after the update is saved (plan moved up from Bronze, with the new monthly rate). Attempted, not guaranteed: it does not go if their email is turned off or the send fails, and the customer's interaction history records the result");
  });

  test('gate off: no pin, and no database read at all', async () => {
    delete process.env.GATE_IB_TIER_UPGRADE_EMAIL;
    expect(await TierUpgradeEmail.proposal(CUSTOMER_ID, UPGRADE)).toBeNull();
    process.env.GATE_IB_TIER_UPGRADE_EMAIL = 'TRUE'; // strict: only exactly "true"
    expect(await TierUpgradeEmail.proposal(CUSTOMER_ID, UPGRADE)).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test.each([
    ['a tier change alone', { waveguard_tier: 'Silver' }],
    ['a rate change alone', { monthly_rate: 90 }],
    ['a card that also changes the stage', { ...UPGRADE, pipeline_stage: 'active_customer' }],
    ['a card that also changes the active flag', { ...UPGRADE, active: true }],
  ])('%s promises nothing', async (_label, updates) => {
    expect(await TierUpgradeEmail.proposal(CUSTOMER_ID, updates)).toBeNull();
  });

  test.each([
    ['a downgrade', { customer: { ...MEMBER, waveguard_tier: 'Gold' } }],
    ['a first tier', { customer: { ...MEMBER, waveguard_tier: null } }],
    ['the same rate', { customer: { ...MEMBER, monthly_rate: '90.00' } }],
    ['a per-application customer', { customer: { ...MEMBER, billing_mode: 'per_application' } }],
    ['an auto-derived tier label', { customer: { ...MEMBER, waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: null } }],
    ['an inactive customer', { customer: { ...MEMBER, active: false } }],
    ['a churned customer', { customer: { ...MEMBER, pipeline_stage: 'churned' } }],
    ['a customer with no email on file', { customer: { ...MEMBER, email: null } }],
    ['a customer who turned email off', { prefs: { email_enabled: false } }],
    ['a customer who no longer exists', { customer: null }],
  ])('%s promises nothing', async (_label, rows) => {
    stubRows(rows);
    expect(await TierUpgradeEmail.proposal(CUSTOMER_ID, UPGRADE)).toBeNull();
  });

  // The email says "Nothing else changes": a card that edits anything besides
  // the tier and the rate promises no email (Codex #6122 r2).
  test.each([
    ['an email address', { email: 'new@example.invalid' }],
    ['a phone', { phone: '+15555550100' }],
    ['a name', { first_name: 'Jordan' }],
    ['an address', { address_line1: '100 Example Way' }],
  ])('a card that also changes %s promises nothing', async (_label, extra) => {
    stubRows();
    expect(await TierUpgradeEmail.proposal(CUSTOMER_ID, { ...UPGRADE, ...extra })).toBeNull();
  });

  // A discount configured to zero: the sender would refuse, so the card
  // promises nothing and a commit never reports the email as started.
  test('a tier whose discount is set to zero promises nothing, and a commit reports not sent', async () => {
    const { WAVEGUARD } = require('../services/pricing-engine/constants');
    const saved = WAVEGUARD.tiers.silver.discount;
    WAVEGUARD.tiers.silver.discount = 0;
    try {
      stubRows();
      expect(await TierUpgradeEmail.proposal(CUSTOMER_ID, UPGRADE)).toBeNull();
      const result = TierUpgradeEmail.afterCommit({ pin: PIN, customerId: CUSTOMER_ID, before: MEMBER, after: { ...MEMBER, ...UPGRADE }, operationId: ACTION_ID });
      expect(result).toMatchObject({ tier_upgrade_email: 'not_sent', tier_upgrade_email_reason: 'tier_benefit_unavailable' });
      expect(mockSendTierUpgraded).not.toHaveBeenCalled();
    } finally {
      WAVEGUARD.tiers.silver.discount = saved;
    }
  });

  // The upgrade direction is the pricing engine's fixed tier rank, whatever
  // the configurable service thresholds say.
  test('tier order does not follow edited service thresholds', () => {
    const { WAVEGUARD } = require('../services/pricing-engine/constants');
    const saved = { silver: WAVEGUARD.tiers.silver.minServices, gold: WAVEGUARD.tiers.gold.minServices };
    WAVEGUARD.tiers.silver.minServices = 9;
    WAVEGUARD.tiers.gold.minServices = 1;
    try {
      expect(TierUpgradeEmail.eligibility({ ...MEMBER, waveguard_tier: 'Silver' }, { ...MEMBER, waveguard_tier: 'Gold', monthly_rate: 80 })).toMatchObject({ eligible: true, from: 'silver', to: 'gold' });
      expect(TierUpgradeEmail.eligibility({ ...MEMBER, waveguard_tier: 'Gold' }, { ...MEMBER, waveguard_tier: 'Silver', monthly_rate: 80 })).toMatchObject({ eligible: false, reason: 'not_an_upgrade' });
    } finally {
      WAVEGUARD.tiers.silver.minServices = saved.silver;
      WAVEGUARD.tiers.gold.minServices = saved.gold;
    }
  });
});

describe('update_customer commit: the email the card promised', () => {
  const confirm = (input, actionContext = { operationId: ACTION_ID }) => executeTool('update_customer', {
    customer_id: CUSTOMER_ID, updates: UPGRADE, ...input,
  }, actionContext);

  test('sends once, after the write, from the committed rows, keyed on the pending action', async () => {
    const result = await confirm({ _tier_upgrade_email: PIN });
    expect(result).toMatchObject({ success: true, tier_upgrade_email: 'sending' });
    // The send is not waited for, so the finished card says "started", not "sent".
    expect(result.message).toMatch(/upgrade email was started/);
    expect(result.warning).toBeUndefined();
    expect(mockSendTierUpgraded).toHaveBeenCalledTimes(1);
    expect(mockSendTierUpgraded).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      before: { waveguard_tier: 'Bronze', monthly_rate: '100.00', billing_mode: 'monthly_membership' },
      after: { waveguard_tier: 'Silver', monthly_rate: 90, billing_mode: 'monthly_membership' },
      sourceId: `ib_pending_action:${ACTION_ID}`,
      idempotencyKey: `membership.tier_upgraded:${CUSTOMER_ID}:ib:${ACTION_ID}`,
    });
    // The customers UPDATE ran before the send was started.
    expect(db.__qb.update.mock.invocationCallOrder[0]).toBeLessThan(mockSendTierUpgraded.mock.invocationCallOrder[0]);
  });

  test('a card with no pin sends nothing, and its result is unchanged', async () => {
    const result = await confirm({});
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('tier_upgrade_email');
    expect(mockSendTierUpgraded).not.toHaveBeenCalled();
  });

  test('gate switched off after the card was shown: the update stands, no email, and the card says so', async () => {
    delete process.env.GATE_IB_TIER_UPGRADE_EMAIL;
    const result = await confirm({ _tier_upgrade_email: PIN });
    expect(result).toMatchObject({ success: true, tier_upgrade_email: 'not_sent', tier_upgrade_email_reason: 'gate_off' });
    expect(result.warning).toMatch(/upgrade email was NOT sent/);
    expect(mockSendTierUpgraded).not.toHaveBeenCalled();
  });

  test.each([
    ['the tier is now a downgrade (another edit raised it first)', { ...MEMBER, waveguard_tier: 'Gold' }, 'not_an_upgrade'],
    ['the customer had no tier by commit time (a first tier)', { ...MEMBER, waveguard_tier: null }, 'first_tier'],
    ['the price no longer changes', { ...MEMBER, monthly_rate: '90.00' }, 'price_unchanged'],
    // A label becoming a paid plan is a membership start, not an upgrade.
    ['the tier before is an auto-derived label', { ...MEMBER, waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: null }, 'not_a_member_before'],
    ['the customer is not billed monthly', { ...MEMBER, billing_mode: 'per_application' }, 'rate_not_billed'],
    ['the customer is inactive', { ...MEMBER, active: false }, 'inactive'],
    ['the customer is churned', { ...MEMBER, pipeline_stage: 'churned' }, 'inactive'],
    ['the tier before differs from the card (Silver to Gold card, row is Bronze)', MEMBER, 'tier_differs_from_card', { from: 'silver', to: 'gold' }, { waveguard_tier: 'Gold', monthly_rate: 90 }],
  ])('rechecks the committed rows: %s -> no email', async (_label, lockedRow, reason, pin = PIN, updates = UPGRADE) => {
    stubRows({ customer: lockedRow });
    const result = await confirm({ _tier_upgrade_email: pin, updates });
    expect(result).toMatchObject({ success: true, tier_upgrade_email: 'not_sent', tier_upgrade_email_reason: reason });
    expect(mockSendTierUpgraded).not.toHaveBeenCalled();
  });

  test('no pending action id: nothing goes (the idempotency key needs it)', async () => {
    const result = await confirm({ _tier_upgrade_email: PIN }, {});
    expect(result).toMatchObject({ success: true, tier_upgrade_email: 'not_sent', tier_upgrade_email_reason: 'no_operation_id' });
    expect(mockSendTierUpgraded).not.toHaveBeenCalled();
  });

  test('a refused commit (stale card) sends nothing', async () => {
    db.__qb.first.mockImplementation(async (arg) => (arg && typeof arg === 'object' ? { version: 'v2' } : { ...MEMBER }));
    db.raw.mockImplementation(() => ({ sql: 'version' }));
    const result = await confirm({ _tier_upgrade_email: PIN, _ib_customer_version: 'v1' });
    expect(result.preview_changed).toBe(true);
    expect(mockSendTierUpgraded).not.toHaveBeenCalled();
  });

  test('a failed or skipped email never fails the update: it is logged', async () => {
    mockSendTierUpgraded.mockImplementationOnce(async () => { throw new Error('provider down'); });
    const thrown = await confirm({ _tier_upgrade_email: PIN });
    await settle();
    expect(thrown).toMatchObject({ success: true, tier_upgrade_email: 'sending' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/tier upgrade email failed for cust-1: provider down/));

    mockSendTierUpgraded.mockImplementationOnce(async () => ({ ok: false, skipped: true, reason: 'email_opted_out' }));
    const skipped = await confirm({ _tier_upgrade_email: PIN });
    await settle();
    expect(skipped.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/tier upgrade email not sent for cust-1: email_opted_out/));
  });

  test('a bulk card never sends it, even if a pin is put on its input', async () => {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    db.__qb.select.mockResolvedValue([{ ...MEMBER, id: A, monthly_rate: '0', waveguard_tier: 'Bronze' }]);
    await executeTool('bulk_update_customers', { customer_ids: [A], updates: UPGRADE, _tier_upgrade_email: PIN }, { operationId: ACTION_ID });
    expect(mockSendTierUpgraded).not.toHaveBeenCalled();
  });
});

// What the model is told about notices follows the gate (Codex #6122 r2).
describe('update_customer tool description', () => {
  const descriptionWith = (gate) => {
    const saved = process.env.GATE_IB_TIER_UPGRADE_EMAIL;
    if (gate === undefined) delete process.env.GATE_IB_TIER_UPGRADE_EMAIL; else process.env.GATE_IB_TIER_UPGRADE_EMAIL = gate;
    let description;
    try {
      jest.isolateModules(() => {
        description = require('../services/intelligence-bar/tools').TOOLS.find((tool) => tool.name === 'update_customer').description;
      });
    } finally {
      if (saved === undefined) delete process.env.GATE_IB_TIER_UPGRADE_EMAIL; else process.env.GATE_IB_TIER_UPGRADE_EMAIL = saved;
    }
    return description;
  };

  test('gate off: says no price-change notice is sent, and nothing about an upgrade email', () => {
    const description = descriptionWith(undefined);
    expect(description).toContain('No price-change notice is sent to the customer.');
    expect(description).not.toMatch(/tier upgrade notice/);
  });

  test('gate on: names the tier upgrade email as the one exception', () => {
    expect(descriptionWith('true')).toMatch(/with one exception: .*emails the customer the tier upgrade notice after Confirm/);
  });
});
