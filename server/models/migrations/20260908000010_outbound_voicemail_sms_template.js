/**
 * SMS template for the outbound voicemail text-back
 * (services/outbound-voicemail-sms.js, gated by GATE_OUTBOUND_VOICEMAIL_SMS).
 *
 * When an admin click-to-call reaches the customer's voicemail, the customer
 * leg is hung up before a message is left and this ONE text goes instead —
 * so the customer knows why a 3-second missed call from the main line
 * showed up (owner-directed 2026-09-08 after the "did you just call me?"
 * investigation). Admin-editable and kill-switchable like every automated
 * template (is_active toggle).
 *
 * {callback_clause} is either " at <formatted caller ID they saw>" or "";
 * {optout_clause} is " Reply STOP to opt out." for a number with no customer
 * record and "" for an existing customer. Both slots keep the sentence
 * grammatical when empty.
 */

const TEMPLATE = {
  template_key: 'outbound_voicemail_missed_you',
  name: 'Outbound Call — Voicemail Missed-You Text',
  category: 'service',
  body: "Hi {first_name}, this is Adam with Waves Pest Control. Sorry we missed you just now. Call or text us back anytime{callback_clause}.{optout_clause}",
  variables: ['first_name', 'callback_clause', 'optout_clause'],
  sort_order: 29,
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
