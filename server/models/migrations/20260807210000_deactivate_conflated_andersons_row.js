// Deactivate "The Andersons Turf Fertilizer with Grub/Crabgrass Control"
// (owner ruling 2026-08-07). The Andersons sells no such SKU — the row
// conflates two distinct products: 15-0-4 with 0.2% imidacloprid GrubOut
// (EPA 9198-236) and Crabgrass Preventer Plus Lawn Food 26-0-6 with
// dithiopyr. A catalog row that matches no real bag can't carry an honest
// label-derived target list or rate, so it comes off the picker; the real
// SKU(s) get added as new rows if/when stocked.
//
// Deactivation only — never a delete: service_products history keeps its
// product_id reference, and the row stays visible to admin catalog tools,
// matching how 20260712000051 retired duplicate rows.

const CONFLATED_NAME = 'The Andersons Turf Fertilizer with Grub/Crabgrass Control';

exports.CONFLATED_NAME = CONFLATED_NAME;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'active'))) return;

  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [CONFLATED_NAME])
    .where({ active: true })
    .update({ active: false, updated_at: new Date() });
};

// Reactivating by name can't prove this migration was what deactivated the
// row (an admin may have retired it independently) — deliberate no-op.
exports.down = async function down() {};
