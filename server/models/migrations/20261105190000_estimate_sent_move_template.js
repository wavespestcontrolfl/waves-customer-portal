'use strict';

/**
 * The app-sent new-home estimate text (owner 2026-11-04, option A of the
 * hands-off moves page; dark behind GATE_MOVING_AUTO_SEND): sms_templates
 * estimate_sent_move, editable in Communications → Templates. A new-home
 * estimate the app made for a move goes out with it in place of
 * estimate_sent (routes/admin-estimates.js estimateSmsTemplate).
 *
 * House layout (20261006220000): "Hi {first_name}," then the facts, a blank
 * line, and the link behind a short label; "Waves" once (owner 2026-11-04,
 * texts say "it's Waves"); transactional to an existing customer, so no STOP
 * line (docs/sms-stop-line-policy.md).
 *
 * Idempotent. The seed writes its sms_template.seeded audit event only when
 * this run inserted the row. down() is a documented no-op (waves-db skill §4:
 * a seed rollback never deletes an admin-editable row once it may have been
 * hand-edited); with the gate off nothing reads the row.
 */
const MIGRATION = '20261105190000_estimate_sent_move_template';
const KEY = 'estimate_sent_move';
const BODY = "Hi {first_name}, it's Waves. Your price at your new home is ready. Your {plan_name} comes with you, with no setup fee.\n\nSee it and pick your first visit: {estimate_url}";

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const inserted = await knex('sms_templates').insert({
    template_key: KEY,
    name: 'Estimate Sent (new home, by the app)',
    category: 'estimates',
    body: BODY,
    variables: JSON.stringify(['first_name', 'plan_name', 'estimate_url']),
    // Next to estimate_sent (20) in the Templates list.
    sort_order: 21,
    is_active: true,
  }).onConflict('template_key').ignore().returning('id');
  if (inserted.length && await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template',
      resource_id: inserted[0].id,
      metadata: { templateKey: KEY, migration: MIGRATION },
      trx: knex, critical: true,
    });
  }
};

exports.down = async function down() {
  // Documented no-op (see the header): the template stays.
};

exports._copy = { KEY, BODY };
