/**
 * The appointment_call_confirmed template body was edited in the admin UI
 * to use {date} and {time} separately, but the variables metadata still
 * lists {date_time}. The call-recording-processor already substitutes all
 * three, so the body renders correctly — but the variables column needs
 * to match the body so the admin chip list is accurate.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .where({ template_key: 'appointment_call_confirmed' })
    .update({
      variables: JSON.stringify(['first_name', 'service_type', 'date', 'time']),
    });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .where({ template_key: 'appointment_call_confirmed' })
    .update({
      variables: JSON.stringify(['first_name', 'service_type', 'date_time']),
    });
};
