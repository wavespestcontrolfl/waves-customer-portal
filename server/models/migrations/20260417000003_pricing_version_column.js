/**
 * Migration — Add pricing_version column to estimates
 *
 * v4.3 Session 1, Step 1a. Every estimate stamped with the engine version
 * that priced it so dispute resolution becomes a SELECT instead of parsing
 * the estimate_data JSON blob.
 *
 * Default 'v4.2' handles backfill automatically. Column stamps the current
 * engine version at insert time once estimate-engine.js is updated at the
 * end of the v4.3 build (not in this session).
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('estimates');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('estimates', 'pricing_version');
  if (!hasColumn) {
    await knex.schema.alterTable('estimates', (t) => {
      t.string('pricing_version', 10).notNullable().defaultTo('v4.2');
      t.index('pricing_version', 'idx_estimates_pricing_version');
    });
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('estimates');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('estimates', 'pricing_version');
  if (hasColumn) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropIndex('pricing_version', 'idx_estimates_pricing_version');
      t.dropColumn('pricing_version');
    });
  }
};
