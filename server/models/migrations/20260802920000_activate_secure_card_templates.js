/**
 * Activate the two /secure card-link SMS templates (owner flip order,
 * 2026-08-02 — post-#3153 checklist steps 2 & 3).
 *
 * `secure_appointment_card` (20260716000001) and
 * `secure_appointment_card_plans` (20260724120000) were both seeded
 * is_active:false as the second dark lever. Activating them alone sends
 * NOTHING: the base lane also requires APPOINTMENT_CARD_REQUEST=true and
 * the plan-choice copy additionally requires GATE_SECURE_PLAN_CHOICE=true
 * (isSecureCardLaneReady checks env gate AND active template, failing
 * toward not offering). The env vars flip after this deploys — template
 * activation must land FIRST so the gate flip doesn't race an inactive
 * template into silent send suppression.
 *
 * Guarded: an admin who already activated a template is untouched (the
 * update targets is_active:false rows only). down() deactivates both —
 * dark is the safe rollback direction for this lane.
 */
const KEYS = ['secure_appointment_card', 'secure_appointment_card_plans'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .whereIn('template_key', KEYS)
    .where({ is_active: false })
    .update({ is_active: true, updated_at: new Date() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .whereIn('template_key', KEYS)
    .update({ is_active: false, updated_at: new Date() });
};
