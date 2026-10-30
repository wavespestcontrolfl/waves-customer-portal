/**
 * Misting calibrations remember the address they were installed at (dark behind GATE_MOSQUITO_MISTING).
 *
 * A customer move edits the SAME customer_properties row (syncPrimaryAddress rewrites its address), so a
 * property id alone would carry the old house's system, nozzle counts and label cap to the new address.
 * The service stamps the property's address on every new calibration and treats a calibration whose stamp
 * no longer matches its property's address (services/stamped-address.js premiseStampConflicts, the one
 * premise rule) as history: never current, no refills. The stamp also keeps a past row's real location.
 *
 * Nullable: rows saved before this migration have no stamp, and a missing stamp is unknown, not different.
 * down() drops the five columns.
 */

const TABLE = 'misting_calibrations';
const COLUMNS = ['installed_address_line1', 'installed_address_line2', 'installed_city', 'installed_state', 'installed_zip'];

exports.up = async function up(knex) {
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.schema.alterTable(TABLE, (t) => { t.text(column).nullable(); });
    }
  }
};

exports.down = async function down(knex) {
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(column); });
    }
  }
};
