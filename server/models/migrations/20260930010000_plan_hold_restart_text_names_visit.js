/**
 * Plan pause restart text names the first visit back (owner rulings
 * 2026-09-29, rule 3). Visits inside a pause are now skipped rather than
 * parked on the return date, so "your hold ends {date} and your visits
 * start again then" would name a day with no visit on it. The text goes
 * out 7 days before the first visit back and names that visit's date.
 *
 * GSM-7, one segment at typical name lengths. Exact-body CAS: a template an
 * administrator has edited is left alone.
 */
const KEY = 'plan_hold_resume_reminder';
const BEFORE = 'Hello {first_name}! Your Waves {service} hold ends {resume_date}, and your visits start again then. Want a different date, or to cancel instead? Reply here.';
const AFTER = 'Hello {first_name}! Your Waves {service} visits start again on {visit_date}. Want a different date, or to cancel instead? Reply here.';
const MIGRATION = '20260930010000_plan_hold_restart_text_names_visit';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const cols = await knex(table).columnInfo();
    const rows = await knex(table).where({ template_key: KEY, body: BEFORE }).select('id');
    for (const row of rows) {
      const patch = { body: AFTER, updated_at: knex.fn.now() };
      if (cols.variables) patch.variables = JSON.stringify(['first_name', 'service', 'visit_date']);
      const changed = await knex(table).where({ id: row.id, body: BEFORE }).update(patch);
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
  // Intentionally no-op: reverting seeded copy would erase later admin edits.
};
exports._copy = { KEY, BEFORE, AFTER };
