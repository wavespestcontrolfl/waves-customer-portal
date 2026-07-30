/**
 * Who owns each in-ground bait station (owner 2026-07-26).
 *
 * With the rental option, the station registry can no longer assume the
 * customer bought the hardware. `owned_by` is the field-facing answer to
 * "do these come out of the ground when the program ends?":
 *
 *   'customer' — bought outright (the only case before this lane, hence the
 *                default and the backfill: every existing row predates
 *                rental, so it is a purchase by construction).
 *   'waves'    — rented; Waves retains title and recovers the hardware on
 *                cancellation.
 *
 * Per-station rather than per-customer on purpose: a rental customer who
 * later buys, or a purchased set extended with rented stations after an
 * addition, both have to be representable. The CHECK keeps the vocabulary
 * closed in lockstep with the estimate's stationsOwnedBy stamp — widening it
 * is a migration, not a new string at a call site (same house rule as
 * termite_station_checks.status).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) return;
  if (await knex.schema.hasColumn('termite_stations', 'owned_by')) return;

  await knex.schema.alterTable('termite_stations', (t) => {
    t.string('owned_by', 20).notNullable().defaultTo('customer');
  });
  await knex.raw(
    "ALTER TABLE termite_stations ADD CONSTRAINT termite_stations_owned_by_check CHECK (owned_by IN ('customer','waves'))"
  );
  // Partial index: the operationally interesting query is "which stations do
  // we still own" (recovery on cancellation, asset count), never the
  // customer-owned majority.
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_termite_stations_waves_owned ON termite_stations(customer_id) WHERE owned_by = 'waves' AND is_active = true"
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) return;
  if (!(await knex.schema.hasColumn('termite_stations', 'owned_by'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_termite_stations_waves_owned');
  await knex.raw('ALTER TABLE termite_stations DROP CONSTRAINT IF EXISTS termite_stations_owned_by_check');
  await knex.schema.alterTable('termite_stations', (t) => {
    t.dropColumn('owned_by');
  });
};
