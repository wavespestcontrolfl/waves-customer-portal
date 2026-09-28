/**
 * Real PostgreSQL: mintRenewalSuccessor's DB-level idempotency anchor —
 * the successor-exists recheck under the row lock, AND the UNIQUE
 * constraint on annual_prepay_terms.renewed_from_term_id
 * (20260924030001_termite_annual_plan_stamps.js) that backs it even if the
 * app-level recheck were ever bypassed. InvoiceService.create and
 * AnnualPrepayRenewals.createTermForAnnualPrepay are mocked to perform
 * real inserts against the scratch schema (so the UNIQUE constraint is
 * live SQL, not a mock); the per-customer advisory lock
 * (lockAndAssertNoAnnualPrepayOverlap) is mocked to a no-op — its own
 * behavior is covered by admin-customers.js's suites.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-renewal-mint-postgres.test.js
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
  const schema = `termite_mint_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    prepay_invoice_id uuid,
    plan_label text,
    monthly_rate numeric(10,2),
    prepay_amount numeric(10,2),
    coverage_service_type text,
    coverage_visit_count integer,
    coverage_cadence text,
    annual_plan_version text,
    status text NOT NULL,
    renewal_decision text,
    renewed_from_term_id uuid,
    notice_45_sent_at timestamptz,
    renewal_noticed_fee numeric(10,2),
    installation_anchored_at timestamptz,
    term_start date NOT NULL,
    term_end date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // The real DB-level idempotency anchor under test.
  await db.schema.alterTable('annual_prepay_terms', (t) => {
    t.unique(['renewed_from_term_id'], 'annual_prepay_terms_renewed_from_term_unique');
  });
  // The mint re-checks the scan's own "renewal due" predicate against the
  // locked parent (Codex #4971 pre-push P0) — it reads the customer's
  // liveness too.
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY, deleted_at timestamptz)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    status text,
    total numeric(10,2),
    tax_amount numeric(10,2) DEFAULT 0,
    -- The renewal invoice's link to its term, written by the mint (Codex
    -- #4971 r5 P1: the invoice send's Bill-To fence keys on it).
    annual_prepay_term_id uuid
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

// The renewal day itself: the parent's term_end (2026-09-26) has just been
// reached — pinned so the fixture never ages out of the renewal window.
const TODAY = '2026-09-27';

describeOrSkip('mintRenewalSuccessor — DB-level idempotency anchor, real Postgres', () => {
  let fixture;
  let notifyAdmin;
  let db;
  let parentId;
  let customerId;

  beforeEach(async () => {
    jest.resetModules();
    fixture = await createScratchDb();
    db = fixture.db;
    customerId = randomUUID();
    parentId = randomUUID();
    await db('annual_prepay_terms').insert({
      id: parentId,
      customer_id: customerId,
      annual_plan_version: 'v3',
      status: 'active',
      prepay_amount: 249,
      term_start: '2025-09-27',
      term_end: '2026-09-26',
      notice_45_sent_at: new Date('2026-08-12T14:00:00Z'),
      // r23/r24: the fee that notice quoted, frozen with its witness.
      renewal_noticed_fee: 249,
      installation_anchored_at: new Date('2025-09-27T14:00:00Z'),
    });
    await db('customers').insert({ id: customerId });

    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    // The mint's fee guards ring a staff bell (Codex #4971 r23/r24) — kept
    // hermetic here: the real notification service would open its own pool
    // on the ambient database and keep Jest from exiting.
    notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../routes/admin-customers', () => ({
      _private: { lockAndAssertNoAnnualPrepayOverlap: jest.fn(async () => undefined) },
    }));
    jest.doMock('../services/invoice', () => ({
      create: jest.fn(async ({ database, customerId: custId, lineItems }) => {
        const [row] = await database('invoices').insert({
          customer_id: custId, status: 'draft', total: lineItems[0].unit_price, tax_amount: 0,
        }).returning('*');
        return row;
      }),
    }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      TERMITE_RENEWAL_GRACE_DAYS: 30,
      // mintRenewalSuccessor takes the parent-decision gate first (Codex
      // #4971 r16); the lock itself is covered by the parent-decision-lock
      // Postgres suite, so it passes straight through here.
      withParentDecisionLock: jest.fn(async (_termId, fn) => fn()),
      createTermForAnnualPrepay: jest.fn(async ({ conn, customerId: custId, prepayInvoiceId, prepayAmount, termStart, termEnd, renewedFromTermId, annualPlanVersion }) => {
        const [row] = await conn('annual_prepay_terms').insert({
          customer_id: custId,
          prepay_invoice_id: prepayInvoiceId,
          prepay_amount: prepayAmount,
          term_start: termStart,
          term_end: termEnd,
          renewed_from_term_id: renewedFromTermId,
          annual_plan_version: annualPlanVersion,
          status: 'payment_pending',
        }).returning('*');
        return row;
      }),
    }));
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('mints exactly one successor', async () => {
    const { _private } = require('../services/termite-annual-renewal-charge');
    const result = await _private.mintRenewalSuccessor(parentId, db, TODAY);
    expect(result.minted).toBe(true);
    const successors = await db('annual_prepay_terms').where({ renewed_from_term_id: parentId });
    expect(successors.length).toBe(1);
    // Codex #4971 r5 P1: the renewal invoice carries its term link (the
    // invoice send's Bill-To fence keys on it).
    expect((await db('invoices').where({ id: successors[0].prepay_invoice_id }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(successors[0].id);
  });

  test('the successor-exists recheck: a second call for the SAME parent returns the existing row, minted:false, and creates nothing new', async () => {
    const { _private } = require('../services/termite-annual-renewal-charge');
    const first = await _private.mintRenewalSuccessor(parentId, db, TODAY);
    expect(first.minted).toBe(true);

    const second = await _private.mintRenewalSuccessor(parentId, db, TODAY);
    expect(second.minted).toBe(false);
    expect(second.successor.id).toBe(first.successor.id);

    const successors = await db('annual_prepay_terms').where({ renewed_from_term_id: parentId });
    expect(successors.length).toBe(1);
    const invoices = await db('invoices');
    expect(invoices.length).toBe(1);
  });

  // Codex #4971 pre-push P0: staff extended the parent's term_end after the
  // candidate scan selected it. The mint re-runs the scan's own predicate
  // against the LOCKED parent and mints nothing — no invoice, no successor
  // with the new, future dates charged today.
  test('a parent no longer due under the mint lock (term_end extended) mints nothing', async () => {
    await db('annual_prepay_terms').where({ id: parentId }).update({ term_end: '2027-09-26' });
    const { _private } = require('../services/termite-annual-renewal-charge');
    await expect(_private.mintRenewalSuccessor(parentId, db, TODAY)).resolves.toBeNull();
    expect(await db('annual_prepay_terms').where({ renewed_from_term_id: parentId })).toHaveLength(0);
    expect(await db('invoices')).toHaveLength(0);
  });

  // Codex #4971 r23 P1: the 45-day notice's quoted fee is frozen on the
  // parent (renewal_noticed_fee). Staff changed the fee afterwards: nothing
  // is minted or charged at a fee the customer was never told.
  test('a parent whose fee changed after the renewal notice mints nothing; a matching noticed fee mints', async () => {
    const { _private } = require('../services/termite-annual-renewal-charge');
    await db('annual_prepay_terms').where({ id: parentId }).update({ renewal_noticed_fee: 199, prepay_amount: 249 });
    await expect(_private.mintRenewalSuccessor(parentId, db, TODAY)).resolves.toBeNull();
    expect(await db('annual_prepay_terms').where({ renewed_from_term_id: parentId })).toHaveLength(0);
    expect(await db('invoices')).toHaveLength(0);
    expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/fee changed after the renewal notice/i), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-renewal-charge:${parentId}:fee_changed_after_notice` }));

    await db('annual_prepay_terms').where({ id: parentId }).update({ renewal_noticed_fee: 249 });
    const result = await _private.mintRenewalSuccessor(parentId, db, TODAY);
    expect(result.minted).toBe(true);
    expect(await db('invoices')).toHaveLength(1);
  });

  // Codex #4971 r24 P1: a witnessed notice whose quoted fee was never frozen
  // (noticed before the column existed) fails closed — nothing minted.
  test('a witnessed notice with NO frozen fee on record mints nothing', async () => {
    await db('annual_prepay_terms').where({ id: parentId }).update({ renewal_noticed_fee: null });
    const { _private } = require('../services/termite-annual-renewal-charge');
    await expect(_private.mintRenewalSuccessor(parentId, db, TODAY)).resolves.toBeNull();
    expect(await db('annual_prepay_terms').where({ renewed_from_term_id: parentId })).toHaveLength(0);
    expect(await db('invoices')).toHaveLength(0);
    expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/noticed fee not on record/i), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-renewal-charge:${parentId}:notice_fee_unfrozen` }));
  });

  test('a parent whose on-time 45-day notice witness is gone mints nothing', async () => {
    await db('annual_prepay_terms').where({ id: parentId }).update({ notice_45_sent_at: null });
    const { _private } = require('../services/termite-annual-renewal-charge');
    await expect(_private.mintRenewalSuccessor(parentId, db, TODAY)).resolves.toBeNull();
    expect(await db('invoices')).toHaveLength(0);
  });

  test('UNIQUE renewed_from_term_id: even bypassing the app-level recheck, Postgres itself refuses a second successor for the same parent', async () => {
    await db('annual_prepay_terms').insert({
      customer_id: customerId, status: 'payment_pending', renewed_from_term_id: parentId, term_start: '2026-09-27', term_end: '2027-09-27',
    });
    await expect(
      db('annual_prepay_terms').insert({
        customer_id: customerId, status: 'payment_pending', renewed_from_term_id: parentId, term_start: '2026-09-28', term_end: '2027-09-28',
      }),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
