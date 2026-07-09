/**
 * Completion text for annual-prepay-covered visits.
 *
 * Owner report 2026-07-09: an annual-prepay customer's completion text opened
 * with "Thanks for your payment today" (service_complete_prepaid) — but no
 * payment happened that day; the visit was covered by the plan bought months
 * earlier. service_complete_prepaid keeps serving the moments where money DID
 * move at (or before) the visit — pay-at-visit prepaid stamps, autopay, an
 * already-paid invoice — and this new template takes only the
 * annualPrepayCovered branch of the completion route.
 *
 * Fallback-protected: if this row is disabled or missing, the completion
 * route falls back to service_complete_prepaid, so a toggle can never cost
 * the customer their completion text.
 */

const TEMPLATE = {
  template_key: 'service_complete_annual_prepay',
  name: 'Service Complete + Annual Prepay',
  category: 'service-reports',
  // Punctuation stays inside GSM-7 (plain hyphen, no em dash / smart quotes):
  // one non-GSM char would flip the whole message to UCS-2 and double the
  // segment count (see services/messaging/segment-counter.js).
  body: "Hello {first_name}! Your {service_type} service is complete and covered by your annual prepaid plan - nothing due today. Your service report is ready: {portal_url}\n\nQuestions or requests? Reply here. Reply STOP to opt out.",
  description: 'Completion text when the visit is covered by an annual prepaid plan — no payment happened today, so it must not thank the customer for one (that copy is service_complete_prepaid, which still covers pay-at-visit / autopay / already-paid invoices). Fallback-protected: if disabled or missing, service_complete_prepaid sends instead.',
  variables: ['first_name', 'service_type', 'portal_url'],
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
