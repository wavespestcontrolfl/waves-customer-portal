// products_catalog.service_lines, the insecticides (follow-up to
// 20261006120000, which seeded the column from the category and left every
// insecticide null because the category alone cannot tell a lawn insecticide
// from a roach one). The lawn sheet lists an untagged product by its category,
// so on a freshly migrated database every insecticide (Advion WDG, Alpine
// WSG, ...) stayed searchable on a lawn visit until the owner's Inventory pass
// (Codex #5993 round 2). The structured lawn protocols settle it instead:
//
//   1. a product any lawn protocol window lists (lawn_protocol_products.
//      product_id) is a lawn product: 'lawn' is added to its lines (set as
//      ['lawn'] on a null row; appended on a tagged row that lacks it, e.g. an
//      insecticide the owner tagged pest-only before this ran, or a bait);
//   2. every other still-null insecticide is a pest product: ['pest'].
//
// Only these rows are written. Adjuvants stay null (both lines, by category).
// A row the owner has already tagged is never rewritten except to add 'lawn'
// for a protocol product, which is what the protocol says of it. down() is a
// documented no-op: these rows are owner-editable in Inventory, and a blanket
// revert would erase the owner's later edits along with this seed.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'service_lines'))) return;
  if (await knex.schema.hasTable('lawn_protocol_products')) {
    const inProtocols = knex('lawn_protocol_products').whereNotNull('product_id').distinct('product_id');
    await knex('products_catalog')
      .whereIn('id', inProtocols)
      .whereNull('service_lines')
      .update({ service_lines: JSON.stringify(['lawn']) });
    await knex('products_catalog')
      .whereIn('id', inProtocols)
      .whereNotNull('service_lines')
      // Containment, not the `?` operator: knex reads a bare ? as a binding.
      .whereRaw(`NOT (service_lines @> '["lawn"]'::jsonb)`)
      .update({ service_lines: knex.raw(`service_lines || '["lawn"]'::jsonb`) });
  }
  await knex('products_catalog')
    .whereNull('service_lines')
    .whereRaw('lower(trim(category)) = ?', ['insecticide'])
    .update({ service_lines: JSON.stringify(['pest']) });
};

exports.down = async function down() {
  // Documented no-op: see the header.
};
