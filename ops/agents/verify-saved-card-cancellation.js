// MUTATES with --execute. The default verifies one historical cancellation.
const { parseArgs } = require('node:util');
const { verifySavedCardCancellation } = require('../../server/services/invoice-payment-authentication');

const usage = 'node ops/agents/verify-saved-card-cancellation.js --attempt <uuid> --intent <pi_id> [--execute]';

async function main() {
  const { values } = parseArgs({ options: {
    attempt: { type: 'string' }, intent: { type: 'string' },
    execute: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log(usage);
  if (!values.attempt || !values.intent) throw new Error(usage);
  if (!process.env.DATABASE_URL || !process.env.STRIPE_SECRET_KEY) {
    throw new Error('Supply DATABASE_URL and STRIPE_SECRET_KEY for the same environment.');
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const database = require('knex')({
    client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 },
  });
  try {
    const result = await verifySavedCardCancellation({
      attemptId: values.attempt, intentId: values.intent, execute: values.execute, stripe, database,
    });
    console.log(JSON.stringify(result));
  } finally {
    await database.destroy();
  }
}

if (require.main === module) main().catch((err) => {
  // Authentication errors from the Stripe SDK can echo part of a key.
  console.error(err.type?.startsWith('Stripe') ? 'Stripe lookup failed. Check the account, credentials and PaymentIntent ID.' : err.message);
  process.exitCode = 1;
});
