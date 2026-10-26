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

  async function recurringVisit(customerId, status = 'completed', date = '2026-10-15') {
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, status, is_recurring: true, scheduled_date: date,
    }).returning('*');
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
    await require('../models/migrations/20261026150000_referral_inbound_reviews').up(db);

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
    await db('referral_inbound_reviews').del();
    await db('referrals').del();
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
    // Not asked about: no plan, a sentinel tier, no phone, archived, the owner's test account.
    await customer({ lead_source_detail: 'Referred by Jane Smith' });
    await customer({ waveguard_tier: 'One-Time', monthly_rate: 99, lead_source_detail: 'Referred by Jane Smith' });
    await linkCustomer('WAVES-JANE', { phone: null });
    await linkCustomer('WAVES-JANE', { deleted_at: new Date() });
    await linkCustomer('WAVES-JANE', { first_name: 'Adam', last_name: 'Martinez' });
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
      firstVisitDone: true,
      selfReferral: false,
      evidence: { source: 'link', code: 'WAVES-JANE', spokenName: null },
      suggestions: [{ customerId: referrer.id, name: 'Jane Smith', city: 'Parrish', viaCode: true }],
    });
    expect(byId[named.id].firstVisitDone).toBe(false);
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
    expect(result).toMatchObject({ converted: true, firstVisitDone: true, credited: { referrerDollars: 25, refereeDollars: 25 }, error: null });

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
    expect(result).toMatchObject({ converted: true, firstVisitDone: false, credited: null, error: null });
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
});
