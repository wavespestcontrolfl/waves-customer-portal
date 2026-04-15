/**
 * Move the "Waves Pest Control Appointment" service from category 'other' to 'specialty'
 * so it appears alongside other specialty offerings in the New Appointment picker.
 */
exports.up = async function (knex) {
  await knex('services')
    .where({ service_key: 'general_appointment' })
    .update({ category: 'specialty' });
};

exports.down = async function (knex) {
  await knex('services')
    .where({ service_key: 'general_appointment' })
    .update({ category: 'other' });
};
