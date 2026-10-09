/**
 * Lawn bermuda removal, staff switch (GATE_LAWN_BERMUDA_REMOVAL, owner 2026-10-06).
 *
 * Adds three columns to customer_turf_profiles: bermuda_removal (boolean, default
 * false), bermuda_removal_set_by (the staff user who last changed it) and
 * bermuda_removal_set_at. Only the dedicated admin route writes them
 * (PUT /api/admin/customers/:customerId/turf-profile/bermuda-removal); the
 * general turf-profile editor never does. Inert until the gate is on: no reader
 * looks at the columns with the gate off.
 *
 * Idempotent in both directions. down() drops the three columns (the switch is
 * re-settable by staff, so there is no admin edit to preserve).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_turf_profiles'))) return;
  const missing = [];
  for (const col of ['bermuda_removal', 'bermuda_removal_set_by', 'bermuda_removal_set_at']) {
    if (!(await knex.schema.hasColumn('customer_turf_profiles', col))) missing.push(col);
  }
  if (!missing.length) return;
  await knex.schema.alterTable('customer_turf_profiles', (t) => {
    if (missing.includes('bermuda_removal')) t.boolean('bermuda_removal').notNullable().defaultTo(false);
    if (missing.includes('bermuda_removal_set_by')) t.string('bermuda_removal_set_by', 80).nullable();
    if (missing.includes('bermuda_removal_set_at')) t.timestamp('bermuda_removal_set_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_turf_profiles'))) return;
  const present = [];
  for (const col of ['bermuda_removal', 'bermuda_removal_set_by', 'bermuda_removal_set_at']) {
    if (await knex.schema.hasColumn('customer_turf_profiles', col)) present.push(col);
  }
  if (!present.length) return;
  await knex.schema.alterTable('customer_turf_profiles', (t) => { t.dropColumns(...present); });
};
