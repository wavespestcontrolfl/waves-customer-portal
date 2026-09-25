/**
 * Real PostgreSQL: the termite annual plan's at-most-once signature charge
 * (owner ruling 2026-09-25 on #4819) against a scratch schema built by the
 * real 20260925000005 migration — the jsonb compare-and-swap claim, the
 * token-conditioned outcome stamp, the claim release, and the consent
 * ledger row all run as real SQL. Stripe, the enrolled-method resolver and
 * the admin bell are mocked at their module boundaries.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-signature-charge-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const FROZEN_TOTAL = 449;
// The v3 BILLING clause as slice 3c words it — wrapped across lines the way
// the rendered agreement is, so the whitespace-normalized match is what is
// exercised (codex round-4 P1: the signed text itself must authorize the
// initial charge).
const SIGNED_TEXT_WITH_AUTHORIZATION = [
  'THE SIGNED AGREEMENT TEXT',
  'BILLING. The setup fee and the first annual protection fee are billed together',
  'and are due before installation: Waves charges them to the payment',
  'method on file at signing, or, if none is on file, sends a payment link',
  'to complete before installation.',
].join('\n');
const SIGNED_TEXT_RENEWALS_ONLY = 'THE SIGNED AGREEMENT TEXT\nRENEWAL. Waves charges the renewal fee to the payment method on file.';

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_sig_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE estimates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    annual_plan_activation_status text,
    annual_plan_deferred_invoice jsonb
  )`);
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    payer_id uuid,
    status text,
    payment_method text,
    subtotal numeric(10,2),
    discount_amount numeric(10,2) DEFAULT 0,
    tax_amount numeric(10,2) DEFAULT 0,
    total numeric(10,2)
  )`);
  await db.raw(`CREATE TABLE customer_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    document_template_key text,
    status text,
    signed_at timestamptz,
    contract_text_snapshot text,
    annual_plan_version text,
    signer_ip text,
    signer_user_agent text,
    document_variables_snapshot jsonb
  )`);
  await db.raw(`CREATE TABLE payment_method_consents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    payment_method_id uuid,
    stripe_payment_method_id text NOT NULL,
    source text NOT NULL,
    consent_text_version varchar(40) NOT NULL,
    consent_text_snapshot text NOT NULL,
    ip text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await require('../models/migrations/20260925000005_termite_annual_signature_charge').up(db);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

function frozenContext() {
  return {
    version: 1,
    parkedAt: '2026-09-20T12:00:00.000Z',
    frozenFinancials: {
      version: 1,
      annualPrepayAmount: 250,
      prepayDiscountApplied: false,
      prepayDiscountRate: 0,
      rodentSetupAmount: 0,
      annualPlanSetup: { description: 'Station Setup', amount: 199 },
      taxRate: null,
      subtotal: FROZEN_TOTAL,
      taxAmount: 0,
      total: FROZEN_TOTAL,
    },
  };
}

describeOrSkip('termite annual signature charge — real Postgres', () => {
  let fixture;
  let ids;

  beforeEach(async () => {
    fixture = await createScratchDb();
    const { db } = fixture;
    const customerId = randomUUID();
    const [estimate] = await db('estimates').insert({
      customer_id: customerId,
      annual_plan_activation_status: 'activated',
      annual_plan_deferred_invoice: JSON.stringify(frozenContext()),
    }).returning('*');
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, status: 'sent', subtotal: FROZEN_TOTAL, discount_amount: 0, tax_amount: 0, total: FROZEN_TOTAL,
    }).returning('*');
    const [contract] = await db('customer_contracts').insert({
      customer_id: customerId,
      document_template_key: ANNUAL_TEMPLATE_KEY,
      status: 'signed',
      signed_at: new Date(),
      contract_text_snapshot: SIGNED_TEXT_WITH_AUTHORIZATION,
      annual_plan_version: 'v3',
      signer_ip: '203.0.113.9',
      signer_user_agent: 'jest',
      document_variables_snapshot: JSON.stringify({ estimate: { id: estimate.id } }),
    }).returning('*');
    ids = {
      customerId, estimateId: estimate.id, invoiceId: invoice.id, contractId: contract.id,
    };
  });

  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (fixture) await fixture.destroy();
  });

  function load({
    gateOn = true, method = 'default', chargeImpl, quoteTotal = FROZEN_TOTAL,
  } = {}) {
    const { db } = fixture;
    const notifyAdmin = jest.fn().mockResolvedValue(true);
    const resolvedMethod = method === 'default'
      ? {
        stripePaymentMethodId: 'pm_saved', paymentMethodRowId: randomUUID(), methodType: 'card', funding: 'debit', source: 'saved',
      }
      : method;
    const chargeInvoiceWithSavedCard = jest.fn(chargeImpl || (async (invoiceId) => {
      await db('invoices').where({ id: invoiceId }).update({ status: 'paid' });
      return { id: 'payment-1' };
    }));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => logger);
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    const quoteInvoiceSavedCardCharge = jest.fn(async () => ({ total: quoteTotal }));
    jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));
    // The frozen-snapshot validator itself is covered by the converter
    // suite; loading the whole converter here would drag its module graph
    // onto this scratch pool.
    jest.doMock('../services/estimate-converter', () => ({
      frozenTermiteAnnualFinancialsFor: (estimate) => {
        const context = typeof estimate?.annual_plan_deferred_invoice === 'string'
          ? JSON.parse(estimate.annual_plan_deferred_invoice)
          : estimate?.annual_plan_deferred_invoice;
        if (!(context?.frozenFinancials?.total > 0)) throw new Error('no frozen snapshot');
        return context.frozenFinancials;
      },
    }));
    // The two shared classifiers are the REAL ones (resolved lazily, after
    // every mock above is registered, so the real module's own graph binds
    // to this test's mocks).
    jest.doMock('../services/recurring-card-on-file', () => {
      const actual = jest.requireActual('../services/recurring-card-on-file');
      return {
        isPrepayCardAndChargeEnabled: jest.fn(() => gateOn),
        resolvePrepayChargeMethod: jest.fn(async () => resolvedMethod),
        isAmbiguousSavedMethodChargeError: actual.isAmbiguousSavedMethodChargeError,
        classifySavedMethodChargeInvoice: actual.classifySavedMethodChargeInvoice,
      };
    });
    const { chargeAnnualInvoiceAtSignature } = require('../services/termite-annual-signature-charge');
    const run = (extra = {}) => chargeAnnualInvoiceAtSignature({
      estimateId: ids.estimateId, contractId: ids.contractId, invoiceId: ids.invoiceId, conn: db, trigger: 'signature', ...extra,
    });
    return {
      run, notifyAdmin, chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge, db, resolvedMethod, logger,
    };
  }

  const chargeState = async (db) => (await db('estimates').where({ id: ids.estimateId }).first()).annual_plan_signature_charge;

  test('enrolled method: charges once, capped at the frozen accepted total, records the signature consent, no pay link', async () => {
    const {
      run, chargeInvoiceWithSavedCard, db, resolvedMethod,
    } = load();

    const outcome = await run();

    expect(outcome).toEqual({ status: 'paid', reason: null, deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith(ids.invoiceId, resolvedMethod.paymentMethodRowId, expect.objectContaining({
      customerInitiated: true,
      maxAuthorizedChargeCents: FROZEN_TOTAL * 100,
      maxAuthorizedTotalCents: FROZEN_TOTAL * 100,
      requireAutopayForCustomerId: ids.customerId,
      requireSelfPayCustomerId: ids.customerId,
    }));
    const state = await chargeState(db);
    expect(state).toMatchObject({ status: 'paid', invoice_id: ids.invoiceId, trigger: 'signature' });
    const consents = await db('payment_method_consents');
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      customer_id: ids.customerId,
      stripe_payment_method_id: 'pm_saved',
      source: 'contract_signing',
      consent_text_snapshot: SIGNED_TEXT_WITH_AUTHORIZATION,
      consent_text_version: 'termite_annual_agreement_v3',
      evidence_contract_id: ids.contractId,
      ip: '203.0.113.9',
    });
  });

  test('at most once: a replay (sweep / double sign) never charges again and never sends a pay link after a paid charge', async () => {
    const { run, chargeInvoiceWithSavedCard, db } = load();
    await run();
    const replay = await run({ trigger: 'sweep' });

    expect(replay).toMatchObject({ status: 'paid', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(await db('payment_method_consents')).toHaveLength(1);
  });

  test('concurrent entries: exactly one Stripe call', async () => {
    const { run, chargeInvoiceWithSavedCard } = load();

    const outcomes = await Promise.all([run(), run({ trigger: 'sweep' }), run({ trigger: 'sweep' })]);

    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o.status === 'paid')).toHaveLength(1);
    expect(outcomes.every((o) => o.deliverPayLink === false)).toBe(true);
  });

  test('decline: owner bell + pay link, and a later entry sends the link again but NEVER retries the card', async () => {
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin, db,
    } = load({ chargeImpl: async () => { throw new Error('Your card was declined.'); } });

    const first = await run();
    expect(first).toEqual({ status: 'declined', reason: 'Your card was declined.', deliverPayLink: true });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringContaining('declined'), expect.any(String),
      expect.objectContaining({ bell: true, dedupeKey: `termite-annual-signature-charge:${ids.estimateId}:charge_declined` }),
    );

    const second = await run({ trigger: 'sweep' });
    expect(second).toMatchObject({ status: 'declined', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect((await chargeState(db)).status).toBe('declined');
  });

  test('an UNCHANGED base whose credit-card surcharge passes the frozen total is not authorized by the signature: skipped up front, pay link + bell, never charged', async () => {
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin, db,
    } = load({ quoteTotal: 462.02 });

    expect(await run()).toEqual({ status: 'skipped', reason: 'surcharge_exceeds_accepted_total', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(await db('payment_method_consents')).toHaveLength(0);
    expect(notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringContaining('surcharge'), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-annual-signature-charge:${ids.estimateId}:surcharge_not_authorized` }),
    );
  });

  test('codex round-4 P1: a signed agreement WITHOUT the explicit initial-charge clause never charges — pay link, no consent row', async () => {
    const {
      run, chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge, db,
    } = load();
    await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: SIGNED_TEXT_RENEWALS_ONLY });

    expect(await run()).toEqual({ status: 'skipped', reason: 'no_initial_charge_authorization', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
    expect(await db('payment_method_consents')).toHaveLength(0);
    expect((await chargeState(db)).status).toBe('skipped');
  });

  test('codex round-4 P1: an Auto Pay enrollment alone is not consent — the enrolled method is never charged without the signed clause', async () => {
    const { run, chargeInvoiceWithSavedCard, db } = load({
      method: {
        stripePaymentMethodId: 'pm_legacy_autopay', paymentMethodRowId: randomUUID(), methodType: 'card', funding: 'debit', source: 'autopay',
      },
    });
    await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: 'THE SIGNED AGREEMENT TEXT' });

    expect(await run()).toMatchObject({ status: 'skipped', reason: 'no_initial_charge_authorization', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('codex round-4 P1: an invoice whose BASE was edited upward is held — owner bell, no charge, NO pay link (not treated as a surcharge)', async () => {
    const {
      run, chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge, notifyAdmin, db,
    } = load({ quoteTotal: 520 });
    await db('invoices').where({ id: ids.invoiceId }).update({ subtotal: 520, total: 520 });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'deferred', reason: 'invoice_base_drift', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringContaining('changed since signing'), expect.stringContaining('subtotal 520'),
      expect.objectContaining({ dedupeKey: `termite-annual-signature-charge:${ids.estimateId}:invoice_base_drift` }),
    );
    expect(await chargeState(db)).toMatchObject({ status: 'deferred', reason: 'invoice_base_drift' });

    // A later sweep entry follows the recorded hold: still no charge, no link.
    const replay = await run({ trigger: 'sweep' });
    expect(replay).toMatchObject({ status: 'deferred', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('codex round-4 P1: base drift is held even on a pay-link lane (charging gate off)', async () => {
    const { run, db } = load({ gateOn: false });
    await db('invoices').where({ id: ids.invoiceId }).update({ tax_amount: 31.43, total: 480.43 });

    expect(await run()).toMatchObject({ status: 'deferred', reason: 'invoice_base_drift', deliverPayLink: false });
  });

  test('an unchanged base with a deposit credit applied (total below the frozen total) is not drift — charges', async () => {
    const { run, chargeInvoiceWithSavedCard, db } = load({ quoteTotal: 400 });
    await db('invoices').where({ id: ids.invoiceId }).update({ total: 400 });

    expect(await run()).toMatchObject({ status: 'paid', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('if the charge-time total still exceeds the ceiling, the charge service refuses → decline lane (pay link), never overcharged', async () => {
    const { run } = load({
      chargeImpl: async () => { throw new Error('Charge total exceeds the quoted total the customer authorized. Review before charging.'); },
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ status: 'declined', deliverPayLink: true });
  });

  test('ambiguous outcome: bell, NO pay link, and no later retry or link', async () => {
    const ambiguous = Object.assign(new Error('timeout talking to Stripe'), { code: 'STRIPE_AMBIGUOUS_OUTCOME' });
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin,
    } = load({ chargeImpl: async () => { throw ambiguous; } });

    const first = await run();
    expect(first).toEqual({ status: 'ambiguous', reason: 'STRIPE_AMBIGUOUS_OUTCOME', deliverPayLink: false });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringContaining('reconciliation'), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-annual-signature-charge:${ids.estimateId}:charge_unresolved` }),
    );

    const second = await run({ trigger: 'sweep' });
    expect(second.deliverPayLink).toBe(false);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
  });

  test('a committed charge whose invoice still reads processing on a CARD is ambiguous (no link)', async () => {
    const { run, db } = load({
      chargeImpl: async (invoiceId) => {
        await db('invoices').where({ id: invoiceId }).update({ status: 'processing', payment_method: 'card' });
        return {};
      },
    });

    expect(await run()).toMatchObject({ status: 'ambiguous', reason: 'card_intent_incomplete', deliverPayLink: false });
  });

  test('an initiated bank debit is processing (settled for delivery purposes, no link)', async () => {
    const { run, db } = load({
      chargeImpl: async (invoiceId) => {
        await db('invoices').where({ id: invoiceId }).update({ status: 'processing', payment_method: 'us_bank_account' });
        return {};
      },
    });

    expect(await run()).toMatchObject({ status: 'processing', deliverPayLink: false });
  });

  test('no enrolled method: pay link exactly as before — no charge, no consent row, no bell', async () => {
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin, db,
    } = load({ method: null });

    expect(await run()).toEqual({ status: 'skipped', reason: 'no_enrolled_method', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(await db('payment_method_consents')).toHaveLength(0);
  });

  test('GATE_PREPAY_CARD_AND_CHARGE off: pay link, never a charge', async () => {
    const { run, chargeInvoiceWithSavedCard } = load({ gateOn: false });

    expect(await run()).toMatchObject({ status: 'skipped', reason: 'gate_off', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('payer-billed invoice: never the homeowner card — the ordinary delivery routes it', async () => {
    const { run, chargeInvoiceWithSavedCard, db } = load();
    await db('invoices').where({ id: ids.invoiceId }).update({ payer_id: randomUUID() });

    expect(await run()).toMatchObject({ status: 'skipped', reason: 'payer_billed', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('no valid frozen total: never charges without a ceiling — bell + pay link', async () => {
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin, db,
    } = load();
    await db('estimates').where({ id: ids.estimateId }).update({ annual_plan_deferred_invoice: JSON.stringify({ version: 1 }) });

    expect(await run()).toMatchObject({ status: 'skipped', reason: 'no_accepted_amount', deliverPayLink: true });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalled();
  });

  test('consent cannot be recorded: nothing charged, no link, and the claim is RELEASED so the sweep retries', async () => {
    const { run, chargeInvoiceWithSavedCard, db } = load();
    await db('customer_contracts').where({ id: ids.contractId }).update({ contract_text_snapshot: null });

    expect(await run()).toMatchObject({ status: 'deferred', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(await chargeState(db)).toBeNull();
  });

  test('a fresh claim held by another executor is left alone — no charge, no link, no false-alarm bell', async () => {
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin, db,
    } = load();
    await db('estimates').where({ id: ids.estimateId }).update({
      annual_plan_signature_charge: JSON.stringify({ status: 'claimed', claim_token: 'other', claimed_at: new Date().toISOString() }),
    });

    expect(await run()).toMatchObject({ status: 'in_flight', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a claim stuck unresolved for over an hour rings the reconciliation bell — still no charge, no link', async () => {
    const {
      run, chargeInvoiceWithSavedCard, notifyAdmin, db,
    } = load();
    await db('estimates').where({ id: ids.estimateId }).update({
      annual_plan_signature_charge: JSON.stringify({ status: 'claimed', claim_token: 'other', claimed_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }),
    });

    expect(await run()).toMatchObject({ status: 'ambiguous', deliverPayLink: false });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringContaining('reconciliation'), expect.any(String), expect.any(Object),
    );
  });
});
