/**
 * Lawn estimate limits (GATE_ESTIMATE_LAWN_LIMITS, owner 2026-10-22).
 *
 * Adds two nullable columns to customer_turf_profiles that the office sets from
 * the estimate photos: other_grasses (text[], any of carpetgrass, bahiagrass,
 * bermudagrass, torpedograss, dallisgrass) and virus_streaks_suspected
 * (boolean). Nothing reads them while the gate is off, and no existing row
 * changes (both stay NULL).
 *
 * Idempotent in both directions. down() drops the two columns; the office
 * re-sets the flags from the photos, so there is no edit to preserve.
 */
const COLUMNS = ['other_grasses', 'virus_streaks_suspected'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_turf_profiles'))) return;
  const missing = [];
  for (const col of COLUMNS) {
    if (!(await knex.schema.hasColumn('customer_turf_profiles', col))) missing.push(col);
  }
  if (!missing.length) return;
  await knex.schema.alterTable('customer_turf_profiles', (t) => {
    if (missing.includes('other_grasses')) t.specificType('other_grasses', 'text[]').nullable();
    if (missing.includes('virus_streaks_suspected')) t.boolean('virus_streaks_suspected').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_turf_profiles'))) return;
  const present = [];
  for (const col of COLUMNS) {
    if (await knex.schema.hasColumn('customer_turf_profiles', col)) present.push(col);
  }
  if (!present.length) return;
  await knex.schema.alterTable('customer_turf_profiles', (t) => { t.dropColumns(...present); });
};
