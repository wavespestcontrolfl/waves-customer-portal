// Runs with the existing CI PostgreSQL pass; never a production connection.
// Inbound referral confirm (GATE_REFERRAL_INBOUND_CONFIRM) against real
// Postgres: which plan customers the office is asked about, and what a confirm
// writes through the real referral engine. The referrals table carries prod's
// NOT NULL referrer and status CHECK; referral_inbound_reviews comes from the
// real migration. A private schema keeps CI's migrated tables untouched.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `referral_inbound_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 4 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// Any text or email the engine tried would land here; every test asserts none.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'text') }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  redactEmailAddresses: (s) => s,
}));
// A synthetic internal account stands in for the real list (no real names in tests).
jest.mock('../services/internal-test-customers', () => ({ INTERNAL_TEST_CUSTOMERS: ['fixture internal'], isInternalTestCustomerId: () => false }));
// The credit ledger has its own suites; here only the postings are counted.
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(async () => ({ id: 'movement' })),
  round2: (n) => Math.round(n * 100) / 100,
}));

(SKIP ? describe.skip : describe)('inbound referral confirm (live Postgres)', () => {
  let db;
  let inbound;
  let postCreditMovement;
  let sendCustomerMessage;
  let sendTemplate;

  async function customer(fields = {}) {
    const [row] = await db('customers').insert({
      first_name: 'Fixture',
      last_name: `Person${Math.floor(Math.random() * 1e6)}`,
      phone: `+1941555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`,
      account_id: randomUUID(),
      active: true,
      ...fields,
    }).returning('*');
    return row;
  }

  // An active plan customer who came in through `code`.
  const linkCustomer = (code, fields = {}) => customer({
    waveguard_tier: 'Silver',
    monthly_rate: 119.1,
    landing_page_url: `https://wavespestcontrol.com/?ref=${code}&utm_source=referral`,
    ...fields,
  });

  // A recurring visit; a completed one gets its closeout record (`notes` = structured_notes).
  async function recurringVisit(customerId, status = 'completed', date = '2026-10-15', notes = {}) {
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, status, is_recurring: true, scheduled_date: date,
    }).returning('*');
    if (status === 'completed') {
      await db('service_records').insert({ scheduled_service_id: row.id, customer_id: customerId, status: 'completed', structured_notes: notes });
    }
    return row;
  }

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    await db.schema.withSchema(mockSchema).createTable('customers', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('first_name');
      t.string('last_name');
      t.string('phone');
      t.string('email');
      t.uuid('account_id');
      t.string('city');
      t.boolean('active').defaultTo(true);
      t.decimal('monthly_rate', 10, 2);
      t.string('waveguard_tier');
      t.text('landing_page_url');
      t.string('lead_source_detail', 200);
      t.string('referral_code', 20).unique();
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
      t.timestamp('deleted_at', { useTz: true });
    });
    await db.schema.withSchema(mockSchema).createTable('referral_promoters', (t) => {
      t.increments('id');
      t.string('customer_phone').notNullable().unique('referral_promoters_customer_phone_unique');
      t.string('customer_email');
      t.string('first_name').notNullable();
      t.string('last_name').notNullable();
      t.uuid('customer_id');
      t.string('referral_code').unique();
      t.text('referral_link');
      t.string('campaign');
      t.string('status').defaultTo('active');
      t.integer('merged_into_promoter_id');
      for (const col of ['referral_balance_cents', 'total_earned_cents', 'total_paid_out_cents', 'total_clicks',
        'total_referrals_sent', 'total_referrals_converted', 'available_balance_cents', 'pending_earnings_cents']) {
        t.integer(col).defaultTo(0);
      }
      t.string('milestone_level').defaultTo('none');
      t.timestamp('milestone_earned_at', { useTz: true });
      t.timestamp('last_referral_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true });
    });
    // Prod's referrals shape (2026-10-26): NOT NULL referrer, status CHECK.
    await db.schema.withSchema(mockSchema).createTable('referrals', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('referrer_customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('referee_name', 100).notNullable();
      t.string('referee_phone', 20).notNullable();
      t.string('referee_email', 150);
      t.string('referral_code', 20).notNullable();
      t.text('status').defaultTo('pending');
      t.decimal('credit_amount', 10, 2).defaultTo(25);
      t.boolean('referrer_credited').defaultTo(false);
      t.boolean('referee_credited').defaultTo(false);
      t.timestamp('converted_at', { useTz: true });
      t.timestamps(true, true);
      t.integer('promoter_id');
      t.uuid('lead_id');
      t.string('source', 30).defaultTo('portal');
      t.decimal('referrer_reward_amount', 10, 2).defaultTo(50);
      t.string('referrer_reward_status', 20).defaultTo('pending');
      t.string('converted_tier');
      t.decimal('converted_monthly_value', 10, 2);
      t.boolean('first_service_completed').defaultTo(false);
      t.string('lost_reason');
    });
    await db.raw(`ALTER TABLE ??.referrals ADD CONSTRAINT referrals_status_check CHECK (status = ANY (ARRAY[
      'active', 'contacted', 'credited', 'estimated', 'lost', 'pending', 'rejected', 'signed_up', 'sms_failed']))`, [mockSchema]);
    // The live program settings (2026-10-26).
    await db.schema.withSchema(mockSchema).createTable('referral_program_settings', (t) => {
      t.integer('id').primary();
      t.boolean('program_active');
      t.string('base_url');
      for (const col of ['referrer_reward_cents', 'referee_discount_cents', 'bonus_silver_cents', 'bonus_gold_cents',
        'bonus_platinum_cents', 'milestone_3_bonus_cents', 'milestone_5_bonus_cents', 'milestone_10_bonus_cents',
        'min_payout_cents', 'max_referrals_per_month']) {
        t.integer(col);
      }
      t.boolean('auto_credit_enabled');
      t.boolean('require_service_completion');
    });
    await db('referral_program_settings').insert({
      id: 1, program_active: true, base_url: 'https://portal.wavespestcontrol.com/r/',
      referrer_reward_cents: 2500, referee_discount_cents: 2500, bonus_silver_cents: 5000, bonus_gold_cents: 7500,
      bonus_platinum_cents: 10000, milestone_3_bonus_cents: 2500, milestone_5_bonus_cents: 5000,
      milestone_10_bonus_cents: 10000, min_payout_cents: 1000, max_referrals_per_month: 20,
      auto_credit_enabled: true, require_service_completion: true,
    });
    await db.schema.withSchema(mockSchema).createTable('scheduled_services', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id');
      t.string('status');
      t.boolean('is_recurring').defaultTo(false);
      t.string('recurring_pattern', 30);
      t.date('scheduled_date');
    });
    await db.schema.withSchema(mockSchema).createTable('service_records', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('scheduled_service_id');
      t.uuid('customer_id');
      t.string('status');
      t.jsonb('structured_notes');
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await require('../models/migrations/20261026150000_referral_inbound_reviews').up(db);
    // The admin bell's columns (migrations 20260401000080, 20260928220000, 20261001001500), for the new-referral bell.
    await db.schema.withSchema(mockSchema).createTable('notifications', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('recipient_type', 20).notNullable();
      t.uuid('recipient_id');
      t.string('category', 30).notNullable();
      t.string('title', 200).notNullable();
      t.text('body');
      t.string('icon', 10);
      t.string('link', 300);
      t.jsonb('metadata');
      t.timestamp('read_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
      t.text('detail');
      t.timestamp('done_at', { useTz: true });
      t.string('done_by', 64);
      t.text('resolution');
    });

    inbound = require('../services/referral-inbound');
    ({ postCreditMovement } = require('../services/customer-credit'));
    ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
    ({ sendTemplate } = require('../services/email-template-library'));
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db('notifications').del();
    await db('referral_inbound_reviews').del();
    await db('referrals').del();
    await db('service_records').del();
    await db('scheduled_services').del();
    await db('referral_promoters').del();
    await db('customers').del();
  });

  afterEach(() => {
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  test('lists plan customers with a link code or a spoken referrer, and nobody else', async () => {
    const referrer = await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE', city: 'Parrish' });
    const linked = await linkCustomer('WAVES-JANE');
    await recurringVisit(linked.id);
    const named = await customer({ waveguard_tier: 'Bronze', monthly_rate: 47, lead_source_detail: 'Referred by Jane Smith' });
    const unnamed = await customer({ waveguard_tier: 'Bronze', monthly_rate: 39.33, lead_source_detail: 'Referral (unnamed)' });
    // Not asked about: no plan, a sentinel tier, no phone, archived, an internal test account.
    await customer({ lead_source_detail: 'Referred by Jane Smith' });
    await customer({ waveguard_tier: 'One-Time', monthly_rate: 99, lead_source_detail: 'Referred by Jane Smith' });
    await linkCustomer('WAVES-JANE', { phone: null });
    await linkCustomer('WAVES-JANE', { deleted_at: new Date() });
    await linkCustomer('WAVES-JANE', { first_name: 'Fixture', last_name: 'Internal' });
    // A referral row already names this one, under another phone format.
    const typedIn = await linkCustomer('WAVES-JANE', { phone: '+19415550199' });
    await db('referrals').insert({
      referrer_customer_id: referrer.id, referee_name: 'Typed In', referee_phone: '(941) 555-0199',
      referral_code: 'WAVES-JANE', status: 'contacted',
    });
    // The office already answered for this one.
    const answered = await linkCustomer('WAVES-JANE');
    await db('referral_inbound_reviews').insert({ customer_id: answered.id, outcome: 'dismissed' });

    const items = await inbound.listInboundReferrals();
    const byId = Object.fromEntries(items.map((i) => [i.customerId, i]));
    expect(Object.keys(byId).sort()).toEqual([linked.id, named.id, unnamed.id].sort());
    expect(byId[typedIn.id]).toBeUndefined();

    expect(byId[linked.id]).toMatchObject({
      creditsNow: true,
      selfReferral: false,
      evidence: { source: 'link', code: 'WAVES-JANE', spokenName: null },
      suggestions: [{ customerId: referrer.id, name: 'Jane Smith', city: 'Parrish', viaCode: true }],
    });
    expect(byId[named.id].creditsNow).toBe(false);
    expect(byId[named.id].evidence).toEqual({ source: 'call', code: null, spokenName: 'Jane Smith' });
    expect(byId[named.id].suggestions[0]).toMatchObject({ customerId: referrer.id, exact: true, viaCode: false });
    expect(byId[unnamed.id].evidence).toEqual({ source: 'call', code: null, spokenName: null });
    expect(byId[unnamed.id].suggestions).toEqual([]);
  });

  test("a link code from the customer's own household is flagged, never suggested", async () => {
    const accountId = randomUUID();
    await customer({ account_id: accountId, referral_code: 'WAVES-SELF' });
    const sibling = await linkCustomer('WAVES-SELF', { account_id: accountId });
    const [item] = await inbound.listInboundReferrals();
    expect(item).toMatchObject({ customerId: sibling.id, selfReferral: true, suggestions: [] });
    await expect(inbound.confirmInboundReferral({ customerId: sibling.id, referrerCustomerId: (await db('customers').where({ referral_code: 'WAVES-SELF' }).first()).id }))
      .rejects.toMatchObject({ statusCode: 400, code: 'SELF_REFERRAL' });
    expect(await db('referrals').count('* as n').first()).toEqual({ n: '0' });
  });

  test('a referrer with the same email is the same household, whatever the account', async () => {
    const sameEmail = await customer({ email: 'shared@example.invalid' });
    const friend = await linkCustomer('WAVES-NONE', { email: 'Shared@Example.invalid' });
    await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: sameEmail.id }))
      .rejects.toMatchObject({ statusCode: 400, code: 'SELF_REFERRAL' });
  });

  test('a spoken name with accents still finds the customer', async () => {
    const referrer = await customer({ first_name: 'José', last_name: 'Núñez' });
    const caller = await customer({ waveguard_tier: 'Bronze', monthly_rate: 47, lead_source_detail: 'Referred by José Núñez' });
    const [item] = await inbound.listInboundReferrals();
    expect(item.customerId).toBe(caller.id);
    expect(item.suggestions).toEqual([expect.objectContaining({ customerId: referrer.id, exact: true })]);
  });

  test('confirm after the first plan visit credits both accounts at once, with no text or email', async () => {
    const referrer = await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
    const friend = await linkCustomer('WAVES-JANE', { first_name: 'Sam', last_name: 'Friend', email: 'sam@example.invalid' });
    await recurringVisit(friend.id, 'completed', '2026-10-15');
    await recurringVisit(friend.id, 'scheduled', '2026-12-01');
    const reviewer = randomUUID();

    const result = await inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id, reviewedBy: reviewer });
    expect(result).toMatchObject({ converted: true, creditsNow: true, credited: { referrerDollars: 25, refereeDollars: 25 }, error: null });

    const referral = await db('referrals').where({ id: result.referralId }).first();
    expect(referral).toMatchObject({
      referrer_customer_id: referrer.id,
      referee_name: 'Sam Friend',
      referee_phone: friend.phone,
      referee_email: 'sam@example.invalid',
      referral_code: 'WAVES-JANE',
      source: 'inbound_link',
      status: 'credited',
      referrer_reward_status: 'earned',
      first_service_completed: true,
      referrer_credited: true,
      referee_credited: true,
      converted_tier: 'Silver',
    });
    expect(postCreditMovement).toHaveBeenCalledTimes(2);
    const credits = postCreditMovement.mock.calls.map(([movement]) => [movement.customerId, movement.delta, movement.referralId]);
    expect(credits).toEqual(expect.arrayContaining([
      [friend.id, 25, referral.id],
      [referrer.id, 25, referral.id],
    ]));

    const promoter = await db('referral_promoters').where({ customer_id: referrer.id }).first();
    expect(promoter).toMatchObject({ referral_code: 'WAVES-JANE', total_referrals_sent: 1, total_referrals_converted: 1, pending_earnings_cents: 0 });
    expect(await db('referral_inbound_reviews').where({ customer_id: friend.id }).first())
      .toMatchObject({ outcome: 'confirmed', referral_id: referral.id, reviewed_by: reviewer });
    expect(await inbound.listInboundReferrals()).toEqual([]);
  });

  test('confirm before the first plan visit converts and leaves the credit to that visit', async () => {
    const referrer = await customer({ first_name: 'Jane', last_name: 'Smith' });
    const caller = await customer({ waveguard_tier: 'Bronze', monthly_rate: 47, lead_source_detail: 'Referred by Jane Smith' });
    // A one-time visit never qualifies for the reward.
    await db('scheduled_services').insert({ customer_id: caller.id, status: 'completed', is_recurring: false, scheduled_date: '2026-10-01' });

    const result = await inbound.confirmInboundReferral({ customerId: caller.id, referrerCustomerId: referrer.id });
    expect(result).toMatchObject({ converted: true, creditsNow: false, credited: null, error: null });
    expect(await db('referrals').where({ id: result.referralId }).first()).toMatchObject({
      source: 'inbound_call',
      status: 'signed_up',
      referrer_reward_status: 'pending_service',
      first_service_completed: false,
    });
    expect(postCreditMovement).not.toHaveBeenCalled();
    // The referrer had no promoter row; confirm enrolled one.
    expect(await db('referral_promoters').where({ customer_id: referrer.id }).first())
      .toMatchObject({ total_referrals_sent: 1, total_referrals_converted: 1, pending_earnings_cents: 2500 });
  });

  test.each([
    ['inspection only', { visitOutcome: 'inspection_only' }],
    ['customer declined', { visitOutcome: 'customer_declined' }],
    ['incomplete', { visitOutcome: 'incomplete' }],
    ['a quiet backfill', { backfill: true }],
  ])('a visit closed as %s does not pay at confirm; the next performed visit will', async (_label, notes) => {
    const referrer = await customer({ referral_code: 'WAVES-JANE' });
    const friend = await linkCustomer('WAVES-JANE');
    await recurringVisit(friend.id, 'completed', '2026-10-15', notes);
    const [item] = await inbound.listInboundReferrals();
    expect(item).toMatchObject({ customerId: friend.id, creditsNow: false });
    const result = await inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id });
    expect(result).toMatchObject({ converted: true, creditsNow: false, credited: null });
    expect(postCreditMovement).not.toHaveBeenCalled();
    expect(await db('referrals').where({ id: result.referralId }).first())
      .toMatchObject({ status: 'signed_up', referrer_reward_status: 'pending_service', first_service_completed: false });
  });

  test('an issued-invoice closeout pays even though it was closed quietly', async () => {
    const referrer = await customer({ referral_code: 'WAVES-JANE' });
    const friend = await linkCustomer('WAVES-JANE');
    await recurringVisit(friend.id, 'completed', '2026-10-15', { backfill: true, issuedInvoiceCloseout: { invoiceId: randomUUID(), trigger: 'paid' } });
    const result = await inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id });
    expect(result).toMatchObject({ creditsNow: true, credited: { referrerDollars: 25, refereeDollars: 25 } });
    expect(postCreditMovement).toHaveBeenCalledTimes(2);
  });

  test('one answer per customer: a second confirm or a later dismissal is refused', async () => {
    const referrer = await customer({ referral_code: 'WAVES-JANE' });
    const friend = await linkCustomer('WAVES-JANE');
    const [a, b] = await Promise.allSettled([
      inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id }),
      inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((a.status === 'rejected' ? a : b).reason).toMatchObject({ statusCode: 409, code: 'ALREADY_REVIEWED' });
    await expect(inbound.dismissInboundReferral({ customerId: friend.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_REVIEWED' });
    expect(await db('referrals').count('* as n').first()).toEqual({ n: '1' });
  });

  test('a phone change that commits while the confirm waits on the row lock decides the referral', async () => {
    const referrer = await customer({ referral_code: 'WAVES-JANE' });
    const friend = await linkCustomer('WAVES-JANE');
    const newPhone = '+19415550177';
    const holder = await db.transaction();
    let pending;
    try {
      await holder('customers').where({ id: friend.id }).update({ phone: newPhone });
      pending = inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id });
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await holder.commit();
    } catch (err) {
      await holder.rollback().catch(() => {});
      throw err;
    }
    const result = await pending;
    expect((await db('referrals').where({ id: result.referralId }).first()).referee_phone).toBe(newPhone);
  });

  test('two profiles that share a phone race to one referral and one conversion', async () => {
    // Repeated: the race needs both transactions past their own row locks at once.
    for (let round = 0; round < 3; round += 1) {
      const referrer = await customer();
      const accountId = randomUUID();
      const home = await linkCustomer('WAVES-ANY', { account_id: accountId, phone: '+19415550188' });
      const rental = await linkCustomer('WAVES-ANY', { account_id: accountId, phone: '(941) 555-0188' });
      const outcomes = await Promise.allSettled([home, rental].map((friend) => (
        inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id }))));
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((o) => o.status === 'rejected').reason).toMatchObject({ statusCode: 409, code: 'ALREADY_REFERRED' });
      expect(await db('referrals').where({ referrer_customer_id: referrer.id }).count('* as n').first()).toEqual({ n: '1' });
      expect(await db('referral_promoters').where({ customer_id: referrer.id }).first()).toMatchObject({ total_referrals_converted: 1 });
      await db('referral_inbound_reviews').del();
      await db('referrals').del();
    }
  });

  test("a confirm that is the referrer's 3rd conversion sends the existing milestone text, and only that", async () => {
    const referrer = await customer({ referral_code: 'WAVES-JANE' });
    await db('referral_promoters').insert({
      customer_phone: referrer.phone, first_name: 'Jane', last_name: 'Smith', customer_id: referrer.id,
      referral_code: 'WAVES-JANE', status: 'active', total_referrals_converted: 2,
    });
    const friend = await linkCustomer('WAVES-JANE');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });
    await inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id });
    expect(await db('referral_promoters').where({ customer_id: referrer.id }).first())
      .toMatchObject({ total_referrals_converted: 3, milestone_level: 'advocate' });
    expect(sendCustomerMessage.mock.calls.map(([message]) => message.metadata.original_message_type)).toEqual(['referral_milestone']);
    // The milestone text is the conversion's own; the no-message guard below covers every other case.
    sendCustomerMessage.mockClear();
  });

  test('dismiss removes the customer from the list and blocks a later confirm', async () => {
    const referrer = await customer({ referral_code: 'WAVES-JANE' });
    const friend = await linkCustomer('WAVES-JANE');
    await inbound.dismissInboundReferral({ customerId: friend.id });
    expect(await inbound.listInboundReferrals()).toEqual([]);
    await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_REVIEWED' });
    expect(await db('referrals').count('* as n').first()).toEqual({ n: '0' });
  });

  test('confirm refuses a customer with no referral evidence, no plan, or an existing referral', async () => {
    const referrer = await customer();
    const noEvidence = await customer({ waveguard_tier: 'Silver', monthly_rate: 80 });
    const noPlan = await customer({ lead_source_detail: 'Referred by Jane' });
    const typedIn = await linkCustomer('WAVES-ANY');
    await db('referrals').insert({
      referrer_customer_id: referrer.id, referee_name: 'Typed In', referee_phone: typedIn.phone.slice(2),
      referral_code: 'WAVES-ANY', status: 'rejected',
    });
    await expect(inbound.confirmInboundReferral({ customerId: noEvidence.id, referrerCustomerId: referrer.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'NO_REFERRAL_EVIDENCE' });
    await expect(inbound.confirmInboundReferral({ customerId: noPlan.id, referrerCustomerId: referrer.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'NOT_ON_PLAN' });
    await expect(inbound.confirmInboundReferral({ customerId: typedIn.id, referrerCustomerId: referrer.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_REFERRED' });
    await expect(inbound.confirmInboundReferral({ customerId: typedIn.id, referrerCustomerId: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'REFERRER_NOT_FOUND' });
    expect(await db('referral_inbound_reviews').count('* as n').first()).toEqual({ n: '0' });
  });
  test('one customer\'s card reads alone', async () => {
    const referrer = await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
    const first = await linkCustomer('WAVES-JANE');
    await linkCustomer('WAVES-JANE');
    const only = await inbound.listInboundReferrals(db, { customerId: first.id });
    expect(only.map((c) => c.customerId)).toEqual([first.id]);
    expect(await inbound.listInboundReferrals(db, { customerId: referrer.id })).toEqual([]);
    expect(await inbound.listInboundReferrals()).toHaveLength(2);
  });

  describe('a deferred-only confirm (the bell\'s Confirm) refuses, under its locks, anything that would send or pay now', () => {
    const promoterFor = (referrer, converted) => db('referral_promoters').insert({
      customer_phone: referrer.phone, first_name: 'Jane', last_name: 'Smith', customer_id: referrer.id,
      referral_code: 'WAVES-JANE', status: 'active', total_referrals_converted: converted,
    });
    const saved = async () => ({
      referrals: (await db('referrals').count('* as n').first()).n,
      answers: (await db('referral_inbound_reviews').count('* as n').first()).n,
    });

    test('a milestone conversion is refused and saves nothing', async () => {
      const referrer = await customer({ referral_code: 'WAVES-JANE' });
      await promoterFor(referrer, 2);
      const friend = await linkCustomer('WAVES-JANE');
      await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id, deferredOnly: true }))
        .rejects.toMatchObject({ statusCode: 409, code: 'MILESTONE_DUE' });
      expect(await saved()).toEqual({ referrals: '0', answers: '0' });
      expect(await db('referral_promoters').where({ customer_id: referrer.id }).first()).toMatchObject({ total_referrals_converted: 2, milestone_level: 'none' });
      expect((await inbound.listInboundReferrals()).map((c) => c.customerId)).toEqual([friend.id]);
    });

    test('rewards paid at once are refused and save nothing', async () => {
      const referrer = await customer({ referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE');
      await db('referral_program_settings').update({ require_service_completion: false });
      try {
        await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id, deferredOnly: true }))
          .rejects.toMatchObject({ statusCode: 409, code: 'REWARD_NOT_DEFERRED' });
      } finally {
        await db('referral_program_settings').update({ require_service_completion: true });
      }
      expect(await saved()).toEqual({ referrals: '0', answers: '0' });
    });

    test('a plan visit already on record is refused and saves nothing', async () => {
      const referrer = await customer({ referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE');
      await recurringVisit(friend.id);
      await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id, deferredOnly: true }))
        .rejects.toMatchObject({ statusCode: 409, code: 'FIRST_VISIT_DONE' });
      expect(await saved()).toEqual({ referrals: '0', answers: '0' });
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    test('a referrer who is not the card\'s one sure referrer is refused and saves nothing', async () => {
      await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const other = await customer({ first_name: 'Rae', last_name: 'Other' });
      const friend = await linkCustomer('WAVES-JANE');
      await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: other.id, deferredOnly: true }))
        .rejects.toMatchObject({ statusCode: 409, code: 'REFERRER_CHANGED' });
      expect(await saved()).toEqual({ referrals: '0', answers: '0' });
    });

    test('a plan visit that completes while the confirm runs is credited after it, so that visit\'s credit is not lost', async () => {
      const engine = require('../services/referral-engine');
      const referrer = await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE');
      const realConvert = engine.convertReferral;
      // The visit commits on another connection after the confirm's own visit check passed.
      const spy = jest.spyOn(engine, 'convertReferral').mockImplementationOnce(async (...args) => {
        await recurringVisit(friend.id);
        return realConvert(...args);
      });
      try {
        await expect(inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id, deferredOnly: true }))
          .resolves.toMatchObject({ converted: true, creditsNow: true, credited: expect.anything(), error: null });
      } finally {
        spy.mockRestore();
      }
      expect(postCreditMovement).toHaveBeenCalledTimes(2);
    });

    test('two confirms for one referrer at the same moment: the one that would be the 3rd conversion is refused', async () => {
      const referrer = await customer({ referral_code: 'WAVES-JANE' });
      await promoterFor(referrer, 1);
      const [one, two] = [await linkCustomer('WAVES-JANE'), await linkCustomer('WAVES-JANE')];
      const results = await Promise.allSettled([one, two].map((friend) => inbound.confirmInboundReferral({
        customerId: friend.id, referrerCustomerId: referrer.id, deferredOnly: true,
      })));
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'MILESTONE_DUE' });
      expect(await db('referral_promoters').where({ customer_id: referrer.id }).first()).toMatchObject({ total_referrals_converted: 2, milestone_level: 'none' });
      expect(await saved()).toEqual({ referrals: '1', answers: '1' });
    });
  });

  describe('the new-referral bell (GATE_REFERRAL_INBOUND_BELL)', () => {
    let bell;
    let buttons;
    let NotificationService;
    const saved = {};
    const TECH = randomUUID();

    beforeAll(() => {
      for (const key of ['GATE_REFERRAL_INBOUND_BELL', 'GATE_REFERRAL_INBOUND_CONFIRM']) saved[key] = process.env[key];
      process.env.GATE_REFERRAL_INBOUND_BELL = 'true';
      process.env.GATE_REFERRAL_INBOUND_CONFIRM = 'true';
      bell = require('../services/referral-inbound-bell');
      buttons = require('../services/admin-alert-buttons');
      NotificationService = require('../services/notification-service');
    });
    afterAll(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    // The bell list as an admin is served it.
    const served = async () => buttons.withAlertButtons(await NotificationService.getAdminNotifications(30, 0, { role: 'admin' }), { role: 'admin' });
    const tap = (row, actionId) => buttons.runAlertButton({ notificationId: row.id, actionId, version: row.version, technicianId: TECH, role: 'admin' });
    const answerOf = (customerId) => db('referral_inbound_reviews').where({ customer_id: customerId }).first();

    test('a card rings once with its buttons; Not a referral from the bell answers it, records the tap, and rings nothing again', async () => {
      await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE', { first_name: 'Ames', last_name: 'Fenn' });
      await expect(bell.syncReferralInboundBells()).resolves.toEqual({ raised: 1, unchanged: 0, closed: 0, failed: 0 });
      await expect(bell.syncReferralInboundBells()).resolves.toEqual({ raised: 0, unchanged: 1, closed: 0, failed: 0 });

      const [row] = await served();
      expect(row).toMatchObject({ category: 'customer', title: "Customers — confirm Ames Fenn's referrer", link: '/admin/referrals?tab=queue' });
      expect(row.actions.map((a) => a.id)).toEqual(['confirm', 'dismiss']);
      // A technician login is served no buttons, and its bell list does not show the row at all.
      const rawRows = await NotificationService.getAdminNotifications(30, 0, { role: 'admin' });
      expect(buttons.withAlertButtons(rawRows, { role: 'technician' })[0]).not.toHaveProperty('actions');
      expect(await NotificationService.getAdminNotifications(30, 0, { role: 'technician', technicianId: randomUUID() })).toEqual([]);

      await expect(tap(row, 'dismiss')).resolves.toEqual({ status: 200, body: { success: true, message: 'Ames Fenn is marked not a referral.' } });
      expect(await answerOf(friend.id)).toMatchObject({ outcome: 'dismissed', reviewed_by: TECH });
      const after = await db('notifications').where({ id: row.id }).first();
      expect(after.done_at).not.toBeNull();
      expect(after.resolution).toBe('Marked not a referral');
      expect(after.metadata.buttonTaps).toEqual([expect.objectContaining({ action: 'dismiss', by: TECH, outcome: 'done' })]);
      expect(after.metadata).not.toHaveProperty('buttonClaim');
      expect(await served()).toEqual([]);

      await expect(tap(row, 'dismiss')).resolves.toMatchObject({ status: 409, body: { error: 'done' } });
      await expect(bell.syncReferralInboundBells()).resolves.toEqual({ raised: 0, unchanged: 0, closed: 0, failed: 0 });
      expect(await db('notifications').count('* as n').first()).toEqual({ n: '1' });
    });

    test('Confirm from the bell runs the Queue\'s confirm with the code owner and sends and pays nothing now', async () => {
      const referrer = await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE', { first_name: 'Ames', last_name: 'Fenn' });
      await bell.syncReferralInboundBells();
      const [row] = await served();
      await expect(tap(row, 'confirm')).resolves.toEqual({
        status: 200, body: { success: true, message: "Jane Smith is confirmed as Ames Fenn's referrer. $25 each after the first plan visit." },
      });
      const referral = await db('referrals').where({ referrer_customer_id: referrer.id }).first();
      expect(referral).toMatchObject({ status: 'signed_up', source: 'inbound_link', referrer_reward_status: 'pending_service' });
      expect(await answerOf(friend.id)).toMatchObject({ outcome: 'confirmed', reviewed_by: TECH });
      expect(postCreditMovement).not.toHaveBeenCalled();
      expect(await db('notifications').where({ id: row.id }).first()).toMatchObject({ resolution: 'Referrer confirmed' });
    });

    test('two taps on one row at the same moment: one runs, the other runs nothing', async () => {
      await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE');
      await bell.syncReferralInboundBells();
      const [row] = await served();
      const results = await Promise.all([tap(row, 'dismiss'), tap(row, 'confirm')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(['busy', 'done', 'changed']).toContain(results.find((r) => r.status === 409).body.error);
      expect(await db('referral_inbound_reviews').where({ customer_id: friend.id }).count('* as n').first()).toEqual({ n: '1' });
      const after = await db('notifications').where({ id: row.id }).first();
      expect(after.metadata.buttonTaps).toHaveLength(1);
      expect(after.metadata.buttonTaps[0].outcome).toBe('done');
      expect(after.metadata).not.toHaveProperty('buttonClaim');
    });

    test('an answer in the Queue closes the open row', async () => {
      const referrer = await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE');
      await bell.syncReferralInboundBells();
      const [row] = await served();
      await inbound.confirmInboundReferral({ customerId: friend.id, referrerCustomerId: referrer.id });
      expect(await db('notifications').where({ id: row.id }).first()).toMatchObject({ done_by: 'episodes', resolution: 'Referrer confirmed' });
      expect(await served()).toEqual([]);
    });

    test('once a plan visit is done, the row offers no Confirm, and a Confirm sent anyway is refused', async () => {
      await customer({ first_name: 'Jane', last_name: 'Smith', referral_code: 'WAVES-JANE' });
      const friend = await linkCustomer('WAVES-JANE');
      await bell.syncReferralInboundBells();
      const [before] = await served();
      await recurringVisit(friend.id);
      await bell.syncReferralInboundBells();
      const [row] = await served();
      expect(row.actions.map((a) => a.id)).toEqual(['dismiss']);
      // A Confirm on the row as it rang first: the row changed, so the tap runs nothing.
      await expect(tap(before, 'confirm')).resolves.toMatchObject({ status: 409, body: { error: 'changed' } });
      expect(await answerOf(friend.id)).toBeUndefined();
      expect(await db('referrals').count('* as n').first()).toEqual({ n: '0' });
    });
  });
  describe('close-only buttons (close_note) on a real bell row', () => {
    let buttons;
    let NotificationService;
    let saved;
    const TECH = randomUUID();

    beforeAll(() => {
      saved = process.env.GATE_ALERT_CLOSE_BUTTONS;
      process.env.GATE_ALERT_CLOSE_BUTTONS = 'true';
      buttons = require('../services/admin-alert-buttons');
      NotificationService = require('../services/notification-service');
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.GATE_ALERT_CLOSE_BUTTONS;
      else process.env.GATE_ALERT_CLOSE_BUTTONS = saved;
    });

    const textRow = async () => {
      const [row] = await db('notifications').insert({
        recipient_type: 'admin', category: 'inbound_sms', title: '1 text from Fixture Person', body: 'Is Friday still on?',
        link: '/admin/communications?thread=x', metadata: JSON.stringify({ triggerKey: 'sms_reply', dedupeKey: `sms-thread:${randomUUID()}`, buttons: buttons.closeNoteButtons('handled') }),
      }).returning('id');
      const [served] = buttons.withAlertButtons(await NotificationService.getAdminNotifications(30, 0, { role: 'admin' }), { role: 'admin' });
      expect(served).toMatchObject({ id: row.id, actions: [{ id: 'handled', label: 'Handled' }] });
      return served;
    };
    const tap = (row) => buttons.runAlertButton({ notificationId: row.id, actionId: 'handled', version: row.version, technicianId: TECH, role: 'admin' });

    test('Handled marks the row done by the person with that note, and records the tap', async () => {
      const row = await textRow();
      await expect(tap(row)).resolves.toEqual({ status: 200, body: { success: true, message: 'Marked handled.' } });
      const after = await db('notifications').where({ id: row.id }).first();
      expect(after).toMatchObject({ done_by: TECH, resolution: 'Handled' });
      expect(after.metadata.buttonTaps).toEqual([expect.objectContaining({ action: 'handled', by: TECH, outcome: 'done' })]);
      expect(after.metadata).not.toHaveProperty('buttonClaim');
    });

    test('a new text that reopens the row right after the close stays open', async () => {
      const row = await textRow();
      const ops = require('../services/sms-operational-actions');
      // A ringing refresh (a new text) lands just after the fenced close: it reopens the row with the new text.
      const spy = jest.spyOn(ops, 'settleCommitmentsForDoneAlert').mockImplementationOnce(async () => {
        await db('notifications').where({ id: row.id }).update({ done_at: null, done_by: null, resolution: null, read_at: null, body: 'One more thing: the dog is out.' });
        return 0;
      });
      try {
        await expect(tap(row)).resolves.toMatchObject({ status: 200 });
      } finally {
        spy.mockRestore();
      }
      const after = await db('notifications').where({ id: row.id }).first();
      expect(after.done_at).toBeNull();
      expect(after.body).toBe('One more thing: the dog is out.');
    });

    test('a new text that rewrites the row between the claim and the close is not marked handled', async () => {
      const row = await textRow();
      const realDone = NotificationService.markAdminDone.bind(NotificationService);
      const spy = jest.spyOn(NotificationService, 'markAdminDone').mockImplementationOnce(async (...args) => {
        await db('notifications').where({ id: row.id }).update({ title: '2 texts from Fixture Person', body: 'Also the side gate is open.' });
        return realDone(...args);
      });
      try {
        await expect(tap(row)).resolves.toEqual({ status: 409, body: { error: 'changed' } });
      } finally {
        spy.mockRestore();
      }
      const after = await db('notifications').where({ id: row.id }).first();
      expect(after.done_at).toBeNull();
      expect(after.body).toBe('Also the side gate is open.');
      expect(after.metadata.buttonTaps).toEqual([expect.objectContaining({ outcome: 'changed' })]);
      expect(after.metadata).not.toHaveProperty('buttonClaim');
    });
  });
});
