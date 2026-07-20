/**
 * Seed pricing_config.termite_bond — quarterly warranty-bond rates by term
 * (owner 2026-07-20: residential termite bond option, billed per application
 * on the shared quarterly station check).
 *
 * Rates mirror the catalog rows termite_bond_{1,5,10}yr base_price
 * ($60 / $54 / $45 per quarter). The pricing engine reads THIS key via
 * db-bridge (constants.TERMITE.bond fallback when absent); the catalog
 * base_price is not consulted by the engine.
 *
 * Insert-if-absent: an existing row (admin-edited or re-run) is never
 * overwritten.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;
  const existing = await knex('pricing_config').where({ config_key: 'termite_bond' }).first();
  if (existing) return;
  await knex('pricing_config').insert({
    config_key: 'termite_bond',
    name: 'Termite Bond Quarterly Rates',
    category: 'termite',
    sort_order: 4,
    data: JSON.stringify({ term_1yr: 60, term_5yr: 54, term_10yr: 45 }),
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;
  await knex('pricing_config').where({ config_key: 'termite_bond' }).del();
};
