/**
 * The pre-slab and trenching `talstar_p` and `bifen_it` options are the LESCO Crosscheck Plus bottle (owner 2026-11-18: "we need to
 * swap out atticus talak for lesco crosscheck", then "yes all linked services follow it"). Crosscheck Plus is bifenthrin 7.9%,
 * EPA Reg. No. 10404-120, sold as 1 gal (128 fl oz); the owner pays $30.90. The option KEYS stay because saved estimates store them;
 * only the product they name, its cost and its copy change.
 *
 * Pricing is DB-authoritative (db-bridge loads pricing_config over constants.js), so the persisted rows must follow the code:
 *  1. onetime_preslab {talstar_p,bifen_it}: Talak 96 fl oz at 41.57 -> Crosscheck Plus 128 fl oz at 30.90, plus label, catalog
 *     link, package label and warnings. margin_divisor, product_oz_per_10_sqft and positioning are kept.
 *  2. onetime_trenching {talstar_p,bifen_it}: the same bottle, label and warnings; the rate fields are kept.
 * Each product moves in every place db-bridge reads one from: the products map, a legacy product_costs map and the top-level key
 * (its overlays read (products || product_costs)[key] || row[key]), so the quote follows whichever one the bridge reads.
 * A product is rewritten only while it still holds the Talak values, or is exactly the admin seed's Talak product (41.57 / 96 with
 * its rate fields and nothing else: what ensureTable in routes/admin-pricing-config.js inserted from 2026-10-25 until this change,
 * when it creates the table). One already on Crosscheck is left alone silently (re-run); one an admin changed is left alone with a
 * warning. A missing table, row or key is never an error.
 *
 * Step P (first, same transaction): production holds a stale SiteOne price for LESCO Crosscheck Plus ($58.42 per 1 gal, entered
 * 2026-09-30; the owner pays $30.90). db-bridge's pre-slab link takes a catalog price within [0.5x, 2x] of the config, and 58.42 is
 * 1.89x of 30.90, so a pre-slab link to that row unfixed would RAISE slab quotes. For each catalog row named LESCO Crosscheck Plus,
 * Step P writes $30.90 on the product's one vendor row, when it is SiteOne's (item D00001542 AND its vendors row named SiteOne:
 * another vendor can list the same number), and the catalog best price exactly the way the inventory price handler does
 * for a manual entry with no shipping or tax (PUT /:productId/pricing + recalcBestPriceLocked: previous price, price, price_amount,
 * landed cost, per-oz figures, last_checked_at, a price_history row holding the OLD price, and the catalog best_price /
 * best_price_amount_cached / best_price_updated_at). It acts only when the rows still look exactly as read on 2026-11-18, the vendor
 * row's price_amount (what costing reads first), its own pack (1 gal, priced per oz: the handler derives the unit cost from it) and
 * an open quote (no expires_at passed: the inventory price rules skip an expired row) included; a vendor row that differs (an
 * edit, shipping or tax: its landed cost would need them) is left alone with a warning. It does not import the route. When only
 * the catalog best price cannot be written (a second vendor row, a winner that is not that row, an inactive product, another
 * catalog size: the recalculation's own winner rules would be needed), the stale SiteOne row is still corrected, so no later
 * recalculation can make $58.42 the winner again, and the catalog row gets the stale mark until the next recalculation: the
 * corrected row may now be the cheapest, and only that recalculation picks the winner from current prices.
 * server/data/pricing.csv, the sheet the admin pricing import reads first, lists the same gallon at $30.90, so a re-import keeps it.
 *
 * Stale mark: a catalog row named LESCO Crosscheck Plus that still holds the stale $58.42 for 128 oz after Step P (Step P had to
 * leave it), or whose SiteOne row Step P corrected without its best price, gets needs_pricing = true and best_price_status = 'stale', what recalcBestPriceLocked writes when it keeps a price it
 * cannot trust. Every engine catalog link (pre-slab, mosquito) reads only rows with needs_pricing false, so it then keeps the
 * config's or code's 30.90 / 128 for every config shape, the code default link included, until a price is entered in the app
 * (that entry recalculates the row and clears the mark). The 1.89x stale price sits inside the links' [0.5x, 2x] band, so unmarked
 * it would RAISE slab quotes. The deploy log says how to finish. A catalog price that is not the stale one is a later entry, and the
 * quote follows it (owner 2026-07-10) inside the band. The config rows move either way.
 *
 * pest_service_costs (the admin Pricing Logic panel's Pest Service Cost Breakdown; display only, pestVisitCostModel prices the
 * visit): its Talak line, 4 fl oz a visit at 41.57 / 128, becomes Crosscheck Plus at the engine's 0.97 (4 fl oz at 30.90 / 128) in
 * the same place, and each total that held the Talak line moves by the same 0.33. Only while that line holds the Talak values.
 *
 * db-bridge reads `catalogProductName ?? catalog_product_name`, `containerCost ?? container_cost ?? bottleCost ?? bottle_cost`, and so
 * on, so a camelCase or bottle alias would win over the snake_case value written here: the rewrite drops those aliases.
 *
 * Ownership: up() writes one pricing_config_audit row (changed_by TAG) for each pricing_config row it rewrote, one for each product
 * Step P priced, one for the stale mark, and one pricing_changelog row when it changed anything; with no pricing_config_audit table it writes nothing
 * (down() could not find its writes). down() restores a product only when this migration's audit row for its row exists AND the
 * product still deep-equals what up() wrote (an admin edit since then is kept); it restores the catalog price only when its audit
 * row exists AND the vendor row still holds exactly what up() wrote AND the catalog row still holds what up() wrote (or, when up()
 * left the catalog best price to the next recalculation, exactly what up() saw: no recalculation has run since); it lifts the stale mark only from a row that
 * still holds the mark and the prices up() saw; it restores the pest breakdown only when its audit row exists AND the row still
 * deep-equals what up() wrote; then it deletes this migration's price_history row, audit rows and changelog row.
 *
 * The CROSSCHECK_* values are inlined (a pushed migration is frozen): server/tests/bifenthrin-option-crosscheck-migration.test.js asserts
 * they equal the talstar_p and bifen_it products in constants.js, so a later constant change fails that test instead of silently
 * disagreeing with this migration.
 */
const { isDeepStrictEqual } = require('util');

const TAG = 'migration:20261119020000_bifenthrin_option_crosscheck';
const LOG = '[bifenthrin-option-crosscheck]';
const REASON = 'Owner 2026-11-18: "we need to swap out atticus talak for lesco crosscheck", "yes all linked services follow it". The talstar_p and bifen_it options are the LESCO Crosscheck Plus bottle (1 gal = 128 fl oz, $30.90, EPA 10404-120). Keys kept so saved estimates replay.';
const CATALOG_REASON = 'Owner 2026-11-18: the owner pays $30.90 for LESCO Crosscheck Plus (1 gal); the SiteOne row held a stale $58.42. Set so the pre-slab catalog link cannot raise slab quotes.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'cost',
  summary: 'Pre-slab + trenching: the talstar_p and bifen_it options are LESCO Crosscheck Plus (1 gal = 128 fl oz, $30.90); the pest cost breakdown follows.',
};
const CATALOG_AUDIT_KEY = 'inventory:lesco_crosscheck_plus_price';
const STALE_AUDIT_KEY = 'inventory:lesco_crosscheck_plus_stale';
const STALE_REASON = 'Owner 2026-11-18: the owner pays $30.90 for LESCO Crosscheck Plus (1 gal); the catalog still held the stale $58.42, which the engine catalog links would take. Marked needs pricing (stale) until the price is entered.';

const CATALOG_NAME = 'LESCO Crosscheck Plus';
const STALE_SKU = 'D00001542';
const STALE_PRICE = 58.42;
const STALE_SIZE_OZ = 128;
const STALE_QUANTITY = '1 gal';
const NEW_PRICE = 30.9;
const NEW_PER_OZ = Math.round((NEW_PRICE / STALE_SIZE_OZ) * 10000) / 10000; // 0.2414, rounded as the price handler does

const PEST_COSTS_KEY = 'pest_service_costs';
const TALAK_PEST_LINE = { bottle_oz: 128, bottle_price: 41.57, oz_per_service: 4, cost_per_service: 1.3 };
const CROSSCHECK_PEST_LINE = { bottle_oz: 128, bottle_price: 30.9, oz_per_service: 4, cost_per_service: 0.97 };
const PEST_LINE_KEY = 'crosscheck_plus';
// The totals the known breakdown shapes carry, each of which holds the bifenthrin line (production: chemical + total; the admin
// seed: direct + fully allocated; the 2026-04-26 seed: total).
const PEST_TOTALS = ['chemical_cost_per_service', 'total_cost_per_service', 'direct_service_cost', 'fully_allocated_cost'];

const PRODUCT_WARNING = 'Bifenthrin repellent barrier (LESCO Crosscheck Plus, EPA 10404-120).';
const CROSSCHECK_PRESLAB = {
  label: 'Crosscheck Plus - Bifenthrin',
  catalog_product_name: CATALOG_NAME,
  package_label: '128 fl oz',
  positioning: 'standard_repellent',
  container_cost: 30.9,
  container_oz: 128,
  warnings: [
    PRODUCT_WARNING,
    'Use only when the Crosscheck Plus label supports pre-construction subterranean termite treatment.',
  ],
};
const CROSSCHECK_TRENCH = {
  label: 'Crosscheck Plus - Bifenthrin',
  positioning: 'standard_repellent',
  container_cost: 30.9,
  container_oz: 128,
  warnings: [
    PRODUCT_WARNING,
    'Do not attach long repair-and-retreat warranty without admin approval.',
  ],
};
// What production holds today (read-only read 2026-11-18); a product is rewritten only while it still holds these.
const TALAK_WARNING = 'Bifenthrin repellent barrier (Atticus Talak 7.9 F, EPA 91234-145).';
const TALAK_PRESLAB = {
  label: 'Talak 7.9 F - Bifenthrin',
  catalog_product_name: 'Atticus Talak 7.9 F',
  package_label: '96 fl oz',
  positioning: 'standard_repellent',
  container_cost: 41.57,
  container_oz: 96,
  warnings: [
    TALAK_WARNING,
    'Use only when the Talak 7.9 F label supports pre-construction subterranean termite treatment.',
  ],
};
const TALAK_TRENCH = {
  label: 'Talak 7.9 F - Bifenthrin',
  positioning: 'standard_repellent',
  container_cost: 41.57,
  container_oz: 96,
  warnings: [
    TALAK_WARNING,
    'Do not attach long repair-and-retreat warranty without admin approval.',
  ],
};
// The admin seed's Talak product (ensureTable, 2026-10-25 until this change), matched whole: no label, so db-bridge would put the
// code's Crosscheck label on the Talak cost.
const SEED_PRESLAB = { container_cost: 41.57, container_oz: 96, product_oz_per_10_sqft: 1, margin_divisor: 0.5294 };
const SEED_TRENCH = {
  container_cost: 41.57, container_oz: 96, product_oz_per_finished_gallon_at_standard_rate: 1, product_oz_per_finished_gallon_at_high_rate: 2,
};
const OPTION_KEYS = ['talstar_p', 'bifen_it'];
// Aliases db-bridge prefers over the snake_case keys written above.
const SHADOWING_ALIASES = ['catalogProductName', 'packageLabel', 'containerCost', 'containerOz', 'bottleCost', 'bottle_cost', 'bottleOz', 'bottle_oz'];

const PLANS = {
  onetime_preslab: { from: TALAK_PRESLAB, seed: SEED_PRESLAB, to: CROSSCHECK_PRESLAB },
  onetime_trenching: { from: TALAK_TRENCH, seed: SEED_TRENCH, to: CROSSCHECK_TRENCH },
};

const VENDOR_COLUMNS = ['previous_price', 'price', 'price_amount', 'landed_cost', 'price_per_oz', 'normalized_unit_price', 'landed_unit_price', 'last_checked_at'];
const CATALOG_COLUMNS = ['best_price', 'best_price_amount_cached', 'best_price_updated_at'];
// What a best-price recalculation rewrites on the catalog row (the stale mark's own columns aside): a vendor-only Step P keeps them
// as it saw them, so down() can tell no recalculation has read the corrected vendor row since.
const CATALOG_SEEN_COLUMNS = [...CATALOG_COLUMNS, 'best_vendor_pricing_id', 'unit_size_oz'];
const REQUIRED_VENDOR_COLUMNS = ['product_id', 'vendor_id', 'vendor_sku', 'is_active', 'approval_status', 'price', 'quantity'];
const REQUIRED_CATALOG_COLUMNS = ['name', 'active', 'best_price', 'unit_size_oz', 'best_vendor_pricing_id'];
// What recalcBestPriceLocked writes when it keeps a catalog price it cannot trust (routes/admin-inventory.js).
const STALE_MARK = { needs_pricing: true, best_price_status: 'stale' };

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const same = (a, b) => num(a) === num(b);
const norm = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v === undefined ? null : v;
};
const sameColumns = (row, expected) => Object.keys(expected).every((c) => norm(row[c]) === norm(expected[c]));
const pickColumns = (row, columns) => Object.fromEntries(columns.map((c) => [c, row[c] === undefined ? null : row[c]]));

async function existingColumns(knex, table, columns) {
  const kept = [];
  for (const column of columns) if (await knex.schema.hasColumn(table, column)) kept.push(column);
  return kept;
}
async function lockProduct(knex, productId) {
  await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productId)]);
}

// ── Step P: the catalog price ────────────────────────────────────────────────

const filled = (v) => v !== null && v !== undefined && v !== '';
// A shipping or tax amount on the row: the handler would fold it into the landed cost, and Step P writes the bare price.
const carries = (v) => filled(v) && Number(v) !== 0;

// The one vendor row Step P may correct: active, approved, unexpired (vendor-pricing-eligibility: expires_at null or later than
// now), at the stale price (price_amount too, when set: costing reads it first), the 1 gal pack priced per oz (the handler derives
// the unit cost from the row's own quantity), with no shipping or tax. Returns null when it is, else the reason it is not.
function vendorRowBlocker(row, now) {
  if (row.is_active !== true || row.approval_status !== 'approved' || !same(row.price, STALE_PRICE)
    || (filled(row.price_amount) && !same(row.price_amount, STALE_PRICE))) {
    return `the vendor row is not the active, approved $${STALE_PRICE} row (price ${row.price}, price_amount ${row.price_amount})`
      + ' - an admin changed it';
  }
  if (filled(row.expires_at) && !(new Date(row.expires_at).getTime() > now.getTime())) {
    return `the vendor row's quote expired (expires_at ${row.expires_at}) - enter the price in the app`;
  }
  if (String(row.quantity ?? '').trim().toLowerCase() !== STALE_QUANTITY || ('unit_normalized' in row && row.unit_normalized !== 'oz')) {
    return `the vendor row is not the ${STALE_QUANTITY} pack priced per oz (quantity ${row.quantity}, unit ${row.unit_normalized})`;
  }
  if (carries(row.shipping_cost) || carries(row.tax_rate)) {
    return `the vendor row carries shipping (${row.shipping_cost}) or tax (${row.tax_rate}) - enter the price in the app`;
  }
  return null;
}

// SiteOne by the vendor row's own vendors row (the app's SiteOne lookup reads the same name), not by the item number alone:
// another vendor can list the same number.
const SITEONE_NAME = 'siteone';
async function isSiteOneRow(knex, row) {
  if (row.vendor_sku !== STALE_SKU || !(await knex.schema.hasTable('vendors'))) return false;
  const vendor = await knex('vendors').where({ id: row.vendor_id }).first();
  return !!vendor && String(vendor.name || '').trim().toLowerCase() === SITEONE_NAME;
}

async function missingColumns(knex) {
  const missing = [
    ...(await existingColumns(knex, 'vendor_pricing', REQUIRED_VENDOR_COLUMNS)).length === REQUIRED_VENDOR_COLUMNS.length ? [] : ['vendor_pricing columns'],
    ...(await existingColumns(knex, 'products_catalog', REQUIRED_CATALOG_COLUMNS)).length === REQUIRED_CATALOG_COLUMNS.length ? [] : ['products_catalog columns'],
  ];
  return missing.length ? `a required ${missing.join(' and ')} is missing` : null;
}

// Returns null when Step P may write the vendor row AND the catalog best price, 'done' when the price is already right, or the
// reason it may not write the catalog best price.
async function catalogBlocker(knex, product, rows, now = new Date()) {
  if (rows.length === 1 && same(rows[0].price, NEW_PRICE)) return 'done';
  const missing = await missingColumns(knex);
  if (missing) return missing;
  if (product.active !== true) return 'the product is not active';
  if (rows.length !== 1 || !(await isSiteOneRow(knex, rows[0]))) return `it does not have exactly one vendor row, SiteOne's ${STALE_SKU}`;
  const row = rows[0];
  const rowBlocker = vendorRowBlocker(row, now);
  if (rowBlocker) return rowBlocker;
  if (product.best_vendor_pricing_id !== row.id) return 'the catalog best price is not backed by that vendor row';
  if (!same(product.best_price, STALE_PRICE) || !same(product.unit_size_oz, STALE_SIZE_OZ)) {
    return `the catalog best price is ${product.best_price} for ${product.unit_size_oz} oz, not ${STALE_PRICE} for ${STALE_SIZE_OZ}`;
  }
  return null;
}

async function insertPriceHistory(knex, productId, row) {
  if (!(await knex.schema.hasTable('price_history'))) return null;
  const inserted = await knex('price_history')
    .insert({ product_id: productId, vendor_id: row.vendor_id, price: STALE_PRICE, quantity: row.quantity, source: 'manual' })
    .returning('id');
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  return first && typeof first === 'object' ? first.id : first || null;
}

// The product's one SiteOne D00001542 row while it is still the stale entry (vendorRowBlocker), else null.
async function staleVendorRow(knex, rows, now) {
  const siteOne = [];
  for (const row of rows) if (await isSiteOneRow(knex, row)) siteOne.push(row);
  return siteOne.length === 1 && !vendorRowBlocker(siteOne[0], now) ? siteOne[0] : null;
}

// Mirrors PUT /:productId/pricing (existing row) + recalcBestPriceLocked for a manual $30.90 entry. True when it changed the rows.
// The vendor row is corrected whenever it is still the stale entry, so no later recalculation can make $58.42 the winner again. The
// catalog best price is written with it only when that row is the product's only vendor row and backs the best price; otherwise
// the recalculation's own winner rules would be needed, so the catalog waits for the next one (the stale mark covers it meanwhile).
// Each catalog row named LESCO Crosscheck Plus on its own: every check is about that product's own vendor rows and best price.
// Returns whether it priced anything, and the products whose SiteOne row it corrected without the catalog best price.
async function fixCatalogPrice(knex) {
  const outcome = { fixed: false, vendorOnly: [] };
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendor_pricing'))) return outcome;
  for (const { id } of await knex('products_catalog').where({ name: CATALOG_NAME })) {
    const step = await fixProductPrice(knex, id);
    if (step) outcome.fixed = true;
    if (step === 'vendor_only') outcome.vendorOnly.push(id);
  }
  return outcome;
}

async function fixProductPrice(knex, productId) {
  await lockProduct(knex, productId);
  const product = await knex('products_catalog').where({ id: productId }).forUpdate().first();
  const rows = await knex('vendor_pricing').where({ product_id: productId }).forUpdate();
  const now = new Date();
  const blocker = await catalogBlocker(knex, product, rows, now);
  if (blocker === 'done') return false;
  let row = rows[0];
  if (blocker) row = (await missingColumns(knex)) ? null : await staleVendorRow(knex, rows, now);
  if (blocker && !row) {
    console.warn(`${LOG} ${CATALOG_NAME} (${productId}) price left alone: ${blocker}`);
    return false;
  }
  if (blocker) {
    console.warn(`${LOG} ${CATALOG_NAME} (${productId}) catalog best price left alone: ${blocker}. The stale SiteOne row itself is corrected, so the next `
      + 'price recalculation picks the winner from current prices.');
  }
  const vendorColumns = await existingColumns(knex, 'vendor_pricing', VENDOR_COLUMNS);
  const catalogColumns = blocker ? [] : await existingColumns(knex, 'products_catalog', CATALOG_COLUMNS);
  const vendorPatch = pickColumns({
    previous_price: STALE_PRICE, price: NEW_PRICE, price_amount: NEW_PRICE, landed_cost: NEW_PRICE,
    price_per_oz: NEW_PER_OZ, normalized_unit_price: NEW_PER_OZ, landed_unit_price: NEW_PER_OZ, last_checked_at: now,
  }, vendorColumns);
  const catalogPatch = pickColumns({ best_price: NEW_PRICE, best_price_amount_cached: NEW_PRICE, best_price_updated_at: now }, catalogColumns);
  const before = {
    vendor_pricing: pickColumns(row, vendorColumns),
    ...(blocker
      ? { catalog_seen: pickColumns(product, await existingColumns(knex, 'products_catalog', CATALOG_SEEN_COLUMNS)) }
      : { products_catalog: pickColumns(product, catalogColumns) }),
  };

  await knex('vendor_pricing').where({ id: row.id }).update(vendorPatch);
  if (!blocker) await knex('products_catalog').where({ id: productId }).update(catalogPatch);
  const historyId = await insertPriceHistory(knex, productId, row);

  const writtenVendor = await knex('vendor_pricing').where({ id: row.id }).first();
  const written = { vendor_pricing: pickColumns(writtenVendor, vendorColumns) };
  if (!blocker) written.products_catalog = pickColumns(await knex('products_catalog').where({ id: productId }).first(), catalogColumns);
  await knex('pricing_config_audit').insert({
    config_key: CATALOG_AUDIT_KEY,
    old_value: JSON.stringify({ product_id: productId, vendor_pricing_id: row.id, price_history_id: historyId, ...before }),
    new_value: JSON.stringify(written),
    changed_by: TAG,
    reason: CATALOG_REASON,
  });
  console.info(`${LOG} ${CATALOG_NAME}: SiteOne price ${STALE_PRICE} -> ${NEW_PRICE} per ${STALE_SIZE_OZ} oz `
    + `(${blocker ? 'the catalog best price waits for the next recalculation' : 'catalog best price follows'})`);
  return blocker ? 'vendor_only' : true;
}

const holdsStalePrice = (row) => same(row.best_price, STALE_PRICE) && same(row.unit_size_oz, STALE_SIZE_OZ);

// The stale mark (see the header) on each catalog row named LESCO Crosscheck Plus that still holds the stale price for 128 oz after
// Step P (it had to leave the rows: a second vendor row, an edited, expired or inactive row, another pack, shipping or tax), and on
// each row whose SiteOne row Step P corrected without its best price (vendorOnly: the winner may have changed), active or not, so it
// cannot come back with an inactive row. Each entry keeps the prices it saw. Returns the ids it marked.
async function markStaleCatalogRows(knex, vendorOnly = []) {
  if (!(await knex.schema.hasTable('products_catalog'))) return [];
  const columns = await existingColumns(knex, 'products_catalog', Object.keys(STALE_MARK));
  if (!columns.includes('needs_pricing')) return [];
  const seenColumns = await existingColumns(knex, 'products_catalog', CATALOG_SEEN_COLUMNS);
  const mark = pickColumns(STALE_MARK, columns);
  const before = [];
  const reasons = new Set();
  for (const { id } of await knex('products_catalog').where({ name: CATALOG_NAME })) {
    await lockProduct(knex, id);
    const row = await knex('products_catalog').where({ id }).forUpdate().first();
    const reason = row && (holdsStalePrice(row) ? 'stale' : (vendorOnly.includes(id) ? 'winner' : null));
    if (!reason || sameColumns(row, mark)) continue;
    before.push({ id, ...pickColumns(row, columns), seen: pickColumns(row, seenColumns) });
    reasons.add(reason);
    await knex('products_catalog').where({ id }).update(mark);
  }
  if (!before.length) return [];
  await knex('pricing_config_audit').insert({
    config_key: STALE_AUDIT_KEY,
    old_value: JSON.stringify(before),
    new_value: JSON.stringify(mark),
    changed_by: TAG,
    reason: STALE_REASON,
  });
  if (reasons.has('stale')) {
    console.warn(`${LOG} ${CATALOG_NAME}: the catalog price is still the stale $${STALE_PRICE.toFixed(2)}, which the pre-slab and `
      + `mosquito catalog links would take over $${NEW_PRICE.toFixed(2)}, so the catalog row is marked needs pricing (stale) and quotes `
      + `use $${NEW_PRICE.toFixed(2)} until a price is entered. Enter $${NEW_PRICE.toFixed(2)} for ${CATALOG_NAME} in Inventory.`);
  }
  if (reasons.has('winner')) {
    console.warn(`${LOG} ${CATALOG_NAME}: the corrected SiteOne row may now be the cheapest, and the catalog best price did not `
      + `follow it, so the catalog row is marked needs pricing (stale) and quotes use $${NEW_PRICE.toFixed(2)} until a recalculation `
      + `picks the winner. Enter $${NEW_PRICE.toFixed(2)} for ${CATALOG_NAME} in Inventory.`);
  }
  return before.map((row) => row.id);
}

// Lifts the stale mark from each row up() marked that still holds the mark and the prices up() saw; a row priced since is left alone.
async function restoreStaleMarks(knex) {
  const own = await knex('pricing_config_audit').where({ config_key: STALE_AUDIT_KEY, changed_by: TAG }).first('old_value', 'new_value');
  if (!own || !(await knex.schema.hasTable('products_catalog'))) return;
  const before = parse(own.old_value);
  const mark = parse(own.new_value);
  if (!Array.isArray(before) || !mark) return;
  for (const { id, seen, ...columns } of before) {
    await lockProduct(knex, id);
    const row = await knex('products_catalog').where({ id }).forUpdate().first();
    if (!row || !seen || !sameColumns(row, seen) || !sameColumns(row, mark)) {
      console.warn(`${LOG} down: the ${CATALOG_NAME} catalog row ${id} changed since this migration - leaving its mark alone`);
      continue;
    }
    await knex('products_catalog').where({ id }).update(columns);
  }
}

async function restoreCatalogPrice(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendor_pricing'))) return;
  for (const own of await knex('pricing_config_audit').where({ config_key: CATALOG_AUDIT_KEY, changed_by: TAG })) {
    await restoreProductPrice(knex, parse(own.old_value), parse(own.new_value));
  }
}

async function restoreProductPrice(knex, before, written) {
  if (!before || !written || !before.vendor_pricing || !written.vendor_pricing) return;
  await lockProduct(knex, before.product_id);
  const product = await knex('products_catalog').where({ id: before.product_id }).forUpdate().first();
  const row = await knex('vendor_pricing').where({ id: before.vendor_pricing_id }).forUpdate().first();
  // With the catalog written, it must still hold what up() wrote; without, exactly what up() saw (a recalculation since, which
  // read the corrected vendor row, rewrites the best price and its time).
  const catalogKept = before.products_catalog && written.products_catalog
    ? product && sameColumns(product, written.products_catalog)
    : product && before.catalog_seen && sameColumns(product, before.catalog_seen);
  if (!row || !catalogKept || !sameColumns(row, written.vendor_pricing)) {
    console.warn(`${LOG} down: the ${CATALOG_NAME} price changed since this migration - leaving it alone`);
    return;
  }
  await knex('vendor_pricing').where({ id: row.id }).update(before.vendor_pricing);
  if (before.products_catalog) await knex('products_catalog').where({ id: product.id }).update(before.products_catalog);
  if (before.price_history_id && await knex.schema.hasTable('price_history')) {
    await knex('price_history').where({ id: before.price_history_id }).del();
  }
}

// ── pricing_config rows ──────────────────────────────────────────────────────

const holds = (product, values) => Object.entries(values).every(([k, v]) => isDeepStrictEqual(product[k], v))
  && SHADOWING_ALIASES.every((alias) => product[alias] === undefined);
const isTalak = (product, plan) => holds(product, plan.from) || isDeepStrictEqual(product, plan.seed);

function toCrosscheck(product, values) {
  const next = { ...product };
  for (const alias of SHADOWING_ALIASES) delete next[alias];
  return { ...next, ...values };
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// The places db-bridge's overlays read a product from: (products || product_costs)[key], then the row's own key (null).
const PRODUCT_PLACES = ['products', 'product_costs', null];
const placeIn = (data, place) => (place === null ? data : isObject(data[place]) ? data[place] : null);
const placeName = (place, key) => (place === null ? key : `${place}.${key}`);
const bridgeReads = (data, key) => (data.products || data.product_costs || {})[key] || data[key];

// Rewrites the Talak products of one row, in every place the bridge reads one from; returns the new data, or null when nothing
// changed.
function rewriteRow(configKey, data, plan) {
  const next = { ...data };
  let changed = false;
  for (const place of PRODUCT_PLACES) {
    const source = placeIn(data, place);
    if (!source) continue;
    const target = place === null ? next : { ...source };
    for (const key of OPTION_KEYS) {
      const product = source[key];
      if (!isObject(product) || holds(product, plan.to)) continue; // none here, or already Crosscheck (a re-run): not ours
      if (!isTalak(product, plan)) {
        console.warn(`${LOG} ${configKey}.${placeName(place, key)} was edited since the Talak swap - leaving the admin's values alone`);
        continue;
      }
      target[key] = toCrosscheck(product, plan.to);
      changed = true;
    }
    if (place !== null) next[place] = target;
  }
  for (const key of OPTION_KEYS) {
    if (!isObject(bridgeReads(data, key))) {
      console.warn(`${LOG} ${configKey} has no ${key} product - the code default (Crosscheck Plus) applies; leaving it alone`);
    }
  }
  return changed ? next : null;
}

// Returns the config keys it wrote.
async function rewriteConfigRows(knex) {
  const rewritten = [];
  for (const [key, plan] of Object.entries(PLANS)) {
    const row = await knex('pricing_config').where({ config_key: key }).forUpdate().first('data');
    const data = row && parse(row.data);
    if (!isObject(data)) continue;
    const next = rewriteRow(key, data, plan);
    if (!next) continue;
    await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
    await knex('pricing_config_audit').insert({
      config_key: key,
      old_value: JSON.stringify(data),
      new_value: JSON.stringify(next),
      changed_by: TAG,
      reason: REASON,
    });
    rewritten.push(key);
  }
  return rewritten;
}

async function restoreConfigRows(knex) {
  for (const key of Object.keys(PLANS)) {
    const own = await knex('pricing_config_audit').where({ config_key: key, changed_by: TAG }).first('old_value', 'new_value');
    if (!own) continue;
    const before = parse(own.old_value);
    const written = parse(own.new_value);
    const row = await knex('pricing_config').where({ config_key: key }).forUpdate().first('data');
    const current = row && parse(row.data);
    if (!isObject(current) || !isObject(before) || !isObject(written)) continue;
    const next = { ...current };
    let restored = false;
    for (const place of PRODUCT_PLACES) {
      const was = placeIn(before, place);
      const wrote = placeIn(written, place);
      if (!was || !wrote) continue;
      const now = placeIn(current, place);
      const target = place === null ? next : now && { ...now };
      for (const option of OPTION_KEYS) {
        if (isDeepStrictEqual(was[option], wrote[option])) continue; // up() did not change this one
        if (target && isDeepStrictEqual(now[option], wrote[option])) {
          target[option] = was[option];
          restored = true;
        } else {
          console.warn(`${LOG} down: ${key}.${placeName(place, option)} changed since this migration - leaving it alone`);
        }
      }
      if (place !== null && target) next[place] = target;
    }
    if (!restored) continue; // nothing restored: leave the row (and its updated_at) alone
    await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
  }
}

// ── pest_service_costs (display) ─────────────────────────────────────────────

// The breakdown with its Talak line replaced in place and each known total moved by the same amount; null when the line does not
// hold the Talak values (an admin's edit, or already moved).
function pestCostsRewrite(data) {
  const chemicals = data && data.chemicals;
  if (!chemicals || typeof chemicals !== 'object' || PEST_LINE_KEY in chemicals || !isDeepStrictEqual(chemicals.talak, TALAK_PEST_LINE)) {
    return null;
  }
  const delta = CROSSCHECK_PEST_LINE.cost_per_service - TALAK_PEST_LINE.cost_per_service;
  const next = {
    ...data,
    chemicals: Object.fromEntries(Object.entries(chemicals).map(([k, v]) => (k === 'talak' ? [PEST_LINE_KEY, CROSSCHECK_PEST_LINE] : [k, v]))),
  };
  for (const field of PEST_TOTALS) {
    if (typeof data[field] === 'number') next[field] = Math.round((data[field] + delta) * 100) / 100;
  }
  return next;
}

async function rewritePestCosts(knex) {
  const row = await knex('pricing_config').where({ config_key: PEST_COSTS_KEY }).forUpdate().first('data');
  const data = row && parse(row.data);
  const next = pestCostsRewrite(data);
  if (!next) {
    if (data && data.chemicals && data.chemicals.talak) console.warn(`${LOG} ${PEST_COSTS_KEY}.chemicals.talak was edited - leaving it alone`);
    return false;
  }
  await knex('pricing_config').where({ config_key: PEST_COSTS_KEY }).update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
  await knex('pricing_config_audit').insert({
    config_key: PEST_COSTS_KEY,
    old_value: JSON.stringify(data),
    new_value: JSON.stringify(next),
    changed_by: TAG,
    reason: REASON,
  });
  return true;
}

async function restorePestCosts(knex) {
  const own = await knex('pricing_config_audit').where({ config_key: PEST_COSTS_KEY, changed_by: TAG }).first('old_value', 'new_value');
  if (!own) return;
  const before = parse(own.old_value);
  const row = await knex('pricing_config').where({ config_key: PEST_COSTS_KEY }).forUpdate().first('data');
  const current = row && parse(row.data);
  if (!before || !current || !isDeepStrictEqual(current, parse(own.new_value))) {
    console.warn(`${LOG} down: ${PEST_COSTS_KEY} changed since this migration - leaving it alone`);
    return;
  }
  await knex('pricing_config').where({ config_key: PEST_COSTS_KEY }).update({ data: JSON.stringify(before), updated_at: knex.fn.now() });
}

exports.TAG = TAG;
exports.CHANGELOG = CHANGELOG;
exports.CROSSCHECK_PRESLAB = CROSSCHECK_PRESLAB;
exports.CROSSCHECK_TRENCH = CROSSCHECK_TRENCH;
exports.TALAK_PRESLAB = TALAK_PRESLAB;
exports.TALAK_TRENCH = TALAK_TRENCH;
exports.REASON = REASON;
exports.CATALOG_REASON = CATALOG_REASON;
exports.CATALOG_AUDIT_KEY = CATALOG_AUDIT_KEY;
exports.NEW_PRICE = NEW_PRICE;
exports.STALE_AUDIT_KEY = STALE_AUDIT_KEY;
exports.STALE_REASON = STALE_REASON;
exports.TALAK_PEST_LINE = TALAK_PEST_LINE;
exports.CROSSCHECK_PEST_LINE = CROSSCHECK_PEST_LINE;

function changelogAfter(rewritten, marked) {
  if (!rewritten.includes('onetime_preslab')) {
    return 'LESCO Crosscheck Plus: 128 fl oz at $30.90; the pre-slab products did not move (see the deploy log)';
  }
  return marked
    ? `LESCO Crosscheck Plus: 128 fl oz at $30.90; the ${CATALOG_NAME} catalog row is marked needs pricing (stale), so quotes use $30.90 until the price is entered in Inventory (see the deploy log)`
    : 'LESCO Crosscheck Plus: 128 fl oz at $30.90 (pre-slab links to the Crosscheck Plus catalog row)';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) {
    console.warn(`${LOG} no pricing_config_audit table - nothing rewritten (down() could not find its writes)`);
    return;
  }
  const { fixed: priceFixed, vendorOnly } = await fixCatalogPrice(knex);
  const marked = await markStaleCatalogRows(knex, vendorOnly);
  const hasConfig = await knex.schema.hasTable('pricing_config');
  const rewritten = hasConfig ? await rewriteConfigRows(knex) : [];
  const pestMoved = hasConfig ? await rewritePestCosts(knex) : false;
  if ((rewritten.length || priceFixed || marked.length || pestMoved) && await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['pre_slab_termiticide', 'trenching', 'mosquito', 'pest_control']),
      before_value: JSON.stringify({ bifenthrin: 'Atticus Talak 7.9 F: 96 fl oz at $41.57; LESCO Crosscheck Plus catalog price $58.42 per 1 gal (stale)' }),
      after_value: JSON.stringify({ bifenthrin: changelogAfter(rewritten, marked.length > 0) }),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await restoreCatalogPrice(knex);
  await restoreStaleMarks(knex);
  if (await knex.schema.hasTable('pricing_config')) {
    await restoreConfigRows(knex);
    await restorePestCosts(knex);
  }
  await knex('pricing_config_audit').where({ changed_by: TAG }).del();
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
