/**
 * Roach catalog cleanup (owner directive 2026-07-30, follow-up to #3078).
 *
 * #3078 renamed the customer-facing estimate line to "Cockroach Treatment";
 * scheduling/invoice surfaces read the Service Library instead. Owner ruling:
 * the existing `cockroach_control` row IS the roach booking service (10 real
 * scheduled visits; the two `pest_initial_*_knockdown` rows have zero
 * scheduled_services / service_records ever and no live code references) —
 * so rename it for word-for-word estimate↔invoice parity and archive the two
 * orphaned knockdown rows rather than renaming them.
 *
 * Archive follows the Service Library convention used by the 12 existing
 * archived rows: is_active=false + is_archived=true + booking_enabled=false +
 * customer_visible=false. Stale pre-rename call extractions that stored
 * "Cockroach Control Service" verbatim stop name-matching after this rename;
 * resolveCallBookingCatalogService's affirmative-roach transcript rule still
 * resolves those bookings to this row.
 *
 * Drift guards both ways: up() only renames a name/short_name that still
 * carries the shipped value (an admin rename in the Service Library wins);
 * down() only restores values this migration set and only re-activates rows
 * still in the archived state it wrote.
 */
const RENAME_KEY = 'cockroach_control';
const OLD_NAME = 'Cockroach Control Service';
const NEW_NAME = 'Cockroach Treatment';
const OLD_SHORT_NAME = 'Cockroach Control';
const ARCHIVE_KEYS = ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown'];
const ARCHIVE_PATCH = {
  is_active: false,
  is_archived: true,
  booking_enabled: false,
  customer_visible: false,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  const row = await knex('services').where({ service_key: RENAME_KEY }).first();
  if (row) {
    const patch = {};
    if (row.name === OLD_NAME) patch.name = NEW_NAME;
    if (row.short_name === OLD_SHORT_NAME) patch.short_name = NEW_NAME;
    if (Object.keys(patch).length) {
      await knex('services')
        .where({ service_key: RENAME_KEY })
        .update({ ...patch, updated_at: knex.fn.now() });
    }
  }

  // Only archive rows that are still live — a row an admin already archived
  // (or deleted) is left alone so down() can't mistakenly re-activate it.
  await knex('services')
    .whereIn('service_key', ARCHIVE_KEYS)
    .where({ is_active: true, is_archived: false })
    .update({ ...ARCHIVE_PATCH, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // Restore the shipped names only if they still carry the values up() set —
  // an admin rename made after the migration survives the rollback.
  const row = await knex('services').where({ service_key: RENAME_KEY }).first();
  if (row) {
    const patch = {};
    if (row.name === NEW_NAME) patch.name = OLD_NAME;
    if (row.short_name === NEW_NAME) patch.short_name = OLD_SHORT_NAME;
    if (Object.keys(patch).length) {
      await knex('services')
        .where({ service_key: RENAME_KEY })
        .update({ ...patch, updated_at: knex.fn.now() });
    }
  }

  // Re-activate only rows still in the exact archived state up() wrote. Both
  // rows were live (is_active=true, is_archived=false, booking_enabled=true,
  // customer_visible=true — prod-verified 2026-07-30) when this shipped.
  await knex('services')
    .whereIn('service_key', ARCHIVE_KEYS)
    .where(ARCHIVE_PATCH)
    .update({
      is_active: true,
      is_archived: false,
      booking_enabled: true,
      customer_visible: true,
      updated_at: knex.fn.now(),
    });
};
