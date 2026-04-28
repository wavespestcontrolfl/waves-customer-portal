/**
 * Widen appointment_reminders.service_type from varchar(100) to text.
 *
 * Multi-service appointments (parent + N addons) render a joined label like
 * "Pest Control, Lawn Care, and Tree & Shrub Quarterly Maintenance" into this
 * column. With realistic service-name lengths (scheduled_service_addons.service_name
 * is varchar(200)), three-service combinations can exceed 100 chars and silently
 * fail registration in registerAppointment's try/catch — leaving the customer
 * with no confirmation, no 72h, no 24h reminder.
 */
exports.up = async function (knex) {
  try {
    await knex.raw('ALTER TABLE appointment_reminders ALTER COLUMN service_type TYPE text');
  } catch { /* already widened */ }
};

exports.down = async function (knex) {
  try {
    await knex.raw("ALTER TABLE appointment_reminders ALTER COLUMN service_type TYPE varchar(100) USING substring(service_type, 1, 100)");
  } catch { /* unable to narrow — rows may exceed 100 chars */ }
};
