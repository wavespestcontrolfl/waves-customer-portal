// Runs with the existing CI PostgreSQL pass; never a production connection.
// Referral Step 2, member side (GATE_REFERRAL_STEP2) against real Postgres and the real credit ledger: the member's
// $25 / $50-near credit at the friend's first PAID recurring service, the 10-a-year cap, the payment wait and its
// retry sweep, and the gate-off path that must stay exactly as it was. A private schema keeps CI's migrated tables
// untouched; the Step 2 migration builds its own columns.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `referral_step2_${randomUUID().replaceAll('-', '')}`;
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
// Anything the engine tried to send would land here; every test asserts none.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'text') }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  redactEmailAddresses: (s) => s,
}));

const DAY = 86400000;

(SKIP ? describe.skip : describe)('referral Step 2 member credit (live Postgres)', () => {
  let db;
  let engine;
  let gates;
  let sendCustomerMessage;
  let sendTemplate;
  let migration;
  let legacyMemberId;

  let phoneSeq = 0;
  async function customer(fields = {}) {
    phoneSeq += 1;
    const [row] = await db('customers').insert({
      first_name: 'Fixture',
      last_name: `Person${phoneSeq}`,
      phone: `+19415${String(100000 + phoneSeq)}`,
      account_id: randomUUID(),
      active: true,
      ...fields,
    }).returning('*');
    return row;
  }
  // A friend on a WaveGuard plan.
  const planFriend = (fields = {}) => customer({ waveguard_tier: 'Silver', monthly_rate: 119.1, ...fields });

  async function promoterFor(member) {
    const existing = await db('referral_promoters').where({ customer_id: member.id }).first();
    if (existing) return existing;
    const [row] = await db('referral_promoters').insert({
      customer_phone: member.phone, first_name: 'Member', last_name: member.last_name,
      customer_id: member.id, referral_code: `WAVES-${member.last_name}`.slice(0, 20),
    }).returning('*');
    return row;
  }

  async function referral(member, friend, { ageDays = 0, fields = {} } = {}) {
    const promoter = await promoterFor(member);
    const [row] = await db('referrals').insert({
      referrer_customer_id: member.id,
      referee_name: 'Fixture Friend',
      referee_phone: friend.phone,
      referral_code: promoter.referral_code,
      status: 'contacted',
      promoter_id: promoter.id,
      referrer_reward_amount: 25,
      created_at: new Date(Date.now() - ageDays * DAY),
      ...fields,
    }).returning('*');
    return row;
  }

  // A plan visit; a completed one gets its closeout record (performed).
  async function recurringVisit(customerId, { status = 'scheduled', date = '2026-12-15', fields = {} } = {}) {
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, status, is_recurring: true, scheduled_date: date, ...fields,
    }).returning('*');
    if (status === 'completed') {
      const [record] = await db('service_records').insert({
        scheduled_service_id: row.id, customer_id: customerId, status: 'completed', structured_notes: {},
      }).returning('id');
      row.record_id = record.id;
    }
    return row;
  }

  async function invoice(customerId, { status = 'sent', fields = {} } = {}) {
    const [row] = await db('invoices').insert({ customer_id: customerId, total: 119, status, ...fields }).returning('*');
    return row;
  }

  const convert = (ref, friend) => engine.convertReferral(ref.id, { customerId: friend.id, tier: 'Silver', monthlyValue: 119.1 });
  const firstService = (friend, visit) => engine.creditReferralOnFirstService({ customerId: friend.id, serviceId: visit.id });
  const credits = (customerId) => db('customer_credit_ledger').where({ customer_id: customerId }).orderBy('created_at').select('*');
  const amounts = async (customerId) => (await credits(customerId)).map((c) => Number(c.delta));
  const row = (id) => db('referrals').where({ id }).first();

  // 0.005 degree of latitude is about 0.35 mile; 0.01 is about 0.69 mile.
  const HOME = { latitude: 27.499, longitude: -82.57 };

  // A performed first plan visit with its invoice paid (`paid: false`: no invoice yet), the referral converted.
  async function performed({ memberFields = {}, friendFields = {}, paid = true } = {}) {
    const member = await customer(memberFields);
    const friend = await planFriend(friendFields);
    const visit = await recurringVisit(friend.id, { status: 'completed' });
    if (paid) await invoice(friend.id, { status: 'paid', fields: { scheduled_service_id: visit.id } });
    const ref = await referral(member, friend, { ageDays: 2 });
    await convert(ref, friend);
    return { member, friend, visit, ref };
  }

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    // A fresh builder for each table: one builder re-runs its earlier statements.
    const s = { createTable: (name, cb) => db.schema.withSchema(mockSchema).createTable(name, cb) };
    await s.createTable('customers', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('first_name');
      t.string('last_name');
      t.string('phone');
      t.string('email');
      t.uuid('account_id');
      t.boolean('active').defaultTo(true);
      t.string('billing_mode');
      t.decimal('monthly_rate', 10, 2);
      t.string('waveguard_tier');
      t.decimal('latitude', 10, 7);
      t.decimal('longitude', 10, 7);
      t.decimal('account_credits', 10, 2).defaultTo(0);
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
      t.timestamp('updated_at', { useTz: true }).defaultTo(db.fn.now());
      t.timestamp('deleted_at', { useTz: true });
    });
    await s.createTable('customer_credit_ledger', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.decimal('delta', 10, 2).notNullable();
      t.decimal('balance_after', 10, 2).notNullable();
      t.string('source', 40).notNullable();
      t.uuid('invoice_id');
      t.uuid('referral_id');
      t.text('note');
      t.string('created_by', 200);
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await s.createTable('referral_promoters', (t) => {
      t.increments('id');
      t.string('customer_phone').notNullable().unique('referral_promoters_customer_phone_unique');
      t.string('customer_email');
      t.string('first_name').notNullable();
      t.string('last_name').notNullable();
      t.uuid('customer_id');
      t.string('referral_code').unique();
      t.string('status').defaultTo('active');
      for (const col of ['referral_balance_cents', 'total_earned_cents', 'total_paid_out_cents', 'total_clicks',
        'total_referrals_sent', 'total_referrals_converted', 'available_balance_cents', 'pending_earnings_cents']) {
        t.integer(col).defaultTo(0);
      }
      t.string('milestone_level').defaultTo('none');
      t.timestamp('milestone_earned_at', { useTz: true });
      t.timestamp('last_referral_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true });
    });
    // Prod's referrals shape before Step 2 (the migration under test adds the rest).
    await s.createTable('referrals', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('referrer_customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('referee_name', 100).notNullable();
      t.string('referee_phone', 20).notNullable();
      t.string('referee_email', 150);
      t.string('referral_code', 20).notNullable();
      t.text('status').defaultTo('pending');
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
    await s.createTable('referral_program_settings', (t) => {
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
      t.timestamp('updated_at', { useTz: true });
    });
    await db('referral_program_settings').insert({
      id: 1, program_active: true, base_url: 'https://portal.wavespestcontrol.com/r/',
      referrer_reward_cents: 2500, referee_discount_cents: 2500, bonus_silver_cents: 0, bonus_gold_cents: 0,
      bonus_platinum_cents: 0, milestone_3_bonus_cents: 2500, milestone_5_bonus_cents: 5000,
      milestone_10_bonus_cents: 10000, min_payout_cents: 1000, max_referrals_per_month: 20,
      auto_credit_enabled: true, require_service_completion: true,
    });
    await s.createTable('scheduled_services', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id');
      t.string('status');
      t.boolean('is_recurring').defaultTo(false);
      t.string('recurring_pattern', 30);
      t.date('scheduled_date');
      t.timestamp('prepaid_at', { useTz: true });
      t.uuid('first_application_invoice_id');
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await s.createTable('service_records', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('scheduled_service_id');
      t.uuid('customer_id');
      t.string('status');
      t.jsonb('structured_notes');
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await s.createTable('invoices', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable();
      t.uuid('scheduled_service_id');
      t.uuid('service_record_id');
      t.uuid('visit_completion_packet_id');
      t.string('status', 20).defaultTo('sent');
      t.decimal('total', 10, 2).notNullable().defaultTo(0);
      t.integer('payer_id');
      t.jsonb('line_items').defaultTo('[]');
      t.string('invoice_number');
    });
    await s.createTable('visit_completion_packets', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('visit_id');
    });
    await s.createTable('visit_completion_packet_items', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('packet_id');
      t.uuid('scheduled_service_id');
    });
    await s.createTable('payments', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id');
      t.string('status');
      t.jsonb('metadata');
      t.date('payment_date');
      t.string('description');
    });
    await s.createTable('referral_clicks', (t) => {
      t.increments('id');
      t.integer('promoter_id');
      t.boolean('is_unique');
      t.boolean('converted_to_lead');
      t.timestamp('created_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await s.createTable('referral_payouts', (t) => {
      t.increments('id');
      t.string('status');
      t.integer('amount_cents');
    });
    // A row that exists before the migration stays readable after it.
    const legacyMember = await customer();
    legacyMemberId = legacyMember.id;
    await db('referrals').insert({
      referrer_customer_id: legacyMember.id, referee_name: 'Legacy', referee_phone: '+19415550000', referral_code: 'WAVES-OLD',
    });

    migration = require('../models/migrations/20261120150000_referral_step2_member_credit');
    await migration.up(db);

    gates = require('../config/feature-gates').gates;
    engine = require('../services/referral-engine');
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
    gates.referralStep2 = true;
    for (const table of ['visit_completion_packet_items', 'visit_completion_packets', 'payments', 'invoices',
      'referral_clicks', 'referral_payouts', 'customer_credit_ledger', 'service_records', 'scheduled_services']) {
      await db(table).del();
    }
    await db('referral_program_settings').where({ id: 1 }).update({ require_service_completion: true });
    await db('referrals').whereNot({ referral_code: 'WAVES-OLD' }).del();
    await db('referral_promoters').del();
    await db('customers').whereNot('id', legacyMemberId).del();
  });

  afterEach(() => {
    gates.referralStep2 = false;
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  describe('the migration', () => {
    test('adds the owner numbers to the settings row, leaves an old referral null, runs twice and rolls back', async () => {
      expect(await db('referral_program_settings').where({ id: 1 }).first()).toMatchObject({
        step2_referrer_reward_cents: 2500,
        step2_near_referrer_reward_cents: 5000,
        step2_near_radius_miles: '0.50',
        step2_annual_credit_cap: 10,
      });
      expect(await db('referrals').where({ referral_code: 'WAVES-OLD' }).first()).toMatchObject({
        referrer_credit_cents: null, referrer_reward_reason: null,
      });
      await migration.up(db);
      await migration.down(db);
      for (const col of migration._REFERRAL_COLUMNS) expect(await db.schema.hasColumn('referrals', col)).toBe(false);
      for (const col of migration._SETTING_COLUMNS) expect(await db.schema.hasColumn('referral_program_settings', col)).toBe(false);
      await migration.up(db);
      for (const col of migration._REFERRAL_COLUMNS) expect(await db.schema.hasColumn('referrals', col)).toBe(true);
    });
  });

  describe('the member credit amount', () => {
    test('a friend farther than half a mile: the member gets $25 and the friend the flat $25', async () => {
      const { member, friend, visit, ref } = await performed({
        memberFields: HOME, friendFields: { latitude: HOME.latitude + 0.01, longitude: HOME.longitude },
      });
      const result = await firstService(friend, visit);
      expect(result).toMatchObject({ referralId: ref.id, referrerDollars: 25, refereeDollars: 25, referrerReason: 'standard' });
      expect(await amounts(member.id)).toEqual([25]);
      expect(await amounts(friend.id)).toEqual([25]);
      expect(await row(ref.id)).toMatchObject({
        status: 'credited', first_service_completed: true, referrer_reward_status: 'earned',
        referrer_credit_cents: 2500, referrer_reward_reason: 'standard', referee_credited: true, referrer_credited: true,
      });
    });

    test('a friend within half a mile: the member gets $50', async () => {
      const { member, friend, visit, ref } = await performed({
        memberFields: HOME, friendFields: { latitude: HOME.latitude + 0.005, longitude: HOME.longitude },
      });
      await firstService(friend, visit);
      expect(await amounts(member.id)).toEqual([50]);
      expect(await row(ref.id)).toMatchObject({ referrer_credit_cents: 5000, referrer_reward_reason: 'near' });
    });

    test('a home with no map point pays $25', async () => {
      const { member, friend, visit } = await performed({ memberFields: HOME });
      await firstService(friend, visit);
      expect(await amounts(member.id)).toEqual([25]);
    });
  });

  describe('the yearly cap', () => {
    // `count` earlier member credits for `memberId`, each tied to its own earlier referral, posted at `at`.
    async function priorCredits(memberId, count, at = new Date()) {
      for (let i = 0; i < count; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: memberId, referee_name: `Prior ${i}`, referee_phone: `+1941556${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited', first_service_completed: true,
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: memberId, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id, created_at: at,
        });
      }
    }

    async function withMemberHaving(count, at) {
      const member = await customer();
      const friend = await planFriend();
      const visit = await recurringVisit(friend.id, { status: 'completed' });
      await invoice(friend.id, { status: 'paid', fields: { scheduled_service_id: visit.id } });
      const ref = await referral(member, friend, { ageDays: 2 });
      await priorCredits(member.id, count, at);
      await convert(ref, friend);
      return { member, friend, visit, ref };
    }

    test('9 credits this year: the 10th is paid', async () => {
      const { member, friend, visit, ref } = await withMemberHaving(9);
      await firstService(friend, visit);
      expect(await db('customer_credit_ledger').where({ customer_id: member.id }).count('* as n').first()).toEqual({ n: '10' });
      expect(await row(ref.id)).toMatchObject({ referrer_reward_reason: 'standard', referrer_credited: true });
    });

    test('10 credits this year: nothing is posted, the referral still closes with the reason, the friend is still paid', async () => {
      const { member, friend, visit, ref } = await withMemberHaving(10);
      expect(await firstService(friend, visit)).toMatchObject({ referrerDollars: 0, refereeDollars: 25, referrerReason: 'cap_reached' });
      expect(await db('customer_credit_ledger').where({ customer_id: member.id }).count('* as n').first()).toEqual({ n: '10' });
      expect(await row(ref.id)).toMatchObject({
        status: 'credited', first_service_completed: true, referrer_reward_status: 'earned',
        referrer_credit_cents: 0, referrer_reward_reason: 'cap_reached', referrer_credited: false,
      });
      expect(await amounts(friend.id)).toEqual([25]);
      expect(await firstService(friend, visit)).toBeNull();
    });

    test("last year's credits do not count: ET midnight is the edge", async () => {
      const { parseETDateTime, etParts } = require('../utils/datetime-et');
      const { year } = etParts(new Date());
      const lastYear = new Date(parseETDateTime(`${year}-01-01T00:00`).getTime() - 60000); // 11:59 PM ET Dec 31
      const { member, friend, visit } = await withMemberHaving(10, lastYear);
      await firstService(friend, visit);
      expect(await db('customer_credit_ledger').where({ customer_id: member.id }).count('* as n').first()).toEqual({ n: '11' });
      const thisYear = new Date(parseETDateTime(`${year}-01-01T00:00`).getTime() + 60000);
      const second = await withMemberHaving(10, thisYear);
      expect(await firstService(second.friend, second.visit)).toMatchObject({ referrerReason: 'cap_reached' });
    });

    test("a credit the member got as a friend is not one of the member's credits", async () => {
      const member = await customer();
      const friend = await planFriend();
      const visit = await recurringVisit(friend.id, { status: 'completed' });
      await invoice(friend.id, { status: 'paid', fields: { scheduled_service_id: visit.id } });
      const ref = await referral(member, friend, { ageDays: 2 });
      await priorCredits(member.id, 9);
      const other = await customer();
      const [theirs] = await db('referrals').insert({
        referrer_customer_id: other.id, referee_name: 'Member as friend', referee_phone: member.phone,
        referral_code: 'WAVES-OTHER', status: 'credited',
      }).returning('id');
      await db('customer_credit_ledger').insert({
        customer_id: member.id, delta: 25, balance_after: 250, source: 'referral', referral_id: theirs.id,
      });
      await convert(ref, friend);
      await firstService(friend, visit);
      expect(await row(ref.id)).toMatchObject({ referrer_reward_reason: 'standard', referrer_credited: true });
    });

    test('two friends of one member finishing together cannot pass the cap', async () => {
      const member = await customer();
      await priorCredits(member.id, 9);
      const pairs = [];
      for (let i = 0; i < 2; i += 1) {
        const friend = await planFriend();
        const visit = await recurringVisit(friend.id, { status: 'completed' });
        await invoice(friend.id, { status: 'paid', fields: { scheduled_service_id: visit.id } });
        const ref = await referral(member, friend, { ageDays: 2 });
        await convert(ref, friend);
        pairs.push({ friend, visit, ref });
      }
      await Promise.all(pairs.map(({ friend, visit }) => firstService(friend, visit)));
      expect(await db('customer_credit_ledger').where({ customer_id: member.id }).count('* as n').first()).toEqual({ n: '10' });
      const reasons = (await Promise.all(pairs.map(({ ref }) => row(ref.id)))).map((r) => r.referrer_reward_reason).sort();
      expect(reasons).toEqual(['cap_reached', 'standard']);
    });
  });

  describe('the member is paid only after the friend\'s first plan visit is paid', () => {
    // The unpaid state: nothing consumed, the referral still waiting.
    async function expectWaiting({ member, friend, visit, ref }) {
      expect(await firstService(friend, visit)).toBeNull();
      expect(await credits(member.id)).toHaveLength(0);
      expect(await credits(friend.id)).toHaveLength(0);
      expect(await row(ref.id)).toMatchObject({ status: 'signed_up', first_service_completed: false, referrer_reward_status: 'pending_service' });
    }

    test("the visit's own invoice: unpaid waits, paid pays, and the sweep finishes the wait", async () => {
      const ctx = await performed({ paid: false });
      const bill = await invoice(ctx.friend.id, { fields: { scheduled_service_id: ctx.visit.id } });
      await expectWaiting(ctx);
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 1, credited: 0 });
      await db('invoices').where({ id: bill.id }).update({ status: 'paid' });
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 1, credited: 1 });
      expect(await amounts(ctx.member.id)).toEqual([25]);
      expect(await amounts(ctx.friend.id)).toEqual([25]);
      // Nothing more on a later sweep or completion.
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 0, credited: 0 });
      expect(await firstService(ctx.friend, ctx.visit)).toBeNull();
      expect(await credits(ctx.member.id)).toHaveLength(1);
    });

    test('an invoice linked only through the service record counts', async () => {
      const ctx = await performed({ paid: false });
      await invoice(ctx.friend.id, { fields: { service_record_id: ctx.visit.record_id } });
      await expectWaiting(ctx);
    });

    test('an invoice linked only through a visit completion packet counts (packet visit, and a packet item)', async () => {
      const ctx = await performed({ paid: false });
      const [packet] = await db('visit_completion_packets').insert({ visit_id: ctx.visit.id }).returning('id');
      const bill = await invoice(ctx.friend.id, { fields: { visit_completion_packet_id: packet.id } });
      await expectWaiting(ctx);
      await db('invoices').where({ id: bill.id }).update({ status: 'paid' });
      expect(await firstService(ctx.friend, ctx.visit)).toMatchObject({ referrerDollars: 25 });

      const other = await performed({ paid: false });
      const [shared] = await db('visit_completion_packets').insert({ visit_id: randomUUID() }).returning('id');
      await db('visit_completion_packet_items').insert({ packet_id: shared.id, scheduled_service_id: other.visit.id });
      await invoice(other.friend.id, { fields: { visit_completion_packet_id: shared.id } });
      await expectWaiting(other);
    });

    test('the first-application invoice stamped on the visit counts', async () => {
      const ctx = await performed({ paid: false });
      const bill = await invoice(ctx.friend.id);
      await db('scheduled_services').where({ id: ctx.visit.id }).update({ first_application_invoice_id: bill.id });
      await expectWaiting(ctx);
    });

    test('a prepaid (covered in full) invoice is settled', async () => {
      const ctx = await performed({ paid: false });
      await invoice(ctx.friend.id, { status: 'prepaid', fields: { scheduled_service_id: ctx.visit.id } });
      expect(await firstService(ctx.friend, ctx.visit)).toMatchObject({ referrerDollars: 25 });
    });

    test('no invoice at all is NOT settled by itself; a prepaid stamp on the visit is', async () => {
      const ctx = await performed({ paid: false });
      await expectWaiting(ctx);
      await db('scheduled_services').where({ id: ctx.visit.id }).update({ prepaid_at: new Date() });
      expect(await firstService(ctx.friend, ctx.visit)).toMatchObject({ referrerDollars: 25 });
    });

    test('no invoice for a monthly member: settled only when the dues are collected for the visit month', async () => {
      const member = await customer();
      const friend = await planFriend({ billing_mode: 'monthly_membership' });
      const visit = await recurringVisit(friend.id, { status: 'completed', date: '2026-11-10' });
      const ref = await referral(member, friend, { ageDays: 2 });
      await convert(ref, friend);
      await expectWaiting({ member, friend, visit, ref });
      await db('payments').insert({
        customer_id: friend.id, status: 'paid', metadata: JSON.stringify({ billed_month: '2026-11' }), payment_date: '2026-11-08', description: 'WaveGuard Monthly',
      });
      expect(await firstService(friend, visit)).toMatchObject({ referrerDollars: 25 });
    });

    test('gate off pays at completion with the invoice unpaid, as today, and the sweep does nothing', async () => {
      const ctx = await performed({ paid: false });
      await invoice(ctx.friend.id, { fields: { scheduled_service_id: ctx.visit.id } });
      gates.referralStep2 = false;
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 0, credited: 0 });
      expect(await firstService(ctx.friend, ctx.visit)).toEqual({ referralId: ctx.ref.id, referrerDollars: 25, refereeDollars: 25 });
    });
  });

  describe('the retry sweep', () => {
    test('a referral stays eligible past 90 days until it settles', async () => {
      const ctx = await performed({ paid: false });
      await invoice(ctx.friend.id, { fields: { scheduled_service_id: ctx.visit.id } });
      await db('referrals').where({ id: ctx.ref.id }).update({ converted_at: new Date(Date.now() - 200 * DAY) });
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 1, credited: 0 });
      await db('referrals').where({ id: ctx.ref.id }).update({ converted_at: new Date(Date.now() - 400 * DAY) });
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 0, credited: 0 });
    });

    test('two profiles on the friend\'s phone are skipped, never guessed', async () => {
      const ctx = await performed({ paid: false });
      await invoice(ctx.friend.id, { status: 'paid', fields: { scheduled_service_id: ctx.visit.id } });
      await planFriend({ phone: ctx.friend.phone });
      expect(await engine.sweepReferralsAwaitingPayment()).toEqual({ checked: 1, credited: 0 });
      expect(await credits(ctx.member.id)).toHaveLength(0);
    });

    test('a rotating cursor reaches rows behind a full page of unpaid referrals', async () => {
      // 201 unpaid referrals ahead of one paid one: the first pass takes the oldest 200, the next reaches the paid one.
      const member = await customer();
      const promoter = await promoterFor(member);
      const base = Date.now() - 100 * DAY;
      const rows = [];
      for (let i = 0; i < 200; i += 1) {
        rows.push({
          referrer_customer_id: member.id, referee_name: `Idle ${i}`, referee_phone: `+1941557${String(1000 + i)}`, referral_code: 'WAVES-IDLE',
          status: 'signed_up', referrer_reward_status: 'pending_service', promoter_id: promoter.id, converted_at: new Date(base + i * 1000),
        });
      }
      await db('referrals').insert(rows);
      const friend = await planFriend();
      const visit = await recurringVisit(friend.id, { status: 'completed' });
      await invoice(friend.id, { status: 'paid', fields: { scheduled_service_id: visit.id } });
      const late = await referral(member, friend, { ageDays: 1, fields: { status: 'signed_up', referrer_reward_status: 'pending_service', converted_at: new Date() } });

      const first = await engine.sweepReferralsAwaitingPayment();
      expect(first).toEqual({ checked: 200, credited: 0 });
      expect(await row(late.id)).toMatchObject({ first_service_completed: false });
      const second = await engine.sweepReferralsAwaitingPayment();
      expect(second).toEqual({ checked: 1, credited: 1 });
      expect(await row(late.id)).toMatchObject({ status: 'credited' });
    });
  });

  describe('Step 2 governs even when the program pays at once', () => {
    test('require_service_completion off + gate on: conversion defers and the member gets the Step 2 amount', async () => {
      await db('referral_program_settings').where({ id: 1 }).update({ require_service_completion: false });
      const member = await customer(HOME);
      const friend = await planFriend({ latitude: HOME.latitude + 0.005, longitude: HOME.longitude });
      const visit = await recurringVisit(friend.id, { status: 'completed' });
      await invoice(friend.id, { status: 'paid', fields: { scheduled_service_id: visit.id } });
      const ref = await referral(member, friend, { ageDays: 1 });
      const result = await convert(ref, friend);
      expect(result.requiresServiceCompletion).toBe(true);
      expect(await row(ref.id)).toMatchObject({ status: 'signed_up', referrer_reward_status: 'pending_service' });
      const promoter = await db('referral_promoters').where({ id: ref.promoter_id }).first();
      expect(promoter).toMatchObject({ available_balance_cents: 0, referral_balance_cents: 0 });
      expect(promoter.pending_earnings_cents).toBeGreaterThan(0);
      await firstService(friend, visit);
      expect(await amounts(member.id)).toEqual([50]);
      expect(await row(ref.id)).toMatchObject({ referrer_reward_reason: 'near' });
    });
  });

  describe('reporting shows what the member earned', () => {
    test('analytics and the promoter list use the actual credit, $0 at the cap included, and the staged amount otherwise', async () => {
      const member = await customer(HOME);
      const near = await planFriend({ latitude: HOME.latitude + 0.005, longitude: HOME.longitude });
      const nearVisit = await recurringVisit(near.id, { status: 'completed' });
      await invoice(near.id, { status: 'paid', fields: { scheduled_service_id: nearVisit.id } });
      const nearRef = await referral(member, near, { ageDays: 1 });
      await convert(nearRef, near);
      await firstService(near, nearVisit);
      // Converted, still waiting on its first payment: the staged $25 counts.
      const waiting = await planFriend();
      await recurringVisit(waiting.id, { status: 'completed' });
      await convert(await referral(member, waiting, { ageDays: 1 }), waiting);
      // A capped one: $0.
      const promoterId = (await row(nearRef.id)).promoter_id;
      await db('referrals').insert({
        referrer_customer_id: member.id, referee_name: 'Capped', referee_phone: '+19415559999', referral_code: 'WAVES-CAP',
        status: 'credited', referrer_reward_status: 'earned', referrer_reward_amount: 25, referrer_credit_cents: 0,
        promoter_id: promoterId, first_service_completed: true,
      });

      const analytics = await engine.getProgramAnalytics(new Date(Date.now() - 7 * DAY), new Date(Date.now() + DAY));
      expect(analytics.financial.totalRewardsDollars).toBe(75); // 50 near + 25 staged + 0 capped
      const stats = await engine.getPromoterStats(promoterId);
      expect(stats.referrals.map((r) => r.rewardAmount).sort((x, y) => x - y)).toEqual([0, 25, 50]);
    });
  });

  describe('settings', () => {
    test('the four Step 2 numbers are saved and validated', async () => {
      await engine.updateSettings({ step2_annual_credit_cap: 12, step2_near_radius_miles: '0.75', step2_referrer_reward_cents: 3000 });
      expect(await db('referral_program_settings').where({ id: 1 }).first()).toMatchObject({
        step2_annual_credit_cap: 12, step2_near_radius_miles: '0.75', step2_referrer_reward_cents: 3000,
      });
      await expect(engine.updateSettings({ step2_near_radius_miles: -1 })).rejects.toMatchObject({ code: 'INVALID_SETTING' });
      await expect(engine.updateSettings({ step2_annual_credit_cap: 1.5 })).rejects.toMatchObject({ code: 'INVALID_SETTING' });
      await engine.updateSettings({ step2_annual_credit_cap: 10, step2_near_radius_miles: 0.5, step2_referrer_reward_cents: 2500 });
    });
  });

  describe('the gate off is today', () => {
    test('conversion and first service pay the flat $25 and $25 with no Step 2 column written, near or not, cap or not', async () => {
      gates.referralStep2 = false;
      const member = await customer(HOME);
      const friend = await planFriend({ latitude: HOME.latitude + 0.005, longitude: HOME.longitude }); // near, but the gate is off
      const visit = await recurringVisit(friend.id);
      const ref = await referral(member, friend, { ageDays: 2 });
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: member.id, referee_name: `Prior ${i}`, referee_phone: `+1941558${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      await convert(ref, friend);
      expect(await amounts(friend.id)).toEqual([]);

      expect(await firstService(friend, visit)).toEqual({ referralId: ref.id, referrerDollars: 25, refereeDollars: 25 });
      expect(await amounts(friend.id)).toEqual([25]);
      expect(await db('customer_credit_ledger').where({ customer_id: member.id }).count('* as n').first()).toEqual({ n: '11' });
      expect(await row(ref.id)).toMatchObject({
        status: 'credited', referee_credited: true, referrer_credited: true,
        referrer_credit_cents: null, referrer_reward_reason: null,
      });
    });
  });
});
