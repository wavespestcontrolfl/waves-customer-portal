/**
 * Completion text for the FIRST visit of an annual prepay whose charge waits
 * for that visit (GATE_PAF_PREPAY). Owner ruling 2026-10-03: neutral wording
 * that is true whatever the charge then does: no amount, no "now".
 *
 * service_complete_annual_prepay says "nothing due today", true for a year
 * already paid. For a year charged minutes after its first visit, that visit
 * gets this text instead; every later visit keeps the regular one.
 *
 * Fallback-protected: if this row is disabled or missing, the completion
 * route sends service_complete_annual_prepay. Supersedes the unused
 * service_complete_annual_prepay_first_charge seed (20261002100000).
 */

const TEMPLATE = {
  template_key: 'service_complete_annual_prepay_after_first_visit',
  name: 'Service Complete + Annual Prepay Charged After First Visit',
  category: 'service-reports',
  // GSM-7 only (plain hyphen); "Waves" named, no STOP line on transactional
  // texts — the audited annual-prepay house voice.
  body: "Hello {first_name}! Your {service_type} is done and covered by your Waves annual plan. Your plan payment is processed after this first visit - you'll get a receipt.\n\nYour report: {portal_url}",
  description: 'Completion text for the first visit of an annual prepay charged after that visit (GATE_PAF_PREPAY): neutral, true whatever the charge then does. Later visits use service_complete_annual_prepay. Fallback-protected: if disabled or missing, service_complete_annual_prepay sends instead.',
  variables: ['first_name', 'service_type', 'portal_url'],
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).first('id');
  if (existing) return;
  await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    description: TEMPLATE.description,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: 9,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};

exports.TEMPLATE = TEMPLATE;
