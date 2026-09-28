/**
 * SMS template for the missed-call text-back
 * (services/missed-call-text-back.js, gated by GATE_MISSED_CALL_TEXT_BACK).
 *
 * An UNKNOWN caller (no customer on file — a lead is fine) calls a Waves
 * line, nobody answers, they wait 25s+ and hang up with no voicemail: one
 * text goes from the exact line they called. Admin-editable and
 * kill-switchable like every other automated template (is_active toggle).
 *
 * Owner ruling 2026-09-26: no "Reply STOP to opt out." line on this one —
 * "they called us" (docs/sms-stop-line-policy.md's deliberate-exceptions
 * section records why this template is not on the keep-list despite being a
 * cold first touch to a non-customer). No signature, no "Pest Control" —
 * brand reads "Waves" only.
 *
 * {callback_clause} is either " at <formatted dialed line>" or "" — the
 * dialed line is only known when it's one of our own SMS-capable numbers
 * (see fromNumberForDialed in the service module); the slot keeps the
 * sentence grammatical when empty.
 */

const TEMPLATE = {
  template_key: 'missed_call_text_back',
  name: 'Missed Call — Text-Back (Unknown Caller)',
  category: 'service',
  body: "Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime{callback_clause}.",
  variables: ['callback_clause'],
  sort_order: 30,
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
