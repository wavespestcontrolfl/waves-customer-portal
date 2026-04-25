/**
 * Deactivate the lead_auto_reply_after_hours template. The lead-webhook
 * now sends lead_auto_reply_biz 24/7 — same menu prompt regardless of
 * hour, since the state machine in server/services/lead-intake.js
 * captures service interest + address overnight and a finalized estimate
 * goes out first thing in the morning.
 *
 * The row stays in sms_templates for history; flipping is_active to false
 * hides it from the admin UI's active-templates view but keeps audit
 * trail intact.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_after_hours' })
    .update({ is_active: false, updated_at: new Date() });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: 'lead_auto_reply_after_hours' })
    .update({ is_active: true, updated_at: new Date() });
};
