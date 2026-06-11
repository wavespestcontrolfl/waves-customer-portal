/**
 * SMS template for the tech rain-out flow (services/rain-out.js).
 *
 * "Moved-first" model: the visit is already rebooked when this text
 * goes out — alt_clause carries the reply-1-confirm / reply-2-switch
 * instructions (handled by the existing reschedule-sms webhook flow),
 * and forecast_clause carries the NWS link for the customer's own zip.
 * Both clauses are composed server-side so the template stays flat.
 */

const TEMPLATE = {
  template_key: 'rain_out_moved',
  name: 'Rain Out - Appointment Moved',
  category: 'service',
  body: 'Hi {first_name} — {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.',
  variables: ['first_name', 'weather_phrase', 'service_type', 'new_option', 'alt_clause', 'forecast_clause'],
  sort_order: 9,
};

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
