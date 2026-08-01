/**
 * reminder_24h_v2 + appointment_confirmation_v2: link-first copy pointing
 * at the customer appointment page (/appointment/:token).
 *
 * NEW rows rather than an in-place splice, the same rollout shape
 * rain_out_moved_v3 (20260730600000) used, so there is no cross-version
 * render hazard in either direction:
 *   - new code renders the _v2 row ONLY while GATE_APPOINTMENT_PAGE is on
 *     (the page these bodies link to 404s until that same gate opens);
 *   - gate off, older code, or a rolled-back migration all keep rendering
 *     the untouched original rows exactly as today;
 *   - an existing-but-DISABLED _v2 row is the ops kill switch and stops
 *     the send rather than silently reverting to long copy.
 * The originals stay untouched and are retired in a cleanup PR only after
 * this deploy + gate flip are verified.
 *
 * Bodies are GSM-7 only — plain hyphens, no typographic dashes. One
 * non-GSM character flips the whole message to UCS-2 and roughly doubles
 * the segment count, which is exactly what this copy exists to avoid
 * (the lesson from the rain_out_moved_v3 review).
 */

const TEMPLATES = [
  {
    template_key: 'reminder_24h_v2',
    name: '24-Hour Reminder (Link-First)',
    // {card_hold_policy_line} is carried over from reminder_24h verbatim:
    // it is the card-hold fee-policy disclosure (free-reschedule cutoff +
    // fee amount) that 20260712100010 added as dispute evidence, and it
    // resolves to '' for the overwhelming majority of visits that carry no
    // hold. Dropping it from the shorter copy would silently remove a fee
    // disclosure from exactly the bookings that need it.
    body: 'Hi {first_name} - your {service_type} is tomorrow at {time} (2-hour arrival window).\n\n{appointment_line}Questions? Reply here. Reply STOP to opt out.{card_hold_policy_line}',
    variables: ['first_name', 'service_type', 'time', 'appointment_line', 'card_hold_policy_line'],
    sort_order_after: 'reminder_24h',
  },
  {
    template_key: 'appointment_confirmation_v2',
    name: 'Appointment Confirmation (Link-First)',
    body: "Hi {first_name} - your {service_type} is booked for {day}, {date} at {time} (2-hour arrival window).\n\n{appointment_line}Questions? Reply here. Reply STOP to opt out.",
    variables: ['first_name', 'service_type', 'day', 'date', 'time', 'appointment_line'],
    sort_order_after: 'appointment_confirmation',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const tpl of TEMPLATES) {
    const existing = await knex('sms_templates')
      .where({ template_key: tpl.template_key })
      .first('id');
    if (existing) continue;

    const sibling = await knex('sms_templates')
      .where({ template_key: tpl.sort_order_after })
      .first('sort_order');

    await knex('sms_templates').insert({
      template_key: tpl.template_key,
      name: tpl.name,
      category: 'service',
      body: tpl.body,
      variables: JSON.stringify(tpl.variables),
      sort_order: (sibling?.sort_order ?? 5) + 1,
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

// Exported for the GSM-7 / segment regression.
exports._test = { TEMPLATES };
