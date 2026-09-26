/**
 * Real PostgreSQL: the termite annual plan's installation anchor and durable
 * install-scheduling handoff (Codex round 4 on #4819), driven through
 * reconcileTermiteAnnualActivations against a scratch schema built by the
 * real 20260925000001..000006 migrations. The candidate scans, the
 * per-customer advisory lock, the installation floor, the overlap check
 * (admin-customers' own status clause), the plan-scoped installation rule
 * (estimate / term link, same property, sole property — codex round 6) and
 * the stamps all run as real SQL.
 * The term window edit itself is createTermForAnnualPrepay's (covered by
 * its own suites) and is stubbed here to the column move it performs; the
 * admin bell is mocked at its module boundary.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-install-anchor-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

// Each test builds a scratch schema through 8 real migrations — on a
// loaded machine (load average ~60) that ran past jest's 5s default and
// failed six tests in one run while passing 32/32 on the next.
jest.setTimeout(60000);

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
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
  const schema = `termite_anchor_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // accepted_at: slice 3b's parkedAt fallback (parkedAtForEstimate) — reads
  // this real column even though this suite never exercises the abandoned-
  // signature passes themselves.
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, property_id uuid, accepted_at timestamptz)');
  await db.raw('CREATE TABLE customer_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    status text,
    sent_at timestamptz,
    sms_sent_at timestamptz,
    email_sent_at timestamptz,
    paid_at timestamptz,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Read by the candidate scans' paid-decided-lapse EXISTS (the real
  // coveredTermsAsOf refund check): a full refund of the prepay invoice's
  // payment un-covers a declined term.
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  // The countersign reminder only reminds what the Requests queue can show
  // (non-archived customers).
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz)');
  // 20260925030001's countersigned_by FK target.
  await db.raw('CREATE TABLE technicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  // share_token_hash/expires_at + cancelled_at/reason + created_at/updated_at:
  // slice 3b's nudge + hard-expiry passes read/write these real columns
  // (predate the slice-3a migrations — 20260511000002_contract_signing_workflow)
  // even though this suite never exercises those passes itself.
  await db.raw(`CREATE TABLE customer_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    document_template_key text,
    status text,
    share_token_hash text,
    share_token_expires_at timestamptz,
    signed_at timestamptz,
    signed_name text,
    cancelled_at timestamptz,
    cancelled_reason text,
    document_variables_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Countersign reminder rotation marker (customer FK omitted in this fixture).
  await db.raw(`CREATE TABLE customer_contract_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id uuid NOT NULL REFERENCES customer_contracts(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL,
    event_type varchar(60) NOT NULL,
    actor_type varchar(30) NOT NULL DEFAULT 'system',
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw('CREATE TABLE payment_method_consents (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw(`CREATE TABLE scheduled_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    source_estimate_id uuid,
    annual_prepay_term_id uuid,
    property_id uuid,
    status text,
    service_type text,
    scheduled_date date
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    source_estimate_id uuid,
    prepay_invoice_id uuid,
    plan_label text,
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
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

describeOrSkip('termite annual installation anchor + install handoff — real Postgres', () => {
  let fixture;
  let ids;

  // Signed and activated on 2026-09-25; the provisional term runs from the
  // signature day.
  const SIGNED_ON = '2026-09-25';

  beforeEach(async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const customerId = randomUUID();
    const [estimate] = await db('estimates').insert({
      customer_id: customerId,
      annual_plan_activation_status: 'activated',
      annual_plan_activated_at: new Date(`${SIGNED_ON}T16:00:00Z`),
      annual_plan_install_handoff_at: new Date(`${SIGNED_ON}T16:00:05Z`),
      annual_plan_deferred_invoice: JSON.stringify({ version: 1, requestedFirstVisit: { date: '2026-10-14', windowStart: '09:00:00' } }),
      annual_plan_signature_charge: JSON.stringify({ status: 'paid' }),
    }).returning('*');
    const [invoice] = await db('invoices').insert({ customer_id: customerId, status: 'paid', sent_at: new Date() }).returning('*');
    const [contract] = await db('customer_contracts').insert({
      customer_id: customerId,
      document_template_key: ANNUAL_TEMPLATE_KEY,
      status: 'signed',
      signed_at: new Date(`${SIGNED_ON}T15:59:00Z`),
      document_variables_snapshot: JSON.stringify({ estimate: { id: estimate.id } }),
    }).returning('*');
    const [term] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      source_estimate_id: estimate.id,
      prepay_invoice_id: invoice.id,
      plan_label: 'WaveGuard Bronze Annual Prepay',
      term_start: SIGNED_ON,
      term_end: '2027-09-25',
      status: 'active',
      created_at: new Date(`${SIGNED_ON}T16:00:00Z`),
    }).returning('*');
    ids = {
      customerId, estimateId: estimate.id, invoiceId: invoice.id, contractId: contract.id, termId: term.id,
    };
  });

  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (fixture) await fixture.destroy();
  });

  function load({ notifyAdminImpl } = {}) {
    const { db } = fixture;
    const notifyAdmin = jest.fn(notifyAdminImpl || (async () => ({ id: randomUUID(), deduped: false })));
    // Stands in for createTermForAnnualPrepay's window edit: the column move
    // it performs on the matched term (its detach/coverage/renewal-date
    // follow-through is covered by the annual-prepay-renewals suites).
    // Both record whether the term was already anchored when they ran:
    // coverage seeding is deferred until the anchor stamp exists, so the
    // window edit / refresh must run after it.
    const anchoredWhenRefreshed = [];
    const createTermForAnnualPrepay = jest.fn(async ({
      sourceEstimateId, termStart, termEnd, conn,
    }) => {
      const before = await conn('annual_prepay_terms').where({ source_estimate_id: sourceEstimateId }).first();
      anchoredWhenRefreshed.push(Boolean(before.installation_anchored_at));
      const [updated] = await conn('annual_prepay_terms').where({ source_estimate_id: sourceEstimateId })
        .update({ term_start: termStart, term_end: termEnd }).returning('*');
      return updated;
    });
    const raiseRetrievalAfterAnchor = jest.fn(async () => ({ raised: true }));
    const refreshTermSnapshot = jest.fn(async (termId, conn) => {
      const term = await conn('annual_prepay_terms').where({ id: termId }).first();
      anchoredWhenRefreshed.push(Boolean(term.installation_anchored_at));
      return term;
    });
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    // Only the window edit is stubbed: the paid-coverage test for a
    // decided-lapse term (coveredTermsAsOf / isPaidDecidedLapseTerm) runs
    // for real against this schema, the same one billing uses.
    jest.doMock('../services/annual-prepay-renewals', () => {
      const actual = jest.requireActual('../services/annual-prepay-renewals');
      return {
        coveredTermsAsOf: actual.coveredTermsAsOf,
        isPaidDecidedLapseTerm: actual.isPaidDecidedLapseTerm,
        createTermForAnnualPrepay,
        refreshTermSnapshot,
        // The portal-decline station-retrieval raise (real SQL covered in
        // termite-annual-renewal-decline-coverage-postgres.test.js).
        raiseRetrievalAfterAnchor,
        raisePendingDeclineRetrievalTasks: jest.fn(async () => ({ scanned: 0, raised: 0 })),
        revalidateDueDeclineRetrievalTasks: jest.fn(async () => ({ checked: 0, withdrawn: 0 })),
      };
    });
    const { reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      sweep: (opts = {}) => reconcileTermiteAnnualActivations({ conn: db, ...opts }),
      notifyAdmin,
      createTermForAnnualPrepay,
      refreshTermSnapshot,
      raiseRetrievalAfterAnchor,
      anchoredWhenRefreshed,
      db,
    };
  }

  const addVisit = (db, fields) => db('scheduled_services').insert({
    customer_id: ids.customerId, status: 'completed', service_type: 'Termite Bait Station Installation', ...fields,
  }).returning('*').then(([row]) => row);
  const readTerm = async (db) => db('annual_prepay_terms').where({ id: ids.termId }).first();
  // A two-property customer whose plan estimate is recorded at property A.
  const twoProperties = async (db, { estimateAtA = true } = {}) => {
    const [a] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
    const [b] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
    if (estimateAtA) await db('estimates').where({ id: ids.estimateId }).update({ property_id: a.id });
    return { propertyA: a.id, propertyB: b.id };
  };

  test('a completed installation re-anchors the original term to the install date + 12 months, exactly once', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    const install = await addVisit(db, { scheduled_date: '2026-10-14' });

    const counts = await sweep();

    expect(counts).toMatchObject({ anchorScanned: 1, anchored: 1, anchorFailed: 0 });
    // Every pass ran its real SQL against the migrated schema.
    expect(Object.keys(counts).filter((key) => key.endsWith('ScanError'))).toEqual([]);
    expect(createTermForAnnualPrepay).toHaveBeenCalledTimes(1);
    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
      customerId: ids.customerId,
      sourceEstimateId: ids.estimateId,
      prepayInvoiceId: ids.invoiceId,
      planLabel: 'WaveGuard Bronze Annual Prepay',
      termStart: '2026-10-14',
      termEnd: '2027-10-14',
    }));
    const term = await readTerm(db);
    expect(ymd(term.term_start)).toBe('2026-10-14');
    expect(ymd(term.term_end)).toBe('2027-10-14');
    expect(term.installation_anchored_at).toBeInstanceOf(Date);
    expect(term.installation_anchor_visit_id).toBe(install.id);

    // A later reschedule-and-complete of another bait visit never moves an
    // anchored term again.
    await addVisit(db, { scheduled_date: '2026-11-02' });
    const again = await sweep();
    expect(again.anchorScanned).toBe(0);
    expect(createTermForAnnualPrepay).toHaveBeenCalledTimes(1);
  });

  test('an installation on the provisional start day stamps the anchor without editing the window', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    await addVisit(db, { scheduled_date: SIGNED_ON });

    expect((await sweep()).anchored).toBe(1);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect((await readTerm(db)).installation_anchored_at).toBeInstanceOf(Date);
  });

  test('only a COMPLETED termite bait/station visit anchors — a booked one, or other termite work, does not', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    await addVisit(db, { scheduled_date: '2026-10-14', status: 'confirmed' });
    await addVisit(db, { scheduled_date: '2026-10-03', service_type: 'Termite Spot Treatment' });

    expect((await sweep()).anchorScanned).toBe(0);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect((await readTerm(db)).installation_anchored_at).toBeNull();
  });

  test('a permanently failing anchor rotates out of the bounded batch instead of starving newer installations (codex #4819 r7 P2)', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    // The fixture's (older) term fails its window edit every time.
    await addVisit(db, { scheduled_date: '2026-10-14' });
    createTermForAnnualPrepay.mockImplementation(async ({ sourceEstimateId, termStart, termEnd, conn }) => {
      if (sourceEstimateId === ids.estimateId) throw new Error('window edit refused');
      const [updated] = await conn('annual_prepay_terms').where({ source_estimate_id: sourceEstimateId })
        .update({ term_start: termStart, term_end: termEnd }).returning('*');
      return updated;
    });
    // A second, newer activated plan with its own completed installation.
    const otherCustomer = randomUUID();
    const [otherEstimate] = await db('estimates').insert({
      customer_id: otherCustomer,
      annual_plan_activation_status: 'activated',
      annual_plan_activated_at: new Date('2026-09-26T16:00:00Z'),
      annual_plan_install_handoff_at: new Date('2026-09-26T16:00:05Z'),
      annual_plan_signature_charge: JSON.stringify({ status: 'paid' }),
    }).returning('*');
    const [otherTerm] = await db('annual_prepay_terms').insert({
      customer_id: otherCustomer,
      source_estimate_id: otherEstimate.id,
      plan_label: 'WaveGuard Bronze Annual Prepay',
      term_start: '2026-09-26',
      term_end: '2027-09-26',
      status: 'active',
      created_at: new Date('2026-09-26T16:00:00Z'),
    }).returning('*');
    await db('scheduled_services').insert({
      customer_id: otherCustomer, status: 'completed', service_type: 'Termite Bait Station Installation', scheduled_date: '2026-10-20',
    });

    const first = await sweep({ limit: 1 });
    expect(first).toMatchObject({ anchorScanned: 1, anchored: 0, anchorFailed: 1 });
    expect((await readTerm(db)).installation_anchor_attempted_at).toBeInstanceOf(Date);

    const second = await sweep({ limit: 1 });
    expect(second).toMatchObject({ anchorScanned: 1, anchored: 1 });
    const other = await db('annual_prepay_terms').where({ id: otherTerm.id }).first();
    expect(other.installation_anchored_at).toBeInstanceOf(Date);
    expect(ymd(other.term_start)).toBe('2026-10-20');
  });

  test('the schedule\'s "Termite Installation Setup" service anchors; a Bora-Care install does not', async () => {
    const { sweep, db } = load();
    await addVisit(db, { scheduled_date: '2026-10-02', service_type: 'Termite Bora-Care Install' });
    const install = await addVisit(db, { scheduled_date: '2026-10-14', service_type: 'Termite Installation Setup' });

    expect((await sweep()).anchored).toBe(1);
    const term = await readTerm(db);
    expect(term.installation_anchor_visit_id).toBe(install.id);
  });

  test('a bait visit from before the plan was activated (an older program) never anchors it', async () => {
    const { sweep, db } = load();
    await addVisit(db, { scheduled_date: '2026-03-10' });

    expect((await sweep()).anchorScanned).toBe(0);
    expect(ymd((await readTerm(db)).term_start)).toBe(SIGNED_ON);
  });

  test('a renewed term (successor exists, or a renewal decision recorded) is never re-anchored', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    await addVisit(db, { scheduled_date: '2026-10-14' });
    await db('annual_prepay_terms').insert({
      customer_id: ids.customerId, term_start: '2027-09-26', term_end: '2028-09-25', status: 'payment_pending', renewed_from_term_id: ids.termId,
    });

    const counts = await sweep();
    expect(counts.anchored).toBe(0);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();

    await db('annual_prepay_terms').where({ renewed_from_term_id: ids.termId }).del();
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ renewal_decision: 'renew' });
    expect((await sweep()).anchored).toBe(0);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
  });

  // Codex round-1 P1: online decline is now available BEFORE installation
  // (reversing the earlier "paid, installed plan only" restriction) — the
  // decided-lapse original term (status 'cancelled', renewal_decision
  // 'cancel') still needs its already-paid coverage year anchored once the
  // installation happens; only the FUTURE renewal was refused.
  test('a term the customer declined to renew BEFORE installation still anchors once the installation completes', async () => {
    const { sweep, createTermForAnnualPrepay, raiseRetrievalAfterAnchor, db } = load();
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled', renewal_decision: 'cancel' });
    const install = await addVisit(db, { scheduled_date: '2026-10-14' });

    const counts = await sweep();

    expect(counts).toMatchObject({ anchorScanned: 1, anchored: 1, anchorFailed: 0 });
    expect(createTermForAnnualPrepay).toHaveBeenCalledTimes(1);
    const term = await readTerm(db);
    expect(term.installation_anchored_at).toBeInstanceOf(Date);
    expect(term.installation_anchor_visit_id).toBe(install.id);
    // The decision itself is untouched by the anchor — only the coverage
    // window moved.
    expect(term.status).toBe('cancelled');
    expect(term.renewal_decision).toBe('cancel');
    // Codex #4940 r5: once anchored (committed), the declined term's dated
    // station-retrieval task is raised against its real term_end.
    expect(raiseRetrievalAfterAnchor).toHaveBeenCalledTimes(1);
    expect(raiseRetrievalAfterAnchor).toHaveBeenCalledWith(ids.termId);
  });

  test('an UNDECIDED term that anchors raises no decline retrieval task', async () => {
    const { sweep, raiseRetrievalAfterAnchor, db } = load();
    await addVisit(db, { scheduled_date: '2026-10-14' });
    expect(await sweep()).toMatchObject({ anchored: 1 });
    expect(raiseRetrievalAfterAnchor).not.toHaveBeenCalled();
  });

  // A void/refund 'cancelled' term (renewal_decision NULL — never a customer
  // decline) never had coverage happen and must never be anchored, even if
  // a termite bait/station visit later gets recorded on the account.
  test('a refunded/voided term (cancelled, no renewal decision) is never anchored', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled', renewal_decision: null });
    await addVisit(db, { scheduled_date: '2026-10-14' });

    const counts = await sweep();

    expect(counts).toMatchObject({ anchorScanned: 0, anchored: 0 });
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect((await readTerm(db)).installation_anchored_at).toBeNull();
  });

  test('a moved window that would overlap another live annual term is refused with a bell — nothing moves, retried later', async () => {
    const { sweep, createTermForAnnualPrepay, notifyAdmin, db } = load();
    await addVisit(db, { scheduled_date: '2026-10-14' });
    const [other] = await db('annual_prepay_terms').insert({
      customer_id: ids.customerId, term_start: '2027-10-01', term_end: '2028-09-30', status: 'active',
    }).returning('*');

    const counts = await sweep();

    expect(counts).toMatchObject({ anchored: 0, anchorFailed: 1 });
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect((await readTerm(db)).installation_anchored_at).toBeNull();
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.stringContaining('coverage not moved'), expect.stringContaining(other.id),
      expect.objectContaining({ dedupeKey: `termite-annual-activation:${ids.estimateId}:anchor_overlap` }),
    );
  });

  test('install handoff: an activated plan whose scheduling bell never landed is re-belled and stamped', async () => {
    const { sweep, notifyAdmin, db } = load();
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });

    const counts = await sweep();

    expect(counts).toMatchObject({ handoffScanned: 1, handedOff: 1, handoffFailed: 0 });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.stringContaining('schedule the installation'), expect.stringContaining('2026-10-14 (09:00 window)'),
      expect.objectContaining({
        dedupeKey: `termite-annual-activation:${ids.estimateId}:schedule_first_visit`,
        metadata: expect.objectContaining({ contractId: ids.contractId }),
      }),
    );
    expect((await db('estimates').where({ id: ids.estimateId }).first()).annual_plan_install_handoff_at).toBeInstanceOf(Date);

    notifyAdmin.mockClear();
    expect((await sweep()).handoffScanned).toBe(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('install handoff: a plan the customer declined to RENEW before installation still gets its scheduling bell (a paid year); a refunded one does not', async () => {
    const { sweep, db } = load();
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled', renewal_decision: 'cancel' });
    expect((await sweep()).handoffScanned).toBe(1);

    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled', renewal_decision: null });
    expect((await sweep()).handoffScanned).toBe(0);
  });

  // Codex pre-push P1: the decided-lapse shape is status-only — a decline
  // followed by a full refund (or a disputed invoice) still reads
  // 'cancelled' + 'cancel', but billing no longer covers that year. Such a
  // term must never get an install-scheduling bell nor be anchored, and it
  // must not even be a scan candidate (so it can't hold a `limit` slot).
  test.each([
    ['a full refund of the prepay payment', async (db) => {
      await db('invoices').where({ id: ids.invoiceId }).update({ stripe_payment_intent_id: 'pi_declined_then_refunded' });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: 'pi_declined_then_refunded' });
    }],
    ['a disputed prepay invoice', async (db) => {
      await db('invoices').where({ id: ids.invoiceId }).update({ status: 'overdue', paid_at: null });
    }],
  ])('decline then %s: no install-handoff bell, no anchor — sweep and direct anchor both refuse', async (_label, unPay) => {
    const { sweep, notifyAdmin, createTermForAnnualPrepay, refreshTermSnapshot, db } = load();
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled', renewal_decision: 'cancel' });
    await addVisit(db, { scheduled_date: '2026-10-14' });
    await unPay(db);

    const counts = await sweep();

    expect(Object.keys(counts).filter((key) => key.endsWith('ScanError'))).toEqual([]);
    expect(counts).toMatchObject({
      anchorScanned: 0, anchored: 0, anchorFailed: 0, handoffScanned: 0, handedOff: 0, handoffFailed: 0,
    });
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(refreshTermSnapshot).not.toHaveBeenCalled();
    const estimate = await db('estimates').where({ id: ids.estimateId }).first('annual_plan_install_handoff_at');
    expect(estimate.annual_plan_install_handoff_at).toBeNull();

    // The direct anchor (under its lock) refuses the same term too.
    const { anchorTermToInstallation } = require('../services/termite-annual-activation');
    expect(await anchorTermToInstallation({ termId: ids.termId, conn: db })).toEqual({ skipped: 'not_original_term' });
    const term = await readTerm(db);
    expect(term.installation_anchored_at).toBeNull();
    expect(term.installation_anchor_visit_id).toBeNull();
    expect(term.status).toBe('cancelled');
    expect(term.renewal_decision).toBe('cancel');
  });

  test('a still-PAID decline sitting next to an un-paid (refunded) decline: only the paid one is scanned, bell rung and anchored', async () => {
    const { sweep, db } = load({});
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled', renewal_decision: 'cancel' });
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    // A second, OLDER plan (activated first, so it sorts ahead under
    // limit 1) whose decline was followed by a full refund.
    const otherCustomer = randomUUID();
    const [otherEstimate] = await db('estimates').insert({
      customer_id: otherCustomer,
      annual_plan_activation_status: 'activated',
      annual_plan_activated_at: new Date('2026-09-01T16:00:00Z'),
      annual_plan_install_handoff_at: null,
    }).returning('*');
    const [otherInvoice] = await db('invoices').insert({ customer_id: otherCustomer, status: 'paid', stripe_payment_intent_id: 'pi_other_refunded' }).returning('*');
    await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: 'pi_other_refunded' });
    const [otherTerm] = await db('annual_prepay_terms').insert({
      customer_id: otherCustomer,
      source_estimate_id: otherEstimate.id,
      prepay_invoice_id: otherInvoice.id,
      term_start: '2026-09-01',
      term_end: '2027-09-01',
      status: 'cancelled',
      renewal_decision: 'cancel',
      created_at: new Date('2026-09-01T16:00:00Z'),
    }).returning('*');
    await db('scheduled_services').insert({
      customer_id: otherCustomer, source_estimate_id: otherEstimate.id, status: 'completed', service_type: 'Termite Bait Station Installation', scheduled_date: '2026-10-01',
    });

    const handoffOnly = await sweep({ limit: 1 });
    expect(handoffOnly).toMatchObject({ handoffScanned: 1, handedOff: 1 });
    expect((await db('estimates').where({ id: ids.estimateId }).first()).annual_plan_install_handoff_at).toBeInstanceOf(Date);
    expect((await db('estimates').where({ id: otherEstimate.id }).first()).annual_plan_install_handoff_at).toBeNull();

    const install = await addVisit(db, { scheduled_date: '2026-10-14' });
    expect(await sweep({ limit: 1 })).toMatchObject({ anchorScanned: 1, anchored: 1 });
    expect((await readTerm(db)).installation_anchor_visit_id).toBe(install.id);
    expect((await db('annual_prepay_terms').where({ id: otherTerm.id }).first()).installation_anchored_at).toBeNull();
  });

  test('install handoff: an installation staff already booked on the estimate is the handoff — stamped, no bell', async () => {
    const { sweep, notifyAdmin, db } = load();
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    await addVisit(db, { scheduled_date: '2026-10-14', status: 'confirmed', source_estimate_id: ids.estimateId });

    expect(await sweep()).toMatchObject({ handoffScanned: 1, handedOff: 1, handoffFailed: 0 });
    expect(notifyAdmin).not.toHaveBeenCalledWith('estimate', expect.stringContaining('schedule the installation'), expect.anything(), expect.anything());
    expect((await db('estimates').where({ id: ids.estimateId }).first()).annual_plan_install_handoff_at).toBeInstanceOf(Date);
  });

  test('install handoff: a cancelled booking, or another property\'s booking on another estimate, still rings the scheduling bell', async () => {
    const { sweep, notifyAdmin, db } = load();
    const { propertyB } = await twoProperties(db);
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    await addVisit(db, { scheduled_date: '2026-10-14', status: 'cancelled', source_estimate_id: ids.estimateId });
    await addVisit(db, {
      scheduled_date: '2026-10-15', status: 'confirmed', source_estimate_id: randomUUID(), property_id: propertyB,
    });

    expect(await sweep()).toMatchObject({ handoffScanned: 1, handedOff: 1 });
    expect(notifyAdmin).toHaveBeenCalledWith('estimate', expect.stringContaining('schedule the installation'), expect.anything(), expect.anything());
  });

  test('install handoff: a bell that fails to persist stays unstamped for the next sweep', async () => {
    const { sweep, db } = load({ notifyAdminImpl: async () => null });
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });

    expect(await sweep()).toMatchObject({ handoffScanned: 1, handedOff: 0, handoffFailed: 1 });
    expect((await db('estimates').where({ id: ids.estimateId }).first()).annual_plan_install_handoff_at).toBeNull();
  });

  test('install handoff: a plan whose installation is already complete (anchored) needs no scheduling bell', async () => {
    const { sweep, notifyAdmin, db } = load();
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    await addVisit(db, { scheduled_date: '2026-10-14' });

    const counts = await sweep();

    expect(counts).toMatchObject({ anchored: 1, handoffScanned: 0 });
    expect(notifyAdmin).not.toHaveBeenCalledWith('estimate', expect.stringContaining('schedule the installation'), expect.anything(), expect.anything());
  });
  // ---- codex round 6: the installation is scoped to THIS plan ------------

  test('anchoring stamps the anchor BEFORE the window edit / refresh, so coverage seeding sees an anchored term', async () => {
    const moved = load();
    await addVisit(moved.db, { scheduled_date: '2026-10-14' });
    expect((await moved.sweep()).anchored).toBe(1);
    expect(moved.createTermForAnnualPrepay).toHaveBeenCalledTimes(1);
    expect(moved.refreshTermSnapshot).not.toHaveBeenCalled();
    expect(moved.anchoredWhenRefreshed).toEqual([true]);
  });

  test('an unmoved anchor still refreshes the term, so its coverage resolves against the anchored window', async () => {
    const { sweep, createTermForAnnualPrepay, refreshTermSnapshot, anchoredWhenRefreshed, db } = load();
    await addVisit(db, { scheduled_date: SIGNED_ON });
    expect((await sweep()).anchored).toBe(1);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    // A paid decided-lapse term is coverage-eligible on EVERY refresh now
    // (Codex #4940 r4), so the anchor needs no special refresh option.
    expect(refreshTermSnapshot).toHaveBeenCalledWith(ids.termId, expect.anything());
    expect(anchoredWhenRefreshed).toEqual([true]);
  });

  test('multi-property: a completed bait installation at property B never anchors property A\'s plan', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    const { propertyB } = await twoProperties(db);
    await addVisit(db, { scheduled_date: '2026-10-14', property_id: propertyB });

    expect((await sweep()).anchorScanned).toBe(0);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect((await readTerm(db)).installation_anchored_at).toBeNull();
  });

  test('multi-property: the installation at the estimate\'s property anchors, ignoring an earlier one at property B', async () => {
    const { sweep, db } = load();
    const { propertyA, propertyB } = await twoProperties(db);
    await addVisit(db, { scheduled_date: '2026-10-05', property_id: propertyB });
    const install = await addVisit(db, { scheduled_date: '2026-10-14', property_id: propertyA });

    expect((await sweep()).anchored).toBe(1);
    const term = await readTerm(db);
    expect(ymd(term.term_start)).toBe('2026-10-14');
    expect(term.installation_anchor_visit_id).toBe(install.id);
  });

  test('multi-property: an installation booked from the plan estimate anchors even with no property recorded', async () => {
    const byEstimate = load();
    await twoProperties(byEstimate.db, { estimateAtA: false });
    const estimateLinked = await addVisit(byEstimate.db, { scheduled_date: '2026-10-14', source_estimate_id: ids.estimateId });
    expect((await byEstimate.sweep()).anchored).toBe(1);
    expect((await readTerm(byEstimate.db)).installation_anchor_visit_id).toBe(estimateLinked.id);
  });

  test('multi-property: a term-linked installation anchors, but not one recorded at a different property', async () => {
    const { sweep, db } = load();
    const { propertyB } = await twoProperties(db);
    await addVisit(db, { scheduled_date: '2026-10-05', annual_prepay_term_id: ids.termId, property_id: propertyB });
    const termLinked = await addVisit(db, { scheduled_date: '2026-10-14', annual_prepay_term_id: ids.termId });

    expect((await sweep()).anchored).toBe(1);
    expect((await readTerm(db)).installation_anchor_visit_id).toBe(termLinked.id);
  });

  test('multi-property with no property on the estimate: an unlinked installation never anchors (explicit link required)', async () => {
    const { sweep, createTermForAnnualPrepay, db } = load();
    const { propertyA } = await twoProperties(db, { estimateAtA: false });
    await addVisit(db, { scheduled_date: '2026-10-14', property_id: propertyA });
    await addVisit(db, { scheduled_date: '2026-10-15' });

    expect((await sweep()).anchorScanned).toBe(0);
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
  });

  test('single-property customer: an unlinked installation still anchors (no other site exists)', async () => {
    const { sweep, db } = load();
    const [only] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
    await addVisit(db, { scheduled_date: '2026-10-14', property_id: only.id });
    expect((await sweep()).anchored).toBe(1);
  });

  test('install handoff: a term-linked or same-property booking is the handoff; another property\'s is not', async () => {
    const { sweep, notifyAdmin, db } = load();
    const { propertyA, propertyB } = await twoProperties(db);
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
    const booked = await addVisit(db, { scheduled_date: '2026-10-15', status: 'confirmed', property_id: propertyB });

    expect(await sweep()).toMatchObject({ handoffScanned: 1, handedOff: 1 });
    expect(notifyAdmin).toHaveBeenCalledWith('estimate', expect.stringContaining('schedule the installation'), expect.anything(), expect.anything());

    for (const link of [{ annual_prepay_term_id: ids.termId }, { property_id: propertyA }]) {
      notifyAdmin.mockClear();
      await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_install_handoff_at: null });
      await db('scheduled_services').where({ id: booked.id }).update({ annual_prepay_term_id: null, property_id: null, ...link });
      expect(await sweep()).toMatchObject({ handoffScanned: 1, handedOff: 1 });
      expect(notifyAdmin).not.toHaveBeenCalledWith('estimate', expect.stringContaining('schedule the installation'), expect.anything(), expect.anything());
    }
  });
});

describeOrSkip('termite annual countersign reminder — real Postgres (codex #4842 r2 P2)', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (fixture) await fixture.destroy();
  });

  function load() {
    const { db } = fixture;
    const notifyAdmin = jest.fn(async () => ({ id: randomUUID(), deduped: false }));
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/annual-prepay-renewals', () => {
      const actual = jest.requireActual('../services/annual-prepay-renewals');
      return {
        coveredTermsAsOf: actual.coveredTermsAsOf,
        isPaidDecidedLapseTerm: actual.isPaidDecidedLapseTerm,
        createTermForAnnualPrepay: jest.fn(),
        refreshTermSnapshot: jest.fn(),
        raiseRetrievalAfterAnchor: jest.fn(),
        raisePendingDeclineRetrievalTasks: jest.fn(async () => ({ scanned: 0, raised: 0 })),
        revalidateDueDeclineRetrievalTasks: jest.fn(async () => ({ checked: 0, withdrawn: 0 })),
      };
    });
    const { reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return { sweep: (opts = {}) => reconcileTermiteAnnualActivations({ conn: db, ...opts }), notifyAdmin, db };
  }

  const customer = async (db, fields = {}) => (await db('customers').insert(fields).returning('id'))[0].id;
  const reminderKeys = (notifyAdmin) => notifyAdmin.mock.calls
    .map(([, , , opts]) => String(opts?.dedupeKey || ''))
    .filter((key) => key.startsWith('termite-annual-countersign-reminder:'));

  test('re-rings a signed annual agreement left un-countersigned past a day; never a countersigned, fresh, or other-template one', async () => {
    const { sweep, notifyAdmin, db } = load();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    // 9:30pm ET on Sep 20 is already Sep 21 in UTC — the reminder names the ET day.
    const lateEvening = new Date('2026-09-21T01:30:00Z');
    const [pending] = await db('customer_contracts').insert({
      customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: lateEvening, signed_name: 'Sam Customer',
    }).returning('*');
    await db('customer_contracts').insert([
      { customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: twoDaysAgo, countersigned_at: new Date() },
      { customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date() },
      { customer_id: await customer(db), document_template_key: 'service_agreement.termite_bait_program_purchase', status: 'signed', signed_at: twoDaysAgo },
    ]);

    const counts = await sweep();

    expect(Object.keys(counts).filter((key) => key.endsWith('ScanError'))).toEqual([]);
    expect(counts).toMatchObject({ countersignScanned: 1, countersignReminded: 1 });
    const reminders = notifyAdmin.mock.calls.filter(([, , , opts]) => String(opts?.dedupeKey || '').startsWith('termite-annual-countersign-reminder:'));
    expect(reminders).toHaveLength(1);
    const [category, title, body, opts] = reminders[0];
    expect(category).toBe('customer');
    expect(title).toMatch(/still needs your countersignature/i);
    expect(body).toMatch(/Sam Customer/);
    expect(body).toMatch(/on 2026-09-20;/);
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: `termite-annual-countersign-reminder:${pending.id}`,
      dedupeWindowMs: 23 * 60 * 60 * 1000,
      link: '/admin/contracts?tab=requests&status=signed',
    });
  });

  test('a backlog larger than the limit rotates: least-recently-reminded first, each reminder records its event', async () => {
    const { sweep, notifyAdmin, db } = load();
    const reminded = () => notifyAdmin.mock.calls
      .map(([, , , opts]) => String(opts?.dedupeKey || ''))
      .filter((key) => key.startsWith('termite-annual-countersign-reminder:'))
      .map((key) => key.split(':').pop());
    const [older] = await db('customer_contracts').insert({
      customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date(Date.now() - 5 * 86400000),
    }).returning('*');
    const [newer] = await db('customer_contracts').insert({
      customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date(Date.now() - 3 * 86400000),
    }).returning('*');

    await sweep({ limit: 1 });
    await sweep({ limit: 1 });
    await sweep({ limit: 1 });

    expect(reminded()).toEqual([older.id, newer.id, older.id]);
    const events = await db('customer_contract_events').where({ event_type: 'countersign_reminder_sent' });
    expect(events).toHaveLength(3);
  });

  test('never reminds an archived customer\'s agreement (hidden from the Requests queue) or a cancelled one (codex #4842 r4 P2)', async () => {
    const { sweep, notifyAdmin, db } = load();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    await db('customer_contracts').insert([
      { customer_id: await customer(db, { deleted_at: new Date() }), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: twoDaysAgo },
      { customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'cancelled', signed_at: twoDaysAgo },
    ]);
    const counts = await sweep();
    expect(counts.countersignScanned).toBe(0);
    expect(reminderKeys(notifyAdmin)).toEqual([]);
  });

  test('a countersign landing mid-batch suppresses the stale reminder and records no event (codex #4842 r4 P2)', async () => {
    const { sweep, notifyAdmin, db } = load();
    const [row] = await db('customer_contracts').insert({
      customer_id: await customer(db), document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date(Date.now() - 2 * 86400000),
    }).returning('*');
    notifyAdmin.mockImplementation(async (category, title, body, opts) => {
      if (!String(opts?.dedupeKey || '').startsWith('termite-annual-countersign-reminder:')) return { id: randomUUID(), deduped: false };
      // The operator countersigns after the scan, before the bell persists.
      await db('customer_contracts').where({ id: row.id }).update({ countersigned_at: new Date() });
      return (await opts.shouldContinue()) ? { id: randomUUID(), deduped: false } : { id: null, suppressed: true, deduped: false };
    });
    const counts = await sweep();
    expect(counts).toMatchObject({ countersignScanned: 1, countersignReminded: 0 });
    expect(await db('customer_contract_events').where({ event_type: 'countersign_reminder_sent' })).toHaveLength(0);
  });
});
