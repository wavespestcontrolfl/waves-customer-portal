/**
 * Access codes: passes are shared at read time (listForVisit), not copied into
 * neighborhood_access, so the directory link added by 20261006120000 (frozen)
 * is unused. Drop it so the schema matches what ships.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('customer_access_codes', 'neighborhood_access_id')) {
    await knex.schema.alterTable('customer_access_codes', (t) => { t.dropColumn('neighborhood_access_id'); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('customer_access_codes', 'neighborhood_access_id'))) {
    await knex.schema.alterTable('customer_access_codes', (t) => { t.uuid('neighborhood_access_id').nullable(); });
  }
};
