/**
 * Catalog best price: move existing winners onto the delivered basis
 * (owner 2026-11-21: compare "the lower price per oz, lb, g, etc, and we always
 * should include shipping").
 *
 * The vendor ranking (scoreVendorRows in routes/admin-inventory.js) now counts
 * shipping: a row that says nothing about its delivered price is ranked with
 * its vendor's shipping rule. The catalog STORES each product's winner, and a product is
 * only recalculated when one of its vendor prices is written. The
 * Intelligence Bar vendor tools rank on read. Without this migration an
 * unchanged product would show one winner on the Inventory screens and
 * another in the Intelligence Bar until someone next saved a price for it.
 *
 * The scope is narrow on purpose. A product is recalculated only when
 *   - the catalog prices it from a current winner (best_price_status
 *     'current' and a best_vendor_pricing_id),
 *   - it has two or more eligible vendor rows (one row has no one to lose to),
 *   - its rows rank per unit, or per ounce on a product the catalog can
 *     scale to its own container (a unit_size_oz). A 'raw' ranking does not
 *     count shipping, so this change did not move it; an ounce ranking with
 *     no unit size is one a recalculation marks stale instead of moving,
 *   - the stored winner is still one of those eligible, ranked rows, and
 *   - with shipping counted it ranks strictly behind another row.
 * Every other product is left exactly as it is:
 *   - A stored winner that still ranks first, alone or tied, is kept. An
 *     exact tie is not a shipping difference, and a rewrite could move the
 *     vendor and its purchasing link for nothing. A recalculation would
 *     also restate a stored price that differs from a fresh one for reasons
 *     that have nothing to do with the winner.
 *   - A stored winner that is no longer eligible (an expired quote) was out
 *     of step with its rows before this change. It is left for the next
 *     price write, as it was.
 *
 * recalcBestPrice is the canonical writer the inventory screens use (ranking,
 * eligibility, pack scaling, cached winner fields, pricing-engine cache). It
 * re-reads the product's rows under the product's advisory lock, so the
 * checks here only choose which products to hand to it.
 */
const RANK_TIE = 1e-9;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasTable('vendor_pricing'))) return;
  const { recalcBestPrice, scoreVendorRows } = require('../../routes/admin-inventory');
  const { eligibleVendorPricing } = require('../../services/vendor-pricing-eligibility');

  const rows = await eligibleVendorPricing(knex('vendor_pricing'))
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name');
  const rowsByProduct = new Map();
  for (const row of rows) {
    if (!rowsByProduct.has(row.product_id)) rowsByProduct.set(row.product_id, []);
    rowsByProduct.get(row.product_id).push(row);
  }
  const contested = [...rowsByProduct].filter(([, productRows]) => productRows.length > 1).map(([productId]) => productId);
  if (!contested.length) return;

  const products = await knex('products_catalog')
    .whereIn('id', contested)
    .where({ best_price_status: 'current' })
    .whereNotNull('best_vendor_pricing_id')
    .select('id', 'unit_size_oz', 'container_size', 'best_price', 'best_vendor_pricing_id')
    .orderBy('id');
  for (const product of products) {
    const { mode, pool } = scoreVendorRows(rowsByProduct.get(product.id), product);
    if (mode === 'raw' || !pool.length || pool[0].rank == null) continue;
    if (mode === 'oz' && !(Number(product.unit_size_oz) > 0)) continue;
    const stored = pool.find((entry) => String(entry.row.id) === String(product.best_vendor_pricing_id));
    if (!stored || stored.rank == null) continue;
    if (stored.rank <= pool[0].rank + RANK_TIE) continue;
    await recalcBestPrice(product.id, knex);
  }
};

// The ranking basis is code, not data: there is no earlier state this
// migration could restore that the code would not move again at the next
// price write. To go back, revert the code and recalculate the same products.
exports.down = async function down() {};
