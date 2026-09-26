/**
 * Real PostgreSQL, REAL (unmocked) createTermForAnnualPrepay / refreshTermSnapshot —
 * codex pre-push P1 follow-up on the round-1 "decline before install" reversal.
 *
 * anchorTermToInstallation (termite-annual-activation.js) now anchors a
 * decided-lapse term (declined online BEFORE its installation, still
 * status 'cancelled' / renewal_decision 'cancel') the same as an undecided
 * one — but anchoring alone only moves the term's dates. THIS suite proves
 * the paid coverage year it anchors to is actually SEEDED (its designated
 * coverage visits are recognized/attached) and PREPAID-STAMPED (the
 * not-yet-completed one gets prepaid_amount/method/at), exactly like an
 * active term's would — via the real refreshTermSnapshot/
 * createTermForAnnualPrepay `anchorInstallation` option
 * (annual-prepay-renewals.js isPaidDecidedLapseTerm), never mocked.
 *
 * Unlike termite-annual-install-anchor-postgres.test.js (which stubs
 * createTermForAnnualPrepay/refreshTermSnapshot at the module boundary to
 * isolate the anchor's own candidate-scan/lock/overlap logic), this suite
 * intentionally does NOT mock '../services/annual-prepay-renewals' — only
 * '../models/db' (redirected to this scratch schema, which the real
 * module's own db-level column introspection then also resolves against)
 * and '../services/logger'.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-decline-before-install-coverage-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const MIGRATIONS = [
  '20260925000001_termite_annual_sign_before_pay',
  '20260925000002_termite_annual_deferred_invoice_snapshot',
  '20260925000003_termite_annual_invoice_delivery_attempt',
  '20260925000004_termite_annual_activation_attempt',
  '20260925000005_termite_annual_signature_charge',
  '20260925000006_termite_annual_install_anchor',
  '20260925000007_termite_annual_anchor_attempt',
  '20260925030001_termite_annual_countersignature_columns',
];

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `apt_decl_cov_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal schema: only what the REAL anchor + coverage-seeding path
  // (anchorTermToInstallation -> createTermForAnnualPrepay ->
  // refreshTermSnapshot -> ensureCoverageRowsForTerm / attachScheduledServices /
  // applyPrepaidCoverageForTerm / isPaidDecidedLapseTerm's coveredTermsAsOf)
  // actually reads or writes. Every OTHER column those functions branch on
  // (is_recurring, estimated_price, window_start, service_id,
  // is_callback, …) is deliberately OMITTED — annual-prepay-renewals.js's
  // own column introspection (scheduledServiceColumns/invoiceColumns, both
  // hard-wired to '../models/db' regardless of the conn a caller passes,
  // which is exactly why '../models/db' is mocked to THIS schema below)
  // then reports those columns absent and skips their branches, the same
  // way it would on a real but narrower table.
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw('CREATE TABLE customer_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL)');
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, property_id uuid)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    status text,
    paid_at timestamptz,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Empty on purpose (isPaidDecidedLapseTerm's coveredTermsAsOf NOT EXISTS
  // refund check) — no row ever matches, which is the common case.
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  // Queried directly on the OUTER transaction (no savepoint of its own) by
  // ensureCoverageRowsForTerm's anchor-less-claim lookup — a missing table
  // there is caught in JS but still poisons the whole Postgres transaction
  // (no rollback happened), so it must exist even though this suite never
  // populates it.
  await db.raw('CREATE TABLE setup_fee_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, scheduled_service_id uuid)');
  await db.raw(`CREATE TABLE scheduled_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    source_estimate_id uuid,
    annual_prepay_term_id uuid,
    property_id uuid,
    status text,
    service_type text,
    scheduled_date date,
    window_start time,
    estimated_duration_minutes int,
    notes text,
    prepaid_amount numeric,
    prepaid_method text,
    prepaid_at timestamptz,
    prepaid_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    source_estimate_id uuid,
    prepay_invoice_id uuid,
    plan_label text,
    monthly_rate numeric,
    prepay_amount numeric,
    coverage_service_type text,
    coverage_visit_count int,
    coverage_cadence text,
    last_scheduled_service_id uuid,
    last_scheduled_service_date date,
    term_start date NOT NULL,
    term_end date NOT NULL,
    status text NOT NULL,
    renewal_decision text,
    renewed_from_term_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of MIGRATIONS) {
    await require(`../models/migrations/${name}`).up(db);
  }
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

const ymd = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

describeOrSkip('a decided-lapse termite term (declined before install) gets real coverage seeding + prepaid stamping once anchored — real Postgres', () => {
  let fixture;

  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (fixture) await fixture.destroy();
  });

  // Loads the REAL anchor + annual-prepay-renewals modules against a fresh
  // scratch schema, mocking only '../models/db' (redirected here) and
  // '../services/logger' (silenced) — annual-prepay-renewals.js is NOT
  // mocked, unlike termite-annual-install-anchor-postgres.test.js's load().
  async function load() {
    fixture = await createScratchDb();
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    const { anchorTermToInstallation } = require('../services/termite-annual-activation');
    return { db, anchorTermToInstallation };
  }

  const etDateString = () => new Date().toISOString().slice(0, 10);
  const addYear = (ymdStr) => {
    const d = new Date(`${ymdStr}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString().slice(0, 10);
  };
  const addMonths = (ymdStr, months) => {
    const d = new Date(`${ymdStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  };

  test('anchors, then seeds coverage recognition + stamps the pending covered visit — completed install visit stays unstamped, decision untouched', async () => {
    const { db, anchorTermToInstallation } = await load();
    const customerId = randomUUID();
    const today = etDateString();
    const signedOn = addMonths(today, -1); // provisional signature day, before installation
    await db('customers').insert({ id: customerId });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'paid', paid_at: new Date(),
    }).returning('*');
    const [term] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      source_estimate_id: estimate.id,
      prepay_invoice_id: invoice.id,
      plan_label: 'WaveGuard Termite Annual Protection',
      prepay_amount: 450,
      coverage_service_type: 'Termite Monitoring Visit',
      coverage_visit_count: 2,
      coverage_cadence: 'annual',
      term_start: signedOn,
      term_end: addYear(signedOn),
      status: 'cancelled',
      renewal_decision: 'cancel',
      created_at: new Date(`${signedOn}T16:00:00Z`),
    }).returning('*');
    // The installation itself (completed TODAY) — becomes the anchor and,
    // by installation_anchor_visit_id identity, this year's first covered
    // visit. Never prepaid-stamped (completed rows are excluded — their
    // billing is settled by the pending-window reconcile, not this stamp).
    const [installVisit] = await db('scheduled_services').insert({
      customer_id: customerId, source_estimate_id: estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: today,
    }).returning('*');
    // A second, pre-existing covered visit later in the coverage year — not
    // yet serviced. THIS is the one the fix must recognize + prepaid-stamp.
    const [futureVisit] = await db('scheduled_services').insert({
      customer_id: customerId, status: 'pending',
      service_type: 'Termite Monitoring Visit', scheduled_date: addMonths(today, 6),
    }).returning('*');

    const result = await anchorTermToInstallation({ termId: term.id, conn: db });

    expect(result).toMatchObject({ anchored: true, termId: term.id, termStart: today });
    const refreshedTerm = await db('annual_prepay_terms').where({ id: term.id }).first();
    expect(refreshedTerm.installation_anchored_at).toBeInstanceOf(Date);
    expect(refreshedTerm.installation_anchor_visit_id).toBe(installVisit.id);
    // The decline itself is untouched by the anchor — only the coverage
    // window/seeding moved.
    expect(refreshedTerm.status).toBe('cancelled');
    expect(refreshedTerm.renewal_decision).toBe('cancel');
    expect(ymd(refreshedTerm.term_start)).toBe(today);

    const refreshedInstall = await db('scheduled_services').where({ id: installVisit.id }).first();
    expect(refreshedInstall.annual_prepay_term_id).toBe(term.id);
    expect(refreshedInstall.prepaid_amount).toBeNull(); // completed — excluded by design

    const refreshedFuture = await db('scheduled_services').where({ id: futureVisit.id }).first();
    expect(refreshedFuture.annual_prepay_term_id).toBe(term.id);
    expect(Number(refreshedFuture.prepaid_amount)).toBe(225); // splitCoverageAmount(450, 2)[1]
    expect(refreshedFuture.prepaid_method).toBe('annual_prepay_invoice');
    expect(refreshedFuture.prepaid_at).toBeInstanceOf(Date);
  });

  test('a refunded/voided term (cancelled, no renewal decision) is never anchored — its coverage is never touched even with a completed installation sitting there', async () => {
    const { db, anchorTermToInstallation } = await load();
    const customerId = randomUUID();
    const today = etDateString();
    const signedOn = addMonths(today, -1);
    await db('customers').insert({ id: customerId });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'refunded', paid_at: new Date(),
    }).returning('*');
    const [term] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      source_estimate_id: estimate.id,
      prepay_invoice_id: invoice.id,
      plan_label: 'WaveGuard Termite Annual Protection',
      prepay_amount: 450,
      coverage_service_type: 'Termite Monitoring Visit',
      coverage_visit_count: 2,
      coverage_cadence: 'annual',
      term_start: signedOn,
      term_end: addYear(signedOn),
      status: 'cancelled',
      renewal_decision: null,
      created_at: new Date(`${signedOn}T16:00:00Z`),
    }).returning('*');
    const [installVisit] = await db('scheduled_services').insert({
      customer_id: customerId, source_estimate_id: estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: today,
    }).returning('*');

    const result = await anchorTermToInstallation({ termId: term.id, conn: db });

    expect(result).toEqual({ skipped: 'not_original_term' });
    const refreshedTerm = await db('annual_prepay_terms').where({ id: term.id }).first();
    expect(refreshedTerm.installation_anchored_at).toBeNull();
    expect(refreshedTerm.installation_anchor_visit_id).toBeNull();
    const refreshedInstall = await db('scheduled_services').where({ id: installVisit.id }).first();
    expect(refreshedInstall.annual_prepay_term_id).toBeNull();
    expect(refreshedInstall.prepaid_amount).toBeNull();
  });
});
