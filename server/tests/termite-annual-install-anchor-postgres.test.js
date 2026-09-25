/**
 * Real PostgreSQL: the termite annual plan's installation anchor and durable
 * install-scheduling handoff (Codex round 4 on #4819), driven through
 * reconcileTermiteAnnualActivations against a scratch schema built by the
 * real 20260925000001..000006 migrations. The candidate scans, the
 * per-customer advisory lock, the installation floor, the overlap check
 * (admin-customers' own status clause) and the stamps all run as real SQL.
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
];

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_anchor_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    status text,
    sent_at timestamptz,
    sms_sent_at timestamptz,
    email_sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE customer_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    document_template_key text,
    status text,
    signed_at timestamptz,
    document_variables_snapshot jsonb
  )`);
  await db.raw('CREATE TABLE payment_method_consents (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw(`CREATE TABLE scheduled_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
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
    const createTermForAnnualPrepay = jest.fn(async ({
      sourceEstimateId, termStart, termEnd, conn,
    }) => {
      const [updated] = await conn('annual_prepay_terms').where({ source_estimate_id: sourceEstimateId })
        .update({ term_start: termStart, term_end: termEnd }).returning('*');
      return updated;
    });
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ createTermForAnnualPrepay }));
    const { reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      sweep: () => reconcileTermiteAnnualActivations({ conn: db }), notifyAdmin, createTermForAnnualPrepay, db,
    };
  }

  const addVisit = (db, fields) => db('scheduled_services').insert({
    customer_id: ids.customerId, status: 'completed', service_type: 'Termite Bait Station Installation', ...fields,
  }).returning('*').then(([row]) => row);
  const readTerm = async (db) => db('annual_prepay_terms').where({ id: ids.termId }).first();

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
});
