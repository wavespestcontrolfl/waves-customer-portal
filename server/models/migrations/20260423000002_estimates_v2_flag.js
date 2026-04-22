/**
 * estimates.use_v2_view — per-estimate toggle for the React redesign
 * (PR B.2). False by default — every existing estimate + every new one
 * serves the current server-rendered HTML until admin/IB flips it.
 *
 * Rollout stages (see PR B.2 description):
 *   1. Virginia flips v2 on for specific test estimates via the
 *      toggle_estimate_v2_view IB tool. Handfull of customers get the
 *      React experience; everyone else unchanged.
 *   2. Once validated, a config flag (separate PR) defaults new
 *      estimates to v2=true. Existing rows with v2=false stay HTML.
 *   3. Backfill + remove the HTML path (separate PR).
 *
 * No index — lookups are always by token (already indexed) and read
 * this column as a single scalar alongside the row.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.boolean('use_v2_view').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('use_v2_view');
  });
};
