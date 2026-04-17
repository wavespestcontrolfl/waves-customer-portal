// This migration was applied on Railway before its source file was committed
// to git. The original file was removed locally and the deletion was pushed,
// which caused knex migrate:latest to fail on deploy with a "migration
// directory is corrupt, file missing" integrity check.
//
// Recreated here as a no-op stub so Knex's integrity check passes. Because
// the migration name is already recorded in knex_migrations on production,
// Knex will skip this file — its contents don't re-run. Any schema or data
// changes made by the original migration are already applied.
exports.up = async () => {};
exports.down = async () => {};
