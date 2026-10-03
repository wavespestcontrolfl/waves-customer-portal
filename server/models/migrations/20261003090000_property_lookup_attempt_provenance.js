// Attempt provenance for property lookups. A failed refresh stamps
// last_attempt_status/at but keeps the previous success's payload (parcel,
// coordinates, record, snapshot), so nothing on the row said whether the
// payload belonged to the stamped attempt; the replay harness had to guess
// from timestamps. Two nullable ids close that: payload_attempt_id is written
// by saveLookup with the attempt that produced the payload, last_attempt_id by
// every attempt stamp with the attempt being stamped. Equal = the payload is
// that attempt's own. Both NULL = a row written before this migration.
// Metadata-only (nullable, no default, no backfill).
const COLUMNS = ['payload_attempt_id', 'last_attempt_id'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_lookups'))) return;
  for (const name of COLUMNS) {
    if (!(await knex.schema.hasColumn('property_lookups', name))) {
      await knex.schema.alterTable('property_lookups', (t) => t.string(name, 64).nullable());
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_lookups'))) return;
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('property_lookups', name)) {
      await knex.schema.alterTable('property_lookups', (t) => t.dropColumn(name));
    }
  }
};
