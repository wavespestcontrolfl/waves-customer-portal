/**
 * SMS template for the voicemail lead text-back
 * (services/voicemail-lead-sms.js, gated by GATE_VOICEMAIL_LEAD_SMS).
 *
 * When a NEW prospect's voicemail produces a workable lead, we text them a
 * prefilled quote-wizard link instead of leaving the callback to chance —
 * the speed-to-lead hole the 2026-07-01 inbound-lead investigation found
 * (voicemail prospects got NOTHING proactive). Admin-editable and kill-
 * switchable like every other automated template (is_active toggle).
 */

const TEMPLATE = {
  template_key: 'voicemail_quote_link',
  name: 'Voicemail Lead — Quote Link Text-Back',
  category: 'service',
  body: "Hi {first_name}, it's Waves Pest Control — got your message about {service_label}. Get your quote here: {quote_url}\n\nOr reply here and we'll call you back.",
  variables: ['first_name', 'service_label', 'quote_url'],
  sort_order: 27,
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
