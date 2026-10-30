// Runs with the existing CI PostgreSQL pass; never a production connection.
// Promoter phone identity across stored spellings (referrals audit 10-29, F7).
// referral_promoters.customer_phone is unique as raw text, and stored phones
// mix E.164 and domestic spellings, so one number in two spellings slipped
// past the constraint: a second promoter for one household, and a household
// lookup that missed the first. enrollPromoter now stores the canonical form
// and treats the same number in any spelling as the unique collision;
// findHouseholdPromoter matches by digits inside the same account.
// A private schema keeps CI's migrated tables untouched.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `referral_phone_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 6 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'text') }));

(SKIP ? describe.skip : describe)('promoter phone identity (live Postgres)', () => {
  let db;
  let engine;
  let isPromoterPhoneCollision;

  async function customer(fields = {}) {
    const [row] = await db('customers').insert({
      first_name: 'Fixture', last_name: 'Profile', account_id: randomUUID(), ...fields,
    }).returning('*');
    return row;
  }
  async function promoterFor(c, customerPhone) {
    const [row] = await db('referral_promoters').insert({
      customer_id: c.id, first_name: c.first_name, last_name: c.last_name,
      customer_phone: customerPhone, referral_code: `T${Math.floor(Math.random() * 1e8)}`,
    }).returning('*');
    return row;
  }
  const promoterCount = async () => Number((await db('referral_promoters').count('* as c').first()).c);

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    const s = () => db.schema.withSchema(mockSchema);
    await s().createTable('customers', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('first_name');
      t.string('last_name');
      t.string('phone');
      t.string('email');
      t.uuid('account_id');
      t.string('referral_code', 20).unique();
    });
    // Prod's identity key: raw-text unique customer_phone.
    await s().createTable('referral_promoters', (t) => {
      t.increments('id');
      t.string('customer_phone').notNullable().unique('referral_promoters_customer_phone_unique');
      t.string('customer_email');
      t.string('first_name').notNullable();
      t.string('last_name').notNullable();
      t.uuid('customer_id').references('id').inTable('customers');
      t.string('referral_code').unique();
      t.text('referral_link');
      t.string('campaign');
      t.string('status').defaultTo('active');
      t.timestamp('updated_at', { useTz: true });
    });
    engine = require('../services/referral-engine');
    ({ isPromoterPhoneCollision } = require('../services/referral-errors'));
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    await db('referral_promoters').del();
    await db('customers').del();
  });

  test('a new promoter stores the canonical phone', async () => {
    const c = await customer({ phone: '(941) 555-0100' });
    const { promoter, alreadyEnrolled } = await engine.resolvePromoter(c.id);
    expect(alreadyEnrolled).toBe(false);
    expect(promoter.customer_phone).toBe('+19415550100');
  });

  test('a sibling profile finds the household promoter stored in another spelling', async () => {
    const accountId = randomUUID();
    const owner = await customer({ phone: '+19415550100', account_id: accountId });
    const legacy = await promoterFor(owner, '(941) 555-0100');
    const sibling = await customer({ phone: '+19415550100', account_id: accountId, last_name: 'Sibling' });

    expect((await engine.findHouseholdPromoter(sibling.id)).id).toBe(legacy.id);
    const resolved = await engine.resolvePromoter(sibling.id);
    expect(resolved).toMatchObject({ household: true, alreadyEnrolled: true });
    expect(resolved.promoter.id).toBe(legacy.id);
    expect(await promoterCount()).toBe(1);
  });

  test('another account with the same number in another spelling is a collision, not a second promoter', async () => {
    const owner = await customer({ phone: '+19415550100' });
    await promoterFor(owner, '941-555-0100');
    const stranger = await customer({ phone: '(941) 555-0100' });

    const err = await engine.resolvePromoter(stranger.id).then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(isPromoterPhoneCollision(err)).toBe(true);
    expect(err.message).not.toMatch(/941/);
    expect(await engine.findHouseholdPromoter(stranger.id)).toBeNull();
    expect(await promoterCount()).toBe(1);
    // The refused enroll left no code on the customer.
    expect((await db('customers').where({ id: stranger.id }).first()).referral_code).toBeNull();
  });

  test('two sibling profiles enrolling at once in different spellings make one promoter', async () => {
    const accountId = randomUUID();
    const a = await customer({ phone: '+19415550100', account_id: accountId });
    const b = await customer({ phone: '(941) 555-0100', account_id: accountId, last_name: 'Sibling' });

    const [ra, rb] = await Promise.all([engine.resolvePromoter(a.id), engine.resolvePromoter(b.id)]);
    expect(ra.promoter.id).toBe(rb.promoter.id);
    expect(await promoterCount()).toBe(1);
  });

  test('an unrelated number and an already enrolled profile are unchanged', async () => {
    const c = await customer({ phone: '+19415550111' });
    const first = await engine.resolvePromoter(c.id);
    const again = await engine.resolvePromoter(c.id);
    expect(again).toMatchObject({ alreadyEnrolled: true });
    expect(again.promoter.id).toBe(first.promoter.id);
    const other = await customer({ phone: '+19415550222' });
    expect((await engine.resolvePromoter(other.id)).alreadyEnrolled).toBe(false);
    expect(await promoterCount()).toBe(2);
  });
});
