/**
 * Read-only SQL sandbox for the AI dashboard chart builder.
 *
 * The AI pin-to-dashboard feature lets an admin describe a chart in plain
 * English; an LLM generates a Postgres SELECT that runs against the live
 * database. That power demands defense-in-depth — this module is the single
 * gate every AI-generated query passes through, both at preview time and every
 * time a pinned widget re-runs on dashboard load.
 *
 * Layers (each independent — any one alone blocks the obvious attacks):
 *   1. Structural: must be a single statement starting with SELECT; no
 *      semicolons, comments, or dollar-quoting (blocks chaining / function
 *      bodies / injected DDL).
 *   2. Identifier denylist: catalog access (pg_*, information_schema,
 *      current_setting/set_config), file/large-object/dblink functions, and any
 *      secret/credential column name (password, token, secret, api_key, jwt,
 *      session, webhook, stripe_*, …) — nothing sensitive is even nameable.
 *   3. Table allowlist: only business-analytics tables may appear after
 *      FROM/JOIN. Anything else (users, auth, tokens, unknown tables) → rejected.
 *   4. Execution guard: run inside `SET TRANSACTION READ ONLY` with a
 *      statement_timeout, wrapped in an outer LIMIT, then rolled back. Postgres
 *      itself throws on any write even if a layer above were somehow bypassed —
 *      this is the backstop, not the only line.
 */

const db = require('../models/db');
const logger = require('./logger');

class SqlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlGuardError';
    this.code = 'SQL_GUARD';
  }
}

// Business-analytics tables the AI may read. NOTHING else is queryable — this is
// the scoping line that keeps auth/credential/PII-token tables out of reach.
const ALLOWED_TABLES = new Set([
  'customers',
  'leads',
  'lead_sources',
  'invoices',
  'invoice_line_items',
  'payments',
  'service_records',
  'scheduled_services',
  'services',
  'review_requests',
  'reviews',
  'estimates',
  'mrr_snapshots',
  'kpi_snapshots',
]);

// Tokens that must never appear anywhere in the SQL. Catalog/system access,
// file/network functions, and secret/credential identifiers. Write/DDL keywords
// are intentionally NOT listed here — the "starts with SELECT", single-statement,
// and READ ONLY transaction guards make writes impossible without the risk of
// false-positives on column names. Matched case-insensitively on word bounds.
const FORBIDDEN_PATTERNS = [
  /\bpg_[a-z_]+/, // pg_sleep, pg_read_file, pg_ls_dir, pg_catalog, …
  /\binformation_schema\b/,
  /\bpg_catalog\b/,
  /\bcurrent_setting\b/,
  /\bset_config\b/,
  /\bdblink\w*/,
  /\bcopy\b/,
  /\blo_[a-z]+/, // large-object functions
  /\bpassword\b/, /\bpasswd\b/, /\bsecret\b/, /\btoken\b/, /\bapi_?key\b/,
  /\bjwt\b/, /\bsession\b/, /\bwebhook\b/, /\bcredential\b/, /\bprivate_key\b/,
  /\bstripe_[a-z_]+/,
];

const MAX_SQL_LENGTH = 4000;

/**
 * Validate an AI-generated SQL string. Throws SqlGuardError on any violation;
 * returns the cleaned (trailing-semicolon-stripped) SQL on success. Pure — no DB.
 */
function validateAnalyticsSql(rawSql) {
  const sql = String(rawSql || '').trim().replace(/;+\s*$/, '');
  if (!sql) throw new SqlGuardError('Empty query.');
  if (sql.length > MAX_SQL_LENGTH) throw new SqlGuardError('Query is too long.');

  const lower = sql.toLowerCase();

  if (!/^select\b/.test(lower)) throw new SqlGuardError('Only a single SELECT is allowed (no WITH/CTEs).');
  if (sql.includes(';')) throw new SqlGuardError('Multiple statements are not allowed.');
  if (sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
    throw new SqlGuardError('SQL comments are not allowed.');
  }
  if (/\$[a-z0-9_]*\$/i.test(sql)) throw new SqlGuardError('Dollar-quoting is not allowed.');

  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(lower)) throw new SqlGuardError('Query references a disallowed table, column, or function.');
  }

  // Every table after FROM/JOIN must be allowlisted. Subqueries get their own
  // FROM matched too; a derived-table "FROM (" never matches the \w+ capture.
  const refs = [...lower.matchAll(/\b(?:from|join)\s+"?([a-z_][a-z0-9_]*)"?/g)].map((m) => m[1]);
  if (refs.length === 0) throw new SqlGuardError('Query must read from a known table.');
  for (const t of refs) {
    if (!ALLOWED_TABLES.has(t)) throw new SqlGuardError(`Table "${t}" is not available to the chart builder.`);
  }

  return sql;
}

/**
 * Validate + run a read-only analytics query. Caps rows and wall-clock, runs in
 * a READ ONLY transaction, and rolls back. Returns { rows, fields }.
 */
async function runReadOnlyAnalyticsQuery(rawSql, { rowCap = 1000, timeoutMs = 5000 } = {}) {
  const sql = validateAnalyticsSql(rawSql);
  const wrapped = `SELECT * FROM (${sql}) AS _aichart LIMIT ${rowCap}`;

  let rows = [];
  let fields = [];
  await db.transaction(async (trx) => {
    // First statements after BEGIN: lock the transaction read-only and bound the
    // wall-clock. A write anywhere inside now raises "read-only transaction".
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw(`SET LOCAL statement_timeout = ${Number(timeoutMs) || 5000}`);
    const res = await trx.raw(wrapped);
    rows = res.rows || [];
    fields = (res.fields || []).map((f) => f.name);
    // Nothing was written; let the (read-only) transaction commit normally.
  });
  return { rows, fields };
}

module.exports = {
  SqlGuardError,
  ALLOWED_TABLES,
  validateAnalyticsSql,
  runReadOnlyAnalyticsQuery,
};
