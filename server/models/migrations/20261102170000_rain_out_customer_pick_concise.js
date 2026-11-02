/**
 * Quick Move "let the customer pick a day" text, shorter (owner 2026-11-02):
 * "can we give them 24 hrs, from the time the sms text was sent, also can we
 * shorten the sms text, more concise".
 *
 * The deadline is now 24 hours after the text, rounded up to the quarter hour
 * (rain-out.js pickDates), so {pick_by} reads "Tue 11 AM" or "Tue 11:15 AM".
 * The new body puts the deadline in the call to action and keeps the house
 * layout (the fact, a blank line, the action with its link, a blank line, what
 * happens next). "Questions? Reply here." goes: a reply reaches us anyway.
 * A representative render is 229 characters (two segments, as before).
 *
 * Same placeholders as the seeded row (20261101164500), GSM-7 only (plain
 * hyphen, straight apostrophe). Exact-body CAS: a row an administrator has
 * edited is left alone.
 */
const KEY = 'rain_out_customer_pick_v1';
const BEFORE = "Hi {first_name} - {reason_lead}, so we need to move your {service_type}. Pick a new time here: {pick_url}\n\nPlease pick by {pick_by}. If we don't hear back, we'll book the best open time and text you. Questions? Reply here.";
const AFTER = "Hi {first_name} - {reason_lead}, so we need to move your {service_type}.\n\nPick a new time by {pick_by}: {pick_url}\n\nIf you don't, we'll book one and text you.";

const MIGRATION = '20261102170000_rain_out_customer_pick_concise';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const rows = await knex('sms_templates').where({ template_key: KEY, body: BEFORE }).select('id');
  for (const row of rows) {
    const changed = await knex('sms_templates')
      .where({ id: row.id, body: BEFORE })
      .update({ body: AFTER, updated_at: knex.fn.now() });
    if (changed && hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: 'sms_template.delivery_copy_updated',
        resource_type: 'sms_templates', resource_id: String(row.id),
        metadata: { migration: MIGRATION, template_key: KEY },
        critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: reverting seeded copy would erase later admin edits.
};
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
