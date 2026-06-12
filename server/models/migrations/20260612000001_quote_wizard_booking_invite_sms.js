/**
 * SMS template for the public quote wizard's post-quote booking invite
 * (routes/public-quote.js).
 *
 * The wizard previously reused `estimate_accepted_onetime` ("Thanks for
 * booking your {service_label}") for this send — copy written for the
 * estimate-ACCEPTANCE moment. At the quote moment nothing is booked yet,
 * so leads were thanked for a booking that doesn't exist (owner report,
 * 2026-06-12). This template says what actually happened: your quote is
 * ready, here's the self-scheduling link.
 */

const TEMPLATE = {
  template_key: 'quote_wizard_booking_invite',
  name: 'Quote Wizard — Booking Invite',
  category: 'estimates',
  body: 'Hello {first_name}! Your {service_label} quote from Waves is ready. Want to get started? Pick a time that works for you: {booking_url}\n\nQuestions or requests? Reply here.',
  variables: ['first_name', 'service_label', 'booking_url'],
  sort_order: 26,
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
