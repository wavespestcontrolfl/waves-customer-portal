/**
 * Editable SMS templates for the rain-out reply flow
 * (services/reschedule-sms.js handleRescheduleReply).
 *
 * The reply-1/2 confirmation and the call-requested acknowledgement were
 * inlined in code (the old reschedule_confirmed_sms_reply template was
 * retired before the closing line became date-aware). Owner ask 2026-07-07:
 * these responses must be editable in the admin portal like every other
 * customer text. Three confirmation variants because the closing line
 * depends on how far out the confirmed slot is — the day-before (24h)
 * reminder only exists for slots two-plus days away, so a same-day or
 * next-day confirmation must not promise one.
 *
 * These sends are transactional: the visit has already moved when the
 * customer's reply lands, so the service falls back to its built-in copy
 * when a row is missing or disabled. Disabling a row reverts to stock copy;
 * it cannot silence the confirmation.
 */

const TEMPLATES = [
  {
    template_key: 'reschedule_confirmed_today',
    name: 'Reschedule Confirmed (Same Day)',
    category: 'appointments',
    body: 'Confirmed. Your service is rescheduled for {date}, {time}.\n\nSee you today.\n\nReply STOP to opt out.',
    description: 'Reply-1/2 confirmation when the confirmed slot is TODAY (ET). Sent the moment the customer\'s reply lands on a rain-out / reschedule offer. Fallback-protected: if this template is disabled or missing, the built-in default copy sends instead.',
    variables: ['date', 'time'],
  },
  {
    template_key: 'reschedule_confirmed_tomorrow',
    name: 'Reschedule Confirmed (Tomorrow)',
    category: 'appointments',
    body: 'Confirmed. Your service is rescheduled for {date}, {time}.\n\nSee you tomorrow.\n\nReply STOP to opt out.',
    description: 'Reply-1/2 confirmation when the confirmed slot is TOMORROW (ET) — no day-before reminder promise (this confirmation already covers that window). Fallback-protected: if disabled or missing, the built-in default copy sends instead.',
    variables: ['date', 'time'],
  },
  {
    template_key: 'reschedule_confirmed_future',
    name: 'Reschedule Confirmed (Future Date)',
    category: 'appointments',
    body: "Confirmed. Your service is rescheduled for {date}, {time}.\n\nWe'll remind you the day before.\n\nReply STOP to opt out.",
    description: 'Reply-1/2 confirmation when the confirmed slot is two or more days out (ET) — the day-before reminder fires for these, so the promise is kept. Fallback-protected: if disabled or missing, the built-in default copy sends instead.',
    variables: ['date', 'time'],
  },
  {
    template_key: 'reschedule_call_requested',
    name: 'Reschedule Reply (Call Requested)',
    category: 'appointments',
    body: "No problem. We'll give you a call shortly.\n\nReply STOP to opt out.",
    description: 'Acknowledgement when a customer replies to a reschedule offer asking for a call, or when their picked option lapsed/became unavailable and the office follows up. Fallback-protected: if disabled or missing, the built-in default copy sends instead.',
    variables: [],
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const template of TEMPLATES) {
    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first('id');
    if (existing) continue;

    await knex('sms_templates').insert({
      template_key: template.template_key,
      name: template.name,
      category: template.category,
      body: template.body,
      description: template.description,
      variables: JSON.stringify(template.variables),
      sort_order: 100,
      is_active: true,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.template_key))
    .del();
};
