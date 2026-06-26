/**
 * Least-privilege Postgres role for the AI dashboard chart sandbox.
 *
 * The AI chart builder runs LLM-generated SELECTs against the live DB. A regex
 * over SQL text can't safely scope that (query_to_xml, comma joins, SELECT *,
 * snake_case secret columns all evade it). So the real boundary is this role:
 * the sandbox executes every query under `SET LOCAL ROLE aichart_readonly`, and
 * this role is granted ONLY column-level SELECT on the NON-SENSITIVE columns of
 * the business-analytics tables. Anything else — other tables, sensitive
 * columns, dynamic SQL that reads them — fails with "permission denied",
 * enforced by Postgres no matter how the query is shaped.
 *
 * Column selection is by EXCLUSION + introspection, so the grant can't drift as
 * the schema changes: every existing column is granted EXCEPT those whose name
 * matches a sensitive/PII pattern. A new safe column is auto-included on the next
 * run; a new secret column is auto-excluded.
 */

const ROLE = 'aichart_readonly';

const ALLOWED_TABLES = [
  'customers', 'leads', 'lead_sources', 'invoices', 'invoice_line_items',
  'payments', 'service_records', 'scheduled_services', 'services',
  'review_requests', 'reviews', 'estimates', 'mrr_snapshots', 'kpi_snapshots',
];

// Column names that must never be readable: credentials/secrets/tokens, and
// direct-contact PII (analytics works at city/zip granularity, not phone/email).
const SENSITIVE_COL = /(password|passwd|secret|token|api_?key|hash|stripe|webhook|jwt|session|signature|ssn|tax_id|routing|account_number|cvv|card|private|credential|salt|otp|verification|reset_|access_key|client_secret|utm_data|raw_)/i;
const PII_COL = /(^phone|_phone$|^email|_email$|ip_address|geocode|lat$|lng$|latitude|longitude)/i;

const qIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

exports.up = async function up(knex) {
  const existing = await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROLE]);
  if (!existing.rows.length) await knex.raw(`CREATE ROLE ${ROLE} NOLOGIN`);

  // Schema access + let the app's DB user assume the role (no-op for a superuser,
  // required otherwise so SET LOCAL ROLE works).
  await knex.raw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await knex.raw(`GRANT ${ROLE} TO CURRENT_USER`);

  const granted = {};
  for (const table of ALLOWED_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasTable(table))) continue;
    // eslint-disable-next-line no-await-in-loop
    const cols = (await knex('information_schema.columns')
      .where({ table_schema: 'public', table_name: table })
      .select('column_name')).map((r) => r.column_name);
    const safe = cols.filter((c) => !SENSITIVE_COL.test(c) && !PII_COL.test(c));
    if (!safe.length) continue;
    const list = safe.map(qIdent).join(', ');
    // eslint-disable-next-line no-await-in-loop
    await knex.raw(`GRANT SELECT (${list}) ON ${qIdent(table)} TO ${ROLE}`);
    granted[table] = safe.length;
  }
  // eslint-disable-next-line no-console
  console.log(`[migration 20260626000011] ${ROLE} granted SELECT on safe columns: ${JSON.stringify(granted)}`);
};

exports.down = async function down(knex) {
  const existing = await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROLE]);
  if (!existing.rows.length) return;
  await knex.raw(`REVOKE ${ROLE} FROM CURRENT_USER`).catch(() => {});
  await knex.raw(`DROP OWNED BY ${ROLE}`).catch(() => {}); // drops all privileges granted to the role
  await knex.raw(`DROP ROLE IF EXISTS ${ROLE}`);
};
