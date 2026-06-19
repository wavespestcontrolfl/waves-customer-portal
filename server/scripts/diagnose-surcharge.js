#!/usr/bin/env node
/**
 * Read-only surcharge diagnostic for a single invoice's payment(s).
 *
 * Usage (break-glass, owner-authorized read-only prod credential):
 *   PROD_RO_URL='postgresql://...' node server/scripts/diagnose-surcharge.js WPC-2026-0178
 *
 * Reads PROD_RO_URL explicitly (never DATABASE_URL) so stray tooling that
 * defaults to DATABASE_URL cannot target prod. SELECT-only — no writes.
 */
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
      .first('id', 'invoice_number', 'subtotal', 'discount_amount', 'tax_amount', 'total', 'status');

    if (!invoice) {
      console.log(`No invoice found for ${invoiceNumber}`);
      return;
    }

    console.log('\n=== INVOICE ===');
    console.table([invoice]);

    const payments = await knex('payments')
      .where({ invoice_id: invoice.id })
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
        'stripe_surcharge_status',
        'created_at',
      );

    console.log('\n=== PAYMENTS ===');
    console.table(payments);

    console.log('\n=== VERDICT ===');
    for (const p of payments) {
      const surcharge = (p.surcharge_amount_cents || 0) / 100;
      if (p.card_funding === 'credit' && surcharge === 0) {
        console.log(`Payment ${p.id}: ⚠️  CREDIT card with $0 surcharge — BUG (surcharge bypassed).`);
      } else if (p.card_funding === 'credit') {
        console.log(`Payment ${p.id}: ✅ credit card, $${surcharge.toFixed(2)} surcharge applied — correct.`);
      } else if (!p.card_funding) {
        console.log(`Payment ${p.id}: ℹ️  funding UNKNOWN/null — failed closed to no surcharge (by design).`);
      } else {
        console.log(`Payment ${p.id}: ✅ ${p.card_funding} card — no surcharge by policy — correct.`);
      }
    }
  } catch (err) {
    console.error('Query failed:', err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
