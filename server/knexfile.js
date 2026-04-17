// Load .env for local dev — on Railway, env vars are injected directly
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Railway may provide the database URL under different variable names
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PRIVATE_URL
    || process.env.DATABASE_PUBLIC_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_PRIVATE_URL
    || process.env.PGDATABASE && `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE}`
    || undefined;
  if (process.env.DATABASE_URL) console.log('[knexfile] Resolved DATABASE_URL from Railway Postgres vars');
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
