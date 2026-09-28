/**
 * Completes 20260928060000 (frozen once pushed): a PENDING price report on a
 * corrected SiteOne offer still carries the old pack, and approving it
 * re-applies the snapshot's quantity and unit costs verbatim
 * (snapshotPricingFields) before recalcBestPrice — a 64 oz SedgeHammer
 * snapshot would scale $59.99 down to ~$1.25 for the 1.33 oz catalog row
 * (Codex #5130 r1).
 *
 * Every still-pending approval event for these products whose snapshot quotes
 * the old pack is rewritten to the corrected pack: quantity, per-oz
 * normalized price, and no landed cost built on the old pack. The reported
 * price, the event, and its approval state are untouched — the reviewer still
 * decides. None exist in production (checked 2026-09-28).
 */
const FIXES = [
  { name: 'Dominion 2L 1 gal', oldQuantities: ['1 gal'], container: '4 x 1 gal case', oz: 512 },
  {
    name: 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
    oldQuantities: ['64 oz'],
    container: '1.33 oz',
    oz: 1.33,
  },
];

exports.up = async function up(knex) {
  for (const table of ['products_catalog', 'price_approval_events', 'price_snapshots']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  for (const fix of FIXES) {
    const snapshots = await knex('price_approval_events as e')
      .join('products_catalog as p', 'p.id', 'e.product_id')
      .join('price_snapshots as s', 's.id', 'e.snapshot_id')
      .join('vendors as v', 'v.id', 's.vendor_id')
      .where('p.name', fix.name)
      .where('e.approval_status', 'pending')
      .whereRaw('lower(v.name) = ?', ['siteone'])
      .whereIn('s.quantity', fix.oldQuantities)
      .distinct('s.id', 's.price', 's.price_amount');
    for (const snap of snapshots) {
      const price = Number(snap.price_amount ?? snap.price);
      const perOz = Number.isFinite(price) && price > 0 ? Math.round((price / fix.oz) * 10000) / 10000 : null;
      await knex('price_snapshots').where({ id: snap.id }).update({
        quantity: fix.container,
        normalized_unit_price: perOz,
        normalized_unit: perOz != null ? 'oz' : null,
        landed_unit_price: null,
        updated_at: knex.fn.now(),
      });
    }
  }
};

// Data correction; the old pack was wrong, so there is nothing to restore.
exports.down = async function down() {};
