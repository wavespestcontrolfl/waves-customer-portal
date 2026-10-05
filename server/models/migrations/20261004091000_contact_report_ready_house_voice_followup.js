/**
 * Follow-up to 20261004090000 (contact_report_ready in the house voice):
 *
 * 1. The variable allowlist gains first_name on EVERY contact_report_ready
 *    row. 20261004090000 changed it only with the seeded body, so a row an
 *    admin had edited kept the old list and could not be edited to use
 *    {first_name} (the template editor validates against the stored list).
 *    The runtime supplies first_name either way; the body is not touched.
 * 2. A variant still carrying the seeded wording gets the house-voice body
 *    (getTemplate picks an active variant over the base row). An edited
 *    variant is left alone. One audit_log event per changed variant.
 *
 * down: documented no-op. The wider allowlist is harmless with the old
 * body, and a variant swap is not told apart from an admin's own edit.
 */
const { TEMPLATE_KEY, BODY, VARIABLES, SEEDED_BODY } = require('./20261004090000_contact_report_ready_house_voice');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const rows = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).select('id', 'variables');
  for (const row of rows) {
    let current = row.variables;
    if (typeof current === 'string') {
      try { current = JSON.parse(current); } catch { current = []; }
    }
    if (!Array.isArray(current)) current = [];
    const next = [...new Set([...VARIABLES, ...current])];
    if (next.length === current.length) continue;
    await knex('sms_templates').where({ id: row.id }).update({ variables: JSON.stringify(next), updated_at: knex.fn.now() });
  }
  if (!(await knex.schema.hasTable('sms_template_variants'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const variants = await knex('sms_template_variants').where({ template_key: TEMPLATE_KEY, body: SEEDED_BODY }).select('id');
  for (const variant of variants) {
    const changed = await knex('sms_template_variants').where({ id: variant.id, body: SEEDED_BODY }).update({ body: BODY, updated_at: knex.fn.now() });
    if (changed && hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: 'sms_template.contact_report_house_voice',
        resource_type: 'sms_template_variants', resource_id: String(variant.id),
        metadata: { migration: '20261004091000_contact_report_ready_house_voice_followup', template_key: TEMPLATE_KEY, before: SEEDED_BODY, after: BODY },
        critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down() {
  // No-op (see the header).
};
