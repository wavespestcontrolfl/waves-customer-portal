/**
 * Cyper TC (EPA 53883-92) prints its label's safety lines on the report card (owner 2026-10-25, "safety A").
 * The row went into the catalog on 2026-09-26 with no report facts, so its card printed no "Safety & re-entry"
 * lines on the 15 quarterly pest visits that used it in the 90 days to 2026-10-25. Both lines are the label's own
 * words: its outdoor uses ("Keep children and pets off treated areas until completely dry.") and its indoor uses
 * ("Do not allow people or pets on treated surfaces until the spray has completely dried."). Report approval
 * (report-data.js approvedReportProductFacts) reads neither customer_visibility nor content_status (21 approved
 * rows are internal_only drafts), so those stay. Each visit freezes its product facts at completion, so only
 * visits completed after this runs print the lines.
 *
 * Fill-only-empty: the row changes only while it is still unapproved with neither line, so a value an admin set
 * is never touched. Audit is append-only: one ':seeded' event per write. down() is a documented no-op: the lines
 * are the label's own words, and a rollback cannot tell this write from an admin who kept or edited it since.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261025153000_cyper_tc_report_safety_lines';
const NAME = 'Cyper TC';
const EPA_REG = '53883-92';
const LINES = Object.freeze({
  customer_precaution_summary: 'Per the product label: keep children and pets off treated areas until completely dry.',
  reentry_summary: 'Do not allow people or pets on treated surfaces until the spray has completely dried.',
});

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const row = await knex('products_catalog').where({ name: NAME, epa_reg_number: EPA_REG })
    .first('id', 'approved_for_service_report', 'customer_precaution_summary', 'reentry_summary');
  if (!row || row.approved_for_service_report === true || row.customer_precaution_summary || row.reentry_summary) return;
  const updated = await knex('products_catalog').where({ id: row.id })
    .whereNull('customer_precaution_summary').whereNull('reentry_summary')
    .update({ ...LINES, approved_for_service_report: true, approved_at: knex.fn.now(), updated_at: knex.fn.now() });
  if (!updated || !canAudit) return;
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:seeded`, resource_type: 'products_catalog', resource_id: String(row.id),
    metadata: {
      migration: MIGRATION,
      product: NAME,
      before: { approved_for_service_report: row.approved_for_service_report, customer_precaution_summary: null, reentry_summary: null },
      after: { approved_for_service_report: true, ...LINES },
    },
    critical: true,
    trx: knex,
  });
};

// Documented no-op: see the header. The audit row keeps the before values.
exports.down = async function down() {};

exports.LINES = LINES;
