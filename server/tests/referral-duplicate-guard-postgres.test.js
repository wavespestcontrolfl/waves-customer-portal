// Runs with the existing CI PostgreSQL pass; never a production connection.
// Overlapping referral submits and "text a friend" invites against real
// Postgres (referrals audit 10-29, F6). Both paths read for a duplicate before
// they write, so two requests in flight together could both pass the read:
// two referral rows, two leads and two invite texts for one friend. The
// promoter row lock (submitReferral) and the advisory-locked receipt
// reservation (POST /api/referrals/invite) make check + write one step.
// A private schema keeps CI's migrated tables untouched.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockSchema = `referral_dupes_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 8 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
let mockCustomerId = null;
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.customerId = mockCustomerId; next(); },
}));
// Every text the code tries lands here. The delay holds each send open so
// overlapping requests are really in flight together.
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => {
  const actual = jest.requireActual('../services/messaging/send-customer-message');
  return {
    sendCustomerMessage: (...a) => mockSend(...a),
    classifyDeliveryCertainty: actual.classifyDeliveryCertainty,
  };
});
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'invite text') }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn(), redactEmailAddresses: (s) => s }));

(SKIP ? describe.skip : describe)('referral duplicate guards (live Postgres)', () => {
  let db;
  let engine;
  let server;
  let base;
  let promoter;

  const sent = (delayMs = 150) => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { sent: true, deliveryOutcome: 'accepted' };
  };

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
    });
    await s().createTable('referral_promoters', (t) => {
      t.increments('id');
      t.string('customer_phone').notNullable().unique();
      t.string('customer_email');
      t.string('first_name').notNullable();
      t.string('last_name').notNullable();
      t.uuid('customer_id');
      t.string('referral_code').unique();
      t.integer('total_referrals_sent').defaultTo(0);
      t.timestamp('last_referral_at', { useTz: true });
      t.timestamp('last_share_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true });
    });
    await s().createTable('referrals', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      // Prod's FK: the insert takes a key-share lock on the referrer's customer row.
      t.uuid('referrer_customer_id').notNullable().references('id').inTable('customers');
      t.string('referee_name', 100).notNullable();
      t.string('referee_phone', 20).notNullable();
      t.string('referee_email', 150);
      t.string('referral_code', 20).notNullable();
      t.text('status').defaultTo('pending');
      t.timestamps(true, true);
      t.integer('promoter_id');
      t.uuid('lead_id');
      t.string('source', 30).defaultTo('portal');
      t.decimal('referrer_reward_amount', 10, 2);
      t.string('referrer_reward_status', 20).defaultTo('pending');
    });
    await s().createTable('leads', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      for (const col of ['first_name', 'last_name', 'phone', 'email', 'address', 'lead_type', 'service_interest', 'first_contact_channel', 'status']) t.string(col);
      t.timestamp('first_contact_at', { useTz: true });
    });
    await s().createTable('lead_activities', (t) => {
      t.increments('id');
      t.uuid('lead_id');
      t.string('activity_type');
      t.text('description');
      t.string('performed_by');
    });
    // Prod shape after 20260618000003 + 20260708000001.
    await s().createTable('referral_invites', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.integer('promoter_id').notNullable();
      t.string('phone', 32);
      t.string('email', 254);
      t.timestamp('sent_at').notNullable().defaultTo(db.fn.now());
    });
    await s().createTable('referral_program_settings', (t) => {
      t.integer('id').primary();
      t.boolean('program_active');
      t.string('base_url', 500);
      t.integer('referrer_reward_cents');
      t.integer('referee_discount_cents');
      t.integer('max_referrals_per_month');
      t.text('invite_sms_template');
    });

    engine = require('../services/referral-engine');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/referrals', require('../routes/referrals-v2'));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    mockSend.mockReset();
    for (const table of ['referral_invites', 'lead_activities', 'leads', 'referrals', 'referral_promoters', 'customers', 'referral_program_settings']) {
      await db(table).del();
    }
    await db('referral_program_settings').insert({
      id: 1, program_active: true, base_url: 'https://portal.example.test/r/',
      referrer_reward_cents: 2500, referee_discount_cents: 2500, max_referrals_per_month: 20,
    });
    const [customer] = await db('customers').insert({
      first_name: 'Fixture', last_name: 'Promoter', phone: '+12025550999', email: 'fixture-promoter@example.test',
    }).returning('*');
    mockCustomerId = customer.id;
    [promoter] = await db('referral_promoters').insert({
      customer_id: customer.id, first_name: 'Fixture', last_name: 'Promoter',
      customer_phone: '+12025550999', referral_code: `T${Math.floor(Math.random() * 1e8)}`,
    }).returning('*');
    jest.spyOn(engine, 'resolvePromoter').mockImplementation(async () => ({ promoter }));
  });

  const submit = (phone, name = 'Friend Fixture') => engine.submitReferral(promoter.id, { name, phone, source: 'admin' });
  const invite = (phone = '+19415550123') => fetch(`${base}/api/referrals/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, friendName: 'Jo' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const count = async (table) => Number((await db(table).count('* as c').first()).c);

  describe('submitReferral', () => {
    test('overlapping submits for one phone write one referral, one lead and one text', async () => {
      mockSend.mockImplementation(sent());
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => submit('+19415550123')));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect(r.reason.message).toBe('You have already referred this phone number');
      }
      expect(await count('referrals')).toBe(1);
      expect(await count('leads')).toBe(1);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect((await db('referral_promoters').where({ id: promoter.id }).first()).total_referrals_sent).toBe(1);
    });

    test('overlapping submits never pass the monthly cap', async () => {
      await db('referral_program_settings').where({ id: 1 }).update({ max_referrals_per_month: 2 });
      mockSend.mockImplementation(sent());
      const phones = ['+19415550101', '+19415550102', '+19415550103', '+19415550104', '+19415550105'];
      const results = await Promise.allSettled(phones.map((p) => submit(p)));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect(r.reason.message).toBe('Monthly referral limit reached (2)');
      }
      expect(await count('referrals')).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    test('a submit and an enroll holding the customer row do not deadlock', async () => {
      mockSend.mockImplementation(sent(0));
      // enrollPromoter's lock order: the customer row, then the promoter row.
      const enroll = await db.transaction();
      try {
        await enroll('customers').where({ id: promoter.customer_id }).forUpdate().first();
        const submitting = submit('+19415550123');
        await new Promise((r) => setTimeout(r, 300));
        // Promoter-first submits held this lock and then waited on the
        // customer row (the referral FK), so Postgres aborted one side.
        await enroll('referral_promoters').where({ customer_id: promoter.customer_id }).forUpdate().first();
        await enroll.commit();
        await expect(submitting).resolves.toMatchObject({ status: 'contacted' });
      } catch (err) {
        if (!enroll.isCompleted()) await enroll.rollback().catch(() => {});
        throw err;
      }
      expect(await count('referrals')).toBe(1);
    });

    test('a refused submit writes nothing and leaves the promoter unlocked', async () => {
      mockSend.mockImplementation(sent(0));
      await expect(submit('+12025550999')).rejects.toThrow('Cannot refer yourself');
      expect(await count('referrals')).toBe(0);
      // The next submit is not stuck behind a lock the refusal left open.
      await expect(submit('+19415550123')).resolves.toMatchObject({ status: 'contacted' });
      expect(await count('referrals')).toBe(1);
    });
  });

  describe('POST /api/referrals/invite', () => {
    test('overlapping taps send one text and store one receipt', async () => {
      mockSend.mockImplementation(sent());
      const results = await Promise.all([invite(), invite(), invite()]);

      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(results.filter((r) => r.body.deduped)).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(await count('referral_invites')).toBe(1);
    });

    test('a definite failure releases the receipt, so a retry sends', async () => {
      mockSend.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', reason: 'Recipient opted out' });
      const first = await invite();
      expect(first.status).toBe(422);
      expect(await count('referral_invites')).toBe(0);

      mockSend.mockImplementation(sent(0));
      const retry = await invite();
      expect(retry).toEqual({ status: 200, body: { success: true } });
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(await count('referral_invites')).toBe(1);
    });

    test('a thrown send that never reached the provider releases the receipt', async () => {
      mockSend.mockImplementationOnce(async () => {
        const err = new Error('template lookup failed');
        err.providerOutcome = { sent: false, deliveryOutcome: 'not_sent' };
        throw err;
      });
      expect((await invite()).status).toBe(500);
      expect(await count('referral_invites')).toBe(0);
    });

    test('an uncertain outcome keeps the receipt, so a retry cannot text twice', async () => {
      mockSend.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain', reason: 'provider timeout' });
      expect((await invite()).status).toBe(422);
      expect(await count('referral_invites')).toBe(1);

      const retry = await invite();
      expect(retry).toEqual({ status: 200, body: { success: true, deduped: true } });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('a different phone is not held by another friend\'s receipt', async () => {
      mockSend.mockImplementation(sent(0));
      await invite('+19415550123');
      const other = await invite('+19415550124');
      expect(other).toEqual({ status: 200, body: { success: true } });
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });
});
