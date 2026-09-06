// Load .env for local dev — on Railway, env vars are injected directly
require('./config/load-env')();

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

// DB_POOL_MIN / DB_POOL_MAX must be read HERE: models/db.js builds knex
// straight from this file, so a pool knob anywhere else is dead config
// (config/index.js once mirrored these envs into config.db.pool, which
// nothing read — setting DB_POOL_MAX on Railway silently did nothing).
function poolSize(envName, fallback) {
  const n = parseInt(process.env[envName], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// A mis-set env var must degrade the pool, never break the app: min > max
// makes tarn throw at startup ("opt.max is smaller than opt.min"), and a
// pool of 1 deadlocks every cron-lock job (the advisory-lock connection is
// pinned while the job body queries the pool for a second one) — so the
// floor for max is 2, and min clamps to max.
function poolConfig(defaultMax) {
  const max = Math.max(2, poolSize('DB_POOL_MAX', defaultMax));
  return { min: Math.min(poolSize('DB_POOL_MIN', 2), max), max };
}

const development = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: poolConfig(10),
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
    pool: poolConfig(20),
    migrations: {
      directory: './models/migrations',
      tableName: 'knex_migrations',
    },
  },
};
