/**
 * SMS template for the short lawn watering text
 * (services/service-report/lawn-watering-sms.js, GATE_LAWN_WATERING_SHORT_TEXT).
 *
 * Owner 2026-10-23: the watering text was "a little wordy, needs to be more
 * concise". With the gate on, the text sends short steps built from the frozen
 * instruction (lawn-watering-short-text.js) under this row; the lead-in is
 * shorter too, so the common shapes fit in one SMS segment.
 *
 * Same contract as lawn_watering_instruction (20260930200000): no signature,
 * no "Reply STOP" line, admin-editable, is_active is the kill switch. A missing
 * or inactive row sends the full text under the original row. Idempotent
 * insert-if-missing; down() removes only this key.
 */

const TEMPLATE = {
  template_key: 'lawn_watering_instruction_short',
  name: 'Lawn Visit - Watering Instruction (short)',
  category: 'service',
  body: 'Lawn watering: {watering_lines}',
  variables: ['watering_lines'],
  sort_order: 33,
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
