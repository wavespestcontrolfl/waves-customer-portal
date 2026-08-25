/**
 * One-time inventory-cost reconciliation (codex #3465 r7/r10-push P1s):
 *
 * 1. vendor_pricing.price_amount sync — legacy approval paths updated
 *    `price` without touching `price_amount`, and the scorer now treats
 *    price_amount as authoritative. For rows with BOTH values present but
 *    different and NO worker snapshot applied (latest_snapshot_id null —
 *    on such rows price is the actively maintained column), price wins.
 *    Snapshot-carrying rows keep their snapshot-owned price_amount.
 *
 * 2. tank_mixes recost — totals persisted before the container-size fix
 *    were computed against the nonexistent `size_oz` column and a
 *    fabricated 128-oz fallback, and products_catalog.best_price itself
 *    may still hold the OLD raw-pack-price semantics until an organic
 *    recalculation runs. So mixes are recosted from the winning ELIGIBLE
 *    vendor row's own sticker per-oz (never the possibly-legacy catalog
 *    figure): eligibility and ranking mirror recalcBestPrice (active,
 *    approved/auto_approved, unexpired, positive price; landed per-oz
 *    orders when present; sticker per-oz prices the mix). A component
 *    with no derivable per-oz flags cost_unknown and contributes $0 —
 *    never a guessed divisor.
 *
 * Quantity parsing reuses the PURE costing utils (no route/db module is
 * required — those boot app state migrations must not depend on).
 * Data-only; down is a no-op (the pre-fix numbers were wrong).
 */
const {
  convertToOz,
  normalizeQuantityToOz,
  parsePackSize,
} = require('../../services/product-costing');

function quantityToOz(quantity) {
  const direct = normalizeQuantityToOz(quantity);
  if (direct && direct > 0) return direct;
  const parsed = parsePackSize(quantity);
  if (!parsed) return null;
  const oz = convertToOz(parsed.amount, parsed.unit);
  return oz && oz > 0 ? Math.round(oz * 100) / 100 : null;
}

function num(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Stored unit-cost → per-oz, honoring the ROW's unit_normalized (r22-push
// P0): a canonical 'lb' row stores $/lb — treating it as $/oz inflates the
// scaled price ~16x. Mirrors the runtime helper.
function storedUnitCostPerOz(value, unitNormalized) {
  const v = num(value);
  if (v == null || v <= 0) return null;
  const ozPerUnit = convertToOz(1, String(unitNormalized || 'oz'));
  if (!ozPerUnit || ozPerUnit <= 0) return null;
  return v / ozPerUnit;
}

// Winning eligible vendor row for one product — mirrors recalcBestPrice's
// eligibility + landed-first ordering. Returns null when no eligible row
// has a derivable price.
async function winningRow(knex, productId) {
  const rows = await knex('vendor_pricing')
    .where('vendor_pricing.product_id', productId)
    .whereRaw('COALESCE(vendor_pricing.price_amount, vendor_pricing.price) > 0')
    .where('vendor_pricing.is_active', true)
    .whereIn('vendor_pricing.approval_status', ['approved', 'auto_approved'])
    .where(function unexpired() {
      this.whereNull('vendor_pricing.expires_at').orWhere('vendor_pricing.expires_at', '>', new Date());
    })
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name');
  let best = null;
  let fallback = null; // no sized row anywhere → cheapest raw price (recalc contract)
  const hasRows = rows.length > 0;
  for (const row of rows) {
    const price = num(row.price_amount) ?? num(row.price);
    if (price == null) continue;
    if (!fallback || price < fallback.price) fallback = { row, price, perOz: null };
    const oz = quantityToOz(row.quantity);
    const storedPerOz = storedUnitCostPerOz(row.normalized_unit_price, row.unit_normalized)
      ?? (num(row.price_per_oz) > 0 ? num(row.price_per_oz) : null);
    const perOz = oz && oz > 0 ? price / oz : storedPerOz;
    if (perOz == null) continue;
    const landed = storedUnitCostPerOz(row.landed_unit_price, row.unit_normalized);
    const rank = landed != null ? landed : perOz;
    // Runtime tie-break parity: equal rank → lower raw price wins.
    if (!best || rank < best.rank || (rank === best.rank && price < best.price)) best = { rank, perOz, price, row };
  }
  return { winner: best || fallback, hasRows };
}

exports.up = async function up(knex) {
  // 1. Repair legacy diverged rows: price_amount ← price, and the DERIVED
  //    unit costs move with it (GH r3 P1) — the old snapshot's
  //    landed_unit_price / normalized_unit_price describe the pre-approval
  //    price and would otherwise keep ranking the row at its former cost.
  //    normalized is recomputed where the quantity parses, cleared where
  //    it doesn't (an unrankable row beats a wrong rank); landed is
  //    cleared (no shipping info survives a legacy approval).
  if (await knex.schema.hasTable('vendor_pricing')) {
    const hasSnapshots = await knex.schema.hasTable('price_snapshots');
    // Snapshot-less rows: price is the actively maintained column.
    // Snapshot-backed rows where a LEGACY approval later moved price
    // (r12-push P1): detectable because price_amount still equals the
    // snapshot's own price_amount while price moved past it — the later
    // legacy write wins. Rows whose price_amount diverged from the
    // snapshot too are ambiguous and left alone.
    const diverged = await knex('vendor_pricing as vp')
      .modify((qb) => {
        if (hasSnapshots) {
          qb.leftJoin('price_snapshots as ps', 'vp.latest_snapshot_id', 'ps.id')
            .where(function classes() {
              this.whereNull('vp.latest_snapshot_id')
                .orWhereRaw('ps.price_amount IS NOT NULL AND vp.price_amount = ps.price_amount');
            });
        } else {
          qb.whereNull('vp.latest_snapshot_id');
        }
      })
      .whereNotNull('vp.price_amount')
      .where('vp.price', '>', 0)
      .whereRaw('vp.price_amount <> vp.price')
      .select('vp.id', 'vp.price', 'vp.quantity');
    for (const row of diverged) {
      const oz = quantityToOz(row.quantity);
      const price = num(row.price);
      const perOz = oz && oz > 0 && price != null
        ? Math.round((price / oz) * 10000) / 10000
        : null;
      await knex('vendor_pricing').where({ id: row.id }).update({
        price_amount: row.price,
        landed_unit_price: null,
        normalized_unit_price: perOz,
        price_per_oz: perOz,
        unit_normalized: perOz != null ? 'oz' : null,
      });
    }
  }

  // 2. Convert products_catalog.best_price to the canonical-container
  //    semantics (r11-push P1): legacy values hold the winner's RAW pack
  //    price, and any later consumer dividing by unit_size_oz — including
  //    a tank-mix recalculation — would resurrect the wrong per-oz cost.
  //    Same winner selection as recalcBestPrice; products with no eligible
  //    row are invalidated (no_valid_price) exactly as the runtime does.
  const winnerCache = new Map();
  if (await knex.schema.hasTable('products_catalog')) {
    // NOTE (r16-push P0): products with NO vendor_pricing rows are left
    // UNTOUCHED — the repo intentionally seeds authoritative catalog-only
    // prices (WaveGuard, tree/shrub protocol products) with no vendor rows,
    // and the runtime never invalidates them either (recalcBestPrice only
    // runs from vendor-row events). Only vendor-backed products convert.
    const productIds = await knex('vendor_pricing').distinct('product_id').pluck('product_id');
    for (const pid of productIds) {
      const entry = await winningRow(knex, pid);
      winnerCache.set(pid, entry);
      const winner = entry.winner;
      if (!winner) {
        // NO eligible winner → leave the catalog row UNTOUCHED (r23-push
        // P0): this sweep visits every vendor-backed product, and products
        // whose only rows are pending scraper placeholders or expired
        // seeded protocol prices still carry an AUTHORITATIVE catalog
        // price. The runtime invalidates organically on the next vendor
        // event; a deploy-time migration must not destroy costing data it
        // cannot rebuild.
        continue;
      }
      const product = await knex('products_catalog').where({ id: pid }).first('unit_size_oz', 'best_price');
      if (!product) continue;
      const unitSizeOz = num(product.unit_size_oz);
      const scalable = winner.perOz != null && unitSizeOz > 0;
      // Count-based / unscalable products (r19-push P0, the HexPro bug):
      // never overwrite an existing (possibly intentional per-unit)
      // catalog price with an unreconcilable raw pack price — only fill a
      // NULL one. Mirrors the runtime rule.
      if (!scalable && num(product.best_price) != null) {
        // Same rule as the runtime: keep the (possibly intentional
        // per-unit) price but flag for review and clear the winner flags
        // so nothing silently consumes an unreconciled figure.
        await knex('products_catalog').where({ id: pid }).update({
          best_price_status: 'stale',
          needs_pricing: true,
          best_price_updated_at: new Date(),
        });
        await knex('vendor_pricing').where({ product_id: pid }).update({ is_best_price: false });
        continue;
      }
      const bestPrice = scalable
        ? Math.round(winner.perOz * unitSizeOz * 100) / 100
        : winner.price;
      await knex('products_catalog').where({ id: pid }).update({
        best_price: bestPrice,
        best_vendor: winner.row.vendor_name,
        best_vendor_pricing_id: winner.row.id,
        best_price_amount_cached: winner.price,
        best_price_vendor_id_cached: winner.row.vendor_id,
        best_price_updated_at: new Date(),
        best_price_status: 'current',
        needs_pricing: false,
      });
      await knex('vendor_pricing').where({ product_id: pid }).update({ is_best_price: false });
      await knex('vendor_pricing').where({ id: winner.row.id }).update({ is_best_price: true });
    }
  }

  // 3. Recost every tank mix from the winning vendor row's per-oz.
  if (!(await knex.schema.hasTable('tank_mixes'))) return;
  if (!(await knex.schema.hasTable('vendor_pricing'))) return;

  const mixes = await knex('tank_mixes').select('id', 'products', 'coverage_sqft');
  for (const mix of mixes) {
    let products;
    try {
      products = typeof mix.products === 'string' ? JSON.parse(mix.products) : (mix.products || []);
    } catch {
      continue; // unparseable products payload — leave the row untouched
    }
    if (!Array.isArray(products) || !products.length) continue;

    let totalCostPerTank = 0;
    const enriched = [];
    for (const p of products) {
      let unitCost = 0;
      let costUnknown = false;
      if (p && p.product_id) {
        costUnknown = true;
        if (!winnerCache.has(p.product_id)) {
          winnerCache.set(p.product_id, await winningRow(knex, p.product_id));
        }
        const entry = winnerCache.get(p.product_id);
        if (entry.winner && entry.winner.perOz != null && entry.winner.perOz > 0) {
          unitCost = entry.winner.perOz;
          costUnknown = false;
        } else {
          // No derivable per-oz winner (r17/r21-push P1): the catalog
          // price was deliberately preserved above — for catalog-only
          // products AND vendor-backed products whose rows can't yield a
          // per-oz — so cost the component from the catalog instead of
          // zeroing it. Unusable catalog values still flag cost_unknown.
          const cat = await knex('products_catalog')
            .where({ id: p.product_id })
            .first('best_price', 'unit_size_oz');
          const bp = cat ? num(cat.best_price) : null;
          const oz = cat ? num(cat.unit_size_oz) : null;
          if (bp != null && bp > 0 && oz != null && oz > 0) {
            unitCost = bp / oz;
            costUnknown = false;
          }
        }
      }
      const ozPerTank = num(p && p.oz_per_tank) || 0;
      const productCost = unitCost * ozPerTank;
      totalCostPerTank += productCost;
      // Strip any prior flag before conditionally re-adding — a stale
      // cost_unknown:true must not survive a now-valid price/size.
      const { cost_unknown: _priorUnknown, ...rest } = p || {};
      enriched.push({
        ...rest,
        cost_per_oz: Math.round(unitCost * 10000) / 10000,
        cost_in_tank: Math.round(productCost * 100) / 100,
        ...(costUnknown ? { cost_unknown: true } : {}),
      });
    }

    const coverage = num(mix.coverage_sqft) || 0;
    await knex('tank_mixes').where({ id: mix.id }).update({
      products: JSON.stringify(enriched),
      cost_per_tank: Math.round(totalCostPerTank * 100) / 100,
      cost_per_1000sf: coverage > 0
        ? Math.round((totalCostPerTank / (coverage / 1000)) * 10000) / 10000
        : 0,
      updated_at: knex.fn.now(),
    });
  }
};

exports.down = async function down() {};
