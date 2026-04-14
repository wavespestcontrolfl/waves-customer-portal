/**
 * Add call-confirmed appointment SMS template to sms_templates table.
 * Used by call-recording-processor when an appointment is confirmed during a call.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const key = 'appointment_call_confirmed';
  const exists = await knex('sms_templates').where({ template_key: key }).first();
  if (exists) return;

  await knex('sms_templates').insert({
    template_key: key,
    name: 'Appointment Confirmed (Call)',
    category: 'service',
    body: 'Hello {first_name}! Your {service_type} appointment has been scheduled.\n\nDate/Time: {date_time}\n\nWe\'ll send you a reminder before your appointment. Reply to this text or call (941) 318-7612 with any questions.\n\n— Waves Pest Control 🌊',
    variables: JSON.stringify(['first_name', 'service_type', 'date_time']),
    sort_order: 5,
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: 'appointment_call_confirmed' }).del();
};
