const RESCHEDULE_BODY = 'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\nNeed to change it again? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.';
const CANCEL_BODY = "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply to this message and we'll get you back on the calendar.";

const PREVIOUS_RESCHEDULE_BODY = 'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\nNeed to change it again? Log into your portal at portal.wavespestcontrol.com or reply here.';
const PREVIOUS_CANCEL_BODY = "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply here and we'll get you back on the calendar.";

exports.up = async function (knex) {
  const hasTemplates = await knex.schema.hasTable('sms_templates');
  if (!hasTemplates) return;
  const cols = await knex('sms_templates').columnInfo();
  const stamp = cols.updated_at ? { updated_at: knex.fn.now() } : {};

  await knex('sms_templates')
    .where({ template_key: 'appointment_rescheduled' })
    .update({ body: RESCHEDULE_BODY, ...stamp });

  await knex('sms_templates')
    .where({ template_key: 'appointment_cancelled' })
    .update({ body: CANCEL_BODY, ...stamp });
};

exports.down = async function (knex) {
  const hasTemplates = await knex.schema.hasTable('sms_templates');
  if (!hasTemplates) return;
  const cols = await knex('sms_templates').columnInfo();
  const stamp = cols.updated_at ? { updated_at: knex.fn.now() } : {};

  await knex('sms_templates')
    .where({ template_key: 'appointment_rescheduled' })
    .update({ body: PREVIOUS_RESCHEDULE_BODY, ...stamp });

  await knex('sms_templates')
    .where({ template_key: 'appointment_cancelled' })
    .update({ body: PREVIOUS_CANCEL_BODY, ...stamp });
};
