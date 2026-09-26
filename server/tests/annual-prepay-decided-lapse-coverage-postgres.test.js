/**
 * Real PostgreSQL: isPaidDecidedLapseTerm (annual-prepay-renewals.js) —
 * codex pre-push P1. A decided-lapse termite annual term (status
 * 'cancelled', renewal_decision 'cancel') keeps its "Coverage continues
 * through …" / "Paid through …" display ONLY while coveredTermsAsOf's
 * own paid/not-refunded/not-disputed test still says so — the same test
 * billing (completion invoicing) already runs, so display and billing can
 * never disagree. This suite drives that real query directly, with the
 * customer-facing exclusion for exactly the two events the property.js GET
 * and auth.js /me badge fix are for: a decline followed by a refund, and a
 * decline followed by a disputed invoice.
 *
 * isPaidDecidedLapseTerm/coveredTermsAsOf thread `conn` all the way through
 * (unlike some of this module's other helpers), so this test passes the
 * scratch-schema connection directly — no need to mock '../models/db'.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/annual-prepay-decided-lapse-coverage-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const { isPaidDecidedLapseTerm } = require('../services/annual-prepay-renewals');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `apt_decided_lapse_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    paid_at timestamptz,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    prepay_invoice_id uuid,
    term_start date NOT NULL,
    term_end date NOT NULL,
    status text NOT NULL,
    renewal_decision text
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('isPaidDecidedLapseTerm — a declined-online term stays covered only while billing still covers it (real Postgres)', () => {
  let fixture;
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  const today = () => new Date().toISOString().slice(0, 10);
  const addYear = (ymd) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString().slice(0, 10);
  };

  async function makeDecidedLapseTerm(db, invoiceRow) {
    const customerId = randomUUID();
    const [invoice] = await db('invoices').insert(invoiceRow).returning('*');
    const start = today();
    const [term] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      prepay_invoice_id: invoice.id,
      term_start: start,
      term_end: addYear(start),
      status: 'cancelled',
      renewal_decision: 'cancel',
    }).returning('*');
    return { term, invoice };
  }

  test('a live decided-lapse term (invoice still paid, no refund/dispute) stays covered', async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const { term } = await makeDecidedLapseTerm(db, {
      status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_live',
    });

    expect(await isPaidDecidedLapseTerm(term, db)).toBe(true);
  });

  test('decline then a FULL REFUND (invoice stays paid, but a matching payments row is refunded) drops coverage', async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const { term } = await makeDecidedLapseTerm(db, {
      status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_refunded',
    });
    await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: 'pi_refunded' });

    expect(await isPaidDecidedLapseTerm(term, db)).toBe(false);
  });

  test('decline then a PARTIAL refund (payments row present but not full) still keeps coverage', async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const { term } = await makeDecidedLapseTerm(db, {
      status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_partial',
    });
    await db('payments').insert({ status: 'succeeded', refund_status: 'partial', stripe_payment_intent_id: 'pi_partial' });

    expect(await isPaidDecidedLapseTerm(term, db)).toBe(true);
  });

  test('decline then a DISPUTED invoice (reopened to overdue, paid_at cleared) drops coverage', async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const { term } = await makeDecidedLapseTerm(db, {
      status: 'overdue', paid_at: null, stripe_payment_intent_id: 'pi_disputed',
    });

    expect(await isPaidDecidedLapseTerm(term, db)).toBe(false);
  });

  test('a void/refund cancelled term with NO renewal_decision is never this shape, regardless of invoice state', async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const { term } = await makeDecidedLapseTerm(db, {
      status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_voidcase',
    });
    await db('annual_prepay_terms').where({ id: term.id }).update({ renewal_decision: null });
    const reread = await db('annual_prepay_terms').where({ id: term.id }).first();

    expect(await isPaidDecidedLapseTerm(reread, db)).toBe(false);
  });
});
