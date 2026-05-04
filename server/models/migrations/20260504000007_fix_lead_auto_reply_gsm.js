/**
 * Keep the lead auto-reply in GSM-7.
 *
 * The previous copy used an em dash, which forced UCS-2 encoding and pushed the
 * message to 3 segments. send_customer_message caps lead conversational SMS at
 * 2 segments, so fresh quote requests were audited but blocked before Twilio.
 */
const BODY =
  "Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in: Pest Control, Lawn Care, or a One-Time Service?\n\nReply and we'll get you a quote right away.";

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_biz' })
    .first();

  if (!existing) {
    await knex('sms_templates').insert({
      template_key: 'lead_auto_reply_biz',
      name: 'Lead Auto-Reply (Business Hours)',
      category: 'estimates',
      body: BODY,
      variables: JSON.stringify(['first_name']),
      sort_order: 21,
    });
    return;
  }

  await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_biz' })
    .where('body', 'like', '%—%')
    .update({
      body: knex.raw("replace(body, '—', ':')"),
      updated_at: new Date(),
    });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_biz' })
    .update({
      body: "Hello {first_name}! Thanks for reaching out to Waves! What are you interested in - Pest Control, Lawn Care, or a One-Time Service? Reply and we'll get you a quote right away.",
      updated_at: new Date(),
    });
};
