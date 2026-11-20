// Runs with the existing CI PostgreSQL pass; never a production connection.
// Referral Step 2, member side (GATE_REFERRAL_STEP2) against real Postgres and the real credit ledger: the member's
// $25 / $50-near credit at the friend's first performed recurring service, the 10-a-year cap, the promoter's total
// earned, and the gate-off path that must stay exactly as it was. A private schema keeps CI's migrated tables
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

  const convert = (ref, friend) => engine.convertReferral(ref.id, { customerId: friend.id, tier: 'Silver', monthlyValue: 119.1 });
  const firstService = (friend, visit) => engine.creditReferralOnFirstService({ customerId: friend.id, serviceId: visit.id });
  const credits = (customerId) => db('customer_credit_ledger').where({ customer_id: customerId }).orderBy('created_at').select('*');
  const amounts = async (customerId) => (await credits(customerId)).map((c) => Number(c.delta));
  const row = (id) => db('referrals').where({ id }).first();

  // 0.005 degree of latitude is about 0.35 mile; 0.01 is about 0.69 mile.
  const HOME = { latitude: 27.499, longitude: -82.57 };

  // A performed first plan visit, the referral converted.
  async function performed({ memberFields = {}, friendFields = {} } = {}) {
    const member = await customer(memberFields);
    const friend = await planFriend(friendFields);
    const visit = await recurringVisit(friend.id, { status: 'completed' });
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
      t.string('address_line1');
      t.string('address_line2');
      t.string('city');
      t.string('state');
      t.string('zip');
      t.uuid('account_id');
      t.boolean('active').defaultTo(true);
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
    await s.createTable('customer_geocode_reviews', (t) => {
      t.uuid('customer_id').primary();
      t.jsonb('address_snapshot').notNullable();
      t.string('status').notNullable();
      t.string('reason').notNullable();
      t.string('source');
      t.text('evidence');
      t.uuid('reviewed_by');
      t.timestamp('reviewed_at', { useTz: true });
      t.decimal('latitude', 10, 7);
      t.decimal('longitude', 10, 7);
      t.timestamp('updated_at', { useTz: true }).defaultTo(db.fn.now());
    });
    await s.createTable('customer_properties', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable();
      t.boolean('is_primary').notNullable().defaultTo(false);
      t.boolean('active').notNullable().defaultTo(true);
      t.string('address_line1');
      t.string('address_line2');
      t.string('city');
      t.string('state');
      t.string('zip');
      t.decimal('latitude', 10, 7);
      t.decimal('longitude', 10, 7);
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
    for (const table of [
      'customer_geocode_reviews', 'customer_properties', 'referral_clicks', 'referral_payouts', 'customer_credit_ledger', 'service_records', 'scheduled_services']) {
      await db(table).del();
    }
    await db('referral_program_settings').where({ id: 1 }).update({
      require_service_completion: true, referee_discount_cents: 2500, step2_annual_credit_cap: 10, step2_near_radius_miles: 0.5,
      step2_referrer_reward_cents: 2500, step2_near_referrer_reward_cents: 5000,
    });
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

    test("the promoter's total earned follows the real credit: $50 near, $0 at the cap", async () => {
      const near = await performed({ memberFields: HOME, friendFields: { latitude: HOME.latitude + 0.005, longitude: HOME.longitude } });
      const staged = await db('referral_promoters').where({ id: near.ref.promoter_id }).first();
      expect(staged).toMatchObject({ total_earned_cents: 2500, pending_earnings_cents: 2500 });
      await firstService(near.friend, near.visit);
      expect(await db('referral_promoters').where({ id: near.ref.promoter_id }).first())
        .toMatchObject({ total_earned_cents: 5000, pending_earnings_cents: 0 });

      // At the cap: the staged $25 comes back out of total earned.
      const capped = await performed({ memberFields: HOME });
      await db('customer_credit_ledger').del();
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: capped.member.id, referee_name: `Prior ${i}`, referee_phone: `+1941559${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: capped.member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      await firstService(capped.friend, capped.visit);
      expect(await row(capped.ref.id)).toMatchObject({ referrer_reward_reason: 'cap_reached' });
      expect(await db('referral_promoters').where({ id: capped.ref.promoter_id }).first())
        .toMatchObject({ total_earned_cents: 0, pending_earnings_cents: 0 });
    });

    test('two placeholder (0, 0) pins are no map point: $25, never the near $50', async () => {
      const both = await performed({ memberFields: { latitude: 0, longitude: 0 }, friendFields: { latitude: 0, longitude: 0 } });
      await firstService(both.friend, both.visit);
      expect(await amounts(both.member.id)).toEqual([25]);
      expect(await row(both.ref.id)).toMatchObject({ referrer_reward_reason: 'standard' });
      // One zero coordinate is a placeholder too.
      const half = await performed({ memberFields: { latitude: 27.499, longitude: 0 }, friendFields: { latitude: 27.499, longitude: 0 } });
      await firstService(half.friend, half.visit);
      expect(await amounts(half.member.id)).toEqual([25]);
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

  describe('the cap year comes from the database transaction clock, not the application clock', () => {
    test('credits stamped this year still count when the application clock reads the end of last year', async () => {
      const { member, friend, visit, ref } = await performed();
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: member.id, referee_name: `Prior ${i}`, referee_phone: `+1941560${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      // Only Date is faked (11:59 PM ET, Dec 31 of last year); the ledger's own stamp is the database's now().
      const { etParts } = require('../utils/datetime-et');
      const year = etParts(new Date()).year;
      jest.useFakeTimers({
        now: new Date(`${year}-01-01T04:59:00Z`), // 11:59 PM ET on Dec 31 of the previous year
        doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'],
      });
      try {
        expect(await firstService(friend, visit)).toMatchObject({ referrerReason: 'cap_reached', referrerDollars: 0 });
      } finally {
        jest.useRealTimers();
      }
      expect(await row(ref.id)).toMatchObject({ referrer_reward_reason: 'cap_reached', referrer_credit_cents: 0 });
      expect(await db('customer_credit_ledger').where({ customer_id: member.id }).count('* as n').first()).toEqual({ n: '10' });
    });
  });

  describe('the member offer the portal route returns under the gate', () => {
    test('amounts, near radius, yearly limit and where the member stands', async () => {
      const member = await customer();
      expect(await engine.step2OfferFor(db, member.id, await engine.getSettings())).toEqual({
        rewardPerReferral: 25, nearReward: 50, nearRadiusMiles: 0.5, annualCap: 10, creditsThisYear: 0, capReached: false,
      });
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: member.id, referee_name: `Prior ${i}`, referee_phone: `+1941561${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      expect(await engine.step2OfferFor(db, member.id, await engine.getSettings())).toMatchObject({ creditsThisYear: 10, capReached: true });
    });
  });

  describe('the Step 2 money path fails closed', () => {
    test('a settings row that cannot be read leaves the referral pending, with nothing credited and no guard consumed', async () => {
      const { member, friend, visit, ref } = await performed();
      const saved = await db('referral_program_settings').where({ id: 1 }).first();
      await db('referral_program_settings').del();
      await expect(firstService(friend, visit)).rejects.toMatchObject({ code: 'SETTINGS_UNAVAILABLE' });
      expect(await credits(member.id)).toHaveLength(0);
      expect(await credits(friend.id)).toHaveLength(0);
      expect(await row(ref.id)).toMatchObject({ status: 'signed_up', first_service_completed: false, referrer_reward_status: 'pending_service' });
      await db('referral_program_settings').insert(saved);
      // The next completion settles it.
      expect(await firstService(friend, visit)).toMatchObject({ referrerDollars: 25, refereeDollars: 25 });
    });

    test('the cap and amounts come from the live row read in the transaction', async () => {
      await db('referral_program_settings').where({ id: 1 }).update({ step2_annual_credit_cap: 5, referee_discount_cents: 3000 });
      const member = await customer();
      const friend = await planFriend();
      const visit = await recurringVisit(friend.id, { status: 'completed' });
      for (let i = 0; i < 5; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: member.id, referee_name: `Prior ${i}`, referee_phone: `+1941562${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      const ref = await referral(member, friend, { ageDays: 1 });
      await convert(ref, friend);
      expect(await firstService(friend, visit)).toMatchObject({ referrerReason: 'cap_reached', referrerDollars: 0, refereeDollars: 30 });
    });
  });

  describe('homes are read through the geocode review', () => {
    const ADDRESS = { address_line1: '1 Test St', city: 'Bradenton', state: 'FL', zip: '34202' };
    const snapshot = (c) => JSON.stringify([c.address_line1 ?? null, c.address_line2 ?? null, c.city ?? null, c.state ?? null, c.zip ?? null]);
    const NEAR = { latitude: HOME.latitude + 0.005, longitude: HOME.longitude };
    const OLD = process.env.GATE_GEOCODE_REVIEW;
    beforeEach(() => { process.env.GATE_GEOCODE_REVIEW = 'true'; });
    afterEach(() => {
      if (OLD === undefined) delete process.env.GATE_GEOCODE_REVIEW; else process.env.GATE_GEOCODE_REVIEW = OLD;
    });

    test('a pin the office marked needs_pin or outside_area is no map point: $25, not the near $50', async () => {
      for (const status of ['needs_pin', 'outside_area']) {
        const ctx = await performed({ memberFields: { ...HOME, ...ADDRESS }, friendFields: { ...NEAR, ...ADDRESS, address_line1: '2 Test St' } });
        await db('customer_geocode_reviews').insert({
          customer_id: ctx.friend.id, address_snapshot: snapshot({ ...ADDRESS, address_line1: '2 Test St' }), status, reason: 'fixture',
        });
        await firstService(ctx.friend, ctx.visit);
        expect(await amounts(ctx.member.id)).toEqual([25]);
        expect(await row(ctx.ref.id)).toMatchObject({ referrer_reward_reason: 'standard' });
      }
    });

    test('a valid primary-property pin counts when the customer row has none: $50', async () => {
      const ctx = await performed({ memberFields: { ...HOME, ...ADDRESS }, friendFields: { ...ADDRESS, address_line1: '3 Test St' } });
      await db('customer_properties').insert({ customer_id: ctx.friend.id, is_primary: true, active: true, ...ADDRESS, address_line1: '3 Test St', ...NEAR });
      await firstService(ctx.friend, ctx.visit);
      expect(await amounts(ctx.member.id)).toEqual([50]);
      expect(await row(ctx.ref.id)).toMatchObject({ referrer_reward_reason: 'near' });
    });

    test('an ordinary pin with no review row is still a pin', async () => {
      const ctx = await performed({ memberFields: { ...HOME, ...ADDRESS }, friendFields: { ...NEAR, ...ADDRESS, address_line1: '4 Test St' } });
      await firstService(ctx.friend, ctx.visit);
      expect(await amounts(ctx.member.id)).toEqual([50]);
    });
  });

  describe('what staff are told, and the reward email at the limit', () => {
    test('the terms come from the live row and the member\'s standing', async () => {
      await db('referral_program_settings').where({ id: 1 }).update({
        referee_discount_cents: 2000, step2_referrer_reward_cents: 3000, step2_near_referrer_reward_cents: 6000, step2_near_radius_miles: 1,
      });
      const member = await customer();
      expect(await engine.step2TermsFor(db, member.id)).toMatchObject({ atCap: false, text: 'Member: $30, or $60 within 1 mile; friend: $20 credit' });
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: member.id, referee_name: `Prior ${i}`, referee_phone: `+1941563${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      expect(await engine.step2TermsFor(db, member.id)).toMatchObject({ atCap: true, text: 'Member is at the yearly limit: $0; friend: $20 credit' });
    });

    test('a $0 member credit leaves nothing for the thank-you email; a posted credit is a candidate', async () => {
      const normal = await performed();
      await firstService(normal.friend, normal.visit);
      expect(await engine.sendDueReferralRewardEmails({ now: new Date() })).toEqual({ credits: 1, immediate: 0, attempted: 0 });

      await db('customer_credit_ledger').del();
      const capped = await performed();
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: capped.member.id, referee_name: `Prior ${i}`, referee_phone: `+1941564${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: capped.member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      await firstService(capped.friend, capped.visit);
      expect(await row(capped.ref.id)).toMatchObject({ referrer_reward_reason: 'cap_reached', status: 'credited' });
      expect(await engine.sendDueReferralRewardEmails({ now: new Date() })).toEqual({ credits: 0, immediate: 0, attempted: 0 });
    });
  });

  describe('referral cost in finance views', () => {
    test('a settled Step 2 referral costs what was recorded, whatever the gate says now; every other referral the flat settings', async () => {
      const near = await performed({ memberFields: HOME, friendFields: { latitude: HOME.latitude + 0.005, longitude: HOME.longitude } });
      await firstService(near.friend, near.visit);
      const capped = await performed();
      for (let i = 0; i < 10; i += 1) {
        const [prior] = await db('referrals').insert({
          referrer_customer_id: capped.member.id, referee_name: `Prior ${i}`, referee_phone: `+1941565${String(1000 + i)}`,
          referral_code: 'WAVES-PRIOR', status: 'credited',
        }).returning('id');
        await db('customer_credit_ledger').insert({
          customer_id: capped.member.id, delta: 25, balance_after: 25 * (i + 1), source: 'referral', referral_id: prior.id,
        });
      }
      await firstService(capped.friend, capped.visit);
      const legacy = await planFriend();
      const ids = [near.friend.id, capped.friend.id, legacy.id];
      // near: $50 member + $25 friend; capped: $0 + $25; legacy: the flat $40.
      expect(await engine.referralAcquisitionCost(db, ids, 40)).toBe(140);
      // After the gate is turned off the recorded amounts still stand; a customer with no Step 2 settlement is flat.
      gates.referralStep2 = false;
      expect(await engine.referralAcquisitionCost(db, ids, 40)).toBe(140);
      expect(await engine.referralAcquisitionCost(db, [legacy.id], 40)).toBe(40);
      expect(await engine.referralAcquisitionCost(db, [], 40)).toBe(0);
    });

    test('a formatted friend phone and a household sharing it cannot misattribute the cost (no phone matching)', async () => {
      const ctx = await performed({ memberFields: HOME, friendFields: { phone: '(941) 555-0199', latitude: HOME.latitude + 0.005, longitude: HOME.longitude } });
      await db('referrals').where({ id: ctx.ref.id }).update({ referee_phone: '+19415550199' });
      await firstService(ctx.friend, ctx.visit);
      expect(await amounts(ctx.friend.id)).toEqual([25]);
      // Another profile on the same phone, never credited: flat.
      const sibling = await customer({ phone: '941-555-0199', waveguard_tier: 'Silver', monthly_rate: 119.1 });
      expect(await engine.referralAcquisitionCost(db, [ctx.friend.id], 40)).toBe(75);
      expect(await engine.referralAcquisitionCost(db, [sibling.id], 40)).toBe(40);
      expect(await engine.referralAcquisitionCost(db, [ctx.friend.id, sibling.id], 40)).toBe(115);
    });
  });

  describe('the rule preview never rejects a list', () => {
    test('a failed read leaves the terms unknown (null); a good read names the member it was computed for', async () => {
      const inbound = require('../services/referral-inbound');
      const member = await customer();
      const spy = jest.spyOn(engine, 'step2TermsFor').mockRejectedValueOnce(new Error('read failed'));
      expect(await inbound.previewTerms(db, member.id)).toBeNull();
      spy.mockRestore();
      expect(await inbound.previewTerms(db, member.id)).toMatchObject({
        atCap: false, forCustomerId: String(member.id), conditional: 'Member: $25, or $50 within half a mile, unless at the yearly limit; friend: $25 credit',
      });
      expect(await inbound.previewTerms(db, null)).toMatchObject({ forCustomerId: null });
    });
  });

  describe('Step 2 governs even when the program pays at once', () => {
    test('require_service_completion off + gate on: conversion defers and the member gets the Step 2 amount', async () => {
      await db('referral_program_settings').where({ id: 1 }).update({ require_service_completion: false });
      const member = await customer(HOME);
      const friend = await planFriend({ latitude: HOME.latitude + 0.005, longitude: HOME.longitude });
      const visit = await recurringVisit(friend.id, { status: 'completed' });
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
      // Total earned keeps the staged amount, exactly as today.
      expect(await db('referral_promoters').where({ id: ref.promoter_id }).first()).toMatchObject({ total_earned_cents: 2500, pending_earnings_cents: 0 });
    });
  });
});
