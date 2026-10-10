/**
 * The effect list of a manual "Mark accepted" (estimate-accept-effects.js).
 *
 * The Intelligence Bar card is rendered from the list the accept itself
 * produces. A dry run runs every step in the accept's own transaction, records
 * the effects, and rolls back; the real run builds the same list under the
 * same locks and refuses (preview_changed) when it differs from the pinned
 * one. The post-commit work is decided by ONE pure plan that the dry run
 * lists and the real run executes.
 *
 * The fake database below models a transaction (a snapshot restored on
 * rollback) so "nothing commits" is checked on the tables, not just on a call
 * count. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateAccepted: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  ...jest.requireActual('../services/account-membership-email'),
  sendMembershipStarted: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue() }));
jest.mock('../services/proposal-win', () => ({
  ensureCustomerForProposalWin: jest.fn(),
  promoteLinkedCustomerForProposalWin: jest.fn(),
  flagProposalCustomerCommercialIfTaxable: jest.fn(),
  createProposalAcceptanceInvoice: jest.fn(),
}));

const AccountMembershipEmail = require('../services/account-membership-email');
const NotificationService = require('../services/notification-service');
const EstimatePublic = require('../routes/estimate-public');
const Linkage = require('../services/estimate-property-linkage');
const RealConverter = require('../services/estimate-converter');
const Effects = require('../services/estimate-accept-effects');
const { markEstimateManuallyAccepted } = require('../services/estimate-manual-acceptance');

const clone = (v) => JSON.parse(JSON.stringify(v));

// ── A table-aware fake with a real commit / rollback ──
function makeWorld({ estimateOverrides = {}, customerOverrides = {}, prefs = [], turf = [], property = null } = {}) {
  const tables = {
    estimates: [{
      id: 'est-1', status: 'sent', customer_id: 'cust-1', sent_at: '2026-10-01T12:00:00.000Z', accepted_at: null,
      updated_at: '2026-10-06T12:00:00.000Z', monthly_total: '90.00', onetime_total: '0', waveguard_tier: 'Gold',
      estimate_data: JSON.stringify({ recurring: { services: [{ name: 'Quarterly Pest Control', service: 'pest_control', monthly: 49 }] } }),
      ...estimateOverrides,
    }],
    customers: [{
      id: 'cust-1', first_name: 'Lena', last_name: 'Synthetic', email: 'lena.synthetic@example.com', pipeline_stage: 'active_customer',
      monthly_rate: '55.00', billing_mode: 'per_application', waveguard_tier: 'Bronze', property_type: null, per_application_fee: null,
      property_sqft: null, updated_at: '2026-10-05T09:00:00.000Z', ...customerOverrides,
    }],
    customer_plan_rates: [{ family_key: 'lawn_care', monthly_rate: '55.00' }],
    customer_turf_profiles: turf,
    customer_properties: property ? [property] : [],
    notification_prefs: prefs,
    activity_log: [],
    leads: [],
  };
  const state = { committed: 0, rolledBack: 0, commitsWithWrites: [] };
  let depth = 0;
  let before = null;
  const database = jest.fn((table) => {
    const q = { cond: null };
    const rows = () => tables[table] || [];
    for (const m of ['whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'forUpdate', 'orderBy', 'leftJoin', 'limit']) q[m] = () => q;
    q.where = (c) => { if (typeof c !== 'function') q.cond = c; return q; };
    q.select = () => q;
    q.first = async () => rows()[0] || null;
    q.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
    q.update = (patch) => {
      if (table === 'estimates') {
        const { estimate_data: _drop, ...plain } = patch;
        tables.estimates[0] = { ...tables.estimates[0], ...plain, accepted_at: tables.estimates[0].accepted_at || '2026-10-10T12:00:00.000Z' };
      } else if (tables[table]?.[0]) {
        const { updated_at: _u, ...plain } = patch;
        tables[table][0] = { ...tables[table][0], ...plain };
      }
      const result = { returning: async () => [tables.estimates[0]], then: (r) => Promise.resolve(1).then(r) };
      return result;
    };
    q.insert = async (row) => { (tables[table] = tables[table] || []).push(row); return [row]; };
    return q;
  });
  database.fn = { now: () => 'NOW' };
  database.raw = jest.fn((sql) => ({ rows: [], __raw: String(sql) }));
  database.schema = { hasTable: async () => true, hasColumn: async () => true };
  database.transaction = jest.fn(async (callback) => {
    depth += 1;
    if (depth === 1) before = clone(tables);
    try {
      const result = await callback(database);
      if (depth === 1) state.committed += 1;
      return result;
    } catch (err) {
      if (depth === 1) {
        state.rolledBack += 1;
        for (const k of Object.keys(tables)) delete tables[k];
        Object.assign(tables, before);
      }
      throw err;
    } finally {
      depth -= 1;
    }
  });
  return { database, tables, state };
}

// What the conversion writes, in the tables, plus the result it returns.
function fakeConverter(world, o = {}) {
  const convertEstimate = jest.fn(async (_id, opts) => {
    if (Array.isArray(opts.effectLog)) {
      opts.effectLog.push({
        kind: 'add_on_classification', add_on_base: o.addOnBase ?? 55, had_other_live_families: false,
        same_family_at_other_property: false, split_by_service: o.split !== false,
      });
    }
    Object.assign(world.tables.customers[0], { monthly_rate: '104.00', waveguard_tier: 'Gold', ...(o.customerWrites || {}) });
    world.tables.customer_plan_rates = [{ family_key: 'lawn_care', monthly_rate: '55.00' }, { family_key: 'pest_control', monthly_rate: '49.00' }];
    if (o.lawnWrites) o.lawnWrites(world.tables);
    return {
      customerId: 'cust-1', tier: 'Gold', monthlyRate: 104, serviceCount: 1, serviceMode: 'recurring', requiresManualRecurringScheduling: false,
      membershipEmail: { customerId: 'cust-1', billingLane: 'per_application', perApplicationAmount: null, monthlyRate: 104 },
      welcomeSms: null,
      commercialScheduleNotification: null,
      perApplicationFeeNotification: null,
      tierUpgradeNotification: o.tierBell ? { type: 'estimate_converted', title: 'WaveGuard Gold activated: review existing plan rates', body: 'x', options: { bell: true } } : null,
      planRateReviewNotification: o.planRateBell ? { type: 'estimate_converted', title: 'Multi-plan rate needs review after re-quote', body: 'x', options: { bell: true } } : null,
      ...(o.conversion || {}),
    };
  });
  return { convertEstimate, estimateOneTimeItemsFromData: RealConverter.estimateOneTimeItemsFromData };
}

const leadLinkService = () => ({ markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() });
const base = (world, converter, extra = {}) => ({
  estimateId: 'est-1', adminUserId: 'admin-1', source: 'verbal_yes', database: world.database, estimateConverter: converter,
  leadLinkService: leadLinkService(), ...extra,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

let transferSpy;
let linkSpy;
beforeEach(() => {
  AccountMembershipEmail.sendMembershipStarted.mockClear();
  NotificationService.notifyAdmin.mockClear();
  transferSpy = jest.spyOn(EstimatePublic, 'transferGroupFollowupOwnership').mockResolvedValue();
  linkSpy = jest.spyOn(Linkage, 'linkAcceptedEstimateProperty').mockResolvedValue();
});
afterEach(() => { transferSpy.mockRestore(); linkSpy.mockRestore(); });

const kinds = (effects) => effects.map((e) => e.kind);
const effect = (effects, kind) => effects.find((e) => e.kind === kind);
const planStep = (effects, step) => effect(effects, 'post_commit').plan.find((s) => s.step === step);

describe('a dry run', () => {
  test('returns the effect list from the accept\'s own steps and rolls the transaction back: nothing commits, nothing is sent', async () => {
    const world = makeWorld();
    const converter = fakeConverter(world);
    const leads = leadLinkService();
    const result = await markEstimateManuallyAccepted(base(world, converter, { dryRun: true, leadLinkService: leads }));
    await settle();
    expect(result.dryRun).toBe(true);
    expect(kinds(result.effects)).toEqual(['estimate', 'add_on_classification', 'customer', 'plan_rate_ledger', 'lawn_profile', 'conversion', 'post_commit']);
    // The transaction rolled back: the tables are as they were.
    expect(world.state).toMatchObject({ committed: 0, rolledBack: 1 });
    expect(world.tables.estimates[0].status).toBe('sent');
    expect(world.tables.customers[0].monthly_rate).toBe('55.00');
    expect(world.tables.activity_log).toEqual([]);
    // And nothing was sent or run after the commit.
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
    expect(leads.markLinkedLeadEstimateAccepted).not.toHaveBeenCalled();
    expect(transferSpy).not.toHaveBeenCalled();
    expect(linkSpy).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // The conversion ran strict and handed the converter the effect log.
    expect(converter.convertEstimate.mock.calls[0][1]).toMatchObject({ strictAddOnClassification: true, refuseLinkedVisits: true });
    expect(Array.isArray(converter.convertEstimate.mock.calls[0][1].effectLog)).toBe(true);
  });

  test('lists what the conversion writes: the claim, the customer fields, the bill by service, the conversion and the post-commit plan', async () => {
    const world = makeWorld();
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { dryRun: true }));
    expect(effect(effects, 'estimate')).toEqual({ kind: 'estimate', action: 'mark_accepted', from_status: 'sent', locks_price: true });
    expect(effect(effects, 'customer')).toMatchObject({
      before: { monthly_rate: '55.00', waveguard_tier: 'Bronze', billing_mode: 'per_application' },
      after: { monthly_rate: '104.00', waveguard_tier: 'Gold', billing_mode: 'per_application' },
    });
    expect(effect(effects, 'plan_rate_ledger')).toEqual({
      kind: 'plan_rate_ledger', before: { lawn_care: 55 }, after: { lawn_care: 55, pest_control: 49 }, total_before: 55, total_after: 104,
    });
    expect(effect(effects, 'conversion')).toMatchObject({ recurring: true, billing_lane: 'per_application', manual_recurring_scheduling: false });
    expect(effect(effects, 'add_on_classification')).toMatchObject({ add_on_base: 55, split_by_service: true });
    expect(effect(effects, 'post_commit').plan.map((s) => s.step)).toEqual([
      'group_followup_transfer', 'property_link', 'lead_won', 'membership_email', 'termite_agreement',
    ]);
  });

  test('an already accepted estimate rolls back too, with no effects', async () => {
    const world = makeWorld({ estimateOverrides: { status: 'accepted', accepted_at: '2026-10-02T10:00:00.000Z' } });
    const result = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { dryRun: true }));
    expect(result).toMatchObject({ dryRun: true, alreadyAccepted: true, effects: [] });
    expect(world.state.committed).toBe(0);
  });

  test('the same state gives the same list (no clocks, no generated ids), so two runs have one fingerprint', async () => {
    const a = makeWorld();
    const b = makeWorld();
    const first = await markEstimateManuallyAccepted(base(a, fakeConverter(a), { dryRun: true }));
    const second = await markEstimateManuallyAccepted(base(b, fakeConverter(b), { dryRun: true }));
    expect(Effects.effectsFingerprint(first.effects)).toBe(Effects.effectsFingerprint(second.effects));
  });
});

describe('the real run against the pinned list', () => {
  async function pinned(worldArgs, converterOpts) {
    const world = makeWorld(worldArgs);
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world, converterOpts), { dryRun: true }));
    return { world, effects, key: Effects.effectsFingerprint(effects) };
  }

  test('a list that matches commits, and runs the plan the dry run listed', async () => {
    const { world, key } = await pinned({}, {});
    const leads = leadLinkService();
    const result = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { expected: { effectsKey: key, membershipEmail: 'send' }, leadLinkService: leads }));
    await settle();
    expect(world.state.committed).toBe(1);
    expect(result.estimate.status).toBe('accepted');
    expect(transferSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith({ estimateId: 'est-1', customerId: 'cust-1' });
    expect(leads.markLinkedLeadEstimateAccepted).toHaveBeenCalledTimes(1);
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledTimes(1);
  });

  test('a different bill classification at commit refuses as preview_changed: rolled back, nothing sent', async () => {
    const { world, key } = await pinned({}, {});
    const leads = leadLinkService();
    await expect(markEstimateManuallyAccepted(base(world, fakeConverter(world, { addOnBase: 0 }), { expected: { effectsKey: key }, leadLinkService: leads })))
      .rejects.toMatchObject({ statusCode: 409, code: 'preview_changed' });
    await settle();
    expect(world.state.committed).toBe(0);
    expect(world.tables.estimates[0].status).toBe('sent');
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
    expect(leads.markLinkedLeadEstimateAccepted).not.toHaveBeenCalled();
  });

  test.each([
    ['a lawn mirror is now rewritten', { lawnWrites: (t) => { t.customers[0].property_sqft = 6500; } }],
    ['a bell is now rung', { planRateBell: true }],
    ['the bill is no longer split by service', { split: false }],
  ])('refuses as preview_changed when %s', async (_name, changed) => {
    const { world, key } = await pinned({}, {});
    await expect(markEstimateManuallyAccepted(base(world, fakeConverter(world, changed), { expected: { effectsKey: key } })))
      .rejects.toMatchObject({ statusCode: 409, code: 'preview_changed' });
    expect(world.state.committed).toBe(0);
  });

  test('refuses when the customer opts out between the dry run and the accept (the email decision flipped)', async () => {
    const { world, key } = await pinned({}, {});
    world.tables.notification_prefs = [{ customer_id: 'cust-1', email_enabled: false }];
    await expect(markEstimateManuallyAccepted(base(world, fakeConverter(world), { expected: { effectsKey: key } })))
      .rejects.toMatchObject({ statusCode: 409, code: 'preview_changed' });
    await settle();
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('without a pinned list the accept compares nothing (the card sent only the older pins)', async () => {
    const world = makeWorld();
    const converter = fakeConverter(world);
    await markEstimateManuallyAccepted(base(world, converter, { expected: { estimateStatus: 'sent' } }));
    expect(converter.convertEstimate.mock.calls[0][1]).not.toHaveProperty('effectLog');
    expect(world.state.committed).toBe(1);
  });
});

describe('finding 1: the approved email decision rides through delivery', () => {
  test('a card that said "no email" skips the send even when the plan would send it now', async () => {
    const world = makeWorld();
    const result = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { expected: { membershipEmail: 'skip' } }));
    await settle();
    expect(result.estimate.status).toBe('accepted');
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('a card that said "send" still sends (the sender itself vetoes a fresh opt-out)', async () => {
    const world = makeWorld();
    await markEstimateManuallyAccepted(base(world, fakeConverter(world), { expected: { membershipEmail: 'send' } }));
    await settle();
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the customer turned email off', { prefs: [{ customer_id: 'cust-1', email_enabled: false }] }, 'email_off'],
    ['there is no address on file', { customerOverrides: { email: null } }, 'no_address'],
    ['the address is not an email', { customerOverrides: { email: 'person@example' } }, 'invalid_address'],
  ])('the dry run lists "no email" when %s', async (_name, worldArgs, reason) => {
    const world = makeWorld(worldArgs);
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { dryRun: true }));
    expect(planStep(effects, 'membership_email')).toMatchObject({ will_send: false, reason });
  });

  test('the dry run lists the masked recipient when the email will go', async () => {
    const world = makeWorld();
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { dryRun: true }));
    expect(planStep(effects, 'membership_email')).toEqual({ step: 'membership_email', attempt: true, will_send: true, reason: null, to: 'l***@example.com' });
  });

  test('a one_time lane never emails (the sender suppresses it)', async () => {
    const world = makeWorld();
    const converter = fakeConverter(world, { conversion: { membershipEmail: { customerId: 'cust-1', billingLane: 'one_time' } } });
    const { effects } = await markEstimateManuallyAccepted(base(world, converter, { dryRun: true }));
    expect(planStep(effects, 'membership_email')).toMatchObject({ will_send: false, reason: 'one_time_lane' });
  });
});

describe('finding 2: the lawn size is read from all three places', () => {
  test('a mirror-only rewrite (turf profile already right, property and customer sizes stale) is in the list', async () => {
    const world = makeWorld({
      turf: [{ customer_id: 'cust-1', grass_type: 'st_augustine', lawn_sqft: 6500 }],
      property: { id: 'prop-1', customer_id: 'cust-1', is_primary: true, active: true, property_sqft: 5000 },
      customerOverrides: { property_sqft: 5000 },
    });
    const converter = fakeConverter(world, {
      lawnWrites: (t) => { t.customer_properties[0].property_sqft = 6500; t.customers[0].property_sqft = 6500; },
    });
    const { effects } = await markEstimateManuallyAccepted(base(world, converter, { dryRun: true }));
    expect(effect(effects, 'lawn_profile')).toEqual({
      kind: 'lawn_profile',
      before: { grass_type: 'st_augustine', turf_lawn_sqft: 6500, primary_property_sqft: 5000, customer_property_sqft: 5000 },
      after: { grass_type: 'st_augustine', turf_lawn_sqft: 6500, primary_property_sqft: 6500, customer_property_sqft: 6500 },
    });
  });
});

describe('finding 4: the bill classifier fails closed in a carded accept', () => {
  test('the dry run and a carded real run ask for strict classification; the page button does not', async () => {
    const dry = makeWorld();
    const dryConverter = fakeConverter(dry);
    await markEstimateManuallyAccepted(base(dry, dryConverter, { dryRun: true }));
    const carded = makeWorld();
    const cardedConverter = fakeConverter(carded);
    await markEstimateManuallyAccepted(base(carded, cardedConverter, { expected: { estimateStatus: 'sent' } }));
    const page = makeWorld();
    const pageConverter = fakeConverter(page);
    await markEstimateManuallyAccepted(base(page, pageConverter));
    expect(dryConverter.convertEstimate.mock.calls[0][1].strictAddOnClassification).toBe(true);
    expect(cardedConverter.convertEstimate.mock.calls[0][1].strictAddOnClassification).toBe(true);
    expect(pageConverter.convertEstimate.mock.calls[0][1]).not.toHaveProperty('strictAddOnClassification');
  });

  test('a classifier that cannot read its evidence surfaces as the converter\'s own 409, rolled back', async () => {
    const world = makeWorld();
    const converter = { convertEstimate: jest.fn().mockRejectedValue(Object.assign(new Error('Could not read the customer\'s other plans.'), { isOperational: true, statusCode: 409, code: 'add_on_classification_unavailable' })) };
    await expect(markEstimateManuallyAccepted(base(world, converter, { dryRun: true })))
      .rejects.toMatchObject({ statusCode: 409, code: 'add_on_classification_unavailable' });
    expect(world.state.committed).toBe(0);
  });

  test('the classification the accept used is in the list, so a different one at commit is a different list', async () => {
    const a = makeWorld();
    const b = makeWorld();
    const first = await markEstimateManuallyAccepted(base(a, fakeConverter(a, { addOnBase: 55 }), { dryRun: true }));
    const second = await markEstimateManuallyAccepted(base(b, fakeConverter(b, { addOnBase: 0 }), { dryRun: true }));
    expect(Effects.effectsFingerprint(first.effects)).not.toBe(Effects.effectsFingerprint(second.effects));
  });
});

describe('finding 5: each accepted one-time line, with what the accept does about it', () => {
  test('is listed from the estimate\'s one-time items, with name and amount', async () => {
    const world = makeWorld({
      estimateOverrides: {
        monthly_total: '49.00',
        estimate_data: JSON.stringify({
          recurring: { services: [{ name: 'Quarterly Pest Control', service: 'pest_control', monthly: 49 }] },
          result: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout', price: 350 }, { service: 'free', name: 'Free Look', price: 0 }] } },
        }),
      },
    });
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { dryRun: true }));
    expect(effects.filter((e) => e.kind === 'one_time_line')).toEqual([
      { kind: 'one_time_line', name: 'German Roach Cleanout', amount: 350, consequence: 'schedule_and_invoice_by_hand' },
    ]);
  });
});

describe('finding 6: the bells come from the conversion through the post-commit plan', () => {
  test('a plan-rate review bell (the grouped reset) and a tier bell are listed, and fire after the commit', async () => {
    const world = makeWorld();
    const converterOpts = { planRateBell: true, tierBell: true };
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world, converterOpts), { dryRun: true }));
    expect(effect(effects, 'post_commit').plan.filter((s) => s.step === 'admin_bell')).toEqual([
      { step: 'admin_bell', bell: 'tier_upgrade', title: 'WaveGuard Gold activated: review existing plan rates' },
      { step: 'admin_bell', bell: 'plan_rate_review', title: 'Multi-plan rate needs review after re-quote' },
    ]);
    const key = Effects.effectsFingerprint(effects);
    const real = makeWorld();
    await markEstimateManuallyAccepted(base(real, fakeConverter(real, converterOpts), { expected: { effectsKey: key } }));
    await settle();
    expect(NotificationService.notifyAdmin.mock.calls.map((c) => c[1])).toEqual([
      'WaveGuard Gold activated: review existing plan rates',
      'Multi-plan rate needs review after re-quote',
    ]);
  });
});

describe('finding 7: a grouped estimate lists its follow-up transfer', () => {
  test('the plan carries the group follow-up transfer for a grouped estimate', async () => {
    const world = makeWorld({ estimateOverrides: { estimate_group_id: 'group-1' } });
    const { effects } = await markEstimateManuallyAccepted(base(world, fakeConverter(world), { dryRun: true }));
    expect(planStep(effects, 'group_followup_transfer')).toEqual({ step: 'group_followup_transfer', grouped: true });
  });
});

describe('the post-commit plan (pure)', () => {
  const accepted = { id: 'est-1', customer_id: 'cust-1' };
  const conversion = { membershipEmail: { billingLane: 'per_application' }, welcomeSms: { customer: { id: 'cust-1' } } };

  test('lists the steps in the page\'s own order', () => {
    expect(Effects.planPostCommit({ billingTerm: 'standard', acceptedEstimate: accepted, conversion }).map((s) => s.step)).toEqual([
      'group_followup_transfer', 'property_link', 'lead_won', 'membership_email', 'welcome_sms', 'termite_agreement',
    ]);
  });

  test('an annual prepay accept never plans the membership email', () => {
    const plan = Effects.planPostCommit({ billingTerm: 'prepay_annual', acceptedEstimate: accepted, conversion });
    expect(plan.some((s) => s.step === 'membership_email')).toBe(false);
  });

  test('no customer, no property link and no termite agreement', () => {
    const plan = Effects.planPostCommit({ billingTerm: 'standard', acceptedEstimate: { id: 'est-1', customer_id: null }, conversion: null });
    expect(plan.map((s) => s.step)).toEqual(['group_followup_transfer', 'lead_won']);
  });

  test('without recipient facts the email outcome is unknown, not guessed', () => {
    expect(Effects.membershipEmailStep({ conversion, billingTerm: 'standard', emailInputs: null })).toMatchObject({ attempt: true, will_send: null });
  });
});

describe('the page button is unchanged', () => {
  test('reads no effect state, passes no card options, and runs the whole plan, email included, as before', async () => {
    const world = makeWorld();
    const converter = fakeConverter(world);
    const leads = leadLinkService();
    const result = await markEstimateManuallyAccepted(base(world, converter, { leadLinkService: leads }));
    await settle();
    const options = converter.convertEstimate.mock.calls[0][1];
    expect(options).toMatchObject({ skipAutoSchedule: true, skipMembershipEmail: true, skipWelcomeSms: true, skipSetupInvoice: true, deferCommercialScheduleNotification: true });
    expect(options).not.toHaveProperty('effectLog');
    expect(options).not.toHaveProperty('strictAddOnClassification');
    expect(options).not.toHaveProperty('refuseLinkedVisits');
    expect(result).not.toHaveProperty('effects');
    expect(result.estimate.status).toBe('accepted');
    expect(world.state.committed).toBe(1);
    expect(transferSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(leads.markLinkedLeadEstimateAccepted).toHaveBeenCalledWith(expect.objectContaining({ estimateId: 'est-1', customerId: 'cust-1', monthlyValue: 90 }));
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledTimes(1);
  });
});
