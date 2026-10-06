/**
 * Switch off the estimate_followup_deposit text (owner 2026-10-06, "off for
 * this"). Estimate deposits stopped on 2026-09-26, but the template that
 * chases an unpaid deposit was still active.
 *
 * The sender (services/estimate-follow-up.js checkDepositAbandoned) already
 * treats a disabled template as "no SMS leg" and keeps the email leg, so
 * nothing else changes. Only an active row is switched off; an admin can
 * turn it back on from the SMS templates page, which is also the rollback.
 */
const KEY = 'estimate_followup_deposit';
const MIGRATION = '20261006233000_estimate_followup_deposit_sms_off';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const row = await knex('sms_templates').where({ template_key: KEY, is_active: true }).first('id');
  if (!row) return;
  const changed = await knex('sms_templates')
    .where({ id: row.id, is_active: true })
    .update({ is_active: false, updated_at: knex.fn.now() });
  if (changed && (await knex.schema.hasTable('audit_log'))) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'sms_template.deactivated',
      resource_type: 'sms_templates', resource_id: String(row.id),
      metadata: { migration: MIGRATION, template_key: KEY },
      critical: true, trx: knex,
    });
  }
};

exports.down = async function down() {
  // Intentionally no-op: an inactive row may be an administrator's own
  // choice. Turn the template back on from the SMS templates page.
};
