/**
 * SMS template for the dropped-call address-request text
 * (services/dropped-call-sms.js, gated by GATE_DROPPED_CALL_SMS).
 *
 * A NEW prospect whose intake call dropped mid-conversation before the
 * service address was captured (the 2026-07-27 Juan case: 12 engaged
 * minutes, call died on the forwarded leg at the exact address-exchange
 * moment, no callback ever happened) gets ONE text asking for the address —
 * the single field that blocks quoting and scheduling. Admin-editable and
 * kill-switchable like every automated template (is_active toggle).
 *
 * {callback_clause} is either " at <formatted line they dialed>" or "" —
 * the clause form keeps the sentence grammatical when the dialed line is
 * unavailable (never renders a dangling "call us back at .").
 */

const TEMPLATE = {
  template_key: 'dropped_call_address_request',
  name: 'Dropped Call — Address Request Text',
  category: 'service',
  body: "Hello {first_name}, it's Waves Pest Control. It looks like our call dropped. Reply with your service address and we'll get your quote moving, or call us back{callback_clause}.\n\nReply STOP to opt out.",
  variables: ['first_name', 'callback_clause'],
  sort_order: 28,
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
