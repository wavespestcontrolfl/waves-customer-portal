/**
 * Real PostgreSQL: P2-4 (owner ruling 2026-09-26) — an unpaid termite
 * renewal successor stays COVERED through its own 30-day payment grace.
 * Runs coveredTermsAsOf's real SQL (the GREATEST(term_start, created_at)
 * + INTERVAL grace-deadline expression, the invoice-status exclusion) —
 * not mocked — against a scratch schema.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-renewal-grace-coverage-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

// annualPrepayCoversVisit's termiteGraceCoversVisit leg (Codex round-7 P1)
// calls annualPrepayTableExists(), which — unlike every OTHER function
// exercised in this file — always queries the MODULE's own top-level `db`
// (`require('../models/db')`), never the `conn`/`db` argument a caller
// passes in. This process has no real DATABASE_URL configured (only
// REPAIR_TEST_DATABASE_URL, read directly by createScratchDb below), so
// that real connection would fail outright; stub just the one method
// actually called. Every other test in this file passes its OWN scratch
// `db` explicitly to coveredTermsAsOf/annualPrepayCoversVisit and never
// touches this mock.
jest.mock('../models/db', () => ({ schema: { hasTable: jest.fn().mockResolvedValue(true) } }));

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_grace_cov_${randomUUID().replace(/-/g, '')}`;
  // A single persistent connection (pool min=max=1): the evening-boundary
  // test below runs `SET TIME ZONE` and every later query in the same test
  // must land on that SAME session, not a fresh pooled connection.
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 1, max: 1 } });
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
    source_estimate_id uuid,
    prepay_invoice_id uuid,
    status text NOT NULL,
    renewal_decision text,
    renewed_from_term_id uuid,
    annual_plan_version text,
    coverage_service_type text,
    dispute_suspended_at timestamptz,
    prior_billing_mode text,
    term_start date NOT NULL,
    term_end date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // What the real dispute demotion (suspendActiveTermsForDisputedInvoice)
  // writes besides the term: the customer's billing_mode restore.
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY, billing_mode text, updated_at timestamptz)');
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY, customer_id uuid NOT NULL, property_id uuid)');
  await db.raw(`CREATE TABLE scheduled_services (
    id uuid PRIMARY KEY, customer_id uuid NOT NULL, annual_prepay_term_id uuid,
    source_estimate_id uuid, property_id uuid, recurring_parent_id uuid
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

describeOrSkip('coveredTermsAsOf — termite renewal grace coverage (P2-4), real Postgres', () => {
  let fixture;
  let db;
  let customerId;
  let invoiceId;

  beforeEach(async () => {
    fixture = await createScratchDb();
    db = fixture.db;
    // Codex round-1 P1: force the SQL session's own timezone to UTC — the
    // exact condition the finding names ("with UTC sessions") — so this
    // test proves the fix regardless of what timezone the machine running
    // it happens to default to.
    await db.raw("SET TIME ZONE 'UTC'");
    customerId = randomUUID();
    invoiceId = randomUUID();
    await db('invoices').insert({ id: invoiceId, status: 'sent' });
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  // Codex #4971 r28 P1: grace needs a parent that still authorizes the
  // renewal — a successor whose ancestry this helper generates gets one by
  // default (live, undecided, its window ending the day before the
  // successor starts); `parent` overrides its fields, `parent: null`
  // inserts none. A caller passing its own renewed_from_term_id owns that
  // ancestor entirely (the missing / foreign / cyclic cases below).
  const dayBefore = (ymd) => {
    const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  async function insertSuccessor({ termStart, createdAt, termEnd = '2099-01-01', overrides = {}, parent = {} } = {}) {
    const id = randomUUID();
    const explicitAncestor = Object.prototype.hasOwnProperty.call(overrides, 'renewed_from_term_id');
    const parentId = explicitAncestor ? overrides.renewed_from_term_id : randomUUID();
    if (parent && !explicitAncestor) {
      await db('annual_prepay_terms').insert({
        id: parentId,
        customer_id: customerId,
        status: 'active',
        annual_plan_version: 'v3',
        term_start: '2000-01-01',
        term_end: dayBefore(termStart),
        created_at: '2000-01-01T12:00:00Z',
        ...parent,
      });
    }
    await db('annual_prepay_terms').insert({
      id,
      customer_id: customerId,
      prepay_invoice_id: invoiceId,
      status: 'payment_pending',
      renewed_from_term_id: parentId,
      annual_plan_version: 'v3',
      term_start: termStart,
      term_end: termEnd,
      created_at: createdAt,
      ...overrides,
    });
    return id;
  }

  async function insertAncestor({ id = randomUUID(), sourceEstimateId = null, renewedFromTermId = null,
    ownerId = customerId } = {}) {
    await db('annual_prepay_terms').insert({
      id,
      customer_id: ownerId,
      source_estimate_id: sourceEstimateId,
      status: 'active',
      renewed_from_term_id: renewedFromTermId,
      annual_plan_version: 'v3',
      term_start: '2025-09-27',
      term_end: '2026-09-26',
      created_at: '2025-09-27T12:00:00Z',
    });
    return id;
  }

  test('covered on day 0 (term_start itself)', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-09-27').where('t.id', id).first('t.id');
    expect(row).toBeDefined();
  });

  test('covered on day 29', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-26').where('t.id', id).first('t.id');
    expect(row).toBeDefined();
  });

  test('covered exactly on the deadline (day 30)', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-27').where('t.id', id).first('t.id');
    expect(row).toBeDefined();
  });

  test('NOT covered the day after the deadline', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-28').where('t.id', id).first('t.id');
    expect(row).toBeUndefined();
  });

  test('the deadline anchors on the LATER of term_start / created_at — a delayed mint keeps the full window', async () => {
    // Minted 5 days after its nominal term_start.
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-10-02T12:00:00Z' });
    // Day 34 from term_start (= day 29 from created_at) is still covered.
    const stillCovered = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-31').where('t.id', id).first('t.id');
    expect(stillCovered).toBeDefined();
    // Day 32 from created_at is not.
    const lapsed = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-11-03').where('t.id', id).first('t.id');
    expect(lapsed).toBeUndefined();
  });

  test('NOT covered after the invoice actually voids', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const coveredBefore = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(coveredBefore).toBeDefined();
    await db('invoices').where({ id: invoiceId }).update({ status: 'void' });
    const coveredAfter = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(coveredAfter).toBeUndefined();
  });

  // Codex #4971 pre-push P0: a dispute inside the first 30 days demotes the
  // PAID successor back to payment_pending (the real
  // suspendActiveTermsForDisputedInvoice, as the dispute webhook runs it)
  // and reopens its invoice with the Stripe identifiers cleared. The grace
  // branch must NOT hand that coverage straight back — completion charges
  // and monthly dues would be suppressed on clawed-back money.
  test('a paid successor disputed inside its grace window is NOT grace-covered after the dispute demotion', async () => {
    await db('customers').insert({ id: customerId, billing_mode: 'annual_prepay' });
    await db('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_renewal' });
    const termId = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', overrides: { status: 'active' } });
    const coveredOn = async (date) => Boolean(await AnnualPrepayRenewals.coveredTermsAsOf(db, date).where('t.id', termId).first('t.id'));
    await expect(coveredOn('2026-10-07')).resolves.toBe(true); // paid and active: covered

    await db.transaction(async (trx) => {
      await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice(invoiceId, trx);
      await trx('invoices').where({ id: invoiceId }).update({
        status: 'overdue', paid_at: null, stripe_payment_intent_id: null, stripe_charge_id: null,
      });
    });

    const term = await db('annual_prepay_terms').where({ id: termId }).first();
    expect(term.status).toBe('payment_pending');
    expect(term.dispute_suspended_at).not.toBeNull();
    // Day 10 of the renewal — inside the 30-day grace window by date alone.
    await expect(coveredOn('2026-10-07')).resolves.toBe(false);
    const visit = {
      id: randomUUID(), customer_id: customerId, service_type: null, scheduled_date: '2026-10-07',
      prepaid_method: null, prepaid_amount: null, annual_prepay_term_id: termId,
    };
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit(visit, db)).resolves.toBe(false);
  });

  // Codex #4971 pre-push P1: grace is DATED coverage only. The date-less
  // form means "still-valid PAID coverage, whatever the window" — and its
  // callers read the term's FULL range: card-expiry exemptions used to
  // treat a grace-only successor's 30 days as a whole covered year across
  // their 60-day horizon, suppressing card-expiry warnings.
  test('the date-less form never includes a grace-only successor — so a card-expiry exemption is never granted over its full year', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', termEnd: '2027-09-26' });

    // Dated: covered on grace day 10.
    expect(await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-07').where('t.id', id).first('t.id')).toBeDefined();
    // Date-less: not paid-backed coverage at all.
    expect(await AnnualPrepayRenewals.coveredTermsAsOf(db, null).where('t.id', id).first('t.id')).toBeUndefined();
    expect(await AnnualPrepayRenewals.coveredTermsAsOf(db).where('t.id', id).first('t.id')).toBeUndefined();
    // computeCardExpiryExemptions' own coverage query (same shape) over a
    // 60-day horizon finds nothing to span it — no exemption.
    const rows = await AnnualPrepayRenewals.coveredTermsAsOf(db, null)
      .where('t.term_start', '<=', '2026-11-26')
      .where('t.term_end', '>=', '2026-09-27')
      .select('t.customer_id', 't.term_start', 't.term_end');
    expect(rows).toEqual([]);

    // Once genuinely paid, the date-less form includes it again (paid-backed).
    await db('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: new Date() });
    expect(await AnnualPrepayRenewals.coveredTermsAsOf(db, null).where('t.id', id).first('t.id')).toBeDefined();
  });

  test('a non-termite payment_pending term (no annual_plan_version) is still NOT covered', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', overrides: { annual_plan_version: null } });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(row).toBeUndefined();
  });

  test('an ORIGINAL (non-successor) termite payment_pending term is still NOT covered', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', overrides: { renewed_from_term_id: null } });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(row).toBeUndefined();
  });

  // Codex round-1 P1: created_at::date cast in the SQL session's OWN
  // timezone (UTC, forced above) instead of ET. 2026-10-01T01:30Z is
  // 2026-09-30 21:30 in America/New_York (EDT, UTC-4) — a mint that landed
  // just before midnight ET reads as the NEXT calendar day under a bare
  // UTC cast, pushing the grace deadline a day too late.
  test('an evening ET mint (created 2026-10-01T01:30Z = 2026-09-30 ET) anchors on the ET date, not the UTC session date', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-30', createdAt: '2026-10-01T01:30:00Z' });
    // Correct ET-anchored deadline: 2026-09-30 + 30 days = 2026-10-30.
    const coveredOnCorrectDeadline = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-30').where('t.id', id).first('t.id');
    expect(coveredOnCorrectDeadline).toBeDefined();
    // The bug's deadline (a bare UTC cast reads created_at as 2026-10-01,
    // one day later) would still read this date as covered — proving the
    // fix actually converts to ET before casting, not just coincidence.
    const notCoveredDayAfter = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-31').where('t.id', id).first('t.id');
    expect(notCoveredDayAfter).toBeUndefined();
  });

  // Codex round-6 P1: a direct, unmocked agreement check between the two
  // deadline twins — termiteRenewalGraceDeadlineSql's raw expression,
  // evaluated by REAL Postgres against the SAME row, and
  // termiteRenewalGraceDeadlineFor's JS computation on that row's own
  // fields. The suite above only proves the SQL twin indirectly (through
  // coveredTermsAsOf's boundary behavior); this proves the two formulas
  // compute the IDENTICAL calendar date, row for row, including the ET
  // evening boundary and a delayed-mint case.
  test('termiteRenewalGraceDeadlineSql and termiteRenewalGraceDeadlineFor agree on the exact deadline date for every row', async () => {
    const cases = [
      { termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' }, // same-day mint
      { termStart: '2026-09-27', createdAt: '2026-10-02T12:00:00Z' }, // delayed mint — created_at later
      { termStart: '2026-10-15', createdAt: '2026-09-27T12:00:00Z' }, // term_start later
      { termStart: '2026-09-30', createdAt: '2026-10-01T01:30:00Z' }, // ET evening boundary
      { termStart: '2026-12-15', createdAt: '2026-12-15T12:00:00Z' }, // year-end rollover
    ];
    for (const c of cases) {
      const id = await insertSuccessor({ termStart: c.termStart, createdAt: c.createdAt });
      const row = await db('annual_prepay_terms').where({ id }).first('term_start', 'created_at');
      const jsDeadline = AnnualPrepayRenewals.termiteRenewalGraceDeadlineFor(row);

      const sqlRow = await db('annual_prepay_terms as t')
        .where('t.id', id)
        .select(db.raw(`${AnnualPrepayRenewals.termiteRenewalGraceDeadlineSql('t')} as deadline`))
        .first();
      const sqlDeadline = typeof sqlRow.deadline === 'string'
        ? sqlRow.deadline.slice(0, 10)
        : new Date(sqlRow.deadline).toISOString().slice(0, 10);

      expect(sqlDeadline).toBe(jsDeadline);
    }
  });

  // Codex round-7 P1: refreshTermSnapshot's attach+stamp step is
  // ACTIVE_STATUSES-only, so a grace-period successor's visits are NEVER
  // stamped prepaid — annualPrepayCoversVisit's own termiteGraceCoversVisit
  // check must recognize grace coverage WITHOUT relying on any stamp at
  // all. Real Postgres: a visit "completed" on grace day 10 (well inside
  // the 30-day window) reads as covered; one on day 31 (past the
  // deadline) does not.
  test('a visit completed on grace day 10 is covered — no stamp required', async () => {
    const ancestorId = await insertAncestor();
    const termId = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: ancestorId } });
    const fakeVisit = {
      id: randomUUID(), customer_id: customerId, service_type: null,
      scheduled_date: '2026-10-07', // day 10 from term_start
      prepaid_method: null, prepaid_amount: null, annual_prepay_term_id: termId,
    };
    const covered = await AnnualPrepayRenewals.annualPrepayCoversVisit(fakeVisit, db);
    expect(covered).toBe(true);
  });

  test('a visit completed on grace day 31 (past the deadline) is NOT covered', async () => {
    const ancestorId = await insertAncestor();
    const termId = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: ancestorId } });
    const fakeVisit = {
      id: randomUUID(), customer_id: customerId, service_type: null,
      scheduled_date: '2026-10-28', // day 31 from term_start
      prepaid_method: null, prepaid_amount: null, annual_prepay_term_id: termId,
    };
    const covered = await AnnualPrepayRenewals.annualPrepayCoversVisit(fakeVisit, db);
    expect(covered).toBe(false);
  });

  test('property-scoped grace covers property A but never an unrelated property B visit', async () => {
    const estimateId = randomUUID();
    const propertyA = randomUUID();
    const propertyB = randomUUID();
    await db('estimates').insert({ id: estimateId, customer_id: customerId, property_id: propertyA });
    const originalId = await insertAncestor({ sourceEstimateId: estimateId });
    await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: originalId, source_estimate_id: null,
        coverage_service_type: 'Termite Monitoring Visit' } });
    const visit = { id: randomUUID(), customer_id: customerId, service_type: 'Termite Monitoring Visit',
      scheduled_date: '2026-10-07', prepaid_method: null, property_id: propertyA };
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit(visit, db)).resolves.toBe(true);
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit({ ...visit, property_id: propertyB }, db)).resolves.toBe(false);
  });

  test('a null-source later successor inherits original scope through its recurring parent; conflicts and ambiguity fail closed', async () => {
    const propertyId = randomUUID();
    const estimateA = randomUUID();
    const estimateB = randomUUID();
    await db('estimates').insert([
      { id: estimateA, customer_id: customerId, property_id: propertyId },
      { id: estimateB, customer_id: customerId, property_id: propertyId },
    ]);
    const originalA = await insertAncestor({ sourceEstimateId: estimateA });
    const middleA = await insertAncestor({ renewedFromTermId: originalA });
    const termA = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: middleA, source_estimate_id: null } });
    const originalB = await insertAncestor({ sourceEstimateId: estimateB });
    await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: originalB, source_estimate_id: null, prepay_invoice_id: invoiceId } });
    const parentId = randomUUID();
    await db('scheduled_services').insert({ id: parentId, customer_id: customerId,
      annual_prepay_term_id: middleA, source_estimate_id: estimateA, property_id: propertyId });
    const child = { id: randomUUID(), customer_id: customerId, service_type: null, scheduled_date: '2026-10-07',
      prepaid_method: null, recurring_parent_id: parentId };
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit(child, db)).resolves.toBe(true);
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit({ ...child, source_estimate_id: estimateB }, db))
      .resolves.toBe(false);
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit({ ...child, recurring_parent_id: null, property_id: propertyId }, db))
      .resolves.toBe(false);
    await expect(AnnualPrepayRenewals.annualPrepayCoversVisit({
      ...child, recurring_parent_id: randomUUID(), annual_prepay_term_id: termA,
    }, db)).resolves.toBe(false);
  });

  test('missing, cross-customer, cyclic, and conflicting-source renewal ancestry is never grace coverage', async () => {
    const estimateA = randomUUID();
    const estimateB = randomUUID();
    await db('estimates').insert([
      { id: estimateA, customer_id: customerId, property_id: randomUUID() },
      { id: estimateB, customer_id: customerId, property_id: randomUUID() },
    ]);
    const cases = [];
    cases.push(await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: randomUUID() } }));
    const foreignAncestor = await insertAncestor({ ownerId: randomUUID(), sourceEstimateId: estimateA });
    cases.push(await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: foreignAncestor } }));
    const conflictAncestor = await insertAncestor({ sourceEstimateId: estimateA });
    cases.push(await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: conflictAncestor, source_estimate_id: estimateB } }));
    const cycleParent = await insertAncestor();
    const cycleSuccessor = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z',
      overrides: { renewed_from_term_id: cycleParent } });
    await db('annual_prepay_terms').where({ id: cycleParent }).update({ renewed_from_term_id: cycleSuccessor });
    cases.push(cycleSuccessor);

    for (const termId of cases) {
      const visit = { id: randomUUID(), customer_id: customerId, service_type: null,
        scheduled_date: '2026-10-07', prepaid_method: null, annual_prepay_term_id: termId };
      await expect(AnnualPrepayRenewals.annualPrepayCoversVisit(visit, db)).resolves.toBe(false);
    }
  });
});
