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
 *  - P1: a fresh decline raises the dated station-retrieval task once; a
 *    decline BEFORE installation raises it once the installation anchor
 *    commits (against the NEW term_end), and the daily sweep backstops a
 *    term whose task was never settled — never twice.
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
  await db.raw('CREATE TABLE setup_fee_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, scheduled_service_id uuid, amount numeric)');
  // ADMIN-BUG-R18 (#4970): the end-at-term lapse upkeep checks for an open
  // end-now Cancel plan acceptance before stamping a decided lapse's visits.
  // Other live termite coverage the retrieval guard reads (Codex #4940 r7).
  await db.raw(`CREATE TABLE termite_bonds (
    id serial PRIMARY KEY,
    customer_id uuid NOT NULL,
    service_type text,
    status text NOT NULL DEFAULT 'active'
  )`);
  await db.raw(`CREATE TABLE service_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    category text,
    source text,
    status text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // The station-retrieval task rows (raised by the stubbed helper below,
  // shaped like notifyAdmin's) — the decline settles only once its own
  // row exists (Codex #4940 r6).
  await db.raw(`CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_type text,
    read_at timestamptz,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
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
    cancel_disposition text,
    decline_retrieval_attempted_at timestamptz,
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

  async function load({ invoiceModule = null } = {}) {
    fixture = await createScratchDb();
    const { db } = fixture;
    const notifyAdmin = jest.fn(async () => ({ id: randomUUID() }));
    // Lazy: the real module must load only AFTER '../models/db' is mocked.
    const termRetrievalDedupeKey = (...args) => jest.requireActual('../services/cancellation-processor').termRetrievalDedupeKey(...args);
    // Stands in for the real helper's insert: one admin retrieval row keyed
    // like the real one (its own suites cover chronology + supersession).
    const raiseTermiteRetrievalTask = jest.fn(async (customerId, _requestId, { retrieveAfter, termId, episodeKey }) => {
      await db('notifications').insert({
        recipient_type: 'admin',
        metadata: {
          kind: 'termite_station_retrieval',
          customerId,
          dedupeKey: termRetrievalDedupeKey(termId, episodeKey, retrieveAfter),
          termId,
          churnEpisode: episodeKey,
          ...(retrieveAfter ? { retrieveAfter } : {}),
        },
      });
      return { raised: true, stationCount: 12 };
    });
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/cancellation-processor', () => ({ raiseTermiteRetrievalTask, termRetrievalDedupeKey }));
    // doMock outlives resetModules: every load sets the invoice module explicitly.
    if (invoiceModule) jest.doMock('../services/invoice', () => invoiceModule);
    else jest.dontMock('../services/invoice');
    const Renewals = require('../services/annual-prepay-renewals');
    const { anchorTermToInstallation } = require('../services/termite-annual-activation');
    return {
      db, Renewals, notifyAdmin, raiseTermiteRetrievalTask, anchorTermToInstallation,
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
      // What recordDecision('cancel') records for a renewal-time lapse.
      cancel_disposition: renewalDecision === 'cancel' ? 'end_at_term' : null,
      annual_plan_version: 'v3',
      installation_anchored_at: new Date(`${termStart}T16:00:00Z`),
      installation_anchor_visit_id: installVisit.id,
      created_at: new Date(`${termStart}T15:00:00Z`),
    }).returning('*');
    // Booked as this plan's coverage (linked to the term, as attach does).
    const [coveredVisit] = await db('scheduled_services').insert({
      customer_id: customerId, annual_prepay_term_id: term.id, status: 'pending', service_type: 'Termite Monitoring Visit', scheduled_date: addMonths(today, 3),
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
    expect(await db('annual_prepay_terms').where({ id: fx.term.id }).first()).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' }));

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

  // Codex #4940 r9: station retrieval is evaluated at DUE time — never at
  // decline or anchor time.
  const dayOffset = (ymdStr, days) => new Date(Date.parse(`${ymdStr}T00:00:00Z`) + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const portalDeclineRow = (db, fx) => db('activity_log').insert({
    customer_id: fx.customerId, action: 'termite_annual_renewal_declined', description: 'x', metadata: { term_id: fx.term.id },
  });
  // A declined term whose paid-through day was yesterday: its retrieval is due.
  async function dueDeclinedTerm(db) {
    const fx = await paidInstalledTerm(db, { status: 'cancelled', renewalDecision: 'cancel' });
    const termEnd = dayOffset(fx.today, -1);
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: termEnd });
    await portalDeclineRow(db, fx);
    return { ...fx, termEnd };
  }
  const settledMarker = (db, fx) => db('activity_log').where({ action: 'termite_annual_decline_retrieval' })
    .whereRaw("metadata->>'term_id' = ?", [fx.term.id]).first('metadata');

  test('a decline raises nothing; the sweep raises the dated task only once term_end has passed — once', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await paidInstalledTerm(db);
    const termEnd = ymd(fx.term.term_end);

    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
    expect(notifyAdmin.mock.calls[0][2]).toContain('The stations will be retrieved after coverage ends');

    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: fx.today })).toEqual({ scanned: 0, raised: 0 });
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: termEnd })).toEqual({ scanned: 0, raised: 0 });

    const dayAfter = dayOffset(termEnd, 1);
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: dayAfter })).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, {
      retrieveAfter: termEnd, termId: fx.term.id, episodeKey: 'portal_renewal_decline', eventAt: expect.anything(),
    });
    expect((await settledMarker(db, fx)).metadata).toEqual(expect.objectContaining({ outcome: 'raised', retrieve_after: termEnd }));
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: dayAfter })).toEqual({ scanned: 0, raised: 0 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
  });

  test('an UNPROCESSED staff renew is superseded by the customer decline (real guarded UPDATE)', async () => {
    const { db, Renewals, notifyAdmin } = await load();
    const fx = await paidInstalledTerm(db, { status: 'renewed', renewalDecision: 'renew' });

    const result = await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });

    expect(result).toEqual(expect.objectContaining({ ok: true, alreadyDeclined: false }));
    const term = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(term).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' }));
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

  // Codex #4940 r5 P1: declined BEFORE installation — no real end date to
  // date the task against until the installation anchors the term.
  test('decline before install, then the installation anchors: nothing raised then; at the NEW term_end + 1 the task is raised once', async () => {
    const {
      db, Renewals, notifyAdmin, raiseTermiteRetrievalTask, anchorTermToInstallation,
    } = await load();
    const customerId = randomUUID();
    const today = etToday();
    const signedOn = addMonths(today, -1);
    await db('customers').insert({ id: customerId, first_name: 'Jane', last_name: 'Doe' });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({ customer_id: customerId, status: 'paid', paid_at: new Date() }).returning('*');
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
      term_end: addMonths(signedOn, 12),
      status: 'active',
      annual_plan_version: 'v3',
      created_at: new Date(`${signedOn}T16:00:00Z`),
    }).returning('*');

    const declined = await Renewals.declineTermiteAnnualRenewal({ customerId, termId: term.id, today });
    expect(declined).toEqual(expect.objectContaining({ ok: true, awaitsInstallation: true }));
    expect(notifyAdmin.mock.calls[0][2]).toContain('after the 12-month coverage year from the station installation ends');

    await db('scheduled_services').insert({
      customer_id: customerId, source_estimate_id: estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: today,
    });
    const anchored = await anchorTermToInstallation({ termId: term.id, conn: db });
    expect(anchored).toEqual(expect.objectContaining({ anchored: true, termStart: today }));
    const newTermEnd = anchored.termEnd;
    expect(newTermEnd).not.toBe(ymd(term.term_end));
    // Nothing at anchor time, nor before the new term_end passes.
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: newTermEnd })).toEqual({ scanned: 0, raised: 0 });

    const dayAfter = dayOffset(newTermEnd, 1);
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: dayAfter })).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(customerId, null, {
      retrieveAfter: newTermEnd, termId: term.id, episodeKey: 'portal_renewal_decline', eventAt: expect.anything(),
    });
    expect(await anchorTermToInstallation({ termId: term.id, conn: db })).toEqual({ skipped: 'already_anchored' });
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: dayAfter })).toEqual({ scanned: 0, raised: 0 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
  });

  test('a retrieval still unsettled long after the term ended is still due (stations still need collecting)', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await paidInstalledTerm(db, { status: 'cancelled', renewalDecision: 'cancel' });
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: '2025-01-15' });
    await portalDeclineRow(db, fx);

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: '2025-01-15' }));
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });
  });

  test('a staff-recorded decline is never a candidate; a failed raise is belled, not settled, and retried', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const staffDeclined = await paidInstalledTerm(db, { status: 'cancelled', renewalDecision: 'cancel' });
    await db('annual_prepay_terms').where({ id: staffDeclined.term.id }).update({ term_end: dayOffset(staffDeclined.today, -1) });
    const failing = await dueDeclinedTerm(db);
    raiseTermiteRetrievalTask.mockRejectedValueOnce(new Error('notifications down'));

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 0 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(failing.customerId, null, expect.any(Object));
    expect(notifyAdmin.mock.calls.map((c) => c[2]).join(' ')).toContain('could not be raised yet');
    expect(await settledMarker(db, failing)).toBeUndefined();

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });
    expect(raiseTermiteRetrievalTask.mock.calls.map((c) => c[0])).not.toContain(staffDeclined.customerId);
  });

  test('a FULL REFUND after the decline makes the retrieval due at once: an IMMEDIATE task, before term_end', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await paidInstalledTerm(db, { status: 'cancelled', renewalDecision: 'cancel' });
    await portalDeclineRow(db, fx);
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });

    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'refunded' });
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: null, termId: fx.term.id }));
    expect((await settledMarker(db, fx)).metadata).toEqual(expect.objectContaining({ outcome: 'raised', retrieve_after: 'immediate' }));
  });

  test('a DISPUTED prepay (unpaid, not refunded) waits for term_end like any declined year', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await paidInstalledTerm(db, { status: 'cancelled', renewalDecision: 'cancel' });
    await portalDeclineRow(db, fx);
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'overdue', paid_at: null });
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
  });

  // raiseTermiteRetrievalTask counts every station on the ACCOUNT, so any
  // OTHER live termite coverage AT DUE TIME means no automatic task — staff
  // are belled to confirm which stations to pull, and it settles only once
  // that bell is stored.
  test.each([
    ['another termite annual term', async (db, fx) => {
      await db('annual_prepay_terms').insert({
        customer_id: fx.customerId, term_start: addMonths(fx.today, -1), term_end: addMonths(fx.today, 11), status: 'active', annual_plan_version: 'v3',
        installation_anchored_at: new Date(),
      });
    }, 'other_termite_plan', 'another termite annual plan'],
    ['a live quarterly termite service at another property', async (db, fx) => {
      await db('scheduled_services').insert({
        customer_id: fx.customerId, status: 'confirmed', service_type: 'Quarterly Termite Bait Monitoring', scheduled_date: addMonths(fx.today, 2),
      });
    }, 'other_termite_service', 'still has termite service on the calendar'],
    ['an active termite bond', async (db, fx) => {
      await db('termite_bonds').insert({ customer_id: fx.customerId, service_type: 'Termite Bond (1 yr)', status: 'active' });
    }, 'termite_bond', 'has an active termite bond'],
  ])('other live termite coverage at due time (%s): no automatic task, staff belled, settled', async (_label, addCoverage, outcome, wording) => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await dueDeclinedTerm(db);
    await addCoverage(db, fx);

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 0 });
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
    expect(notifyAdmin.mock.calls.map((c) => c[2]).join(' ')).toContain(wording);
    expect((await settledMarker(db, fx)).metadata).toEqual(expect.objectContaining({ term_id: fx.term.id, outcome }));
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });
  });

  test('a staff bell that is NOT stored leaves the term unsettled — the next sweep retries it', async () => {
    const { db, Renewals, notifyAdmin } = await load();
    const fx = await dueDeclinedTerm(db);
    await db('termite_bonds').insert({ customer_id: fx.customerId, service_type: 'Termite Bond (1 yr)', status: 'active' });
    notifyAdmin.mockResolvedValueOnce(null);

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 0 });
    expect(await settledMarker(db, fx)).toBeUndefined();
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 0 });
    expect((await settledMarker(db, fx)).metadata).toEqual(expect.objectContaining({ outcome: 'termite_bond' }));
  });

  test('coverage that ended before the due date never blocks the task: a completed / cancelled termite visit, an expired bond', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await dueDeclinedTerm(db);
    await db('scheduled_services').insert([
      { customer_id: fx.customerId, status: 'completed', service_type: 'Termite Liquid Treatment', scheduled_date: addMonths(fx.today, -3) },
      { customer_id: fx.customerId, status: 'cancelled', service_type: 'Quarterly Termite Bait Monitoring', scheduled_date: addMonths(fx.today, 2) },
    ]);
    await db('termite_bonds').insert({ customer_id: fx.customerId, service_type: 'Termite Bond (1 yr)', status: 'expired' });

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
  });

  // Codex #4940 r8 P2: terms whose action keeps failing rotate — the least-
  // recently-attempted (never-attempted first) goes next, not the same one.
  test('with limit 1, a repeatedly failing candidate never starves a newer one', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const older = await dueDeclinedTerm(db);
    const newer = await dueDeclinedTerm(db);
    await db('annual_prepay_terms').where({ id: older.term.id }).update({ term_end: dayOffset(older.today, -5) });
    raiseTermiteRetrievalTask.mockRejectedValue(new Error('notifications down'));

    await Renewals.raisePendingDeclineRetrievalTasks({ limit: 1 });
    await Renewals.raisePendingDeclineRetrievalTasks({ limit: 1 });
    await Renewals.raisePendingDeclineRetrievalTasks({ limit: 1 });

    expect(raiseTermiteRetrievalTask.mock.calls.map((c) => c[0])).toEqual([older.customerId, newer.customerId, older.customerId]);
    const stamped = await db('annual_prepay_terms').whereIn('id', [older.term.id, newer.term.id]).whereNotNull('decline_retrieval_attempted_at');
    expect(stamped).toHaveLength(2);
  });

  // Codex #4940 r9/r10 P1: a signed plan still payment_pending is declinable
  // online. The decision is recorded WITHOUT a status change, so it stays on
  // every pending rail; when the invoice is paid it settles to the decided-
  // lapse shape (move 15) — covered through term_end, never renewing.
  test('an unpaid plan declined online stays payment_pending (pending rails); paid, it becomes a covered decided lapse, never active', async () => {
    const { db, Renewals } = await load();
    const fx = await paidInstalledTerm(db);
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'sent', paid_at: null });
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ status: 'payment_pending' });

    const declined = await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    expect(declined).toEqual(expect.objectContaining({ ok: true, unpaid: true, alreadyDeclined: false }));
    expect(await db('annual_prepay_terms').where({ id: fx.term.id }).first())
      .toEqual(expect.objectContaining({ status: 'payment_pending', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' }));
    // Still on the pending rail the billing cron excludes by.
    expect([...(await Renewals.getPaymentPendingCustomerIds(fx.today))]).toContain(fx.customerId);
    await Renewals.refreshActiveTermsForCustomer(fx.customerId, db);
    expect((await db('scheduled_services').where({ id: fx.coveredVisit.id }).first()).prepaid_amount).toBeNull();

    // The prepay is paid after all.
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'paid', paid_at: new Date() });
    const synced = await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);
    expect(synced.map((t) => t.status)).toEqual(['cancelled']);
    const after = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(after).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' }));
    expect(await Renewals.isPaidDecidedLapseTerm(after, db)).toBe(true);
    const stamped = await db('scheduled_services').where({ id: fx.coveredVisit.id }).first();
    expect(Number(stamped.prepaid_amount)).toBeGreaterThan(0);
    expect(stamped.prepaid_method).toBe('annual_prepay_invoice');
    expect([...(await Renewals.getPaymentPendingCustomerIds(fx.today))]).not.toContain(fx.customerId);
    // A replayed payment sync never activates it.
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);
    expect((await db('annual_prepay_terms').where({ id: fx.term.id }).first()).status).toBe('cancelled');
  });

  test('an unpaid declined plan whose invoice is VOIDED leaves the pending rails, never covered', async () => {
    const { db, Renewals } = await load();
    const fx = await paidInstalledTerm(db);
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'sent', paid_at: null });
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ status: 'payment_pending' });
    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });

    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'void' });
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);
    const after = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(after).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel' }));
    expect(await Renewals.isPaidDecidedLapseTerm(after, db)).toBe(false);
    expect([...(await Renewals.getPaymentPendingCustomerIds(fx.today))]).not.toContain(fx.customerId);
  });

  // Codex #4940 r10 P1: a staff correction to term_end AFTER the due-time
  // task was raised (and while it is still open).
  test('term_end corrected LATER after the task was raised: re-raised at the new date, the old open row retired', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await dueDeclinedTerm(db);
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });

    const later = dayOffset(fx.today, 20);
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: later });
    // The stubbed helper retires other open rows like the real one does.
    raiseTermiteRetrievalTask.mockImplementationOnce(async (customerId, _r, { retrieveAfter, termId, episodeKey }) => {
      await db('notifications').whereRaw("metadata->>'churnEpisode' = ?", [episodeKey]).whereNull('read_at').update({ read_at: new Date() });
      await db('notifications').insert({
        recipient_type: 'admin',
        metadata: {
          kind: 'termite_station_retrieval', customerId, termId, churnEpisode: episodeKey, retrieveAfter,
          dedupeKey: `termite_station_retrieval:term:${termId}:${episodeKey}:dated:${retrieveAfter}`,
        },
      });
      return { raised: true, stationCount: 12 };
    });

    await Renewals.raisePendingDeclineRetrievalTasks();
    expect(raiseTermiteRetrievalTask).toHaveBeenLastCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: later, termId: fx.term.id }));
    const open = await db('notifications').whereNull('read_at').whereRaw("metadata->>'churnEpisode' = 'portal_renewal_decline'").select('metadata');
    expect(open.map((r) => r.metadata.retrieveAfter)).toEqual([later]);
    const latestMarker = await db('activity_log').where({ action: 'termite_annual_decline_retrieval' }).orderBy('created_at', 'desc').first();
    expect(latestMarker.metadata).toEqual(expect.objectContaining({ outcome: 'raised', retrieve_after: later }));
    // Settled at the new date: nothing more.
    await Renewals.raisePendingDeclineRetrievalTasks();
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(2);
  });

  test('term_end corrected EARLIER after the task was raised: staff belled with the correction, once; no re-raise', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await dueDeclinedTerm(db);
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });

    const earlier = dayOffset(fx.termEnd, -10);
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: earlier });
    await Renewals.raisePendingDeclineRetrievalTasks();
    await Renewals.raisePendingDeclineRetrievalTasks();

    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
    const correctionBells = notifyAdmin.mock.calls.filter((c) => String(c[3]?.dedupeKey || '').endsWith(':date_moved_earlier'));
    expect(correctionBells.length).toBeGreaterThanOrEqual(1);
    expect(new Set(correctionBells.map((c) => c[3].dedupeKey)).size).toBe(1);
    expect(correctionBells[0][2]).toContain('earlier than the open station-retrieval task says');
  });

  // #4940 pre-push P1: declined while unpaid, installed, then the invoice is
  // VOIDED — the installed stations must still enter retrieval.
  async function unpaidDeclinedAwaitingInstall(db) {
    const customerId = randomUUID();
    const today = etToday();
    const signedOn = addMonths(today, -1);
    await db('customers').insert({ id: customerId, first_name: 'Jane', last_name: 'Doe' });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({ customer_id: customerId, status: 'sent' }).returning('*');
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
      term_end: addMonths(signedOn, 12),
      status: 'payment_pending',
      annual_plan_version: 'v3',
      created_at: new Date(`${signedOn}T16:00:00Z`),
    }).returning('*');
    return {
      customerId, today, estimate, invoice, term,
    };
  }

  test('decline unpaid -> installation completes -> anchored (dates, no coverage) -> invoice voided -> decided lapse -> immediate retrieval', async () => {
    const {
      db, Renewals, raiseTermiteRetrievalTask, anchorTermToInstallation,
    } = await load();
    const fx = await unpaidDeclinedAwaitingInstall(db);
    expect(await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today }))
      .toEqual(expect.objectContaining({ ok: true, unpaid: true }));

    const [install] = await db('scheduled_services').insert({
      customer_id: fx.customerId, source_estimate_id: fx.estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: fx.today,
    }).returning('*');
    const [futureVisit] = await db('scheduled_services').insert({
      customer_id: fx.customerId, status: 'pending', service_type: 'Termite Monitoring Visit', scheduled_date: addMonths(fx.today, 6),
    }).returning('*');

    const anchored = await anchorTermToInstallation({ termId: fx.term.id, conn: db });
    expect(anchored).toEqual(expect.objectContaining({ anchored: true, termStart: fx.today }));
    const afterAnchor = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(afterAnchor).toEqual(expect.objectContaining({ status: 'payment_pending', renewal_decision: 'cancel', installation_anchor_visit_id: install.id }));
    // Dates only — an unpaid term is never granted coverage.
    const untouched = await db('scheduled_services').where({ id: futureVisit.id }).first();
    expect(untouched.prepaid_amount).toBeNull();
    expect(untouched.prepaid_method).toBeNull();

    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'void' });
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);
    expect(await db('annual_prepay_terms').where({ id: fx.term.id }).first()).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel' }));
    // The voided plan's unlinked future visit is taken off the calendar (a
    // live termite visit left there would, conservatively, make the sweep
    // ask staff to confirm which stations instead of raising the task).
    await db('scheduled_services').where({ id: futureVisit.id }).update({ status: 'cancelled' });

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: null, termId: fx.term.id }));
  });

  test('installed but NEVER anchored (the anchor did not land), then voided: the completed installation still makes it due', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await unpaidDeclinedAwaitingInstall(db);
    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'void' });
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);

    // Not installed yet: nothing to retrieve.
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });

    await db('scheduled_services').insert({
      customer_id: fx.customerId, source_estimate_id: fx.estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: fx.today,
    });
    expect((await db('annual_prepay_terms').where({ id: fx.term.id }).first()).installation_anchored_at).toBeNull();
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: null }));
  });
  // #4940 pre-push P1: an installed plan the anchor never landed on still
  // carries its PROVISIONAL term_end — the retrieval waits for the real end
  // the anchor's own rule derives (installation date + 12 months).
  async function unanchoredPaidDecline(db, { installedMonthsAgo }) {
    const customerId = randomUUID();
    const today = etToday();
    const signedOn = addMonths(today, -14);
    await db('customers').insert({ id: customerId, first_name: 'Jane', last_name: 'Doe' });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'paid', paid_at: new Date(`${signedOn}T17:00:00Z`), stripe_payment_intent_id: `pi_${randomUUID()}`,
    }).returning('*');
    const installedOn = addMonths(today, -installedMonthsAgo);
    await db('scheduled_services').insert({
      customer_id: customerId, source_estimate_id: estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: installedOn,
    });
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
      // Provisional (signing + 12 months): already in the past.
      term_end: addMonths(signedOn, 12),
      status: 'cancelled',
      renewal_decision: 'cancel',
      cancel_disposition: 'end_at_term',
      annual_plan_version: 'v3',
      created_at: new Date(`${signedOn}T16:00:00Z`),
    }).returning('*');
    const fx = {
      customerId, today, estimate, invoice, term, installedOn,
    };
    await portalDeclineRow(db, fx);
    return fx;
  }

  test('unanchored PAID plan, provisional term_end past, installed 2 months ago: not due — the real end is installation + 12 months', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask } = await load();
    const fx = await unanchoredPaidDecline(db, { installedMonthsAgo: 2 });
    expect(ymd(fx.term.term_end) < fx.today).toBe(true);

    // A candidate (past provisional term_end + installation evidence), but
    // not due: nothing raised, nothing settled.
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: fx.today })).toEqual({ scanned: 1, raised: 0 });
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
    expect(await settledMarker(db, fx)).toBeUndefined();
  });

  test('unanchored PAID plan installed 13 months ago: due, dated to installation + 12 months (the anchor rule); no false correction bell', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await unanchoredPaidDecline(db, { installedMonthsAgo: 13 });
    const { addMonthsSameDay } = jest.requireActual('../utils/date-only');
    const realEnd = addMonthsSameDay(fx.installedOn, 12);
    expect(realEnd < fx.today).toBe(true);
    expect(realEnd > ymd(fx.term.term_end)).toBe(true);

    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: fx.today })).toEqual({ scanned: 1, raised: 1 });
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: realEnd, termId: fx.term.id }));
    expect((await settledMarker(db, fx)).metadata).toEqual(expect.objectContaining({ outcome: 'raised', retrieve_after: realEnd }));
    // The correction pass reads the same derived end, never the provisional
    // term_end — no "date moved earlier" bell.
    await Renewals.raisePendingDeclineRetrievalTasks({ today: fx.today });
    expect(notifyAdmin.mock.calls.filter((c) => String(c[3]?.dedupeKey || '').endsWith(':date_moved_earlier'))).toHaveLength(0);
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
  });

  // #4940 pre-push P1: the paid follow-through of a declined pending term
  // stamps billing_mode 'annual_prepay' only while the term covers today.
  async function unpaidDeclinedPlan(db, Renewals, { expired }) {
    await db.raw('ALTER TABLE customers ADD COLUMN billing_mode text, ADD COLUMN updated_at timestamptz');
    await db.raw('ALTER TABLE invoices ADD COLUMN scheduled_service_id uuid, ADD COLUMN annual_prepay_covered_term_id uuid, ADD COLUMN payer_id uuid, ADD COLUMN payment_recorded_at timestamptz');
    const fx = await paidInstalledTerm(db);
    await db('customers').where({ id: fx.customerId }).update({ billing_mode: 'per_application' });
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'sent', paid_at: null });
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ status: 'payment_pending' });
    const declined = await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    expect(declined).toEqual(expect.objectContaining({ ok: true, unpaid: true }));
    if (expired) {
      // The whole year has run out while the invoice stayed unpaid.
      const termStart = addMonths(fx.today, -14);
      await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_start: termStart, term_end: addMonths(termStart, 12) });
    }
    const term = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    // A covered visit completed inside the year and billed per visit (open
    // invoice): the historical payment's reconcile settles it as covered.
    const [completed] = await db('scheduled_services').insert({
      customer_id: fx.customerId, annual_prepay_term_id: fx.term.id, status: 'completed',
      service_type: 'Termite Monitoring Visit', scheduled_date: addMonths(ymd(term.term_start), 1),
    }).returning('*');
    const [visitInvoice] = await db('invoices').insert({ customer_id: fx.customerId, status: 'sent', scheduled_service_id: completed.id }).returning('*');
    return { ...fx, term, visitInvoice };
  }

  const settleInvoiceModule = () => ({ settleInvoiceAsAnnualPrepayCovered: jest.fn(async () => ({ settled: true })) });

  test('unpaid decline PAID BEFORE term_end: covered decided lapse, billing_mode annual_prepay, historical visit reconciled', async () => {
    const invoiceModule = settleInvoiceModule();
    const { db, Renewals } = await load({ invoiceModule });
    const fx = await unpaidDeclinedPlan(db, Renewals, { expired: false });

    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'paid', paid_at: new Date() });
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);

    const after = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(after).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel' }));
    expect(await Renewals.isPaidDecidedLapseTerm(after, db)).toBe(true);
    expect((await db('customers').where({ id: fx.customerId }).first()).billing_mode).toBe('annual_prepay');
    expect(invoiceModule.settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledWith(fx.visitInvoice.id, fx.term.id);
  });

  test('unpaid decline PAID AFTER term_end: still a decided lapse and reconciled, but billing_mode is left — never annual_prepay on expired coverage', async () => {
    const invoiceModule = settleInvoiceModule();
    const { db, Renewals } = await load({ invoiceModule });
    const fx = await unpaidDeclinedPlan(db, Renewals, { expired: true });
    expect(ymd(fx.term.term_end) < fx.today).toBe(true);

    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'paid', paid_at: new Date() });
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);

    const after = await db('annual_prepay_terms').where({ id: fx.term.id }).first();
    expect(after).toEqual(expect.objectContaining({ status: 'cancelled', renewal_decision: 'cancel' }));
    expect((await db('customers').where({ id: fx.customerId }).first()).billing_mode).toBe('per_application');
    expect(invoiceModule.settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledWith(fx.visitInvoice.id, fx.term.id);
    // A replayed payment sync neither activates it nor stamps the mode.
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);
    expect((await db('annual_prepay_terms').where({ id: fx.term.id }).first()).status).toBe('cancelled');
    expect((await db('customers').where({ id: fx.customerId }).first()).billing_mode).toBe('per_application');
  });
  // #4940 pre-push P1: installed, declined while UNPAID, and the invoice never
  // resolves (still payment_pending + 'cancel'). Once the installation-derived
  // end passes: ONE staff bell, settled on it — never a task, never a status
  // change.
  test('installed + unpaid decline + invoice never resolves: past the derived end, one staff bell, settled, no task; before it, nothing', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await unpaidDeclinedAwaitingInstall(db);
    expect(await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today }))
      .toEqual(expect.objectContaining({ ok: true, unpaid: true }));
    // Signed 14 months ago, installed 13 months ago, never paid (overdue).
    const signedOn = addMonths(fx.today, -14);
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({
      term_start: signedOn, term_end: addMonths(signedOn, 12), created_at: new Date(`${signedOn}T16:00:00Z`),
    });
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'overdue' });
    const installedOn = addMonths(fx.today, -13);
    await db('scheduled_services').insert({
      customer_id: fx.customerId, source_estimate_id: fx.estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: installedOn,
    });
    const { addMonthsSameDay } = jest.requireActual('../utils/date-only');
    const realEnd = addMonthsSameDay(installedOn, 12);
    const unpaidBells = () => notifyAdmin.mock.calls.filter((c) => String(c[3]?.dedupeKey || '').endsWith(':unpaid_plan'));

    // On the end date itself: not yet due — nothing.
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: realEnd })).toEqual({ scanned: 1, raised: 0 });
    expect(unpaidBells()).toHaveLength(0);
    expect(await settledMarker(db, fx)).toBeUndefined();

    // Past it: one staff bell, settled on it, no task.
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: fx.today })).toEqual({ scanned: 1, raised: 0 });
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
    expect(unpaidBells()).toHaveLength(1);
    expect(unpaidBells()[0][2]).toContain('the plan was never paid');
    expect(unpaidBells()[0][2]).toContain('decide on collection and station retrieval');
    expect((await settledMarker(db, fx)).metadata).toEqual(expect.objectContaining({ outcome: 'unpaid_plan', retrieve_after: realEnd }));
    // Billing status untouched: the term and its invoice are as they were.
    expect(await db('annual_prepay_terms').where({ id: fx.term.id }).first())
      .toEqual(expect.objectContaining({ status: 'payment_pending', renewal_decision: 'cancel' }));
    expect((await db('invoices').where({ id: fx.invoice.id }).first()).status).toBe('overdue');

    // Settled: the next sweep neither re-bells nor raises.
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: fx.today })).toEqual({ scanned: 0, raised: 0 });
    expect(unpaidBells()).toHaveLength(1);
    expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
  });

  test('an unpaid declined plan with NO completed installation is never a candidate, however late', async () => {
    const { db, Renewals, notifyAdmin } = await load();
    const fx = await unpaidDeclinedAwaitingInstall(db);
    await Renewals.declineTermiteAnnualRenewal({ customerId: fx.customerId, termId: fx.term.id, today: fx.today });
    const bellsBefore = notifyAdmin.mock.calls.length;
    expect(await Renewals.raisePendingDeclineRetrievalTasks({ today: addMonths(fx.today, 24) })).toEqual({ scanned: 0, raised: 0 });
    expect(notifyAdmin.mock.calls.length).toBe(bellsBefore);
  });
  // #4940 pre-push P1: a DELAYED installation anchor can resolve a paid term
  // to a coverage year that has already ended — billing_mode 'annual_prepay'
  // is stamped only while the anchored year covers today.
  async function paidTermAwaitingAnchor(db, { installedMonthsAgo, declined }) {
    await db.raw('ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_mode text, ADD COLUMN IF NOT EXISTS updated_at timestamptz');
    const customerId = randomUUID();
    const today = etToday();
    const signedOn = addMonths(today, -14);
    await db('customers').insert({
      id: customerId, first_name: 'Jane', last_name: 'Doe', billing_mode: 'per_application',
    });
    const [estimate] = await db('estimates').insert({ customer_id: customerId }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'paid', paid_at: new Date(`${signedOn}T17:00:00Z`), stripe_payment_intent_id: `pi_${randomUUID()}`,
    }).returning('*');
    const installedOn = addMonths(today, -installedMonthsAgo);
    await db('scheduled_services').insert({
      customer_id: customerId, source_estimate_id: estimate.id, status: 'completed',
      service_type: 'Termite Bait Station Installation', scheduled_date: installedOn,
    });
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
      term_end: addMonths(signedOn, 12),
      status: declined ? 'cancelled' : 'active',
      renewal_decision: declined ? 'cancel' : null,
      cancel_disposition: declined ? 'end_at_term' : null,
      annual_plan_version: 'v3',
      created_at: new Date(`${signedOn}T16:00:00Z`),
    }).returning('*');
    return {
      customerId, today, term, installedOn,
    };
  }
  const billingModeOf = async (db, customerId) => (await db('customers').where({ id: customerId }).first()).billing_mode;

  test.each([
    ['a paid decided lapse (declined before install)', true],
    ['an undecided active term', false],
  ])('anchor resolving to an EXPIRED year leaves billing_mode unchanged; a CURRENT year stamps it — %s', async (_label, declined) => {
    const { db, anchorTermToInstallation } = await load();
    const expired = await paidTermAwaitingAnchor(db, { installedMonthsAgo: 13, declined });
    const anchoredExpired = await anchorTermToInstallation({ termId: expired.term.id, conn: db });
    expect(anchoredExpired).toEqual(expect.objectContaining({ anchored: true, moved: true, termStart: expired.installedOn }));
    expect(anchoredExpired.termEnd < expired.today).toBe(true);
    expect(await billingModeOf(db, expired.customerId)).toBe('per_application');

    const current = await paidTermAwaitingAnchor(db, { installedMonthsAgo: 2, declined });
    const anchoredCurrent = await anchorTermToInstallation({ termId: current.term.id, conn: db });
    expect(anchoredCurrent).toEqual(expect.objectContaining({ anchored: true, moved: true }));
    expect(await billingModeOf(db, current.customerId)).toBe('annual_prepay');
  });

  // An unpaid term anchored (dates only) to a year that has since ended, then
  // paid late through the ordinary pending -> active payment sync.
  test('pending term anchored to an EXPIRED year, then paid: billing_mode unchanged; paid within its year: stamped', async () => {
    const { db, Renewals, anchorTermToInstallation } = await load();
    // Columns the pending -> active activation reads on the prepay invoice.
    await db.raw('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS scheduled_service_id uuid, ADD COLUMN IF NOT EXISTS line_items jsonb, ADD COLUMN IF NOT EXISTS annual_prepay_covered_term_id uuid, ADD COLUMN IF NOT EXISTS payer_id uuid, ADD COLUMN IF NOT EXISTS payment_recorded_at timestamptz, ADD COLUMN IF NOT EXISTS notes text, ADD COLUMN IF NOT EXISTS sent_at timestamptz, ADD COLUMN IF NOT EXISTS payer_statement_id uuid, ADD COLUMN IF NOT EXISTS credit_applied numeric, ADD COLUMN IF NOT EXISTS total numeric, ADD COLUMN IF NOT EXISTS amount_paid numeric, ADD COLUMN IF NOT EXISTS updated_at timestamptz, ADD COLUMN IF NOT EXISTS annual_prepay_term_id uuid');
    await db.raw('ALTER TABLE scheduled_services ADD COLUMN IF NOT EXISTS service_id uuid, ADD COLUMN IF NOT EXISTS pending_setup_fee numeric, ADD COLUMN IF NOT EXISTS recurring_parent_id uuid');
    const run = async (installedMonthsAgo) => {
      const fx = await paidTermAwaitingAnchor(db, { installedMonthsAgo, declined: false });
      await db('invoices').where({ id: fx.term.prepay_invoice_id }).update({ status: 'sent', paid_at: null });
      await db('annual_prepay_terms').where({ id: fx.term.id }).update({ status: 'payment_pending' });
      expect(await anchorTermToInstallation({ termId: fx.term.id, conn: db })).toEqual(expect.objectContaining({ anchored: true }));
      await db('invoices').where({ id: fx.term.prepay_invoice_id }).update({ status: 'paid', paid_at: new Date() });
      await Renewals.syncTermForInvoicePayment(fx.term.prepay_invoice_id, db);
      return fx;
    };
    const expired = await run(13);
    expect(await billingModeOf(db, expired.customerId)).toBe('per_application');
    const current = await run(2);
    expect((await db('annual_prepay_terms').where({ id: current.term.id }).first()).status).toBe('active');
    expect(await billingModeOf(db, current.customerId)).toBe('annual_prepay');
  });
  // Codex #4940 r11 P1: opening the bell marks the task READ — that is not
  // the retrieval. A read task still gets the date correction.
  test('a READ task, then term_end extended: a replacement task at the new date plus a correction bell; once only', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await dueDeclinedTerm(db);
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    // Staff open the bell (NotificationBell marks it read) — stations still in.
    await db('notifications').whereRaw("metadata->>'churnEpisode' = 'portal_renewal_decline'").update({ read_at: new Date() });

    const later = dayOffset(fx.today, 20);
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: later });
    await Renewals.raisePendingDeclineRetrievalTasks();

    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(2);
    expect(raiseTermiteRetrievalTask).toHaveBeenLastCalledWith(fx.customerId, null, expect.objectContaining({ retrieveAfter: later, termId: fx.term.id }));
    const tasks = await db('notifications').whereRaw("metadata->>'churnEpisode' = 'portal_renewal_decline'").orderBy('created_at', 'asc').select('metadata', 'read_at');
    expect(tasks.map((r) => r.metadata.retrieveAfter)).toEqual([fx.termEnd, later]);
    expect(tasks[1].read_at).toBeNull();
    const laterBells = notifyAdmin.mock.calls.filter((c) => String(c[3]?.dedupeKey || '').endsWith(':date_moved_later'));
    expect(laterBells).toHaveLength(1);
    expect(laterBells[0][2]).toContain('later than the earlier station-retrieval task said');
    const latestMarker = await db('activity_log').where({ action: 'termite_annual_decline_retrieval' }).orderBy('created_at', 'desc').first();
    expect(latestMarker.metadata).toEqual(expect.objectContaining({ outcome: 'raised', retrieve_after: later }));

    // The latest task now matches the end: nothing more.
    await Renewals.raisePendingDeclineRetrievalTasks();
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(2);
    expect(notifyAdmin.mock.calls.filter((c) => String(c[3]?.dedupeKey || '').endsWith(':date_moved_later'))).toHaveLength(1);
  });

  test('a READ task whose date still matches the retrieval end: nothing is re-raised or belled', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    await dueDeclinedTerm(db);
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    await db('notifications').whereRaw("metadata->>'churnEpisode' = 'portal_renewal_decline'").update({ read_at: new Date() });
    const bellsBefore = notifyAdmin.mock.calls.length;

    await Renewals.raisePendingDeclineRetrievalTasks();
    await Renewals.raisePendingDeclineRetrievalTasks();
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls.length).toBe(bellsBefore);
  });

  test('a READ task dated more than six months back is outside the correction scan', async () => {
    const { db, Renewals, raiseTermiteRetrievalTask, notifyAdmin } = await load();
    const fx = await dueDeclinedTerm(db);
    const old = addMonths(fx.today, -7);
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: old });
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });
    await db('notifications').whereRaw("metadata->>'churnEpisode' = 'portal_renewal_decline'").update({ read_at: new Date() });
    const bellsBefore = notifyAdmin.mock.calls.length;

    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ term_end: dayOffset(old, 30) });
    await Renewals.raisePendingDeclineRetrievalTasks();
    expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls.length).toBe(bellsBefore);
  });
  // #4940 pre-push P1: a declined pending term paid AFTER term_end settles
  // first, then reconciles history. A failed reconcile is retried by the
  // covered-terms sweep (expired terms included) until it completes, and the
  // completion marker stops further runs.
  test('paid after term_end, reconcile fails once: the next sweep reconciles, marks it, then never runs again', async () => {
    const holder = {};
    const settleInvoiceAsAnnualPrepayCovered = jest.fn()
      .mockRejectedValueOnce(new Error('settle blew up'))
      .mockImplementation(async (invoiceId, termId) => {
        // What the real settle leaves: the invoice covered by this term, so
        // a re-run of the reconcile skips it.
        await holder.db('invoices').where({ id: invoiceId }).update({ annual_prepay_covered_term_id: termId });
        return { settled: true };
      });
    const { db, Renewals } = await load({ invoiceModule: { settleInvoiceAsAnnualPrepayCovered } });
    holder.db = db;
    const fx = await unpaidDeclinedPlan(db, Renewals, { expired: true });
    const reconciledMarker = () => db('activity_log').where({ action: 'annual_prepay_paid_lapse_reconciled' })
      .whereRaw("metadata->>'term_id' = ?", [fx.term.id]).select('metadata');

    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'paid', paid_at: new Date() });
    await Renewals.syncTermForInvoicePayment(fx.invoice.id, db);
    expect((await db('annual_prepay_terms').where({ id: fx.term.id }).first()).status).toBe('cancelled');
    expect(settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledTimes(1);
    expect(await reconciledMarker()).toHaveLength(0);

    // The daily sweep retries the expired, unmarked paid lapse.
    await Renewals.reconcileCoveredTermsSweep();
    expect(settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledTimes(2);
    expect(settleInvoiceAsAnnualPrepayCovered).toHaveBeenLastCalledWith(fx.visitInvoice.id, fx.term.id);
    expect((await db('invoices').where({ id: fx.visitInvoice.id }).first()).annual_prepay_covered_term_id).toBe(fx.term.id);
    const markers = await reconciledMarker();
    expect(markers).toHaveLength(1);
    expect(markers[0].metadata).toEqual(expect.objectContaining({ settled: 1 }));

    // Marked: no further runs, and billing_mode still untouched.
    await Renewals.reconcileCoveredTermsSweep();
    expect(settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledTimes(2);
    expect(await reconciledMarker()).toHaveLength(1);
    expect((await db('customers').where({ id: fx.customerId }).first()).billing_mode).toBe('per_application');
  });

  test('a paid decided lapse that was never declined while unpaid is not a retry candidate', async () => {
    const invoiceModule = settleInvoiceModule();
    const { db, Renewals } = await load({ invoiceModule });
    const fx = await unpaidDeclinedPlan(db, Renewals, { expired: true });
    // As if declined while already paid: no unpaid flag on the decline row.
    await db('activity_log').where({ action: 'termite_annual_renewal_declined' }).update({ metadata: db.raw("metadata - 'unpaid'") });
    await db('annual_prepay_terms').where({ id: fx.term.id }).update({ status: 'cancelled' });
    await db('invoices').where({ id: fx.invoice.id }).update({ status: 'paid', paid_at: new Date() });

    await Renewals.reconcileCoveredTermsSweep();
    expect(invoiceModule.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
  });
});

