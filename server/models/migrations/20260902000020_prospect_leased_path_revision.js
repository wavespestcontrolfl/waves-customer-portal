/**
 * Board safety layer (split of #3687, Codex r30): the acquisition-path
 * revision a placement was LEASED on.
 *
 * `seo_link_prospects.leased_path_revision` — stamped by worker.claim() from
 * the linked path's `revision`. A same-path change that lands while the row
 * is leased (a gate change, a working-origin move, a lane shift) cannot be
 * applied to a leased row; at lease release the registry compares the
 * path's current revision with this stamp and applies the transition then.
 */
exports.up = async function up(knex) {
  const cols = await knex('seo_link_prospects').columnInfo();
  if (!cols.leased_path_revision) {
    await knex.schema.alterTable('seo_link_prospects', (t) => {
      t.integer('leased_path_revision');
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE seo_link_prospects DROP COLUMN IF EXISTS leased_path_revision');
};
