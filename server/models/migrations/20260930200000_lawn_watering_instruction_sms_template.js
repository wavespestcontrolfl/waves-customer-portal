/**
 * SMS template for the separate lawn watering text
 * (services/service-report/lawn-watering-sms.js, gated by
 * GATE_LAWN_WATERING_SMS).
 *
 * Owner ruling 2026-09-30 (reverses the 2026-08-01 "no watering advice in the
 * completion text" ruling for this one case): right after a lawn visit's
 * completion text, the customer gets ONE more text carrying the visit's
 * frozen watering instruction. It is its own text, never a line inside the
 * completion template, so the completion text stays short.
 *
 * {watering_lines} is the frozen instruction's finished sentences joined with
 * a single space, verbatim (clock times already absolute Eastern). No
 * signature, no "Waves" sign-off, no emoji, and no "Reply STOP" line: a
 * completed visit is transactional (docs/sms-stop-line-policy.md), and the
 * send rides the same consent, STOP and quiet-hours policy as the completion
 * text.
 *
 * Admin-editable and kill-switchable like every other automated template
 * (is_active toggle). The sender fails closed: a missing or inactive row
 * sends nothing. Idempotent insert-if-missing; down() removes only this key.
 */

const TEMPLATE = {
  template_key: 'lawn_watering_instruction',
  name: 'Lawn Visit - Watering Instruction',
  category: 'service',
  body: "Watering after today's visit: {watering_lines}",
  variables: ['watering_lines'],
  sort_order: 32,
};

exports.TEMPLATE = TEMPLATE;

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .first();
  if (existing) return;

  await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
    is_active: true,
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};
