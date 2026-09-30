/**
 * Plan pause restart text keeps its original {resume_date} token (Codex
 * #5354 r1 P1). 20260930010000 renamed it to {visit_date}; an application
 * rollback, or an old pod still serving during the deploy, supplies only
 * resume_date and would fail every due restart text on the unresolved
 * token. The wording is unchanged: the sender now passes the first visit
 * back's date as resume_date (and visit_date, for any body still carrying
 * that token).
 *
 * Exact-body CAS from either earlier body: a template an administrator
 * has edited is left alone.
 */
const KEY = 'plan_hold_resume_reminder';
const FROM = [
  'Hello {first_name}! Your Waves {service} visits start again on {visit_date}. Want a different date, or to cancel instead? Reply here.',
  'Hello {first_name}! Your Waves {service} hold ends {resume_date}, and your visits start again then. Want a different date, or to cancel instead? Reply here.',
];
const AFTER = 'Hello {first_name}! Your Waves {service} visits start again on {resume_date}. Want a different date, or to cancel instead? Reply here.';
const MIGRATION = '20260930020000_plan_hold_restart_text_keeps_token';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const cols = await knex(table).columnInfo();
    const rows = await knex(table).where({ template_key: KEY }).whereIn('body', FROM).select('id', 'body');
    for (const row of rows) {
      const patch = { body: AFTER, updated_at: knex.fn.now() };
      if (cols.variables) patch.variables = JSON.stringify(['first_name', 'service', 'resume_date']);
      const changed = await knex(table).where({ id: row.id, body: row.body }).update(patch);
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.delivery_copy_updated',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: MIGRATION, template_key: KEY },
          critical: true, trx: knex,
        });
      }
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: the {resume_date} body renders under both the old
  // and the new sender.
};
exports._copy = { KEY, FROM, AFTER };
