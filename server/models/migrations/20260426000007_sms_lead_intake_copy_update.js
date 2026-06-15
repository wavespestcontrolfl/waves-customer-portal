/**
 * Update lead-intake SMS copy:
 *   • lead_auto_reply_biz — split into three paragraphs
 *     (line break after "Waves!" and after "One-Time Service?") for
 *     readability in the customer's SMS thread.
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
