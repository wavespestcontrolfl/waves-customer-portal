const RESCHEDULE_BODY = 'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\nNeed to change it again? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.';
const CANCEL_BODY = "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply to this message and we'll get you back on the calendar.";

const TEMPLATES = [
  {
    template_key: 'appointment_rescheduled',
    name: 'Appointment Rescheduled',
    category: 'service',
    body: RESCHEDULE_BODY,
    variables: JSON.stringify(['first_name', 'service_type', 'day', 'date', 'time']),
    sort_order: 6,
  },
  {
    template_key: 'appointment_cancelled',
    name: 'Appointment Cancelled',
    category: 'service',
    body: CANCEL_BODY,
    variables: JSON.stringify(['first_name', 'service_type', 'day', 'date']),
    sort_order: 7,
  },
];

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('sms_templates');
  if (!hasTemplates) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();

  for (const template of TEMPLATES) {
    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first();

    const row = {
      ...template,
      ...(cols.updated_at ? { updated_at: now } : {}),
    };

    if (existing) {
      await knex('sms_templates')
        .where({ template_key: template.template_key })
        .update(row);
    } else {
      await knex('sms_templates').insert({
        ...row,
        ...(cols.is_active ? { is_active: true } : {}),
        ...(cols.created_at ? { created_at: now } : {}),
      });
    }
  }
};

exports.down = async function down() {};
