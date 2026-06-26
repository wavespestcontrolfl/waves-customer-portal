/**
 * Filtered analytics views + a least-privilege role for the AI chart sandbox.
 *
 * The AI chart builder runs LLM-generated SELECTs against the live DB. Rather
 * than try to validate arbitrary SQL, the role `aichart_readonly` can read ONLY
 * these curated `ai_*` views — each exposes an EXPLICIT safe-column allowlist
 * (no PII/secret columns), bakes in the INTERNAL_TEST_CUSTOMERS exclusion (so AI
 * tiles match production KPIs), and the role has ZERO base-table access. The
 * sandbox runs every query `SET LOCAL ROLE aichart_readonly` in a READ ONLY
 * transaction, so any base table, sensitive column, or SQL-executing trick
 * (query_to_xml/dblink) fails with "permission denied", enforced by Postgres.
 *
 * Views are owner-defined (definer's rights). Column lists are intersected with
 * the live schema so a renamed/absent column can't break the migration; the
 * column sets + table names below are aligned to the real schema (verified by
 * introspection) and to the schema doc in services/ai-chart-builder.js.
 */

const { INTERNAL_TEST_CUSTOMERS } = require('../../services/internal-test-customers');

const ROLE = 'aichart_readonly';

// Denormalized-name test predicates mirror the dashboard's excludeInternalLeads /
// excludeInternalEstimates: leads/customers carry first_name+last_name, estimates
// carries customer_name — and those rows are often NOT linked to a customer, so a
// customer_id filter alone misses them.
const NAME_FIRSTLAST = "lower(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,''))";
const NAME_CUSTOMER = "lower(coalesce(t.customer_name,''))";

const VIEWS = [
  { name: 'ai_customers', table: 'customers', customerCol: null, nameExpr: NAME_FIRSTLAST,
    cols: ['id', 'city', 'state', 'zip', 'member_since', 'created_at', 'active', 'deleted_at', 'pipeline_stage', 'pipeline_stage_changed_at', 'monthly_rate', 'waveguard_tier', 'lead_source', 'lead_source_area', 'lead_source_channel', 'churned_at', 'churn_reason', 'lifetime_revenue', 'total_services', 'nearest_location_id'],
    extra: ["(t.active AND t.deleted_at IS NULL AND t.pipeline_stage IN ('active_customer','won','at_risk')) AS is_live_customer"] },
  { name: 'ai_leads', table: 'leads', customerCol: 'customer_id', nameExpr: NAME_FIRSTLAST,
    cols: ['id', 'customer_id', 'first_contact_at', 'first_contact_channel', 'status', 'lead_source_id', 'monthly_value', 'service_interest', 'city', 'is_residential', 'lead_type', 'response_time_minutes', 'converted_at', 'created_at'] },
  { name: 'ai_lead_sources', table: 'lead_sources', customerCol: null, nameExpr: null,
    cols: ['id', 'name', 'source_type', 'channel', 'is_active', 'gbp_location_id'] },
  { name: 'ai_invoices', table: 'invoices', customerCol: 'customer_id', nameExpr: null,
    cols: ['id', 'customer_id', 'status', 'total', 'paid_at', 'sent_at', 'due_date', 'created_at'] },
  { name: 'ai_payments', table: 'payments', customerCol: 'customer_id', nameExpr: null,
    cols: ['id', 'customer_id', 'amount', 'status', 'payment_date', 'created_at'] },
  { name: 'ai_service_records', table: 'service_records', customerCol: 'customer_id', nameExpr: null,
    cols: ['id', 'customer_id', 'service_date', 'service_type', 'revenue', 'labor_hours', 'gross_margin_pct', 'revenue_per_man_hour', 'is_callback', 'created_at'] },
  { name: 'ai_scheduled_services', table: 'scheduled_services', customerCol: 'customer_id', nameExpr: null,
    cols: ['id', 'customer_id', 'scheduled_date', 'status', 'service_type', 'is_callback', 'no_show', 'created_at'] },
  { name: 'ai_services', table: 'services', customerCol: null, nameExpr: null,
    cols: ['id', 'name', 'is_active', 'base_price'] },
  { name: 'ai_review_requests', table: 'review_requests', customerCol: 'customer_id', nameExpr: null,
    cols: ['id', 'customer_id', 'submitted_at', 'status', 'score', 'rating', 'created_at'] },
  { name: 'ai_reviews', table: 'google_reviews', customerCol: 'customer_id', nameExpr: null,
    // Exclude the Places aggregate pseudo-rows (reviewer_name='_stats') the way
    // the review-trend endpoint does, so AI review counts/averages aren't skewed.
    viewWhere: "coalesce(t.reviewer_name,'') <> '_stats'",
    cols: ['id', 'star_rating', 'review_created_at', 'location_id', 'customer_id', 'dismissed', 'created_at'] },
  { name: 'ai_estimates', table: 'estimates', customerCol: 'customer_id', nameExpr: NAME_CUSTOMER,
    cols: ['id', 'customer_id', 'status', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest', 'category', 'source', 'sent_at', 'accepted_at', 'declined_at', 'created_at'] },
  { name: 'ai_mrr_snapshots', table: 'mrr_snapshots', customerCol: null, nameExpr: null,
    cols: ['period_month', 'total_mrr', 'committed_mrr', 'at_risk_mrr', 'customer_count', 'captured_at'] },
  { name: 'ai_kpi_snapshots', table: 'kpi_snapshots', customerCol: null, nameExpr: null,
    cols: ['snapshot_date', 'metric', 'value', 'captured_at'] },
];

const qIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

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
  const custNameExpr = "lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))";

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
    const selectParts = cols.map((c) => `t.${qIdent(c)}`);
    for (const e of (v.extra || [])) selectParts.push(e);

    // Test-account exclusion: by denormalized name (catches unlinked rows) AND by
    // linked customer_id — whichever the table supports.
    const preds = [];
    if (v.viewWhere) preds.push(v.viewWhere);
    if (testArr && v.nameExpr) preds.push(`${v.nameExpr} <> ALL(${testArr})`);
    if (testArr && v.customerCol && actual.has(v.customerCol)) {
      preds.push(`(t.${qIdent(v.customerCol)} IS NULL OR t.${qIdent(v.customerCol)} NOT IN `
        + `(SELECT c.id FROM customers c WHERE ${custNameExpr} = ANY(${testArr})))`);
    }
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';

    // eslint-disable-next-line no-await-in-loop
    await knex.raw(`CREATE OR REPLACE VIEW ${qIdent(v.name)} AS SELECT ${selectParts.join(', ')} FROM ${qIdent(v.table)} t${where}`);
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
