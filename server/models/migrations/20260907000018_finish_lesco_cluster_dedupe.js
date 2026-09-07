/**
 * Finish 20260712000051_catalog_dedupe_irrigation_rotation for the two LESCO
 * clusters production never reconciled. Their keeper rows were imported after
 * that migration ran, so it skipped both clusters, and prod still carries the
 * keeper (the row every lawn_protocol_products line references) AND the
 * short-named duplicate as active — the state 20260907000100 refuses.
 *
 * Same loser step as the dedupe: the duplicate's aliases move to the keeper,
 * its own name becomes a keeper alias, and it is deactivated — never deleted;
 * its vendor pricing, stock and history rows stay attached. Two additions the
 * canonical migration needs: a MISSING keeper package size is filled only when
 * the keeper's own 320 fl oz unit size proves the 2.5 gal package, and the
 * duplicate's distributor SKU rows follow the active identity so the weekly
 * price scan lands on it. No price, cost, rate, stock, protocol or
 * vendor-pricing row changes. A catalog without the imported keepers
 * (development, preview) already has one identity per cluster and is skipped.
 */
const assert = require('node:assert/strict');
const SOURCE = 'finish_lesco_cluster_dedupe_20260907';
const CLUSTERS = [
  { keeper: 'LESCO Chelated Iron Plus', duplicate: 'LESCO 12-0-0 Chelated Iron Plus', container: '2.5 gal', ounces: 320 },
  { keeper: 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', duplicate: 'LESCO K-Flow 0-0-25', container: '2.5 gal', ounces: 320 },
];

async function oneByName(knex, name) {
  const rows = await knex('products_catalog').where({ name }).forUpdate();
  assert.ok(rows.length <= 1, `Expected at most one catalog product: ${name}`);
  return rows[0] || null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  const hasAliases = await knex.schema.hasTable('product_aliases');
  const hasDistributorMap = await knex.schema.hasTable('distributor_product_map');
  for (const cluster of CLUSTERS) {
    const keeper = await oneByName(knex, cluster.keeper);
    if (!keeper) {
      console.info(`[finish_lesco_cluster_dedupe] ${cluster.keeper}: not in this catalog; cluster skipped`);
      continue;
    }
    assert.notEqual(keeper.active, false, `Keeper is retired: ${cluster.keeper}`);
    // Package evidence the canonical migration asserts. Fill only a missing
    // size, and only when the keeper's own unit size proves the package.
    const keeperUpdates = {};
    if (keeper.container_size == null) {
      assert.equal(Number(keeper.unit_size_oz), cluster.ounces, `Package size needs review: ${cluster.keeper} (${keeper.unit_size_oz})`);
      keeperUpdates.container_size = cluster.container;
    } else {
      assert.equal(keeper.container_size, cluster.container, `Package evidence conflicts: ${cluster.keeper} (${keeper.container_size})`);
    }
    const duplicate = await oneByName(knex, cluster.duplicate);
    const duplicateActive = duplicate != null && duplicate.active !== false;
    if (!duplicateActive && !Object.keys(keeperUpdates).length) {
      console.info(`[finish_lesco_cluster_dedupe] ${cluster.keeper}: already the single active identity; nothing to do`);
      continue;
    }
    if (Object.keys(keeperUpdates).length) {
      await knex('products_catalog').where({ id: keeper.id }).update({ ...keeperUpdates, updated_at: knex.fn.now() });
    }
    let aliasesMoved = 0;
    let aliasAdded = false;
    let distributorMapsMoved = 0;
    if (duplicateActive) {
      if (hasAliases) {
        // Protocol shorthand resolves through product_aliases against the
        // ACTIVE catalog, so the duplicate's aliases and its own name move.
        aliasesMoved = await knex('product_aliases')
          .where({ product_id: duplicate.id })
          .update({ product_id: keeper.id, updated_at: knex.fn.now() });
        const existing = await knex('product_aliases')
          .where({ product_id: keeper.id })
          .whereRaw('LOWER(alias_name) = LOWER(?)', [cluster.duplicate])
          .first('id');
        if (!existing) {
          await knex('product_aliases').insert({
            product_id: keeper.id, alias_name: cluster.duplicate, created_at: knex.fn.now(), updated_at: knex.fn.now(),
          });
          aliasAdded = true;
        }
      }
      if (hasDistributorMap) {
        const duplicateMaps = await knex('distributor_product_map').where({ product_id: duplicate.id }).forUpdate();
        if (duplicateMaps.length) {
          const conflicts = await knex('distributor_product_map')
            .where({ product_id: keeper.id })
            .whereIn('vendor_id', duplicateMaps.map((row) => row.vendor_id));
          assert.equal(conflicts.length, 0, `Distributor map conflicts: ${cluster.keeper}`);
          distributorMapsMoved = await knex('distributor_product_map')
            .where({ product_id: duplicate.id })
            .update({ product_id: keeper.id });
        }
      }
      const retired = await knex('products_catalog')
        .where({ id: duplicate.id })
        .whereRaw('active IS NOT FALSE')
        .update({ active: false, updated_at: knex.fn.now() });
      assert.equal(retired, 1, `Could not retire duplicate: ${cluster.duplicate}`);
    }
    await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
      resource_id: String(keeper.id), critical: true, trx: knex,
      metadata: { role: 'keeper', keeperUpdates, duplicateId: duplicate ? duplicate.id : null,
        duplicateRetired: duplicateActive, aliasesMoved, aliasAdded, distributorMapsMoved,
        source: 'Keeper/duplicate pair from 20260712000051; the keeper carries the lawn_protocol_products references' } });
    if (duplicateActive) {
      await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
        resource_id: String(duplicate.id), critical: true, trx: knex,
        metadata: { role: 'retired_duplicate', keeperId: keeper.id, priorActive: duplicate.active,
          bestPrice: duplicate.best_price, costPerUnit: duplicate.cost_per_unit, costUnit: duplicate.cost_unit,
          inventoryUnit: duplicate.inventory_unit, inventoryOnHand: duplicate.inventory_on_hand,
          note: 'Vendor pricing, stock and history rows stay on this row; current quotes and stock are re-entered on the keeper through the inventory page' } });
    }
    console.info(`[finish_lesco_cluster_dedupe] ${cluster.keeper}: ${duplicateActive ? `retired "${cluster.duplicate}"` : 'duplicate already retired'}; keeper fills ${JSON.stringify(keeperUpdates)}; aliases moved ${aliasesMoved}${aliasAdded ? ' +name' : ''}; distributor maps moved ${distributorMapsMoved}`);
  }
};

// Reactivating the duplicates would recreate the two-identity state the
// canonical migration refuses, and the audit rows hold the prior values.
exports.down = async function down() {};
