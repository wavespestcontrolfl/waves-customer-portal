/**
 * geo_grid_ranks.grid_size — the N of the N×N grid this pin belongs to.
 *
 * V2 makes grid size configurable per scan (3×3 … 9×9). Storing it per row lets
 * getHeatmap judge a run "complete" against its OWN grid_size² instead of a
 * single hardcoded constant, so a 3×3 run and a 7×7 run can coexist. Existing
 * rows were all the legacy 5×5 default — backfilled to 5.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('geo_grid_ranks', 'grid_size'))) {
    await knex.schema.alterTable('geo_grid_ranks', (t) => {
      t.integer('grid_size').notNullable().defaultTo(5);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('geo_grid_ranks', 'grid_size')) {
    await knex.schema.alterTable('geo_grid_ranks', (t) => {
      t.dropColumn('grid_size');
    });
  }
};
