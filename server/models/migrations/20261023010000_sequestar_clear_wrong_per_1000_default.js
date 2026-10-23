/**
 * No-op placeholder. Do not delete or edit.
 *
 * An earlier PR in the Tree & Shrub 13-0-13 / Sequestar label-dose lane pushed this file, and preview databases recorded it
 * in knex_migrations. Knex tracks migrations by filename, so deleting the file would make `migrate:latest` report the
 * directory as corrupt. The file is kept with an empty up() and down().
 *
 * It was superseded by 20261023140000_sequestar_per_1000_default_correction_v2, which does the Sequestar per-1,000
 * prefill correction (locked read, conditional update, audit row in the same transaction).
 */
exports.up = async function up() {};
exports.down = async function down() {};
