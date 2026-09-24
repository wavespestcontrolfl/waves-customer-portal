/**
 * apply-credit's saved-card claim fence — Codex round-2 P2: re-throwing
 * assertNoInvoiceChargeReconciliationPending's mapped error INSIDE the
 * apply-credit db.transaction rolled back its own promotion of a stale,
 * submitted 'claimed' attempt to 'ambiguous' (services/stripe.js's
 * promoteStaleSavedCardClaim runs on the SAME trx). Every LATER attempt
 * then re-read the same un-promoted, stale-but-still-'claimed' row and
 * kept reporting "a charge is in progress" forever instead of "ambiguous,
 * reconcile it" — the promotion could never stick.
 *
 * This proves the transaction-commit mechanics directly (real Postgres,
 * not mocked): returning a refusal SENTINEL from inside the transaction
 * (the fix, mirroring recordManualPayment's chargeReconciliationPending)
 * lets the promotion commit; re-throwing the mapped error (the bug) rolls
 * it back. Exercised against StripeService.assertNoInvoiceChargeReconciliationPending
 * itself rather than the full HTTP route, which needs a large unrelated
 * fixture (credit balance, invoice totals, customer contacts) that would
 * only obscure this one transaction-mechanics question.
 */
const { randomUUID } = require('crypto');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

async function seed(db) {
  const f = { customerId: randomUUID(), invoiceId: randomUUID(), attemptId: randomUUID() };
  await db('customers').insert({
    id: f.customerId, first_name: 'Fixture', last_name: 'ClaimPromotion', phone: '+12025550199',
    email: `${f.customerId}@example.invalid`,
  });
  await db('invoices').insert({
    id: f.invoiceId, token: randomUUID(), invoice_number: `AUD-${f.invoiceId.slice(0, 8)}`,
    customer_id: f.customerId, title: 'Quarterly pest control', status: 'sent', total: 120, subtotal: 120,
    line_items: JSON.stringify([{ description: 'Quarterly service', quantity: 1, unit_price: 120, amount: 120 }]),
    stripe_payment_intent_id: null,
  });
  // Stale (created > 5 min ago) AND submitted — the shape
  // promoteStaleSavedCardClaim (not releaseStalePreSubmitSavedCardClaim)
  // acts on.
  const staleAt = new Date(Date.now() - 10 * 60 * 1000);
  await db('stripe_invoice_charge_attempts').insert({
    id: f.attemptId, invoice_id: f.invoiceId, stripe_payment_method_id: 'pm_fixture_promotion',
    idempotency_key: `inv_card_on_file_${f.invoiceId}_${f.attemptId}`, status: 'claimed',
    submitted_at: staleAt, created_at: staleAt, amount: 120,
  });
  return f;
}

async function cleanup(db, f) {
  if (!f) return;
  await db('stripe_invoice_charge_attempts').where({ invoice_id: f.invoiceId }).del().catch(() => {});
  await db('invoices').where({ id: f.invoiceId }).del().catch(() => {});
  await db('customers').where({ id: f.customerId }).del().catch(() => {});
}

postgres('assertNoInvoiceChargeReconciliationPending stale-claim promotion — commit vs. rollback', () => {
  let db;
  let StripeService;

  beforeAll(() => {
    db = require('../models/db');
    StripeService = require('../services/stripe');
  });
  afterAll(async () => { await db.destroy(); });

  test('fix shape: returning a refusal sentinel instead of re-throwing lets the promotion COMMIT', async () => {
    const f = await seed(db);
    try {
      const outcome = await db.transaction(async (trx) => {
        try {
          await StripeService.assertNoInvoiceChargeReconciliationPending(f.invoiceId, trx);
        } catch (fenceErr) {
          expect(fenceErr.code).toBe('STRIPE_AMBIGUOUS_OUTCOME');
          return { chargeReconciliationPending: fenceErr.message };
        }
        throw new Error('expected the fence to trip');
      });

      expect(outcome.chargeReconciliationPending).toBeTruthy();

      const after = await db('stripe_invoice_charge_attempts').where({ id: f.attemptId }).first('status', 'resolved_at');
      expect(after.status).toBe('ambiguous');
      expect(after.resolved_at).toBeNull();
    } finally {
      await cleanup(db, f);
    }
  });

  test('bug shape (control): re-throwing the mapped error inside the transaction ROLLS BACK the promotion', async () => {
    const f = await seed(db);
    try {
      let caught = null;
      try {
        await db.transaction(async (trx) => {
          try {
            await StripeService.assertNoInvoiceChargeReconciliationPending(f.invoiceId, trx);
          } catch (fenceErr) {
            const err = new Error(`${fenceErr.message} — resolve it before applying credit`);
            err.statusCode = 409;
            throw err; // the pre-fix behavior
          }
          throw new Error('expected the fence to trip');
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.statusCode).toBe(409);

      // The promotion never committed — the row is exactly as seeded.
      const after = await db('stripe_invoice_charge_attempts').where({ id: f.attemptId }).first('status', 'resolved_at');
      expect(after.status).toBe('claimed');
      expect(after.resolved_at).toBeNull();
    } finally {
      await cleanup(db, f);
    }
  });
});
