/**
 * Real PostgreSQL: the termite annual plan charged AFTER the station
 * installation (owner ruling 2026-09-30, BILLING clause approved
 * 2026-10-03). An agreement signed on the after-installation wording
 * records 'awaiting_installation' at signing — no charge, no pay link —
 * and the daily sweep charges it once the plan's installation visit is
 * completed. The jsonb compare-and-swap from 'awaiting_installation', the
 * restore on release, the candidate scans and the never-installed alert
 * all run as real SQL. Stripe, the enrolled-method resolver, the invoice
 * sender and the admin bell are mocked at their module boundaries.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-charge-after-installation-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const r3 = require('../models/migrations/20260925030002_termite_annual_v3_countersignature_and_billing_clause');
const r4 = require('../models/migrations/20261003130000_termite_annual_v3_charge_after_installation_clause');

jest.setTimeout(60000);

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const FROZEN_TOTAL = 449;
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
  const schema = `termite_afterinst_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, property_id uuid, accepted_at timestamptz, estimate_data jsonb)');
  await db.raw('CREATE TABLE customer_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    payer_id uuid,
    payer_statement_id uuid,
    scheduled_service_id uuid,
    service_record_id uuid,
    status text,
    payment_method text,
    subtotal numeric(10,2),
    discount_amount numeric(10,2) DEFAULT 0,
    tax_amount numeric(10,2) DEFAULT 0,
    total numeric(10,2),
    sent_at timestamptz,
    sms_sent_at timestamptz,
    email_sent_at timestamptz,
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
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz)');
  await db.raw('CREATE TABLE technicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
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
    contract_text_snapshot text,
    annual_plan_version text,
    signer_ip text,
    signer_user_agent text,
    document_variables_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE customer_contract_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id uuid NOT NULL REFERENCES customer_contracts(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL,
    event_type varchar(60) NOT NULL,
    actor_type varchar(30) NOT NULL DEFAULT 'system',
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE payment_method_consents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    payment_method_id uuid,
    stripe_payment_method_id text NOT NULL,
    source text NOT NULL,
    consent_text_version varchar(20) NOT NULL,
    consent_text_snapshot text NOT NULL,
    ip text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE collections_flags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    flag varchar(40) NOT NULL,
    reason text,
    created_by varchar(80),
    created_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz
  )`);
  await db.raw(`CREATE TABLE scheduled_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    source_estimate_id uuid,
    annual_prepay_term_id uuid,
    property_id uuid,
    recurring_parent_id uuid,
    paf_held_term_id uuid,
    prepaid_method text,
    status text,
    service_type text,
    scheduled_date date
  )`);
  // The visit's closeout records: the newest one says whether the work was
  // performed (wherePerformedCloseout).
  await db.raw(`CREATE TABLE service_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_service_id uuid,
    status text,
    structured_notes jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
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
    dispute_suspended_at timestamptz,
    annual_plan_version text,
    coverage_service_type text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of MIGRATIONS) {
    await require(`../models/migrations/${name}`).up(db);
  }
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describe('the approved BILLING clause', () => {
  const {
    agreementAuthorizesInitialCharge, agreementAuthorizesAfterInstallCharge,
  } = jest.requireActual('../services/termite-program-agreement');

  test('the revised body authorizes the after-installation charge across its line wraps, and no longer the signing charge', () => {
    expect(agreementAuthorizesAfterInstallCharge(r4.TEMPLATE_V3_ANNUAL_R4_BODY)).toBe(true);
    expect(agreementAuthorizesInitialCharge(r4.TEMPLATE_V3_ANNUAL_R4_BODY)).toBe(false);
    expect(r4.TEMPLATE_V3_ANNUAL_R4_BODY).not.toMatch(/due before installation/);
  });

  test('the at-signing body before this revision authorizes only the signing charge', () => {
    expect(agreementAuthorizesAfterInstallCharge(r3.TEMPLATE_V3_ANNUAL_R3_BODY)).toBe(false);
    expect(agreementAuthorizesInitialCharge(r3.TEMPLATE_V3_ANNUAL_R3_BODY)).toBe(true);
  });

  test('only the BILLING intro changed', () => {
    expect(r4.TEMPLATE_V3_ANNUAL_R4_BODY.replace(r4.AFTER_INSTALL_BILLING_INTRO, r3.REVISED_BILLING_INTRO))
      .toBe(r3.TEMPLATE_V3_ANNUAL_R3_BODY);
  });
});

describeOrSkip('termite annual charge after installation — real Postgres', () => {
  let fixture;
  let ids;
  // Relative to the run date: the never-installed alert measures real
  // elapsed time from the signature, so a fixed calendar date would age
  // into the alert window.
  const dayOffset = (days) => new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
  const SIGNED_ON = dayOffset(-2);
  const SIGNED_AT = `${SIGNED_ON}T15:59:00.000Z`;

  beforeEach(async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const customerId = randomUUID();
    const [estimate] = await db('estimates').insert({
      customer_id: customerId,
      annual_plan_activation_status: 'activated',
      annual_plan_activated_at: new Date(`${SIGNED_ON}T16:00:00Z`),
      annual_plan_install_handoff_at: new Date(`${SIGNED_ON}T16:00:05Z`),
      annual_plan_deferred_invoice: JSON.stringify({
        version: 1,
        parkedAt: `${SIGNED_ON}T12:00:00.000Z`,
        frozenFinancials: { version: 1, subtotal: FROZEN_TOTAL, taxAmount: 0, total: FROZEN_TOTAL },
      }),
    }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'draft', subtotal: FROZEN_TOTAL, discount_amount: 0, tax_amount: 0, total: FROZEN_TOTAL,
    }).returning('*');
    const [contract] = await db('customer_contracts').insert({
      customer_id: customerId,
      document_template_key: ANNUAL_TEMPLATE_KEY,
      status: 'signed',
      signed_at: new Date(SIGNED_AT),
      contract_text_snapshot: r4.TEMPLATE_V3_ANNUAL_R4_BODY,
      annual_plan_version: 'v3',
      signer_ip: '203.0.113.9',
      signer_user_agent: 'jest',
      document_variables_snapshot: JSON.stringify({ estimate: { id: estimate.id } }),
    }).returning('*');
    const [term] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      source_estimate_id: estimate.id,
      prepay_invoice_id: invoice.id,
      plan_label: 'Termite Annual Protection',
      term_start: SIGNED_ON,
      term_end: dayOffset(363),
      status: 'payment_pending',
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

  let visitPayerId = null;
  function load({ method = 'default', chargeImpl, notifyAdminImpl } = {}) {
    const { db } = fixture;
    visitPayerId = null;
    const notifyAdmin = jest.fn(notifyAdminImpl || (async () => ({ id: randomUUID(), deduped: false })));
    const resolvedMethod = method === 'default'
      ? {
        stripePaymentMethodId: 'pm_saved', paymentMethodRowId: randomUUID(), methodType: 'card', funding: 'debit', source: 'saved',
      }
      : method;
    const chargeInvoiceWithSavedCard = jest.fn(chargeImpl || (async (invoiceId) => {
      await db('invoices').where({ id: invoiceId }).update({ status: 'paid' });
      return { id: 'payment-1' };
    }));
    const sendViaSMSAndEmail = jest.fn(async (invoiceId) => {
      await db('invoices').where({ id: invoiceId }).update({ sent_at: new Date() });
      return { ok: true };
    });
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/stripe', () => ({
      chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: FROZEN_TOTAL })),
    }));
    jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
    // The visit's payer, as completion's own payer exclusion resolves it.
    jest.doMock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => (visitPayerId ? { payerId: visitPayerId } : null)) }));
    jest.doMock('../services/estimate-converter', () => ({
      canAutoSendDraftInvoice: () => true,
      frozenTermiteAnnualFinancialsFor: (estimate) => {
        const context = typeof estimate?.annual_plan_deferred_invoice === 'string'
          ? JSON.parse(estimate.annual_plan_deferred_invoice)
          : estimate?.annual_plan_deferred_invoice;
        if (!(context?.frozenFinancials?.total > 0)) throw new Error('no frozen snapshot');
        return context.frozenFinancials;
      },
    }));
    jest.doMock('../services/recurring-card-on-file', () => {
      const actual = jest.requireActual('../services/recurring-card-on-file');
      return {
        isPrepayCardAndChargeEnabled: jest.fn(() => true),
        resolvePrepayChargeMethod: jest.fn(async () => resolvedMethod),
        isAmbiguousSavedMethodChargeError: actual.isAmbiguousSavedMethodChargeError,
        classifySavedMethodChargeInvoice: actual.classifySavedMethodChargeInvoice,
      };
    });
    jest.doMock('../services/annual-prepay-renewals', () => {
      const actual = jest.requireActual('../services/annual-prepay-renewals');
      return {
        coveredTermsAsOf: actual.coveredTermsAsOf,
        isPaidDecidedLapseTerm: actual.isPaidDecidedLapseTerm,
        createTermForAnnualPrepay: jest.fn(async ({ sourceEstimateId, termStart, termEnd, conn }) => {
          const [updated] = await conn('annual_prepay_terms').where({ source_estimate_id: sourceEstimateId })
            .update({ term_start: termStart, term_end: termEnd }).returning('*');
          return updated;
        }),
        refreshTermSnapshot: jest.fn(async (termId, conn) => conn('annual_prepay_terms').where({ id: termId }).first()),
        raisePendingDeclineRetrievalTasks: jest.fn(async () => ({ scanned: 0, raised: 0 })),
      };
    });
    const SignatureCharge = require('../services/termite-annual-signature-charge');
    const { reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      atSigning: (extra = {}) => SignatureCharge.chargeAnnualInvoiceAtSignature({
        estimateId: ids.estimateId, contractId: ids.contractId, invoiceId: ids.invoiceId, conn: db, trigger: 'signature', ...extra,
      }),
      afterInstall: () => SignatureCharge.chargeAnnualInvoiceAfterInstallation({
        estimateId: ids.estimateId, invoiceId: ids.invoiceId, conn: db,
      }),
      sweep: () => reconcileTermiteAnnualActivations({ conn: db }),
      notifyAdmin, chargeInvoiceWithSavedCard, sendViaSMSAndEmail, db, resolvedMethod,
    };
  }

  const chargeState = async (db) => (await db('estimates').where({ id: ids.estimateId }).first()).annual_plan_signature_charge;
  // What the closeout does for the plan (complete-scheduled-service.js): ask
  // the real holding-term rule, waiting year first and then an activated one,
  // and stamp the answer on the visit. Returns the stamped term id or null.
  const closeoutStamp = async (db, visit) => {
    const Renewals = jest.requireActual('../services/annual-prepay-renewals');
    const row = await db('scheduled_services').where({ id: visit.id }).first();
    const held = await Renewals.pafDeferredHoldingTerm(row, db, { throwOnError: true, claim: true })
      || await Renewals.pafDeferredHoldingTerm(row, db, { throwOnError: true, activated: true, claim: true });
    await db('scheduled_services').where({ id: visit.id }).update({ paf_held_term_id: held?.id || null });
    return held?.id || null;
  };
  // A completed installation visit with a performed closeout record, closed
  // out (stamped) like a real completion, unless `closeout` says otherwise
  // (null = no record at all, and no closeout run).
  const addInstall = async (db, fields = {}, closeout = {}) => {
    const [visit] = await db('scheduled_services').insert({
      customer_id: ids.customerId, status: 'completed', service_type: 'Termite Installation Setup', scheduled_date: dayOffset(0), ...fields,
    }).returning('*');
    if (closeout && visit.status === 'completed') {
      await db('service_records').insert({
        scheduled_service_id: visit.id, status: 'completed', structured_notes: JSON.stringify(closeout),
      });
      await closeoutStamp(db, visit);
    }
    return visit;
  };
  const stampOf = async (db, visit) => (await db('scheduled_services').where({ id: visit.id }).first()).paf_held_term_id;
  const signedDaysAgo = (db, days) => db('estimates').where({ id: ids.estimateId }).update({
    annual_plan_signature_charge: db.raw('annual_plan_signature_charge || ?::jsonb', [
      JSON.stringify({ signed_at: new Date(Date.now() - days * 86400e3).toISOString() }),
    ]),
  });
  const bellTitles = (notifyAdmin) => notifyAdmin.mock.calls.map((call) => call[1]);

  test('signing an after-installation agreement charges nothing and sends no pay link; a replay changes nothing', async () => {
    const { atSigning, chargeInvoiceWithSavedCard, notifyAdmin, db } = load();

    expect(await atSigning()).toEqual({ status: 'awaiting_installation', reason: null, deliverPayLink: false });
    const state = await chargeState(db);
    expect(state).toMatchObject({
      status: 'awaiting_installation', invoice_id: ids.invoiceId, contract_id: ids.contractId, signed_at: SIGNED_AT,
    });
    expect(await atSigning({ trigger: 'sweep' })).toEqual({ status: 'awaiting_installation', reason: null, deliverPayLink: false });
    expect(await chargeState(db)).toEqual(state);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(await db('payment_method_consents')).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('before the installation is completed the daily sweep neither charges nor sends the invoice', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, sendViaSMSAndEmail, db } = load();
    await atSigning();
    await addInstall(db, { status: 'confirmed' });

    const counts = await sweep();

    expect(Object.keys(counts).filter((key) => key.endsWith('ScanError'))).toEqual([]);
    expect(counts).toMatchObject({ installChargeScanned: 0, installCharged: 0, deliveryScanned: 0 });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    expect((await chargeState(db)).status).toBe('awaiting_installation');
  });

  test('once the installation is completed the sweep charges once, capped at the signed total, on the signed agreement as consent', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, sendViaSMSAndEmail, notifyAdmin, db, resolvedMethod } = load();
    await atSigning();
    const installed = await addInstall(db);

    const counts = await sweep();

    expect(Object.keys(counts).filter((key) => key.endsWith('ScanError'))).toEqual([]);
    expect(counts).toMatchObject({ installChargeScanned: 1, installCharged: 1, installPayLinked: 0, installChargeHeld: 0 });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith(ids.invoiceId, resolvedMethod.paymentMethodRowId, expect.objectContaining({
      customerInitiated: false,
      maxAuthorizedChargeCents: FROZEN_TOTAL * 100,
      maxAuthorizedTotalCents: FROZEN_TOTAL * 100,
      requireAutopayForCustomerId: ids.customerId,
      // Bound again inside the charge transaction, under the visit's lock.
      requireSelfPayScheduledServiceId: installed.id,
      requireCompletedVisit: true,
      requirePerformedVisit: true,
      requireHeldTermId: ids.termId,
      requireNoOtherVisitInvoice: true,
      requireSignedContractId: ids.contractId,
    }));
    expect(await chargeState(db)).toMatchObject({ status: 'paid', trigger: 'installation_complete', contract_id: ids.contractId });
    const consents = await db('payment_method_consents');
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ source: 'contract_signing', evidence_contract_id: ids.contractId });
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    expect(bellTitles(notifyAdmin).filter((title) => /declined|reconciliation|not attempted/.test(title))).toEqual([]);

    // A second sweep finds nothing to charge.
    const again = await sweep();
    expect(again.installChargeScanned).toBe(0);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('two entries at once: exactly one Stripe call', async () => {
    const { atSigning, afterInstall, chargeInvoiceWithSavedCard, db } = load();
    await atSigning();
    await addInstall(db);

    const outcomes = await Promise.all([afterInstall(), afterInstall(), afterInstall()]);

    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o.status === 'paid').length).toBeGreaterThanOrEqual(1);
    expect(outcomes.every((o) => o.deliverPayLink === false)).toBe(true);
  });

  test('a plan cancelled before installation is never charged, even if a visit is later marked completed', async () => {
    const { atSigning, afterInstall, sweep, chargeInvoiceWithSavedCard, db } = load();
    await atSigning();
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled' });
    await db('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
    await addInstall(db);

    expect((await sweep()).installChargeScanned).toBe(0);
    expect(await afterInstall()).toMatchObject({ status: 'awaiting_installation', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect((await chargeState(db)).status).toBe('awaiting_installation');
  });

  describe('the closeout stamps the installation visit; coverage, release and text read the stamp', () => {
    const Renewals = () => jest.requireActual('../services/annual-prepay-renewals');
    const stampCovers = async (db, visit) => Renewals().pafHeldStampCovers(await db('scheduled_services').where({ id: visit.id }).first(), db);
    const firstVisitText = async (db, visit) => jest.requireActual('../services/paf-prepay-release')
      .isFirstHeldVisitOfUnpaidYear(await db('scheduled_services').where({ id: visit.id }).first(), db);

    test('the installation is stamped with the plan term, covered while the charge waits and after it, and sends the after-visit text only while unpaid', async () => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const visit = await addInstall(db);

      expect(await stampOf(db, visit)).toBe(ids.termId);
      expect(await stampCovers(db, visit)).toBe(true);
      expect(await firstVisitText(db, visit)).toBe(true);

      expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 1 });
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(await firstVisitText(db, visit)).toBe(false);
    });

    test('still covered after a declined charge: the plan pay link collects it, never a visit bill', async () => {
      const { atSigning, sweep, db } = load({
        chargeImpl: async () => { throw Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }); },
      });
      await atSigning();
      const visit = await addInstall(db);
      await sweep();

      expect((await chargeState(db)).status).toBe('declined');
      expect(await stampCovers(db, visit)).toBe(true);
    });

    test('the charge transaction refuses a visit that stopped being the installation (reopened, payer, paid another way): back to waiting, no pay link', async () => {
      const { atSigning, sweep, sendViaSMSAndEmail, db } = load({
        chargeImpl: async () => { throw Object.assign(new Error('The visit is no longer held by this annual prepay. Review before charging.'), { code: 'VISIT_NOT_COMPLETED' }); },
      });
      await atSigning();
      const waiting = await chargeState(db);
      await addInstall(db);

      expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 0, installPayLinked: 0, installChargeHeld: 1 });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(await chargeState(db)).toEqual(waiting);
    });

    test('the agreement was cancelled before money moved: nothing charged, no pay link, the office owns it', async () => {
      const { atSigning, sweep, sendViaSMSAndEmail, notifyAdmin, db } = load({
        chargeImpl: async () => { throw Object.assign(new Error('The signed agreement that authorizes this charge is no longer signed.'), { code: 'CONTRACT_NOT_SIGNED' }); },
      });
      await atSigning();
      await addInstall(db);

      expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 0, installPayLinked: 0, installChargeHeld: 1 });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(await chargeState(db)).toMatchObject({ status: 'deferred', reason: 'agreement_no_longer_signed' });
      expect(bellTitles(notifyAdmin)).toContain('Termite annual plan — after-installation charge not attempted');
    });

    test('a stamped installation reopened before the charge does not block the real one: the replacement takes the stamp and releases the charge', async () => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const first = await addInstall(db);
      expect(await stampOf(db, first)).toBe(ids.termId);
      await db('scheduled_services').where({ id: first.id }).update({ status: 'confirmed' }); // reopened

      expect((await sweep()).installChargeScanned).toBe(0);

      const replacement = await addInstall(db, { scheduled_date: dayOffset(1) });
      expect(await stampOf(db, replacement)).toBe(ids.termId);
      expect(await stampOf(db, first)).toBeNull();
      expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 1 });
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard.mock.calls[0][2]).toMatchObject({ requireSelfPayScheduledServiceId: replacement.id });
    });

    test('the never-released alert is re-checked at the alert itself: an installation that closed out after the scan rings nothing', async () => {
      const { atSigning, notifyAdmin, db } = load();
      const SignatureCharge = require('../services/termite-annual-signature-charge');
      await atSigning();
      await signedDaysAgo(db, 15);
      await addInstall(db); // closed out after the sweep's stale scan picked the plan

      expect(await SignatureCharge.alertNeverInstalled({ estimateId: ids.estimateId, invoiceId: ids.invoiceId, conn: db })).toBe(false);
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect((await chargeState(db)).never_installed_alerted_at).toBeUndefined();
    });

    test('two installation visits of one plan closing at the same moment: exactly one is stamped', async () => {
      const { atSigning, db } = load();
      await atSigning();
      const visits = [];
      for (const day of [0, 1]) {
        const [visit] = await db('scheduled_services').insert({
          customer_id: ids.customerId, status: 'completed', service_type: 'Termite Installation Setup', scheduled_date: dayOffset(day),
        }).returning('*');
        await db('service_records').insert({ scheduled_service_id: visit.id, status: 'completed', structured_notes: JSON.stringify({}) });
        visits.push(visit);
      }

      const held = await Promise.all(visits.map((visit) => closeoutStamp(db, visit)));

      expect(held.filter(Boolean)).toEqual([ids.termId]);
      const stamped = await db('scheduled_services').whereNotNull('paf_held_term_id');
      expect(stamped).toHaveLength(1);
    });

    test.each([
      ['Termite Bait Station Cartridge Replacement'],
      ['Annual Termite Active Bait Station Service'],
      ['Quarterly Termite Active Bait Station Service'],
    ])('a maintenance job (%s) completed first is not the installation: not stamped, no charge', async (serviceType) => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const job = await addInstall(db, { service_type: serviceType });

      expect(await stampOf(db, job)).toBeNull();
      expect((await sweep()).installChargeScanned).toBe(0);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('"Termite Bait Station Installation" is an installation', async () => {
      const { atSigning, db } = load();
      await atSigning();
      expect(await stampOf(db, await addInstall(db, { service_type: 'Termite Bait Station Installation' }))).toBe(ids.termId);
    });

    test('the wait is recorded inside the activation transaction, so a closeout never sees the term without it', async () => {
      const { db } = load();
      const SignatureCharge = require('../services/termite-annual-signature-charge');
      const contract = await db('customer_contracts').where({ id: ids.contractId }).first();

      await db.transaction(async (trx) => {
        expect(await SignatureCharge.recordInstallationWait({
          conn: trx, estimateId: ids.estimateId, contract, invoiceId: ids.invoiceId, trigger: 'signature',
        })).toEqual({ agreed: true });
      });
      expect(await chargeState(db)).toMatchObject({ status: 'awaiting_installation', contract_id: ids.contractId, signed_at: SIGNED_AT });
      // An installation closing right now is stamped, with no sign-time entry having run.
      expect(await stampOf(db, await addInstall(db))).toBe(ids.termId);

      // The at-signing wording records nothing.
      await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_signature_charge: null });
      expect(await SignatureCharge.recordInstallationWait({
        conn: db, estimateId: ids.estimateId, contract: { ...contract, contract_text_snapshot: r3.TEMPLATE_V3_ANNUAL_R3_BODY }, invoiceId: ids.invoiceId,
      })).toEqual({ agreed: false });
      expect(await chargeState(db)).toBeNull();
    });

    test('billing previews agree with the closeout: the batch prefilter includes the plan\'s customer, and the verdict is covered before and after the stamp', async () => {
      const { atSigning, db } = load();
      const other = randomUUID();

      expect([...await Renewals().deferredPrepayHoldCustomerIds(db, [ids.customerId, other])]).toEqual([]);
      await atSigning();
      const prefilter = await Renewals().deferredPrepayHoldCustomerIds(db, [ids.customerId, other]);
      expect([...prefilter]).toEqual([ids.customerId]);

      const booked = await addInstall(db, { status: 'confirmed' });
      const row = async (visit) => db('scheduled_services').where({ id: visit.id }).first();
      expect(await Renewals().annualCoverageVerdictForPrediction(await row(booked), db, { deferredCustomerIds: prefilter })).toBe(true);

      await db('scheduled_services').where({ id: booked.id }).update({ status: 'completed' });
      await db('service_records').insert({ scheduled_service_id: booked.id, status: 'completed', structured_notes: JSON.stringify({}) });
      await closeoutStamp(db, booked);
      expect(await Renewals().annualCoverageVerdictForPrediction(await row(booked), db, { deferredCustomerIds: prefilter })).toBe(true);
    });

    test('one installation per plan: a later bait/station job is not stamped and bills normally', async () => {
      const { atSigning, sweep, db } = load();
      await atSigning();
      const install = await addInstall(db);
      const later = await addInstall(db, { scheduled_date: dayOffset(30), service_type: 'Termite Installation Setup' });

      expect(await stampOf(db, install)).toBe(ids.termId);
      expect(await stampOf(db, later)).toBeNull();

      await sweep();
      // A fresh closeout of the later job after the plan is paid still finds the installation's stamp.
      await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'active' });
      await db('invoices').where({ id: ids.invoiceId }).update({ paid_at: new Date() });
      expect(await closeoutStamp(db, later)).toBeNull();
    });

    test('an unsuccessful first visit, then the real installation: only the real one is stamped, and the plan is charged once', async () => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const inspected = await addInstall(db, { scheduled_date: dayOffset(-1) }, { visitOutcome: 'inspection_only' });

      expect(await stampOf(db, inspected)).toBeNull();
      await sweep(); // the anchor may take the inspection-only visit for coverage dates; it decides no money
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();

      const install = await addInstall(db);
      expect(await stampOf(db, install)).toBe(ids.termId);
      expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 1 });
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    });

    test('an installation billed to a third-party payer is not stamped: no automatic charge, and the office hears at 14 days', async () => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, notifyAdmin, db } = load();
      await atSigning();
      visitPayerId = randomUUID();
      const visit = await addInstall(db);

      expect(await stampOf(db, visit)).toBeNull();
      expect((await sweep()).installChargeScanned).toBe(0);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();

      await signedDaysAgo(db, 15);
      expect((await sweep()).neverInstalledAlerted).toBe(1);
      expect(bellTitles(notifyAdmin)).toContain('Termite annual plan — signed, installation has not released the charge');
    });

    test.each([
      ['linked to the visit', (visit) => ({ scheduled_service_id: visit.id })],
      ['linked to its service record', (_visit, record) => ({ service_record_id: record.id })],
    ])('an installation with its own paid invoice (%s, no prepaid stamp) is not held: no automatic charge', async (_label, link) => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const [visit] = await db('scheduled_services').insert({
        customer_id: ids.customerId, status: 'completed', service_type: 'Termite Installation Setup', scheduled_date: dayOffset(0),
      }).returning('*');
      const [record] = await db('service_records').insert({
        scheduled_service_id: visit.id, status: 'completed', structured_notes: JSON.stringify({}),
      }).returning('*');
      await db('invoices').insert({ customer_id: ids.customerId, status: 'paid', total: 199, subtotal: 199, ...link(visit, record) });

      expect(await closeoutStamp(db, visit)).toBeNull();
      expect((await sweep()).installChargeScanned).toBe(0);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('a voided visit invoice does not count: the installation is held', async () => {
      const { atSigning, db } = load();
      await atSigning();
      const [visit] = await db('scheduled_services').insert({
        customer_id: ids.customerId, status: 'completed', service_type: 'Termite Installation Setup', scheduled_date: dayOffset(0),
      }).returning('*');
      await db('service_records').insert({ scheduled_service_id: visit.id, status: 'completed', structured_notes: JSON.stringify({}) });
      await db('invoices').insert({ customer_id: ids.customerId, status: 'void', total: 199, subtotal: 199, scheduled_service_id: visit.id });

      expect(await closeoutStamp(db, visit)).toBe(ids.termId);
    });

    test('an installation paid another way (prepaid stamp) is not held: no automatic charge', async () => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const visit = await addInstall(db, { prepaid_method: 'cash' });

      expect(await stampOf(db, visit)).toBeNull();
      expect((await sweep()).installChargeScanned).toBe(0);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('another visit of the same customer, and a liquid termite job, are not stamped', async () => {
      const { atSigning, db } = load();
      await atSigning();
      const pest = await addInstall(db, { service_type: 'Quarterly Pest Control' });
      const liquid = await addInstall(db, { service_type: 'Termite Bora-Care Install' });

      expect(await stampOf(db, pest)).toBeNull();
      expect(await stampOf(db, liquid)).toBeNull();
    });

    test('an at-signing plan is unchanged: its installation visit is not stamped by this rule', async () => {
      const { atSigning, db } = load({ method: null });
      await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: r3.TEMPLATE_V3_ANNUAL_R3_BODY });
      await atSigning();
      const visit = await addInstall(db);

      expect((await chargeState(db)).deferred_at).toBeUndefined();
      expect(await stampOf(db, visit)).toBeNull();
    });

    test('a plan cancelled before installation holds nothing', async () => {
      const { atSigning, db } = load();
      await atSigning();
      await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled' });
      await db('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const visit = await addInstall(db);

      expect(await stampOf(db, visit)).toBeNull();
    });

    test('a two-property customer: an installation at the other property is not stamped', async () => {
      const { atSigning, db } = load();
      await atSigning();
      const [a] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
      const [b] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
      await db('estimates').where({ id: ids.estimateId }).update({ property_id: a.id });
      const there = await addInstall(db, { property_id: b.id });
      const here = await addInstall(db, { property_id: a.id });

      expect(await stampOf(db, there)).toBeNull();
      expect(await stampOf(db, here)).toBe(ids.termId);
    });
  });

  test('a customer who declined the NEXT renewal online still pays the installed first year', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
    await atSigning();
    await db('annual_prepay_terms').where({ id: ids.termId }).update({ renewal_decision: 'cancel' });
    await addInstall(db);

    expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 1 });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect((await chargeState(db)).status).toBe('paid');
  });

  test.each([
    ['closed as inspection only', { visitOutcome: 'inspection_only' }],
    ['closed as customer declined', { visitOutcome: 'customer_declined' }],
    ['closed as incomplete', { visitOutcome: 'incomplete' }],
    ['a quiet backfill closeout', { backfill: 'true' }],
    ['completed with no closeout record', null],
  ])('an installation visit %s is not a performed installation: no charge', async (_label, closeout) => {
    const { atSigning, afterInstall, sweep, chargeInvoiceWithSavedCard, db } = load();
    await atSigning();
    await addInstall(db, {}, closeout);

    expect((await sweep()).installChargeScanned).toBe(0);
    expect(await afterInstall()).toMatchObject({ status: 'awaiting_installation', reason: 'not_installed_or_not_owed' });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('a visit re-closed as performed after an inspection-only closeout is charged (the newest closeout decides)', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
    await atSigning();
    const visit = await addInstall(db, {}, { visitOutcome: 'inspection_only' });
    await db('service_records').insert({
      scheduled_service_id: visit.id, status: 'completed', structured_notes: JSON.stringify({}), created_at: new Date(Date.now() + 60000),
    });
    await closeoutStamp(db, visit);

    expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 1 });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('the direct entry re-checks the installation under its claim and hands the wait back untouched', async () => {
    const { atSigning, afterInstall, chargeInvoiceWithSavedCard, db } = load();
    await atSigning();
    const before = await chargeState(db);

    expect(await afterInstall()).toMatchObject({ status: 'awaiting_installation', reason: 'not_installed_or_not_owed', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(await chargeState(db)).toEqual(before);
  });

  test('a decline after installation: one office alert naming the installation, the pay link goes out, the card is never retried', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, sendViaSMSAndEmail, notifyAdmin, db } = load({
      chargeImpl: async () => { throw Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }); },
    });
    await atSigning();
    await addInstall(db);

    const counts = await sweep();

    expect(counts).toMatchObject({ installChargeScanned: 1, installCharged: 0, installPayLinked: 1 });
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
    expect(bellTitles(notifyAdmin)).toContain('Termite annual plan — card on file declined after installation');
    expect((await chargeState(db)).status).toBe('declined');

    await sweep();
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('no payment method on file after installation: the pay link goes out, no charge', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, sendViaSMSAndEmail, db } = load({ method: null });
    await atSigning();
    await addInstall(db);

    expect(await sweep()).toMatchObject({ installChargeScanned: 1, installPayLinked: 1 });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
    expect(await chargeState(db)).toMatchObject({ status: 'skipped', reason: 'no_enrolled_method' });
  });

  test('a collections hold at installation time: nothing charged, the wait is restored, and it charges after the release', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, sendViaSMSAndEmail, db } = load();
    await atSigning();
    const waiting = await chargeState(db);
    await addInstall(db);
    await db('collections_flags').insert({ customer_id: ids.customerId, flag: 'collection_hold', reason: 'dispute on call' });

    expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 0, installChargeHeld: 1 });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    expect(await chargeState(db)).toEqual(waiting);

    await db('collections_flags').where({ customer_id: ids.customerId }).update({ released_at: db.fn.now() });
    expect(await sweep()).toMatchObject({ installChargeScanned: 1, installCharged: 1 });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('an agreement signed on the at-signing wording is charged at signing and never by the installation entry', async () => {
    const { atSigning, afterInstall, sweep, chargeInvoiceWithSavedCard, db } = load();
    await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: r3.TEMPLATE_V3_ANNUAL_R3_BODY });

    expect(await atSigning()).toEqual({ status: 'paid', reason: null, deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeInvoiceWithSavedCard.mock.calls[0][2]).toMatchObject({ customerInitiated: true });
    await addInstall(db);
    expect((await sweep()).installChargeScanned).toBe(0);
    expect(await afterInstall()).toMatchObject({ status: 'paid', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('the installation entry rings nothing and charges nothing for a plan that was never recorded as waiting', async () => {
    const { afterInstall, chargeInvoiceWithSavedCard, notifyAdmin, db } = load();
    await addInstall(db);

    expect(await afterInstall()).toEqual({ status: 'not_awaiting_installation', reason: null, deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(await chargeState(db)).toBeNull();
  });

  test('a payer-billed invoice never enters the wait: it keeps the payer path', async () => {
    const { atSigning, chargeInvoiceWithSavedCard, db } = load();
    await db('invoices').where({ id: ids.invoiceId }).update({ payer_id: randomUUID() });

    expect(await atSigning()).toEqual({ status: 'skipped', reason: 'payer_billed', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect((await chargeState(db)).status).toBe('skipped');
  });

  test('a signed agreement that cannot be read: no charge, no pay link, nothing recorded, one office alert', async () => {
    const { atSigning, chargeInvoiceWithSavedCard, notifyAdmin, db } = load({ method: null });
    await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: null });

    expect(await atSigning()).toEqual({ status: 'deferred', reason: 'agreement_unreadable', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(await chargeState(db)).toBeNull();
  });

  test('signed 14 days ago and still not installed: exactly one office alert, and still no charge', async () => {
    const { atSigning, sweep, chargeInvoiceWithSavedCard, notifyAdmin, db } = load();
    await atSigning();

    expect((await sweep()).neverInstalledAlerted).toBe(0);

    await signedDaysAgo(db, 15);
    expect((await sweep()).neverInstalledAlerted).toBe(1);
    expect((await sweep()).neverInstalledAlerted).toBe(0);
    expect(bellTitles(notifyAdmin).filter((title) => title === 'Termite annual plan — signed, installation has not released the charge')).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect((await chargeState(db)).status).toBe('awaiting_installation');
  });

  test('the 14 days count from the signature, not from a delayed activation', async () => {
    const { atSigning, sweep, db } = load();
    // Signed 20 days ago; the activation (and so the wait record) only landed now.
    await db('customer_contracts').where({ id: ids.contractId }).update({ signed_at: new Date(Date.now() - 20 * 86400e3) });
    await atSigning();

    expect((await sweep()).neverInstalledAlerted).toBe(1);
  });

  test('a leap-day signature still reaches the alert (the shape check caps February at 28; the wait time stands in)', async () => {
    const { atSigning, sweep, db } = load();
    await atSigning();
    await db('estimates').where({ id: ids.estimateId }).update({
      annual_plan_signature_charge: db.raw('annual_plan_signature_charge || ?::jsonb', [JSON.stringify({
        signed_at: '2028-02-29T15:00:00.000Z', deferred_at: new Date(Date.now() - 15 * 86400e3).toISOString(),
      })]),
    });

    expect((await sweep()).neverInstalledAlerted).toBe(1);
  });

  test('an installation visit closed as inspection only still counts as never installed for the alert', async () => {
    const { atSigning, sweep, db } = load();
    await atSigning();
    await signedDaysAgo(db, 15);
    await addInstall(db, {}, { visitOutcome: 'inspection_only' });

    expect((await sweep()).neverInstalledAlerted).toBe(1);
  });

  test.each([
    ['throws', async () => { throw new Error('notification store down'); }],
    ['resolves null (its own insert failed)', async () => null],
  ])('a never-installed alert that %s is not recorded: the next sweep rings it', async (_label, failing) => {
    let fail = true;
    const { atSigning, sweep, db } = load({
      notifyAdminImpl: async () => (fail ? failing() : { id: randomUUID(), deduped: false }),
    });
    await atSigning();
    await signedDaysAgo(db, 15);

    expect((await sweep()).neverInstalledAlerted).toBe(0);
    expect((await chargeState(db)).never_installed_alerted_at).toBeUndefined();

    fail = false;
    expect((await sweep()).neverInstalledAlerted).toBe(1);
    expect((await chargeState(db)).never_installed_alerted_at).toEqual(expect.any(String));
    expect((await sweep()).neverInstalledAlerted).toBe(0);
  });
});
