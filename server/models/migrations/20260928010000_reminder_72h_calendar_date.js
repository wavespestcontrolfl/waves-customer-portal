/**
 * 3-day reminder text shows the calendar date (owner 2026-09-27).
 *
 * The live reminder_72h body read "Waves {service_type}: {day}, {window}" —
 * a weekday with no date, so a customer couldn't tell which Thursday. The
 * sender (appointment-reminders.js) already passes {date} ("October 2") and
 * the row's variables list already declares it; only the body left it out.
 * The email version (appointment.reminder_72h) already shows both.
 *
 * Exact-body CAS: a template an administrator has edited is left alone.
 */
const KEY = 'reminder_72h';
const BEFORE = 'Hello {first_name}! Waves {service_type}: {day}, {window}.\n\n{reschedule_line}{card_hold_policy_line}';
const AFTER = 'Hello {first_name}! Waves {service_type}: {day}, {date}, {window}.\n\n{reschedule_line}{card_hold_policy_line}';

const MIGRATION = '20260928010000_reminder_72h_calendar_date';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const rows = await knex(table).where({ template_key: KEY, body: BEFORE }).select('id');
    for (const row of rows) {
      const changed = await knex(table)
        .where({ id: row.id, body: BEFORE })
        .update({ body: AFTER, updated_at: knex.fn.now() });
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
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
