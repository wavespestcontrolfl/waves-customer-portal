/**
 * Outbound voicemail text-back — per-reason templates + shorter generic copy.
 * Supersedes 20260908000010 (already applied on the preview environment, so
 * it is not edited; waves-db §4).
 *
 * Owner scoping 2026-09-08 over 60 days of outbound calls: the resolver
 * (services/outbound-call-reason.js) names one of three reasons — quote
 * request (web form auto-bridge), returning your call, saw your text — or
 * falls back to the generic copy. One admin-editable, is_active-toggleable
 * template per reason; a disabled reason template falls back to the generic
 * one, a disabled generic template stops the lane's texts.
 *
 * The generic body is shortened ("it's Waves") ONLY if it still carries the
 * 000010 seed text — an admin edit made in between is preserved.
 *
 * {callback_clause} is either " at <formatted caller ID they saw>" or "";
 * {optout_clause} is " Reply STOP to opt out." for a number with no customer
 * record and "" for an existing customer.
 */

const VARIABLES = ['first_name', 'callback_clause', 'optout_clause'];
const TAIL = 'Call or text back anytime{callback_clause}.{optout_clause}';
const GENERIC_KEY = 'outbound_voicemail_missed_you';
const GENERIC_SEED_BODY_000010 = "Hi {first_name}, this is Adam with Waves Pest Control. Sorry we missed you just now. Call or text us back anytime{callback_clause}.{optout_clause}";

const TEMPLATES = [
  {
    template_key: GENERIC_KEY,
    name: 'Outbound Call — Voicemail Text (generic)',
    body: `Hi {first_name}, it's Waves. Sorry we missed you. ${TAIL}`,
    sort_order: 29,
  },
  {
    template_key: 'outbound_voicemail_quote_request',
    name: 'Outbound Call — Voicemail Text (quote request)',
    body: `Hi {first_name}, it's Waves. We got your quote request and tried to reach you. ${TAIL}`,
    sort_order: 30,
  },
  {
    template_key: 'outbound_voicemail_returning_call',
    name: 'Outbound Call — Voicemail Text (returning your call)',
    body: `Hi {first_name}, it's Waves, returning your call. Sorry we missed you. ${TAIL}`,
    sort_order: 31,
  },
  {
    template_key: 'outbound_voicemail_saw_text',
    name: 'Outbound Call — Voicemail Text (saw your text)',
    body: `Hi {first_name}, it's Waves. Saw your text and tried to reach you. ${TAIL}`,
    sort_order: 32,
  },
].map((t) => ({ ...t, category: 'service', variables: VARIABLES }));

exports.TEMPLATES = TEMPLATES;

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const t of TEMPLATES) {
    const existing = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (existing) {
      if (t.template_key === GENERIC_KEY && existing.body === GENERIC_SEED_BODY_000010) {
        await knex('sms_templates').where({ template_key: GENERIC_KEY }).update({ body: t.body, name: t.name, updated_at: knex.fn.now() });
      }
      continue;
    }
    await knex('sms_templates').insert({
      template_key: t.template_key,
      name: t.name,
      category: t.category,
      body: t.body,
      variables: JSON.stringify(t.variables),
      sort_order: t.sort_order,
      is_active: true,
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .whereIn('template_key', TEMPLATES.filter((t) => t.template_key !== GENERIC_KEY).map((t) => t.template_key))
    .del();
  // The generic row belongs to 000010; only its copy is rolled back.
  await knex('sms_templates')
    .where({ template_key: GENERIC_KEY, body: TEMPLATES[0].body })
    .update({ body: GENERIC_SEED_BODY_000010 });
};
