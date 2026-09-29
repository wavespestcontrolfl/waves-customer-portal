/**
 * Rescheduled text quotes the 2-hour arrival window (owner 2026-09-28).
 *
 * appointment_rescheduled read "…is now {day}, {date} at {time}." — the
 * reschedule flow filled {time} with the exact start ("at 9:00 AM") and the
 * schedule screen with a range ("at 9:00 AM - 11:00 AM"), while every
 * reminder quotes the arrival window. Both senders now also pass {window}
 * ("between 9:00 AM and 11:00 AM", the reminders' own phrase) and the body
 * uses it. {window} is added to the row's variables list.
 *
 * Exact-body CAS: a template an administrator has edited is left alone.
 */
const KEY = 'appointment_rescheduled';
const BEFORE = 'Hello {first_name}! Your {service_type} with Waves is now {day}, {date} at {time}.\n\nNeed a different time? Reply here.';
const AFTER = 'Hello {first_name}! Your {service_type} with Waves is now {day}, {date}, {window}.\n\nNeed a different time? Reply here.';

const MIGRATION = '20260928070000_rescheduled_text_arrival_window';

function withWindow(variables) {
  let list = variables;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return variables; }
  }
  if (!Array.isArray(list) || list.includes('window')) return variables;
  return JSON.stringify([...list, 'window']);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const hasVariables = await knex.schema.hasColumn(table, 'variables');
    const rows = await knex(table).where({ template_key: KEY, body: BEFORE })
      .select(hasVariables ? ['id', 'variables'] : ['id']);
    for (const row of rows) {
      const patch = { body: AFTER, updated_at: knex.fn.now() };
      if (hasVariables) patch.variables = withWindow(row.variables);
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
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
exports._withWindow = withWindow;
