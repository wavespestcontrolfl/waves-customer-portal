/**
 * Restore lead_auto_reply_biz to the menu-style body that drives the
 * lead intake state machine. The 20260415000011 sync migration reverted
 * this row to the old "specialist will be calling" copy, which left
 * inbound leads with no menu to reply to — so the awaiting_service →
 * awaiting_address → draft-estimate flow in server/services/lead-intake.js
 * never advanced past step 1.
 *
 * After this migration runs, business-hours leads receive the same
 * three-option prompt that after-hours leads already get, and replies
 * route through sms-service-intent.js as designed.
 */
const CORRECT_BODY =
  "Hello {first_name}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? Reply and we'll get you a quote right away.";

const PREVIOUS_BUGGY_BODY =
  'Hello {first_name}! Waves here! We received your quote request. A specialist will be calling soon. Thank you!';

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_biz' })
    .first();

  if (existing) {
    await knex('sms_templates')
      .where({ template_key: 'lead_auto_reply_biz' })
      .update({ body: CORRECT_BODY, updated_at: new Date() });
  } else {
    await knex('sms_templates').insert({
      template_key: 'lead_auto_reply_biz',
      name: 'Lead Auto-Reply (Business Hours)',
      category: 'estimates',
      body: CORRECT_BODY,
      variables: JSON.stringify(['first_name']),
      sort_order: 21,
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_biz' })
    .update({ body: PREVIOUS_BUGGY_BODY, updated_at: new Date() });
};
