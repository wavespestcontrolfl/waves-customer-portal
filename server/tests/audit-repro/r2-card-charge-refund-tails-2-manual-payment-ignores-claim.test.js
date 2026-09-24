/**
 * Audit repro r2-card-charge-refund-tails-2 (race / double collection):
 *
 * chargeInvoiceWithSavedCard commits a durable 'claimed' row in
 * stripe_invoice_charge_attempts (stripe.js:215-246) and stamps submitted_at
 * on the ROOT handle (stripe.js:304-323) BEFORE stripe.paymentIntents.create
 * (stripe.js:2539). The invoice's own processing/paid flip + PI stamp lives
 * inside the still-open invoice transaction (stripe.js:2559-2582), so a
 * process death after the Stripe call leaves: invoice 'sent', no PI stamp,
 * attempt 'claimed' + submitted_at set. Every other collection rail asks
 * assertNoInvoiceChargeReconciliationPending (stripe.js:143) first and would
 * refuse with STRIPE_CHARGE_IN_PROGRESS; recordManualPayment
 * (invoice-manual-payment.js:100-300) never reads the attempt table and flips
 * the invoice to paid with a cash ledger row — the customer's card charge then
 * lands as a quarantined orphan (double collection).
 *
 * Runs only against a private waves_audit_* Postgres clone:
 *   createdb -h localhost -T waves_audit_tpl waves_audit_<slug>
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_<slug> \
 *     NODE_ENV=test npx jest --runInBand tests/audit-repro/r2-card-charge-refund-tails-2-manual-payment-ignores-claim.test.js
 *
 * Written to assert the CORRECT behaviour (409 refusal) — it FAILS on current code.
 */
jest.mock('../../models/marker-db', () => () => require('../../models/db'));
jest.mock('../../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref', 'destroy']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn', 'client']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Post-flip side effects that are irrelevant to the fence under test.
jest.mock('../../services/invoice-followups', () => ({ stopOnPayment: jest.fn(async () => undefined) }));
jest.mock('../../services/billing-pause', () => ({ maybeResumeBillingPauseOnPayment: jest.fn(async () => undefined) }));
jest.mock('../../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => null) }));
jest.mock('../../services/project-report-hold', () => ({ scheduleHoldReleaseSweep: jest.fn() }));
jest.mock('../../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));
jest.mock('../../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => undefined) }));
jest.mock('../../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: false })) }));
jest.mock('../../services/receipt-delivery-queue', () => ({ enqueueReceiptDelivery: jest.fn(), scheduleReceiptDeliveryDrain: jest.fn() }));
jest.mock('../../services/dispatch-alerts', () => ({ createAlert: jest.fn(async () => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const connection = process.env.DATABASE_URL;
const postgres = connection && /\/waves_audit_/.test(connection) ? describe : describe.skip;
let mockPg;
jest.setTimeout(60000);

async function seed() {
  const f = { customerId: randomUUID(), invoiceId: randomUUID(), attemptId: randomUUID() };
  await mockPg('customers').insert({
    id: f.customerId, first_name: 'Fixture', last_name: 'ClaimFence', phone: '+12025550188',
    email: `${f.customerId}@example.invalid`,
  });
  await mockPg('invoices').insert({
    id: f.invoiceId, token: randomUUID(), invoice_number: `AUD-${f.invoiceId.slice(0, 8)}`,
    customer_id: f.customerId, title: 'Quarterly pest control', status: 'sent', total: 120, subtotal: 120,
    line_items: JSON.stringify([{ description: 'Quarterly service', quantity: 1, unit_price: 120, amount: 120 }]),
    stripe_payment_intent_id: null,
  });
  // The state a crash between stripe.js:2539 (PI create) and the invoice
  // transaction commit leaves behind: claimed + submitted, no PI id yet.
  await mockPg('stripe_invoice_charge_attempts').insert({
    id: f.attemptId, invoice_id: f.invoiceId, stripe_payment_method_id: 'pm_fixture_claimfence',
    idempotency_key: `inv_card_on_file_${f.invoiceId}_${f.attemptId}`, status: 'claimed',
    submitted_at: new Date(), amount: 120,
  });
  return f;
}

async function cleanup(f) {
  if (!f) return;
  await mockPg('activity_log').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('payments').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('stripe_invoice_charge_attempts').where({ invoice_id: f.invoiceId }).del().catch(() => {});
  await mockPg('invoices').where({ id: f.invoiceId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

postgres('r2-card-charge-refund-tails-2: manual payment ignores the durable saved-card claim fence', () => {
  let f;
  beforeAll(async () => {
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    f = await seed();
  });
  afterAll(async () => { await cleanup(f); if (mockPg) await mockPg.destroy(); });

  test('the shared fence WOULD refuse this invoice (control: STRIPE_CHARGE_IN_PROGRESS)', async () => {
    const StripeService = require('../../services/stripe');
    await expect(StripeService.assertNoInvoiceChargeReconciliationPending(f.invoiceId))
      .rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS' });
  });

  test('recordManualPayment refuses (409) while a submitted saved-card claim is unresolved', async () => {
    const { recordManualPayment } = require('../../services/invoice-manual-payment');
    let outcome;
    try {
      outcome = await recordManualPayment(f.invoiceId, { method: 'check', reference: '1042', sendReceipt: false });
    } catch (err) {
      outcome = err;
    }
    const after = await mockPg('invoices').where({ id: f.invoiceId }).first('status', 'stripe_payment_intent_id');
    const ledger = await mockPg('payments').where({ customer_id: f.customerId });
    const attempt = await mockPg('stripe_invoice_charge_attempts').where({ id: f.attemptId }).first('status', 'resolved_at');
    // Diagnostic for the report.
     
    console.log('[repro] outcome:', outcome instanceof Error ? `${outcome.statusCode} ${outcome.message}` : `resolved invoice.status=${outcome?.invoice?.status}`,
      '| invoice after:', after, '| payments rows:', ledger.length, '| attempt:', attempt);

    // CORRECT behaviour: a 409 refusal, invoice untouched, no cash ledger row.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.statusCode).toBe(409);
    expect(after.status).toBe('sent');
    expect(ledger).toHaveLength(0);
  });
});
