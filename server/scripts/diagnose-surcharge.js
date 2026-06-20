#!/usr/bin/env node
/**
 * Read-only surcharge diagnostic for a single invoice's payment(s).
 *
 * Usage (break-glass, owner-authorized read-only prod credential):
 *   PROD_RO_URL='postgresql://...' node server/scripts/diagnose-surcharge.js WPC-2026-0178
 *
 * Reads PROD_RO_URL explicitly (never DATABASE_URL) so stray tooling that
 * defaults to DATABASE_URL cannot target prod. SELECT-only — no writes.
 *
 * Surcharge model (server/services/stripe-pricing.js): a flat 2.90% applies
 * ONLY to positively-confirmed credit cards (card_funding === 'credit').
 * Debit / prepaid / ACH / unknown funding all fail closed to base-only.
 * The invoice total stores base only; the surcharge lives on the payment row.
 */
// Canonical surcharge math — the diagnostic must verify against the same
// engine production charges with, not re-derive the rate. Pure module, no
// db/env side effects, safe to require from a CLI script.
const {
  computeSurchargeCents,
  CONFIGURED_COST_BPS,
} = require('../services/stripe-pricing');

const invoiceNumber = process.argv[2] || 'WPC-2026-0178';
const connectionString = process.env.PROD_RO_URL;

if (!connectionString) {
  console.error('Set PROD_RO_URL to the read-only connection string. Aborting.');
  process.exit(1);
}

const knex = require('knex')({
  client: 'pg',
  connection: { connectionString, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 1 },
});

(async () => {
  try {
    const invoice = await knex('invoices')
      .where({ invoice_number: invoiceNumber })
      .first(
        'id',
        'invoice_number',
        'subtotal',
        'discount_amount',
        'tax_amount',
        'total',
        'status',
        'stripe_payment_intent_id',
      );

    if (!invoice) {
      console.log(`No invoice found for ${invoiceNumber}`);
      return;
    }

    console.log('\n=== INVOICE ===');
    console.table([invoice]);

    // The payments table has NO invoice_id column. Linkage mirrors
    // findInvoiceForPayment() in routes/stripe-webhook.js, reversed:
    //   1) payments.stripe_payment_intent_id === invoices.stripe_payment_intent_id
    //   2) payments.metadata->>'invoice_id' (or waves_/dispute_ variants) === invoice.id
    const payments = await knex('payments')
      .where(function linkToInvoice() {
        if (invoice.stripe_payment_intent_id) {
          this.where('stripe_payment_intent_id', invoice.stripe_payment_intent_id);
        }
        this.orWhereRaw("metadata->>'invoice_id' = ?", [invoice.id]);
        this.orWhereRaw("metadata->>'waves_invoice_id' = ?", [invoice.id]);
        this.orWhereRaw("metadata->>'dispute_invoice_id' = ?", [invoice.id]);
      })
      .orderBy('created_at', 'asc')
      .select(
        'id',
        'amount',
        'status',
        'card_brand',
        'card_funding',
        'base_amount_cents',
        'surcharge_amount_cents',
        'surcharge_rate_bps',
        'surcharge_policy_version',
        'stripe_surcharge_maximum_amount_cents',
        'stripe_payment_intent_id',
        'created_at',
      );

    console.log('\n=== PAYMENTS ===');
    console.table(payments);

    if (!payments.length) {
      console.log(
        '\nNo payment rows link to this invoice — unpaid, a cash/check reconcile '
        + 'with no payment row, or the PI/metadata linkage is missing.',
      );
      return;
    }

    console.log('\n=== VERDICT ===');
    for (const p of payments) {
      const surcharge = (p.surcharge_amount_cents || 0) / 100;
      const base = p.base_amount_cents != null ? p.base_amount_cents / 100 : null;
      // surcharge_policy_version is stamped only when the surcharge engine
      // actually ran at charge time. Null means the charge predated or
      // bypassed that path (e.g. funding backfilled AFTER the charge by
      // scripts/backfill-card-funding.js) — so card_funding='credit' with
      // $0 surcharge is NOT a live bug unless the policy version is set.
      const policyRan = !!p.surcharge_policy_version;

      // Money reconciliation: amount should equal base + surcharge.
      let reconcile = '';
      if (base != null) {
        const expected = base + surcharge;
        const drift = Math.abs(expected - Number(p.amount));
        if (drift > 0.005) {
          reconcile = `  (⚠️ amount $${Number(p.amount).toFixed(2)} ≠ base $${base.toFixed(2)} + surcharge $${surcharge.toFixed(2)})`;
        }
      }

      // Verify the STORED surcharge against the canonical engine. Compare in
      // integer cents at the rate this row recorded (so a charge from before a
      // rate change still verifies as arithmetically correct), then separately
      // note if that recorded rate differs from the current configured policy.
      const storedSurchargeCents = p.surcharge_amount_cents || 0;
      const recordedRateBps = p.surcharge_rate_bps || CONFIGURED_COST_BPS;
      let expectedCents = null;
      if (p.base_amount_cents != null) {
        expectedCents = computeSurchargeCents(p.base_amount_cents, {
          costBps: recordedRateBps,
          stripeMaxCents: p.stripe_surcharge_maximum_amount_cents ?? undefined,
        });
      }
      const matchesCanonical = expectedCents != null && storedSurchargeCents === expectedCents;
      const rateNote = recordedRateBps === CONFIGURED_COST_BPS
        ? ''
        : `  (recorded ${recordedRateBps} bps vs current ${CONFIGURED_COST_BPS} bps — expected for a charge before a rate change)`;

      if (p.status === 'refunded' || p.status === 'disputed') {
        console.log(`Payment ${p.id}: ℹ️  status=${p.status} — check refunded_surcharge_cents separately.${reconcile}`);
      } else if (p.card_funding === 'credit' && surcharge > 0 && expectedCents == null) {
        console.log(`Payment ${p.id}: ℹ️  credit card, $${surcharge.toFixed(2)} surcharge, but base_amount_cents is null — cannot verify against canonical math.${reconcile}`);
      } else if (p.card_funding === 'credit' && matchesCanonical) {
        console.log(`Payment ${p.id}: ✅ credit card, $${surcharge.toFixed(2)} surcharge matches canonical ${recordedRateBps} bps on $${base.toFixed(2)} base — correct.${rateNote}${reconcile}`);
      } else if (p.card_funding === 'credit' && expectedCents != null && !matchesCanonical) {
        console.log(`Payment ${p.id}: ⚠️  CREDIT card MISCALCULATED — stored $${surcharge.toFixed(2)} but ${recordedRateBps} bps on $${base.toFixed(2)} base = $${(expectedCents / 100).toFixed(2)} expected. BUG.${reconcile}`);
      } else if (p.card_funding === 'credit' && policyRan) {
        console.log(`Payment ${p.id}: ⚠️  CREDIT card, policy ${p.surcharge_policy_version} ran but $0 surcharge — BUG (surcharge bypassed).${reconcile}`);
      } else if (p.card_funding === 'credit') {
        console.log(`Payment ${p.id}: ℹ️  funding now reads 'credit' but no surcharge policy was stamped — charged on a non-surcharge path or funding backfilled after the charge (not a live bug; verify charge path).${reconcile}`);
      } else if (storedSurchargeCents > 0) {
        // Only positively-confirmed credit cards may be surcharged. A positive
        // surcharge on debit / prepaid / unknown funding is a policy violation.
        console.log(`Payment ${p.id}: ⚠️  ${p.card_funding || 'UNKNOWN/null'} funding charged $${surcharge.toFixed(2)} surcharge — BUG (only confirmed credit cards may be surcharged; expected $0).${reconcile}`);
      } else if (!p.card_funding) {
        console.log(`Payment ${p.id}: ℹ️  funding UNKNOWN/null — failed closed to no surcharge (by design).${reconcile}`);
      } else {
        console.log(`Payment ${p.id}: ✅ ${p.card_funding} card — no surcharge by policy — correct.${reconcile}`);
      }
    }
  } catch (err) {
    console.error('Query failed:', err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
