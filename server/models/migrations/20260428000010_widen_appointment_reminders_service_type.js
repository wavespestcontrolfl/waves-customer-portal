/**
 * Widen appointment_reminders.service_type from varchar(100) to text.
 *
 * Multi-service appointments (parent + N addons) render a joined label like
 * "Pest Control, Lawn Care, and Tree & Shrub Quarterly Maintenance" into this
 * column. With realistic service-name lengths (scheduled_service_addons.service_name
 * is varchar(200)), three-service combinations can exceed 100 chars and silently
 * fail registration in registerAppointment's try/catch — leaving the customer
 * with no confirmation, no 72h, no 24h reminder.
 *
 * Idempotency is achieved with an explicit pre-check against information_schema
 * rather than swallowing exceptions — a bare catch here would mask lock,
 * permission, or schema errors and let the migration record itself as applied
 * while the column is still varchar(100).
 */
async function getColumnType(knex) {
  const result = await knex.raw(
    "SELECT data_type FROM information_schema.columns WHERE table_name = 'appointment_reminders' AND column_name = 'service_type'"
  );
  return result.rows[0]?.data_type || null;
}

exports.up = async function (knex) {
  const type = await getColumnType(knex);
  if (type === null) return;       // table or column not present
  if (type === 'text') return;     // already widened
  await knex.raw('ALTER TABLE appointment_reminders ALTER COLUMN service_type TYPE text');
};

exports.down = async function (knex) {
  const type = await getColumnType(knex);
  if (type !== 'text') return;     // already narrow or column missing
  await knex.raw(
    "ALTER TABLE appointment_reminders ALTER COLUMN service_type TYPE varchar(100) USING substring(service_type, 1, 100)"
  );
};
