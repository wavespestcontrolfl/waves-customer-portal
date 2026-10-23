/**
 * INERT. Superseded by 20261023121000_lawn_v13_dec_large_patch_potassium_v2.
 *
 * The first cut of the December large patch potassium bag (GATE_LAWN_DEC_LARGE_PATCH_K) was pushed under this name, so databases that ran
 * the PR's preview deploys recorded it in knex_migrations. Knex stops with "the migration directory is corrupt" when a recorded
 * migration file is missing, so the file stays. It does nothing in either direction: the catalog row, the staged December rows and their
 * audit rows are written, compared and rolled back by 20261023121000 alone (which also carries on from any rows this file's first
 * version wrote).
 */
exports.up = async function up() {};
exports.down = async function down() {};
