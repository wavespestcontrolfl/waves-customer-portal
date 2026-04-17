/**
 * Migration — Fix HexPro unit vs pack pricing inconsistency
 *
 * Context: migration 20260417000001_seed_specialty_products.js set HexPro's
 * `best_price` to $86.94, which is the 10-station pack price. Advance and
 * Trelona stations in the same migration are stored at per-station cost
 * ($14, $24). When the COGS calc in pricing-engine v4.3+ joins
 * service_product_usage (usage_amount: 1, usage_unit: 'station') against
 * products_catalog.best_price, it multiplies per-unit usage by pack-level
 * cost, silently overcounting HexPro material cost by 10x on every termite
 * monitoring job that uses HexPro.
 *
 * Fix: store the unit cost ($8.69/station) as best_price to match the
 * Advance/Trelona data model. Preserve pack-level invoice reality in
 * vendor_pricing (quantity: '10 stations', price: $86.94). Update the
 * service_product_usage note to remove the ambiguity.
 *
 * Rollback: reverts best_price to $86.94. vendor_pricing row stays the same
 * (pack pricing is correct in both directions). service_product_usage note
 * reverts to the pre-fix text.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  const hexPro = await knex('products_catalog')
    .whereRaw("LOWER(name) LIKE '%hexpro%'")
    .first();

  if (!hexPro) return; // HexPro not in catalog — nothing to fix

  // 1. Update products_catalog to per-station pricing
  await knex('products_catalog').where({ id: hexPro.id }).update({
    best_price: 8.69,            // $86.94 / 10 stations = $8.69/station
    container_size: '1 station', // align with Advance/Trelona model
    needs_pricing: false,
    active: true,
  });

  // 2. Ensure vendor_pricing retains the pack-level invoice reality
  //    (this is how Waves actually buys the product — in 10-packs)
  const vendor = await knex('vendors').where({ code: 10 }).first(); // code 10 = Veseris
  if (vendor) {
    const existing = await knex('vendor_pricing')
      .where({ product_id: hexPro.id, vendor_id: vendor.id })
      .first();
    const packData = {
      product_id: hexPro.id,
      vendor_id: vendor.id,
      price: 86.94,
      quantity: '10 stations',
      unit: 'each',
      is_best_price: true,
      last_checked_at: new Date(),
    };
    if (existing) {
      await knex('vendor_pricing').where({ id: existing.id }).update(packData);
    } else {
      await knex('vendor_pricing').insert(packData);
    }
  }

  // 3. Update the COGS note to reflect unit pricing
  await knex('service_product_usage')
    .where({ product_id: hexPro.id, service_type: 'Termite Monitoring' })
    .update({
      notes: 'HexPro wood-monitor station — $8.69/station unit cost (sold by Veseris as 10-pack at $86.94). Detection system for termite monitoring tier.',
    });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  const hexPro = await knex('products_catalog')
    .whereRaw("LOWER(name) LIKE '%hexpro%'")
    .first();

  if (!hexPro) return;

  // Revert products_catalog to pack pricing
  await knex('products_catalog').where({ id: hexPro.id }).update({
    best_price: 86.94,
    container_size: null,
  });

  // Revert the COGS note
  await knex('service_product_usage')
    .where({ product_id: hexPro.id, service_type: 'Termite Monitoring' })
    .update({
      notes: 'HexPro wood-monitor station — $86.94/10-pack ($8.69/station), detection system',
    });

  // vendor_pricing row unchanged — pack pricing is correct in both directions
};
