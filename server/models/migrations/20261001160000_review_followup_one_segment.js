/**
 * Keep the legacy Day-3 review follow-up (review_request_followup) in one SMS
 * segment while naming a Google review. 20261001140000's wording ("a Google
 * review of Waves helps other SWFL families...") runs to two GSM-7 segments
 * with the production g.page link for first names of 5+ characters; dropping
 * "of Waves" fits one segment through 12-character names (the old "your
 * review" body overflowed at 8).
 *
 * Exact-body compare-and-swap on sms_templates and sms_template_variants,
 * from either the 140000 wording or the original (an administrator's own edit
 * is left alone), an audit_log event per changed row (waves-db rule for
 * admin-editable rows), documented no-op down.
 */
const KEY = 'review_request_followup';
const BEFORE = [
  'No pressure, {first_name}. If you have a minute, a Google review of Waves helps other SWFL families find a pest company they can trust: {google_review_url}',
  'No pressure, {first_name}. If you have a minute, your review of Waves helps other SWFL families find a pest company they can trust: {google_review_url}',
];
const AFTER = 'No pressure, {first_name}. If you have a minute, a Google review helps other SWFL families find a pest company they can trust: {google_review_url}';
const MIGRATION = '20261001160000_review_followup_one_segment';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    for (const before of BEFORE) {
      const rows = await knex(table).where({ template_key: KEY, body: before }).select('id');
      for (const row of rows) {
        const changed = await knex(table).where({ id: row.id, body: before }).update({ body: AFTER, updated_at: knex.fn.now() });
        if (changed && hasAudit) {
          const { recordAuditEvent } = require('../../services/audit-log');
          await recordAuditEvent({
            actor_type: 'system', action: 'sms_template.review_copy_names_google',
            resource_type: table, resource_id: String(row.id),
            metadata: { migration: MIGRATION, template_key: KEY, before, after: AFTER },
            critical: true, trx: knex,
          });
        }
      }
    }
  }
};

// Documented no-op (waves-db rule for data corrections that keep admin
// edits): matching the new body does not prove this migration wrote it. The
// audit_log events keep the before/after copy.
exports.down = async function down() {};
exports._copy = { KEY, BEFORE, AFTER };
