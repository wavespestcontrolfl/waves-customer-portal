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
 */
async function syncPricesToEstimator() {
  logger.info('[PriceSync] Starting price sync...');

  try {
    // 1. Pull all products with prices from catalog
    const products = await db('products_catalog')
      .whereNotNull('best_price')
      .where('best_price', '>', 0)
      .select('id', 'name', 'best_price', 'size_oz', 'category');

    logger.info(`[PriceSync] Found ${products.length} products with pricing`);

    // 2. Build price map (cost per oz)
    const priceMap = {};
    for (const p of products) {
      const containerOz = parseFloat(p.size_oz) || 128;
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

    for (const mix of activeMixes) {
      const mixProducts = typeof mix.products === 'string'
        ? JSON.parse(mix.products)
        : (mix.products || []);

      if (!mixProducts.length) continue;

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

        await db('tank_mixes').where({ id: mix.id }).update({
          products: JSON.stringify(updatedProducts),
          cost_per_tank: costPerTank,
          cost_per_1000sf: costPer1000,
          updated_at: db.fn.now(),
        });

        mixesUpdated++;
        logger.info(`[PriceSync] Updated mix "${mix.name}": $${mix.cost_per_tank} → $${costPerTank}/tank`);
      }
    }

    // 4. Log pricing engine comparison (future: actually update rates)
    // For now, log what the estimator rates SHOULD be based on actual product costs
    logger.info(`[PriceSync] Complete — ${mixesUpdated} tank mixes updated, ${changes.length} price changes detected`);

    if (changes.length > 0) {
      logger.info('[PriceSync] Price changes:');
      for (const c of changes) {
        logger.info(`  ${c.mix} / ${c.product}: $${c.old_cost_in_tank} → $${c.new_cost_in_tank} (${c.delta > 0 ? '+' : ''}$${c.delta})`);
      }
    }

    return {
      products_with_pricing: products.length,
      mixes_updated: mixesUpdated,
      price_changes: changes,
    };
  } catch (err) {
    logger.error(`[PriceSync] Error: ${err.message}`);
    throw err;
  }
}

module.exports = { syncPricesToEstimator };
