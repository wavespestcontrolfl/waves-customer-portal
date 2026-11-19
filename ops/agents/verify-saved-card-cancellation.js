// MUTATES with --execute. The default verifies one historical cancellation.
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { parse: parsePgUrl } = require('pg-connection-string');
const { verifySavedCardCancellation } = require('../../server/services/invoice-payment-authentication');

const usage = 'node ops/agents/verify-saved-card-cancellation.js --attempt <uuid> --intent <pi_id> [--execute]';

function databaseConfig(connectionString) {
  let parsed;
  try {
    parsed = parsePgUrl(connectionString);
  } catch {
    // Do not let a URL parser include the password in its error text.
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL.');
  }
  // pg resolves URL fields first, then PG* environment values, then its
  // defaults. In particular, an empty URL host must not hide PGHOST.
  const user = parsed.user || process.env.PGUSER || undefined;
  const host = String(parsed.host || process.env.PGHOST || 'localhost')
    .replace(/^\[|\]$/g, '');
  const port = Number(parsed.port || process.env.PGPORT || 5432);
  const database = parsed.database || process.env.PGDATABASE || user;
  const caFile = process.env.PG_CA_FILE || process.env.PGSSLROOTCERT || parsed.sslrootcert;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('/');
  const ssl = local ? parsed.ssl : {
    // Do not carry sslmode/no-verify/ssl=false from the URL into pg. A remote
    // connection always verifies the certificate and hostname; with no ca,
    // Node uses its public trust store.
    ...(typeof parsed.ssl === 'object' ? parsed.ssl : {}),
    rejectUnauthorized: true,
    ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}),
  };
  return {
    client: 'pg',
    connection: {
      host,
      port,
      user,
      password: parsed.password || process.env.PGPASSWORD,
      database,
      ssl,
    },
    pool: { min: 0, max: 1 },
  };
}

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
  const database = require('knex')(databaseConfig(process.env.DATABASE_URL));
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

module.exports = { databaseConfig };
