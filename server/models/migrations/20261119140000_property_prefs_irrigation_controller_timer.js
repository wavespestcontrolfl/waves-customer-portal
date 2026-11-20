// The sprinkler timer on file (owner 2026-11-19, sprinkler timer connect, step 1): its brand, its Hunter model, and
// whether the customer runs it from the maker's phone app. Each holds a key from the shared list in
// @waves/irrigation-runtime (CONTROLLER_BRANDS / CONTROLLER_MODELS / CONTROLLER_APP_ANSWERS); null = not asked or not
// answered. Customer-entered on My Property; staff may set them in Customer 360. Not part of the irrigation-revision
// trigger: a timer shapes no watering instruction, so recording one never invalidates a week's plan.
const TABLE = 'property_preferences';
const COLUMNS = [
  ['irrigation_controller_brand', 16],
  ['irrigation_controller_model', 16],
  ['irrigation_controller_app', 16],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [column, width] of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.schema.alterTable(TABLE, (table) => { table.string(column, width).nullable(); });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [column] of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (table) => { table.dropColumn(column); });
    }
  }
};
