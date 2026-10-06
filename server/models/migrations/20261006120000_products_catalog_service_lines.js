// products_catalog.service_lines: the service lines a product is applied on
// (pest|lawn|mosquito|termite|rodent|tree_shrub|palm, the detectServiceLine
// ids), set in Inventory. The tech lawn sheet lists lawn-tagged products only
// (owner 2026-10-05: a lawn visit never lists a termiticide or a roach bait).
// null = not tagged yet: the sheets then fall back to the category.
//
// Distinct from per_completion_service_lines (which completed visits consume
// a supply), which stays as it is.
//
// The column is seeded from the category where the category settles it. An
// insecticide is NOT tagged (a lawn insecticide and a roach insecticide share
// the category), nor is an adjuvant: those stay null for the owner's own pass.
// Only rows still null are written, so a later re-run never overwrites an
// Inventory edit. down() drops the column.

const SEED_BY_CATEGORY = [
  // [category keys as stored, lower-cased and trimmed], lines
  [['herbicide', 'pre-emergent', 'post-emergent', 'fungicide', 'fertilizer', 'liquid fertilizer',
    'micronutrient', 'micronutrients', 'micronutrient fertilizer', 'pgr', 'amendment', 'soil amendment',
    'biostimulant', 'wetting agent', 'surfactant', 'soil surfactant'], ['lawn']],
  [['termiticide', 'termite bait', 'termite monitoring'], ['termite']],
  [['termiticide / insecticide', 'termiticide/insecticide'], ['termite', 'pest']],
  [['rodenticide', 'rodent trap'], ['rodent']],
  [['mosquito'], ['mosquito']],
  [['bait', 'igr'], ['pest']],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'service_lines'))) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.jsonb('service_lines');
    });
  }
  for (const [categories, lines] of SEED_BY_CATEGORY) {
    await knex('products_catalog')
      .whereNull('service_lines')
      .whereRaw('lower(trim(category)) = ANY(?)', [categories])
      .update({ service_lines: JSON.stringify(lines) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (await knex.schema.hasColumn('products_catalog', 'service_lines')) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.dropColumn('service_lines');
    });
  }
};
