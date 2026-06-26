/**
 * Read-only SQL sandbox for the AI dashboard chart builder.
 *
 * The AI pin-to-dashboard feature lets an admin describe a chart in plain
 * English; an LLM generates a Postgres SELECT that runs against the live
 * database. That power demands a real security boundary — and a regex over SQL
 * text is NOT one (comma joins, query_to_xml executing inner SQL, SELECT *,
 * snake_case secret columns all slip a denylist). So the boundary is the
 * DATABASE, not this file:
 *
 *   Every query runs under `SET LOCAL ROLE aichart_readonly` inside a
 *   `SET TRANSACTION READ ONLY` transaction. That role (created by migration
 *   20260626000011) can read ONLY the curated `ai_*` analytics VIEWS — which
 *   expose an explicit safe-column allowlist and already exclude test accounts —
 *   and has NO access to base tables. Reading any base table, sensitive column,
 *   or executing inner SQL via query_to_xml/dblink to reach them all fail with
 *   "permission denied", enforced by Postgres regardless of how the SQL is
 *   shaped. The read-only transaction blocks writes; statement_timeout + an
 *   outer LIMIT bound cost.
 *
 * The static checks below are cheap DEFENSE-IN-DEPTH (fast rejects, clearer
 * errors), not the primary control. The role is the control.
 */

const db = require('../models/db');

// Least-privilege role the migration grants column-level SELECT on safe
// analytics columns. The query is executed AS this role — the security boundary.
const ANALYTICS_ROLE = 'aichart_readonly';

class SqlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlGuardError';
    this.code = 'SQL_GUARD';
  }
}

// Catalog/system access and query-executing functions. Belt to the role's
// suspenders — these are denied by the role too, but rejecting them up front
// gives a clear error and never reaches the DB. (Write/DDL keywords are NOT
// listed: "starts with SELECT" + single-statement + READ ONLY make writes
// impossible without risking false-positives on column names.)
const FORBIDDEN_PATTERNS = [
  /\bpg_[a-z_]+/, // pg_sleep, pg_read_file, pg_ls_dir, pg_catalog, …
  /\binformation_schema\b/,
  /\bpg_catalog\b/,
  /\bcurrent_setting\b/,
  /\bset_config\b/,
  /\bdblink\w*/,
  /\bcopy\b/,
  /\blo_[a-z]+/, // large-object functions
  /\w*_to_xml\w*/, // query_to_xml / table_to_xml / query_to_xmlschema / cursor_to_xml — execute inner SQL
];

const MAX_SQL_LENGTH = 4000;

/**
 * Static pre-validation (defense-in-depth). Throws SqlGuardError on violation;
 * returns the cleaned (trailing-semicolon-stripped) SQL on success. Pure — no
 * DB. The DB role is what actually scopes table/column access at run time.
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
  if (!/\bfrom\b/.test(lower)) throw new SqlGuardError('Query must read from a table.');

  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(lower)) throw new SqlGuardError('Query uses a disallowed catalog/system function.');
  }

  return sql;
}

/**
 * Validate + run a read-only analytics query AS the least-privilege role. Caps
 * rows and wall-clock; rolls back. The role (not the regex) is what prevents
 * access to non-analytics tables, sensitive columns, and SQL-executing tricks.
 * Returns { rows, fields }.
 */
async function runReadOnlyAnalyticsQuery(rawSql, { rowCap = 1000, timeoutMs = 5000 } = {}) {
  const sql = validateAnalyticsSql(rawSql);
  const wrapped = `SELECT * FROM (${sql}) AS _aichart LIMIT ${Number(rowCap) || 1000}`;

  let rows = [];
  let fields = [];
  await db.transaction(async (trx) => {
    // Order matters: lock read-only first, then drop to the least-privilege role
    // (so the query is privilege-checked by Postgres), then bound the clock.
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw(`SET LOCAL statement_timeout = ${Number(timeoutMs) || 5000}`);
    await trx.raw(`SET LOCAL ROLE ${ANALYTICS_ROLE}`);
    const res = await trx.raw(wrapped);
    rows = res.rows || [];
    fields = (res.fields || []).map((f) => f.name);
    // Nothing was written; the read-only transaction commits cleanly.
  });
  return { rows, fields };
}

module.exports = {
  SqlGuardError,
  ANALYTICS_ROLE,
  validateAnalyticsSql,
  runReadOnlyAnalyticsQuery,
};
