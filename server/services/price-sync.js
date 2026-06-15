/**
 * Price Sync Service
 *
 * Reads best_price from products_catalog and compares against current
 * job costing rates. Logs what would change for future pricing engine updates.
 *
 * Also recalculates all active tank mix costs from current inventory prices.
 */
const db = require('../models/db');
const logger = require('./logger');

/**
 * Sync prices from products_catalog to tank mixes and log changes.
 * Does NOT modify pricingEngine.js constants — that's a future step.
 * Instead, recalculates tank mix costs and logs pricing deltas.
 *
 * @param {{ dryRun?: boolean }} [options] When dryRun is true, computes and
 *   returns the would-be tank-mix cost deltas without writing to the database.
 *   Mixes containing any product without both a known best_price and a usable
 *   package size are never recosted — they are returned in `skipped` with the
 *   blocking product ids and reasons rather than persisting a cost we cannot
 *   actually compute.
 */
async function syncPricesToEstimator(options = {}) {
  const { dryRun = false } = options;
  logger.info(`[PriceSync] Starting price sync${dryRun ? ' (dry run — no writes)' : ''}...`);

  try {
    // 1. Pull all products with prices from catalog
    const products = await db('products_catalog')
      .whereNotNull('best_price')
      .where('best_price', '>', 0)
      .select('id', 'name', 'best_price', 'unit_size_oz', 'category');

    logger.info(`[PriceSync] Found ${products.length} products with pricing`);

    // 2. Build price map (cost per oz). Only products with both a best_price
    //    and a usable package size can be recosted; a priced product missing a
    //    normalized unit_size_oz is tracked separately so we never guess its
    //    package size (e.g. defaulting to one gallon).
    const priceMap = {};
    const unsizedProductIds = new Set();
    for (const p of products) {
      const containerOz = parseFloat(p.unit_size_oz);
      if (!Number.isFinite(containerOz) || containerOz <= 0) {
        unsizedProductIds.add(p.id);
        continue;
      }
      const costPerOz = parseFloat(p.best_price) / containerOz;
      priceMap[p.id] = {
        name: p.name,
        best_price: parseFloat(p.best_price),
        container_oz: containerOz,
        cost_per_oz: Math.round(costPerOz * 10000) / 10000,
      };
    }

    // 3. Recalculate all active tank mixes
    const activeMixes = await db('tank_mixes').where('active', true);
    let mixesUpdated = 0;
    const changes = [];
    const mixUpdates = [];
    const skipped = [];

    for (const mix of activeMixes) {
      const mixProducts = typeof mix.products === 'string'
        ? JSON.parse(mix.products)
        : (mix.products || []);

      if (!mixProducts.length) continue;

      // A tank mix can only be safely recosted if EVERY product it uses has a
      // known best_price AND package size. Recosting a partially-priced mix
      // would drop the unpriced products' cost from the tank total (understating
      // it), so skip the mix and report why rather than writing a number we
      // cannot actually compute.
      const blockers = [];
      for (const p of mixProducts) {
        if (priceMap[p.product_id]) continue;
        blockers.push({
          product_id: p.product_id,
          reason: unsizedProductIds.has(p.product_id) ? 'missing_unit_size_oz' : 'no_best_price',
        });
      }
      if (blockers.length) {
        skipped.push({ mix: mix.name, blockers });
        logger.info(`[PriceSync] Skipped mix "${mix.name}" — ${blockers.length} product(s) without a usable price/size`);
        continue;
      }

      let newCostPerTank = 0;
      let hasChange = false;

      const updatedProducts = mixProducts.map(p => {
        const pricing = priceMap[p.product_id];
        if (!pricing) return p;

        const ozPerTank = parseFloat(p.oz_per_tank) || 0;
        const newCost = pricing.cost_per_oz * ozPerTank;
        const oldCost = parseFloat(p.cost_in_tank) || 0;

        if (Math.abs(newCost - oldCost) > 0.01) {
          hasChange = true;
          changes.push({
            mix: mix.name,
            product: pricing.name,
            old_cost_in_tank: oldCost,
            new_cost_in_tank: Math.round(newCost * 100) / 100,
            delta: Math.round((newCost - oldCost) * 100) / 100,
          });
        }

        newCostPerTank += newCost;

        return {
          ...p,
          cost_per_oz: pricing.cost_per_oz,
          cost_in_tank: Math.round(newCost * 100) / 100,
        };
      });

      if (hasChange) {
        const costPerTank = Math.round(newCostPerTank * 100) / 100;
        const coverage = parseInt(mix.coverage_sqft) || 0;
        const costPer1000 = coverage > 0
          ? Math.round((newCostPerTank / (coverage / 1000)) * 10000) / 10000
          : 0;

        mixUpdates.push({
          mix: mix.name,
          old_cost_per_tank: parseFloat(mix.cost_per_tank) || 0,
          new_cost_per_tank: costPerTank,
          old_cost_per_1000sf: parseFloat(mix.cost_per_1000sf) || 0,
          new_cost_per_1000sf: costPer1000,
        });

        if (!dryRun) {
          await db('tank_mixes').where({ id: mix.id }).update({
            products: JSON.stringify(updatedProducts),
            cost_per_tank: costPerTank,
            cost_per_1000sf: costPer1000,
            updated_at: db.fn.now(),
          });
        }

        mixesUpdated++;
        logger.info(`[PriceSync] ${dryRun ? 'Would update' : 'Updated'} mix "${mix.name}": $${mix.cost_per_tank} → $${costPerTank}/tank`);
      }
    }

    // 4. Log pricing engine comparison (future: actually update rates)
    // For now, log what the estimator rates SHOULD be based on actual product costs
    logger.info(`[PriceSync] Complete${dryRun ? ' (dry run)' : ''} — ${mixesUpdated} tank mixes ${dryRun ? 'would change' : 'updated'}, ${changes.length} price changes detected, ${skipped.length} mix(es) skipped (incomplete pricing)`);

    if (changes.length > 0) {
      logger.info('[PriceSync] Price changes:');
      for (const c of changes) {
        logger.info(`  ${c.mix} / ${c.product}: $${c.old_cost_in_tank} → $${c.new_cost_in_tank} (${c.delta > 0 ? '+' : ''}$${c.delta})`);
      }
    }

    return {
      dry_run: dryRun,
      products_with_pricing: products.length,
      mixes_updated: mixesUpdated,
      mix_updates: mixUpdates,
      price_changes: changes,
      skipped,
    };
  } catch (err) {
    logger.error(`[PriceSync] Error: ${err.message}`);
    throw err;
  }
}

module.exports = { syncPricesToEstimator };
