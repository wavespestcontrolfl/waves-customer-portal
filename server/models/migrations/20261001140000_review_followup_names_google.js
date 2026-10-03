/**
 * The legacy Day-3 review follow-up text (review_request_followup, sent by
 * review-request.js for requests outside a cadence) names a Google review
 * (owner ruling 2026-10-01: every review ask says "Google review"). Its
 * current body says only "your review of Waves".
 *
 * Exact-body CAS on sms_templates and sms_template_variants: a template an
 * administrator has edited is left alone. Each changed row gets an audit_log
 * event with the before/after copy (waves-db rule for admin-editable rows).
 * down is a documented no-op.
 */
const KEY = 'review_request_followup';
const BEFORE = 'No pressure, {first_name}. If you have a minute, your review of Waves helps other SWFL families find a pest company they can trust: {google_review_url}';
const AFTER = 'No pressure, {first_name}. If you have a minute, a Google review of Waves helps other SWFL families find a pest company they can trust: {google_review_url}';
const MIGRATION = '20261001140000_review_followup_names_google';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const rows = await knex(table).where({ template_key: KEY, body: BEFORE }).select('id');
    for (const row of rows) {
      const changed = await knex(table).where({ id: row.id, body: BEFORE }).update({ body: AFTER, updated_at: knex.fn.now() });
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.review_copy_names_google',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: MIGRATION, template_key: KEY, before: BEFORE, after: AFTER },
          critical: true, trx: knex,
        });
      }
    }
  }
};

// Documented no-op (waves-db rule for data corrections that keep admin
// edits): matching the new body does not prove this migration wrote it, so a
// revert could erase an operator's identical edit. The audit_log events keep
// the before/after copy.
exports.down = async function down() {};
exports._copy = { KEY, BEFORE, AFTER };
