/**
 * Filtered analytics views + a least-privilege role for the AI chart sandbox.
 *
 * The AI chart builder runs LLM-generated SELECTs against the live DB. A regex
 * over SQL text can't safely scope that, and column-level grants on RAW tables
 * still risk leaking sensitive columns (gate_code, access_notes, address) and
 * the owner's INTERNAL_TEST_CUSTOMERS rows. So the role gets access ONLY to a set
 * of curated views:
 *
 *   - each `ai_<entity>` view exposes an EXPLICIT safe-column allowlist (so a new
 *     sensitive column is never auto-exposed — it has to be added on purpose);
 *   - customer-scoped views exclude INTERNAL_TEST_CUSTOMERS, so AI tiles match
 *     the production KPIs/Intelligence-Bar numbers;
 *   - the role `aichart_readonly` is granted SELECT on the VIEWS ONLY — zero
 *     access to base tables. The sandbox runs every query `SET LOCAL ROLE
 *     aichart_readonly` in a READ ONLY transaction, so reaching any base table,
 *     sensitive column, or executing dynamic SQL (query_to_xml/dblink) to read
 *     them all fail with "permission denied", enforced by Postgres.
 *
 * Views are owner-defined (definer's rights), so the role reading a view never
 * needs base-table privileges. Column lists are intersected with the live schema
 * so a renamed/absent column can't break the migration.
 */

const { INTERNAL_TEST_CUSTOMERS } = require('../../services/internal-test-customers');

const ROLE = 'aichart_readonly';

// Explicit safe-column allowlist per entity. Anything not listed (names, phone,
// email, address_line*, gate_code, access_notes, internal_notes, tokens, stripe
// ids, geo, utm_data, password_hash, …) is simply never in the view.
const VIEWS = [
  { name: 'ai_customers', table: 'customers', customerCol: null, isCustomers: true,
    cols: ['id', 'city', 'state', 'zip', 'member_since', 'created_at', 'active', 'deleted_at', 'pipeline_stage', 'pipeline_stage_changed_at', 'monthly_rate', 'waveguard_tier', 'lead_source', 'lead_source_area', 'lead_source_channel', 'churned_at', 'churn_reason', 'lifetime_revenue', 'total_services', 'nearest_location_id'] },
  { name: 'ai_leads', table: 'leads', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'first_contact_at', 'first_contact_channel', 'status', 'lead_source_id', 'monthly_value', 'service_interest', 'city', 'is_residential', 'lead_type', 'response_time_minutes', 'created_at'] },
  { name: 'ai_lead_sources', table: 'lead_sources', customerCol: null,
    cols: ['id', 'name', 'source_type', 'channel', 'is_active', 'gbp_location_id'] },
  { name: 'ai_invoices', table: 'invoices', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'status', 'total', 'paid_at', 'sent_at', 'due_date', 'created_at'] },
  { name: 'ai_payments', table: 'payments', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'amount', 'status', 'payment_date', 'created_at'] },
  { name: 'ai_service_records', table: 'service_records', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'service_date', 'service_type', 'revenue', 'labor_hours', 'gross_margin_pct', 'revenue_per_man_hour', 'is_callback', 'created_at'] },
  { name: 'ai_scheduled_services', table: 'scheduled_services', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'scheduled_date', 'status', 'service_type', 'created_at'] },
  { name: 'ai_services', table: 'services', customerCol: null,
    cols: ['id', 'name', 'is_active'] },
  { name: 'ai_review_requests', table: 'review_requests', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'submitted_at', 'status', 'score', 'created_at'] },
  { name: 'ai_reviews', table: 'reviews', customerCol: null,
    cols: ['id', 'rating', 'created_at'] },
  { name: 'ai_estimates', table: 'estimates', customerCol: 'customer_id',
    cols: ['id', 'customer_id', 'status', 'total', 'service_interest', 'created_at'] },
  { name: 'ai_mrr_snapshots', table: 'mrr_snapshots', customerCol: null,
    cols: ['period_month', 'total_mrr', 'committed_mrr', 'at_risk_mrr', 'customer_count', 'captured_at'] },
  { name: 'ai_kpi_snapshots', table: 'kpi_snapshots', customerCol: null,
    cols: ['snapshot_date', 'metric', 'value', 'captured_at'] },
];

const qIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Lowercased "first last" of test accounts, as a SQL array literal.
function testNamesArrayLiteral() {
  const list = (INTERNAL_TEST_CUSTOMERS || []).map((n) => `'${String(n).replace(/'/g, "''")}'`);
  return list.length ? `ARRAY[${list.join(', ')}]` : null;
}

exports.up = async function up(knex) {
  const existing = await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROLE]);
  if (!existing.rows.length) await knex.raw(`CREATE ROLE ${ROLE} NOLOGIN`);
  await knex.raw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await knex.raw(`GRANT ${ROLE} TO CURRENT_USER`); // lets the app user SET ROLE

  const testArr = testNamesArrayLiteral();
  const testNameExpr = "lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))";

  const built = [];
  for (const v of VIEWS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasTable(v.table))) continue;
    // eslint-disable-next-line no-await-in-loop
    const actual = new Set((await knex('information_schema.columns')
      .where({ table_schema: 'public', table_name: v.table })
      .select('column_name')).map((r) => r.column_name));
    const cols = v.cols.filter((c) => actual.has(c));
    if (!cols.length) continue;
    const select = cols.map((c) => `t.${qIdent(c)}`).join(', ');

    let where = '';
    if (testArr && v.isCustomers && actual.has('first_name') && actual.has('last_name')) {
      where = ` WHERE lower(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,'')) <> ALL(${testArr})`;
    } else if (testArr && v.customerCol && actual.has(v.customerCol)) {
      where = ` WHERE t.${qIdent(v.customerCol)} IS NULL OR t.${qIdent(v.customerCol)} NOT IN (`
        + `SELECT c.id FROM customers c WHERE ${testNameExpr} = ANY(${testArr}))`;
    }

    // eslint-disable-next-line no-await-in-loop
    await knex.raw(`CREATE OR REPLACE VIEW ${qIdent(v.name)} AS SELECT ${select} FROM ${qIdent(v.table)} t${where}`);
    // eslint-disable-next-line no-await-in-loop
    await knex.raw(`GRANT SELECT ON ${qIdent(v.name)} TO ${ROLE}`);
    built.push(v.name);
  }
  // eslint-disable-next-line no-console
  console.log(`[migration 20260626000011] aichart views granted to ${ROLE}: ${built.join(', ')}`);
};

exports.down = async function down(knex) {
  for (const v of VIEWS) {
    // eslint-disable-next-line no-await-in-loop
    await knex.raw(`DROP VIEW IF EXISTS ${qIdent(v.name)}`).catch(() => {});
  }
  const existing = await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROLE]);
  if (!existing.rows.length) return;
  await knex.raw(`REVOKE ${ROLE} FROM CURRENT_USER`).catch(() => {});
  await knex.raw(`DROP OWNED BY ${ROLE}`).catch(() => {});
  await knex.raw(`DROP ROLE IF EXISTS ${ROLE}`);
};
