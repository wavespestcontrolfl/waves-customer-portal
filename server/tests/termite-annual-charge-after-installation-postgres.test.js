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
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, property_id uuid, accepted_at timestamptz)');
  await db.raw('CREATE TABLE customer_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    payer_id uuid,
    payer_statement_id uuid,
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

  function load({ method = 'default', chargeImpl, notifyAdminImpl } = {}) {
    const { db } = fixture;
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
  // A completed installation visit with a performed closeout record, unless
  // `closeout` says otherwise (null = no record at all).
  const addInstall = async (db, fields = {}, closeout = {}) => {
    const [visit] = await db('scheduled_services').insert({
      customer_id: ids.customerId, status: 'completed', service_type: 'Termite Installation Setup', scheduled_date: dayOffset(0), ...fields,
    }).returning('*');
    if (closeout && visit.status === 'completed') {
      await db('service_records').insert({
        scheduled_service_id: visit.id, status: 'completed', structured_notes: JSON.stringify(closeout),
      });
    }
    return visit;
  };
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
    await addInstall(db);

    const counts = await sweep();

    expect(Object.keys(counts).filter((key) => key.endsWith('ScanError'))).toEqual([]);
    expect(counts).toMatchObject({ installChargeScanned: 1, installCharged: 1, installPayLinked: 0, installChargeHeld: 0 });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith(ids.invoiceId, resolvedMethod.paymentMethodRowId, expect.objectContaining({
      customerInitiated: false,
      maxAuthorizedChargeCents: FROZEN_TOTAL * 100,
      maxAuthorizedTotalCents: FROZEN_TOTAL * 100,
      requireAutopayForCustomerId: ids.customerId,
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

  describe('the plan covers its own installation visit (no second bill beside the plan invoice)', () => {
    // The real coverage chokepoint every completion / billing caller asks.
    const covers = (db, visit, opts) => jest.requireActual('../services/annual-prepay-renewals')
      .annualPrepayCoversVisit(visit, db, opts);
    // The rule alone, for the "not covered" cases: past it the chokepoint
    // goes on to the paid-coverage checks, which need the full billing schema.
    const ruleCovers = (db, visit) => jest.requireActual('../services/annual-prepay-renewals')
      .termiteDeferredInstallCoversVisit(visit, db, { throwOnError: true });

    test('a priced installation visit is covered while the charge waits, in strict mode too, and stays covered after the charge', async () => {
      const { atSigning, sweep, chargeInvoiceWithSavedCard, db } = load();
      await atSigning();
      const visit = await addInstall(db);

      expect(await covers(db, visit)).toBe(true);
      expect(await covers(db, visit, { throwOnError: true })).toBe(true);

      await sweep();
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'active' });
      expect(await covers(db, visit, { throwOnError: true })).toBe(true);
    });

    test('still covered after a declined charge: the plan pay link collects it, never a visit bill', async () => {
      const { atSigning, sweep, db } = load({
        chargeImpl: async () => { throw Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }); },
      });
      await atSigning();
      const visit = await addInstall(db);
      await sweep();

      expect((await chargeState(db)).status).toBe('declined');
      expect(await covers(db, visit, { throwOnError: true })).toBe(true);
    });

    test('only the installation itself: a later bait/station job of the same plan bills normally, before and after the anchor', async () => {
      const { atSigning, sweep, db } = load();
      await atSigning();
      const install = await addInstall(db);
      const later = await addInstall(db, { scheduled_date: dayOffset(30), status: 'confirmed', service_type: 'Termite Bait Station Cartridge Replacement' });

      expect(await ruleCovers(db, install)).toBe(true);
      expect(await ruleCovers(db, later)).toBe(false);

      await sweep(); // anchors the term to the installation and charges the plan
      expect((await db('annual_prepay_terms').where({ id: ids.termId }).first()).installation_anchor_visit_id).toBe(install.id);
      expect(await ruleCovers(db, install)).toBe(true);
      expect(await ruleCovers(db, later)).toBe(false);
    });

    test('a cancelled earlier booking does not take the installation\'s place', async () => {
      const { atSigning, db } = load();
      await atSigning();
      await addInstall(db, { scheduled_date: dayOffset(-1), status: 'cancelled' });
      const install = await addInstall(db);

      expect(await ruleCovers(db, install)).toBe(true);
    });

    test('another visit of the same customer is not covered by it', async () => {
      const { atSigning, db } = load();
      await atSigning();
      const pest = await addInstall(db, { service_type: 'Quarterly Pest Control' });
      const liquid = await addInstall(db, { service_type: 'Termite Bora-Care Install' });

      expect(await ruleCovers(db, pest)).toBe(false);
      expect(await ruleCovers(db, liquid)).toBe(false);
    });

    test('an at-signing plan is unchanged: its unpaid installation visit is not covered by this rule', async () => {
      const { atSigning, db } = load({ method: null });
      await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: r3.TEMPLATE_V3_ANNUAL_R3_BODY });
      await atSigning();
      const visit = await addInstall(db);

      expect((await chargeState(db)).deferred_at).toBeUndefined();
      expect(await ruleCovers(db, visit)).toBe(false);
    });

    test('a plan cancelled before installation covers nothing', async () => {
      const { atSigning, db } = load();
      await atSigning();
      await db('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'cancelled' });
      const visit = await addInstall(db);

      expect(await ruleCovers(db, visit)).toBe(false);
    });

    test('a two-property customer: an installation at the other property is not covered', async () => {
      const { atSigning, db } = load();
      await atSigning();
      const [a] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
      const [b] = await db('customer_properties').insert({ customer_id: ids.customerId }).returning('*');
      await db('estimates').where({ id: ids.estimateId }).update({ property_id: a.id });
      const here = await addInstall(db, { property_id: a.id });
      const there = await addInstall(db, { property_id: b.id });

      expect(await ruleCovers(db, here)).toBe(true);
      expect(await ruleCovers(db, there)).toBe(false);
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
    expect(bellTitles(notifyAdmin).filter((title) => title === 'Termite annual plan — signed, not installed, not charged')).toHaveLength(1);
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
