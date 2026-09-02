/**
 * Step-3 investigator: cumulative probe coverage per domain (Codex PR r11).
 *
 * A terminal not_reproducible close must not fire while fixed probe routes
 * were never offered a fetch slot (hint-rich domains can starve the probe
 * tail for many passes). The mask records which PROBE_PATHS indexes have
 * been attempted across passes; closure waits for a full mask — or for a
 * pass that makes no progress (nothing more can be learned).
 */
exports.up = async function up(knex) {
  const cols = await knex('seo_link_domains').columnInfo();
  if (!cols.probe_coverage_mask) {
    await knex.schema.alterTable('seo_link_domains', (t) => {
      t.integer('probe_coverage_mask').notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE seo_link_domains DROP COLUMN IF EXISTS probe_coverage_mask');
};
