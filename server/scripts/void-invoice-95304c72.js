#!/usr/bin/env node
/**
 * One-off — Void Invoice 95304c72-0b85-43a2-a060-8b934d529226 ($350)
 *
 * This invoice was created under a Stripe customer ID that doesn't exist in
 * the current Stripe account (cus_UKRWDUhMmGQcfN) and was flagged by Waves
 * to be voided rather than paid. Soft-delete preserves the audit trail.
 *
 * Run (dry-run, default):
 *   node server/scripts/void-invoice-95304c72.js
 *
 * Run (execute):
 *   node server/scripts/void-invoice-95304c72.js --execute
 */

const db = require('../models/db');

const INVOICE_ID = '95304c72-0b85-43a2-a060-8b934d529226';

async function main() {
  const execute = process.argv.includes('--execute');

  const invoice = await db('invoices').where({ id: INVOICE_ID }).first();

  if (!invoice) {
    console.log(`Invoice ${INVOICE_ID} not found. Nothing to do.`);
    process.exit(0);
  }

  console.log('Found invoice:');
  console.log(`  id:             ${invoice.id}`);
  console.log(`  invoice_number: ${invoice.invoice_number}`);
  console.log(`  customer_id:    ${invoice.customer_id}`);
  console.log(`  total:          $${invoice.total}`);
  console.log(`  status (before): ${invoice.status}`);

  if (invoice.status === 'void') {
    console.log('Already void. Nothing to do.');
    process.exit(0);
  }

  if (invoice.status === 'paid') {
    console.log('Refusing to void a paid invoice. Use a refund instead.');
    process.exit(1);
  }

  if (!execute) {
    console.log('\nDRY RUN — pass --execute to apply:');
    console.log(`  UPDATE invoices SET status='void' WHERE id='${INVOICE_ID}';`);
    process.exit(0);
  }

  const updated = await db('invoices')
    .where({ id: INVOICE_ID })
    .update({ status: 'void', updated_at: db.fn.now() })
    .returning(['id', 'invoice_number', 'status', 'updated_at']);

  console.log('\nVoided:');
  console.log(updated[0]);
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
