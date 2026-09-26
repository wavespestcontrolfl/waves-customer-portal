/**
 * Real PostgreSQL, REAL (unmocked) declineTermiteAnnualRenewal /
 * refreshActiveTermsForCustomer / refreshTermSnapshot — Codex #4940 round 4.
 *
 *  - P1: a declined-renewal year (status 'cancelled', renewal_decision
 *    'cancel') is still PAID coverage through term_end. A covered visit
 *    rescheduled after the decline must be attached + prepaid-stamped by the
 *    ordinary coverage refresh exactly like an active term's — never left to
 *    invoice at completion. A decline followed by a refund stamps nothing.
 *  - P1: the customer's online decline supersedes a staff 'renew' that has
 *    not been processed (no successor term minted from it); a processed one
 *    (successor exists) is refused and left untouched. Runs the guarded
 *    renewed → cancelled UPDATE (move 14) as real SQL.
 *  - P1: a fresh decline raises the dated station-retrieval task once.
 *
 * Mocks only '../models/db' (redirected to this scratch schema), the logger,
 * the admin bell, and the retrieval-task raiser (its own suites own its body).
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand --forceExit server/tests/termite-annual-renewal-decline-coverage-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

// Real createTerm/refresh machinery on a scratch schema — slow under load.
jest.setTimeout(60000);

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
  const schema = `apt_decl_r4_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Same narrow schema as termite-annual-decline-before-install-coverage-
  // postgres.test.js (see its notes on omitted columns), plus what the
  // decline writes: the decision columns, annual_plan_version, activity_log.
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name text, last_name text)');
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
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  await db.raw('CREATE TABLE setup_fee_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, scheduled_service_id uuid)');
  await db.raw(`CREATE TABLE activity_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    action text,
    description text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
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
    renewal_decision_at timestamptz,
    renewal_decision_by uuid,
    renewal_notes text,
    renewed_from_term_id uuid,
    annual_plan_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of MIGRATIONS) {
    await require(`../models/migrations/${name}`).up(db);
  }
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termite annual renewal decline — coverage, renew supersession, retrieval task (real Postgres)', () => {
  let fixture;

  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (fixture) await fixture.destroy();
  });

  async function load() {
    fixture = await createScratchDb();
    const { db } = fixture;
    const notifyAdmin = jest.fn(async () => ({ id: randomUUID() }));
    const raiseTermiteRetrievalTask = jest.fn(async () => ({ raised: true, stationCount: 12 }));
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/cancellation-processor', () => ({ raiseTermiteRetrievalTask }));
    const Renewals = require('../services/annual-prepay-renewals');
    return {
      db, Renewals, notifyAdmin, raiseTermiteRetrievalTask,
    };
  }

  const etToday = () => new Date().toISOString().slice(0, 10);
  const ymd = (value) => (value instanceof Date
    ? [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
    : String(value).slice(0, 10));
  const addMonths = (ymdStr, months) => {
    const d = new Date(`${ymdStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  };

  // An installed, paid termite annual term (anchored to its completed
  // installation) with its second covered visit booked + stamped.
  async function paidInstalledTerm(db, { status = 'active', renewalDecision = null } = {}) {
    const customerId = randomUUID();
    const today = etToday();
    const termStart = addMonths(today, -2);
    await db('customers').insert({ id: customerId, first_name: 'Jane', last_name: 'Doe' });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_${randomUUID()}`,
    }).returning('*');
    const [installVisit] = await db('scheduled_services').insert({
      customer_id: customerId, source_estimate_id: estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: termStart,
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
      term_start: termStart,
      term_end: addMonths(termStart, 12),
      status,
      renewal_decision: renewalDecision,
      annual_plan_version: 'v3',
      installation_anchored_at: new Date(`${termStart}T16:00:00Z`),
      installation_anchor_visit_id: installVisit.id,
      created_at: new Date(`${termStart}T15:00:00Z`),
    }).returning('*');
    const [coveredVisit] = await db('scheduled_services').insert({
      customer_id: customerId, status: 'pending', service_type: 'Termite Monitoring Visit', scheduled_date: addMonths(today, 3),
    }).returning('*');
    return {
      customerId, today, term, invoice, coveredVisit,
    };
  }

  // What a reschedule leaves behind: the original covered row retired with
  // its stamp cleared, and a fresh, unlinked, unstamped replacement.
  async function rescheduleCoveredVisit(db, { customerId, coveredVisit, today }) {
    await db('scheduled_services').where({ id: coveredVisit.id }).update({
      status: 'rescheduled', annual_prepay_term_id: null, prepaid_amount: null, prepaid_method: null, prepaid_at: null,
    });
    const [replacement] = await db('scheduled_services').insert({
      customer_id: customerId, status: 'pending', service_type: 'Termite Monitoring Visit', scheduled_date: addMonths(today, 4),
    }).returning('*');
    return replacement;
  }

  test('decline, then a covered visit is rescheduled: the ordinary refresh attaches + prepaid-stamps the replacement', async () => {
    const { db, Renewals } = await load();
    const fx = await paidInstalledTerm(db);
    await Renewals.refreshActiveTermsForCustomer(fx.customerId, db);
    expect(Number((await db('scheduled_services').where({ id: fx.coveredVisit.id }).first()).prepaid_amount)).toBe(225);

    const declined = await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    expect(declined).toEqual(expect.objectContaining({ ok: true, alreadyDeclined: false }));
    expect(await db('annual_prepay_terms').where({ id: fx.term.id }).first()).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel' }));

    const replacement = await rescheduleCoveredVisit(db, fx);
    await Renewals.refreshActiveTermsForCustomer(fx.customerId, db);

    const stamped = await db('scheduled_services').where({ id: replacement.id }).first();
    expect(stamped.annual_prepay_term_id).toBe(fx.term.id);
    expect(Number(stamped.prepaid_amount)).toBe(225);
    expect(stamped.prepaid_method).toBe('annual_prepay_invoice');
  });

  test('decline, then a refund: a rescheduled covered visit is never stamped', async () => {
    const { db, Renewals } = await load();
    const fx = await paidInstalledTerm(db);
    await Renewals.refreshActiveTermsForCustomer(fx.customerId, db);
    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: fx.invoice.stripe_payment_intent_id });

    const replacement = await rescheduleCoveredVisit(db, fx);
    await Renewals.refreshActiveTermsForCustomer(fx.customerId, db);

    const row = await db('scheduled_services').where({ id: replacement.id }).first();
    expect(row.annual_prepay_term_id).toBeNull();
    expect(row.prepaid_amount).toBeNull();
    expect(row.prepaid_method).toBeNull();
  });

  test('a fresh decline raises the dated station-retrieval task once; a replay raises nothing', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await paidInstalledTerm(db);

    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });

    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, {
      retrieveAfter: ymd(fx.term.term_end),
      termId: fx.term.id,
      episodeKey: 'portal_renewal_decline',
    });
  });

  test('an UNPROCESSED staff renew is superseded by the customer decline (real guarded UPDATE)', async () => {
    const { db, Renewals, notifyAdmin } = await load();
    const fx = await paidInstalledTerm(db, { status: 'renewed', renewalDecision: 'renew' });

    const result = await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });

    expect(result).toEqual(expect.objectContaining({ ok: true, alreadyDeclined: false }));
    const term = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(term).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel' }));
    expect(term.renewal_decision_at).toBeInstanceOf(Date);
    const activity = await db('activity_log').where({ customer_id: fx.customerId }).first();
    expect(activity.metadata).toEqual(expect.objectContaining({ superseded_decision: 'renew' }));
    expect(notifyAdmin.mock.calls[0][2]).toContain('replacing the renewal staff had recorded');
  });

  test('a PROCESSED staff renew (successor term minted) is refused and left untouched', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await paidInstalledTerm(db, { status: 'renewed', renewalDecision: 'renew' });
    await db('annual_prepay_terms').insert({
      customer_id: fx.customerId,
      term_start: ymd(fx.term.term_end),
      term_end: addMonths(ymd(fx.term.term_end), 12),
      status: 'payment_pending',
      annual_plan_version: 'v3',
      renewed_from_term_id: fx.term.id,
    });

    const result = await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });

    expect(result).toEqual({ ok: false, reason: 'already_decided', decision: 'renew', termId: fx.term.id });
    expect(await db('annual_prepay_terms').where({ id: fx.term.id }).first()).toEqual(expect.objectContaining({ status: 'renewed', renewal_decision: 'renew' }));
    // The guarded UPDATE itself refuses too, even if a caller skipped the check.
    expect(await Renewals._private.supersedeRenewWithCustomerCancel({ termId: fx.term.id, conn: db })).toBeNull();
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
  });
});
