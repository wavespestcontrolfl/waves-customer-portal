'use strict';

// Codex #4821 r1 P2 on 030101 (frozen — it had already run on the PR's
// preview branch): 030101 infers "030100 patched this row" from the mere
// PRESENCE of a placeholder, which is false in the idempotent / partially
// anchored states 030100 supports (placeholder already there, or one
// column lacking both anchors). Audit history is append-only, so this
// records, for every such inferred event, a correcting observation that
// says exactly what is true: which placeholders are present per column,
// and that presence is not proof 030100 mutated the row. Idempotent.
const INFERRED_ACTION = 'automation_step.patched';
const OBSERVED_ACTION = 'automation_step.placeholder_observed';
const SOURCE_MIGRATION = '20260924030100_new_lead_consultation_placeholder_reinsert';
const THIS_MIGRATION = '20260924030102_new_lead_consultation_placeholder_observation';
const HTML_RE = /\{\{\s*consultation_booking\s*\}\}/;
const TEXT_RE = /\{\{\s*consultation_booking_text\s*\}\}/;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const inferred = await knex('audit_log')
    .where({ action: INFERRED_ACTION, resource_type: 'automation_step' })
    .whereRaw("metadata->>'migration' = ?", [SOURCE_MIGRATION])
    .select('id', 'resource_id');
  for (const event of inferred) {
    const done = await knex('audit_log')
      .where({ action: OBSERVED_ACTION, resource_type: 'automation_step', resource_id: event.resource_id })
      .whereRaw("metadata->>'corrects' = ?", [String(event.id)])
      .first('id');
    if (done) continue;
    const row = await knex('automation_steps').where({ id: event.resource_id }).first('html_body', 'text_body');
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system', action: OBSERVED_ACTION, resource_type: 'automation_step',
      resource_id: event.resource_id,
      metadata: {
        corrects: String(event.id),
        migration: THIS_MIGRATION,
        note: `Presence observation after ${SOURCE_MIGRATION}; not proof that migration mutated the row (it is idempotent and per-column anchored).`,
        html_placeholder_present: HTML_RE.test(row?.html_body || ''),
        text_placeholder_present: TEXT_RE.test(row?.text_body || ''),
      },
      trx: knex, critical: true,
    });
  }
};

// Audit history is append-only.
exports.down = async function down() {};
