#!/usr/bin/env node
/**
 * Backfill card_funding on payment_methods from Stripe.
 *
 * For each stored Stripe card that doesn't have card_funding populated,
 * retrieves the PaymentMethod from Stripe and writes pm.card.funding.
 *
 * Usage:
 *   node server/scripts/backfill-card-funding.js
 *   node server/scripts/backfill-card-funding.js --dry-run
 *   node server/scripts/backfill-card-funding.js --limit 50
 *
 * Controlled concurrency (5 at a time), retry on rate limit, resumable.
 */

require('dotenv').config();
const knex = require('../models/db');
const Stripe = require('stripe');
const stripeConfig = require('../config/stripe-config');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) || 500 : 500;
})();
const CONCURRENCY = 5;
const RATE_LIMIT_RETRY_MS = 2000;
const MAX_RETRIES = 3;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia' });

  const rows = await knex('payment_methods')
    .where({ processor: 'stripe', method_type: 'card' })
    .whereNull('card_funding')
    .whereNotNull('stripe_payment_method_id')
    .select('id', 'stripe_payment_method_id', 'customer_id')
    .limit(LIMIT);

  console.log(`Found ${rows.length} cards missing card_funding (limit=${LIMIT}, dry_run=${DRY_RUN})`);
  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    process.exit(0);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  async function processRow(row) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const pm = await stripe.paymentMethods.retrieve(row.stripe_payment_method_id);
        const funding = pm.card?.funding || null;
        const country = pm.card?.country || null;

        if (!funding) {
          console.log(`  [skip] ${row.id} (${row.stripe_payment_method_id}): no card.funding from Stripe`);
          skipped++;
          return;
        }

        if (DRY_RUN) {
          console.log(`  [dry-run] ${row.id}: would set card_funding=${funding}, card_country=${country}`);
          updated++;
          return;
        }

        await knex('payment_methods')
          .where({ id: row.id })
          .update({
            card_funding: funding,
            card_funding_checked_at: knex.fn.now(),
          });

        console.log(`  [ok] ${row.id}: card_funding=${funding}`);
        updated++;
        return;
      } catch (err) {
        if (err.statusCode === 429 && attempt < MAX_RETRIES) {
          console.log(`  [rate-limit] ${row.id}: retrying in ${RATE_LIMIT_RETRY_MS}ms (attempt ${attempt}/${MAX_RETRIES})`);
          await sleep(RATE_LIMIT_RETRY_MS * attempt);
          continue;
        }
        if (err.code === 'resource_missing') {
          console.log(`  [gone] ${row.id} (${row.stripe_payment_method_id}): PM no longer exists in Stripe`);
          skipped++;
          return;
        }
        console.error(`  [error] ${row.id}: ${err.message}`);
        failed++;
        return;
      }
    }
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processRow));
    if (i + CONCURRENCY < rows.length) {
      console.log(`  ... processed ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
