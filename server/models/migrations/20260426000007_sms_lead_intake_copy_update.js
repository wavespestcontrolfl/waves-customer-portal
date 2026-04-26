/**
 * Update lead-intake SMS copy:
 *   • lead_auto_reply_biz / _after_hours — split into three paragraphs
 *     (line break after "Waves!" and after "One-Time Service?") for
 *     readability in the customer's SMS thread.
 *   • lead_service_pest / lead_service_lawn — drop the "confirm the
 *     service address — can you text it over?" sentence. The owner no
 *     longer wants the auto-reply to ask for the address.
 *
 * Idempotent: only updates rows that still match the previous copy, so
 * any custom edits Virginia/Waves made in the admin UI are preserved.
 */

const UPDATES = [
  {
    template_key: 'lead_auto_reply_biz',
    previous: "Hello {first_name}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? Reply and we'll get you a quote right away.",
    next: "Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in — Pest Control, Lawn Care, or a One-Time Service?\n\nReply and we'll get you a quote right away.",
  },
  {
    template_key: 'lead_auto_reply_after_hours',
    previous: "Hello {first_name}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? We'll follow up first thing in the morning with a custom quote.",
    next: "Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in — Pest Control, Lawn Care, or a One-Time Service?\n\nWe'll follow up first thing in the morning with a custom quote.",
  },
  {
    template_key: 'lead_service_pest',
    previous: 'Great, {first_name} — putting together a pest control quote now. Just need to confirm the service address — can you text it over?',
    next: 'Great, {first_name} — putting together a pest control quote now.',
  },
  {
    template_key: 'lead_service_lawn',
    previous: 'Great, {first_name} — putting together a lawn care quote now. Just need to confirm the service address — can you text it over?',
    next: 'Great, {first_name} — putting together a lawn care quote now.',
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const { template_key, previous, next } of UPDATES) {
    await knex('sms_templates')
      .where({ template_key, body: previous })
      .update({ body: next, updated_at: new Date() });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const { template_key, previous, next } of UPDATES) {
    await knex('sms_templates')
      .where({ template_key, body: next })
      .update({ body: previous, updated_at: new Date() });
  }
};
