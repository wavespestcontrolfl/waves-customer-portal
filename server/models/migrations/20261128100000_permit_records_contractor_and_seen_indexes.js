'use strict';

/**
 * Adds functional contractor-name indexes on pool_permit_records and
 * construction_permit_records plus a last_seen_at index on
 * construction_permit_records to prevent sequential scans in
 * admin-builder-prospects and admin-mail-prospects queries.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pool_permit_records')) {
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_pool_permit_records_contractor_norm ON pool_permit_records (UPPER(BTRIM(contractor_name)))',
    );
  }
  if (await knex.schema.hasTable('construction_permit_records')) {
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_construction_permit_records_contractor_norm ON construction_permit_records (UPPER(BTRIM(contractor_name)))',
    );
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_construction_permit_records_last_seen ON construction_permit_records (last_seen_at)',
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pool_permit_records_contractor_norm');
  await knex.raw('DROP INDEX IF EXISTS idx_construction_permit_records_contractor_norm');
  await knex.raw('DROP INDEX IF EXISTS idx_construction_permit_records_last_seen');
};
