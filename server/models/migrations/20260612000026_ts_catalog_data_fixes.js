/**
 * Migration — products_catalog data fixes found by the T&S pricing audit
 *
 * 1. The LESCO 8-2-12 palm/ornamental fertilizer row carries
 *    container_size '1 lb' at a ~$44-46 price — that price is for the 50 lb
 *    bag (cf. the wholesale-verified $46.36/50 lb basis in
 *    pricing-engine/constants.js PALM.internalCostBasis). Anything costing
 *    per-unit off this row would over-model fertilizer cost 50x.
 *
 * 2. SuffOil-X (horticultural spray oil) appears throughout the
 *    "10/10 SWFL Tree & Shrub Protocol" (server/config/protocols.json) but
 *    has no products_catalog row at all. Insert it flagged needs_pricing —
 *    no invented price; the procurement flow fills best_price from a real
 *    vendor quote.
 */
const LESCO_8212_PREFIX = 'LESCO 8-2-12 100% Poly Plus OPTI%';

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex('products_catalog')
    .whereILike('name', LESCO_8212_PREFIX)
    .where({ container_size: '1 lb' })
    .update({ container_size: '50 lb', updated_at: knex.fn.now() });

  const existing = await knex('products_catalog')
    .whereILike('name', '%suffoil%')
    .first();
  if (!existing) {
    await knex('products_catalog').insert({
      name: 'SuffOil-X Spray Oil Emulsion',
      category: 'Insecticide',
      subcategory: 'Horticultural Oil',
      active_ingredient: 'Unsulfonated residue of petroleum oil 80%',
      formulation: 'Spray oil emulsion',
      container_size: '2.5 gal',
      default_rate: '1.0-1.5% v/v solution',
      default_unit: 'percent_solution',
      needs_pricing: true,
      active: true,
      rate_notes: JSON.stringify('T&S protocol: 1.0% standard, 1.5% only with active scale/mites and safe plant/weather conditions. Keep separate from copper tanks. OMRI listed.'),
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex('products_catalog')
    .whereILike('name', LESCO_8212_PREFIX)
    .where({ container_size: '50 lb' })
    .update({ container_size: '1 lb', updated_at: knex.fn.now() });

  await knex('products_catalog')
    .where({ name: 'SuffOil-X Spray Oil Emulsion', needs_pricing: true })
    .del();
};
