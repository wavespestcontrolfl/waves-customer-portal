/**
 * Real PostgreSQL: the unified campaign cooldown's termite renewal-charge
 * touch (Codex #4971 r4 P2) — campaignCooldownReason counts the renewal
 * charge as customer contact ONLY on durable evidence: the renewal
 * successor's invoice delivery stamps, or a charge attempt with submission
 * evidence, inside the 30-day window. The lane's own bookkeeping columns
 * (renewal_charge_attempted_at / _skipped_at) never count on their own — a
 * fence claim that never reached Stripe, or a skip whose pay link never went
 * out, told the customer nothing — while a pay link a recovery leg delivered
 * long after the attempt DOES count.
 *
 * Scratch schema (only the tables the cooldown reads); '../models/db' is
 * redirected to it. Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/campaign-drafts-gate-renewal-contact-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `campaign_renewal_contact_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE message_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, campaign_type text, created_at timestamptz NOT NULL DEFAULT now())');
  await db.raw('CREATE TABLE sms_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, message_type text, created_at timestamptz NOT NULL DEFAULT now())');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    sent_at timestamptz,
    sms_sent_at timestamptz,
    email_sent_at timestamptz
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    prepay_invoice_id uuid,
    renewed_from_term_id uuid,
    annual_plan_version text,
    notice_30_sent_at timestamptz,
    notice_15_sent_at timestamptz,
    notice_7_sent_at timestamptz,
    notice_45_sent_at timestamptz,
    notice_45_late_sent_at timestamptz,
    notice_30_late_sent_at timestamptz,
    renewal_charge_attempted_at timestamptz,
    renewal_charge_skipped_at timestamptz
  )`);
  await db.raw(`CREATE TABLE stripe_invoice_charge_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'claimed',
    submitted_at timestamptz,
    stripe_payment_intent_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('campaign cooldown — durable termite renewal contact only (real Postgres)', () => {
  let fixture;
  let db;
  let Gate;
  const DAY = 86400000;
  const ago = (days) => new Date(Date.now() - days * DAY);

  beforeEach(async () => {
    jest.resetModules();
    fixture = await createScratchDb();
    db = fixture.db;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    Gate = require('../services/campaign-drafts-gate');
    Gate._resetNoticeColumnCacheForTests();
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  // A renewal successor for a fresh customer, its invoice and (optionally)
  // one charge attempt on it.
  async function renewal({ invoice = {}, attempt = null, term = {} } = {}) {
    const customerId = randomUUID();
    const [inv] = await db('invoices').insert({ status: 'sent', ...invoice }).returning('*');
    await db('annual_prepay_terms').insert({
      customer_id: customerId, prepay_invoice_id: inv.id, renewed_from_term_id: randomUUID(), annual_plan_version: 'v3', ...term,
    });
    if (attempt) await db('stripe_invoice_charge_attempts').insert({ invoice_id: inv.id, ...attempt });
    return customerId;
  }

  test('bookkeeping alone never counts: a claim that never reached Stripe, or a skip whose pay link never went out', async () => {
    const neverReached = await renewal({ term: { renewal_charge_attempted_at: ago(1) }, attempt: { status: 'failed', created_at: ago(1) } });
    const undeliveredSkip = await renewal({ term: { renewal_charge_skipped_at: ago(1) } });
    // Codex #4971 r22 P2: submitted_at is committed BEFORE the Stripe call —
    // alone it proves no contact either (the pre-call crash shape).
    const submittedOnly = await renewal({ attempt: { status: 'failed', submitted_at: ago(5) } });
    expect(await Gate.campaignCooldownReason(neverReached)).toBeNull();
    expect(await Gate.campaignCooldownReason(undeliveredSkip)).toBeNull();
    expect(await Gate.campaignCooldownReason(submittedOnly)).toBeNull();
  });

  test('durable contact counts: a delivered renewal invoice, or a charge that reached Stripe, inside the window', async () => {
    const smsDelivered = await renewal({ invoice: { sms_sent_at: ago(3) } });
    const emailDelivered = await renewal({ invoice: { email_sent_at: ago(3) } });
    const submitted = await renewal({ attempt: { status: 'failed', submitted_at: ago(5), stripe_payment_intent_id: 'pi_processed' } });
    const intentOnly = await renewal({ attempt: { status: 'ambiguous', stripe_payment_intent_id: 'pi_x', created_at: ago(5) } });
    // Attempted long ago, but a recovery leg delivered the pay link this week.
    const lateDelivery = await renewal({ term: { renewal_charge_attempted_at: ago(45) }, invoice: { sent_at: ago(2) } });
    for (const customerId of [smsDelivered, emailDelivered, submitted, intentOnly, lateDelivery]) {
      expect(await Gate.campaignCooldownReason(customerId)).toBe('recent_renewal_charge_contact');
    }
  });

  test('contact outside the 30-day window, or on a term that is not a termite renewal, does not count', async () => {
    const stale = await renewal({ invoice: { sms_sent_at: ago(40) }, attempt: { status: 'failed', submitted_at: ago(40), created_at: ago(40) } });
    const notARenewal = await renewal({ invoice: { sms_sent_at: ago(1) }, term: { renewed_from_term_id: null } });
    const notTermite = await renewal({ invoice: { sms_sent_at: ago(1) }, term: { annual_plan_version: null } });
    expect(await Gate.campaignCooldownReason(stale)).toBeNull();
    expect(await Gate.campaignCooldownReason(notARenewal)).toBeNull();
    expect(await Gate.campaignCooldownReason(notTermite)).toBeNull();
  });
});
