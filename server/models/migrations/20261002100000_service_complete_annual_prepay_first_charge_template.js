/**
 * Completion text for the FIRST visit of an annual prepay charged after the
 * first visit (GATE_PAF_PREPAY, owner ruling 2026-10-02: "change for the first
 * visit only").
 *
 * service_complete_annual_prepay says "nothing due today", true for every
 * visit of a year already paid. For a year whose charge waits for the first
 * visit, the prepay sweep charges the saved method minutes after that visit
 * completes, so the first visit's text says the year is being charged now.
 * Every later visit keeps service_complete_annual_prepay.
 *
 * Fallback-protected: if this row is disabled or missing, the completion
 * route sends service_complete_annual_prepay instead.
 */

const TEMPLATE = {
  template_key: 'service_complete_annual_prepay_first_charge',
  name: 'Service Complete + Annual Prepay Charged Now',
  category: 'service-reports',
  // GSM-7 only (plain hyphen, no em dash / smart quotes): one non-GSM char
  // flips the message to UCS-2 and doubles the segment count.
  // House voice matches the audited service_complete_annual_prepay body
  // (20260926120000): "Waves" named, no STOP line on transactional texts.
  body: "Hello {first_name}! Your {service_type} is done. Your Waves annual plan payment of {amount} is being charged to your {method_line} now - receipt to follow.\n\nYour report: {portal_url}",
  description: 'Completion text for the first visit of an annual prepay charged after the first visit: the year is charged minutes after this visit, so it says so (amount = the total the customer acknowledged at approval; method_line = "card on file" or "saved bank account"). Later visits use service_complete_annual_prepay. Fallback-protected: if disabled or missing, service_complete_annual_prepay sends instead.',
  variables: ['first_name', 'service_type', 'amount', 'method_line', 'portal_url'],
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .first('id');
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
  await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .del();
};

exports.TEMPLATE = TEMPLATE;
