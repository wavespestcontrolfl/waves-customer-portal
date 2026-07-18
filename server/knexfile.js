// Load .env for local dev — on Railway, env vars are injected directly
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function hasUsableDatabaseUrl(value) {
  const url = String(value || '').trim();
  return !!url && url !== 'undefined' && url !== 'null';
}

function databaseUrlFromPgVars() {
  const { PGDATABASE, PGUSER, PGPASSWORD, PGHOST, PGPORT } = process.env;
  if (!PGDATABASE || !PGUSER || !PGHOST) return null;

  const user = encodeURIComponent(PGUSER);
  const password = PGPASSWORD ? `:${encodeURIComponent(PGPASSWORD)}` : '';
  const database = encodeURIComponent(PGDATABASE);
  return `postgresql://${user}${password}@${PGHOST}:${PGPORT || 5432}/${database}`;
}

// Railway may provide the database URL under different variable names
if (!hasUsableDatabaseUrl(process.env.DATABASE_URL)) {
  delete process.env.DATABASE_URL;
  const resolvedDatabaseUrl = process.env.DATABASE_PRIVATE_URL
    || process.env.DATABASE_PUBLIC_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_PRIVATE_URL
    || databaseUrlFromPgVars();
  if (resolvedDatabaseUrl) {
    process.env.DATABASE_URL = resolvedDatabaseUrl;
    // Keep stdout available for machine-readable command output (for example,
    // `audit:staff-rollout -- --json`). Connection diagnostics belong on
    // stderr so piping stdout to a JSON parser remains safe.
    console.error('[knexfile] Resolved DATABASE_URL from Railway Postgres vars');
  }
}

const development = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 },
  migrations: {
    directory: './models/migrations',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: '../scripts/seeds',
  },
};

module.exports = {
  development,

  // Jest sets NODE_ENV=test automatically; without this alias, knex(undefined)
  // throws and the LOCAL=1 regression harness falls back to engine defaults
  // silently. See TODO.md — "LOCAL=1 regression harness silently falls back".
  test: development,

  production: {
    client: 'pg',
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    },
    pool: { min: 2, max: 20 },
    migrations: {
      directory: './models/migrations',
      tableName: 'knex_migrations',
    },
  },
};
