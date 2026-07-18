/**
 * Widen estimates.pricing_version varchar(10) → varchar(80).
 *
 * The column was sized for the legacy engine constant ('v4.2'), but the
 * version that actually priced a lawn estimate is the lawn mechanism token
 * (e.g. LAWN_PRICING_V2_DENSE_35_FLOOR, 30 chars) — Codex #2667 r4: stamping
 * the 10-char constant made the pricing_version stamp a no-op because it
 * equals the column default. 80 matches estimate_pricing_audit_snapshots'
 * pricing_version width. NOT NULL + default 'v4.2' are preserved.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (!(await knex.schema.hasColumn('estimates', 'pricing_version'))) return;
  await knex.schema.alterTable('estimates', (t) => {
    t.string('pricing_version', 80).notNullable().defaultTo('v4.2').alter();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (!(await knex.schema.hasColumn('estimates', 'pricing_version'))) return;
  // Values longer than the original width must be truncated before the
  // narrowing alter, or the alter itself throws.
  await knex('estimates')
    .whereRaw('LENGTH(pricing_version) > 10')
    .update({ pricing_version: knex.raw('LEFT(pricing_version, 10)') });
  await knex.schema.alterTable('estimates', (t) => {
    t.string('pricing_version', 10).notNullable().defaultTo('v4.2').alter();
  });
};
