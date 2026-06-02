const PREP_SMS_TEMPLATE_KEYS = [
  'pest_prep_cockroach',
  'pest_prep_bed_bug',
];

exports.PREP_SMS_TEMPLATE_KEYS = PREP_SMS_TEMPLATE_KEYS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .whereIn('template_key', PREP_SMS_TEMPLATE_KEYS)
    .del();
};

exports.down = async function down() {
  // Intentionally no-op. These customer prep SMS templates were removed
  // because appointment prep dates can drift from the confirmed visit date.
};
