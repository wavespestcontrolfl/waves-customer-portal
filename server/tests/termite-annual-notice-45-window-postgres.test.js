/**
 * Real PostgreSQL: the termite 45-day renewal-notice rung's candidate query
 * (annual-prepay-renewals termiteNotice45Candidates) is a CATCH-UP window —
 * every unsent termite annual-plan term renewing 31–45 days out — not an
 * exact day, so a missed cron day or a failed send never loses the notice
 * witness the renewal transition requires.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-notice-45-window-postgres.test.js
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
  const schema = `termite_notice45_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    term_start date NOT NULL,
    term_end date NOT NULL,
    status text NOT NULL,
    renewal_decision text,
    annual_plan_version text,
    notice_45_sent_at timestamptz,
    notice_45_claimed_at timestamptz
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termite 45-day renewal notice — catch-up window (real Postgres)', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => {
    jest.resetModules();
    if (fixture) await fixture.destroy();
  });

  test('selects every unsent termite term renewing 31–45 days out; never 30/46, non-termite, sent, decided, or freshly claimed', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const today = '2026-09-26';
    const plus = (n) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const term = (label, fields) => ({
      label, customer_id: randomUUID(), term_start: '2025-10-01', status: 'active', annual_plan_version: 'v3', ...fields,
    });
    const rows = [
      term('day30', { term_end: plus(30) }),
      term('day31', { term_end: plus(31) }),
      term('day40', { term_end: plus(40) }),
      term('day45', { term_end: plus(45) }),
      term('day46', { term_end: plus(46) }),
      term('nonTermite', { term_end: plus(40), annual_plan_version: null }),
      term('alreadySent', { term_end: plus(40), notice_45_sent_at: new Date() }),
      term('decided', { term_end: plus(40), renewal_decision: 'cancel' }),
      term('cancelled', { term_end: plus(40), status: 'cancelled' }),
      term('freshClaim', { term_end: plus(40), notice_45_claimed_at: new Date() }),
      term('staleClaim', { term_end: plus(41), notice_45_claimed_at: new Date(Date.now() - 60 * 60 * 1000) }),
      term('renewalPending', { term_end: plus(35), status: 'renewal_pending' }),
    ];
    const ids = {};
    for (const { label, ...fields } of rows) {
      const [row] = await db('annual_prepay_terms').insert(fields).returning('id');
      ids[row.id] = label;
    }

    const candidates = await _private.termiteNotice45Candidates({ today, conn: db });
    expect(candidates.map((row) => ids[row.id])).toEqual(['day31', 'renewalPending', 'day40', 'staleClaim', 'day45']);
  });
});
