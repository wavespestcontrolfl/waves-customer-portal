'use strict';

// 20260924030100_new_lead_consultation_placeholder_reinsert patches the live,
// admin-editable new_lead step 0 but recorded no audit event for it (local
// Codex P1 landed after 030100 had already run on the PR's preview branch, so
// editing it in place is a silent no-op there — waves-db skill §4). Record it
// once here for any database whose step 0 carries the placeholders and has no
// such entry yet, same pattern as 20260924000003_lead_consultation_link_sms_template_seed_audit.
const ACTION = 'automation_step.patched';
const MIGRATION = '20260924030100_new_lead_consultation_placeholder_reinsert';
const PRESENT_RE = /\{\{\s*consultation_booking(?:_text)?\s*\}\}/;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const rows = await knex('automation_steps')
    .where({ template_key: 'new_lead', step_order: 0 })
    .select('id', 'html_body', 'text_body');
  for (const row of rows) {
    if (!PRESENT_RE.test(`${row.html_body || ''}${row.text_body || ''}`)) continue;
    const recorded = await knex('audit_log')
      .where({ action: ACTION, resource_type: 'automation_step', resource_id: row.id })
      .whereRaw("metadata->>'migration' = ?", [MIGRATION])
      .first('id');
    if (recorded) continue;
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system', action: ACTION, resource_type: 'automation_step',
      resource_id: row.id,
      metadata: {
        templateKey: 'new_lead', stepOrder: 0, migration: MIGRATION,
        placeholders: ['{{consultation_booking}}', '{{consultation_booking_text}}'],
      },
      trx: knex, critical: true,
    });
  }
};

// Audit history is append-only.
exports.down = async function down() {};
