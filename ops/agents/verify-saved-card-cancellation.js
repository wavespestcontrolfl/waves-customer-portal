// MUTATES with --execute. The default verifies one historical cancellation.
const fs = require('node:fs');
const { isIP } = require('node:net');
const tls = require('node:tls');
const { parseArgs } = require('node:util');
const { parse: parsePgUrl } = require('pg-connection-string');
const { verifySavedCardCancellation } = require('../../server/services/invoice-payment-authentication');

const usage = 'node ops/agents/verify-saved-card-cancellation.js --attempt <uuid> --intent <pi_id> [--execute]';
const DATABASE_ENV = 'SAVED_CARD_CANCELLATION_DATABASE_URL';
const firstPresent = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

function databaseConfig(connectionString) {
  let parsed;
  try {
    parsed = parsePgUrl(connectionString);
  } catch {
    // Do not let a URL parser include the password in its error text.
    throw new Error(`${DATABASE_ENV} is not a valid PostgreSQL URL.`);
  }
  // pg resolves URL fields first, then PG* environment values, then its
  // defaults. In particular, an empty URL host must not hide PGHOST.
  const user = firstPresent(parsed.user, process.env.PGUSER);
  const host = String(firstPresent(parsed.host, process.env.PGHOST, 'localhost'))
    .replace(/^\[|\]$/g, '');
  const port = Number(firstPresent(parsed.port, process.env.PGPORT, 5432));
  const database = firstPresent(parsed.database, process.env.PGDATABASE, user);
  const caFile = firstPresent(process.env.PG_CA_FILE, process.env.PGSSLROOTCERT, parsed.sslrootcert);
  const certificateHost = firstPresent(String(process.env.PGSSL_SERVER_NAME || '').trim(), host);
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('/');
  // pg-connection-string leaves the literal URL value ssl=false as a string;
  // normalize it before handing the local config back to node-postgres.
  const localSsl = parsed.ssl === 'false' ? false : parsed.ssl === 'true' ? true : parsed.ssl;
  const ssl = local ? localSsl : {
    // Do not carry sslmode/no-verify/ssl=false from the URL into pg. A remote
    // connection always verifies the certificate and hostname; with no ca,
    // Node uses its public trust store.
    ...(typeof parsed.ssl === 'object' ? parsed.ssl : {}),
    rejectUnauthorized: true,
    ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}),
    // Explicitly verify every remote identity. TLS does not send an IP literal
    // as SNI, but checkServerIdentity still validates its IP SAN.
    ...(!isIP(certificateHost) ? { servername: certificateHost } : {}),
    checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(certificateHost, certificate),
  };
  return {
    client: 'pg',
    connection: {
      host,
      port,
      user,
      password: firstPresent(parsed.password, process.env.PGPASSWORD),
      database,
      options: firstPresent(parsed.options, process.env.PGOPTIONS),
      application_name: firstPresent(parsed.application_name, process.env.PGAPPNAME),
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
  if (!process.env[DATABASE_ENV] || !process.env.STRIPE_SECRET_KEY) {
    throw new Error(`Supply ${DATABASE_ENV} and STRIPE_SECRET_KEY for the same environment.`);
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const database = require('knex')(databaseConfig(process.env[DATABASE_ENV]));
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
