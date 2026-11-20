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
 * Sent quotes: a replay keeps the slab container cost or trench product surcharge a stored row priced with (the pins in
 * services/estimate-tree-shrub-knob-replay). An estimate that kept only its engine inputs has no stored row, so it prices the new
 * bottle, as every replay pin does without its row. On 2026-11-19 no open sent or viewed estimate held a slab or trench service.
 *
 * Step P (first, same transaction): production holds a stale SiteOne price for LESCO Crosscheck Plus ($58.42 per 1 gal, entered
 * 2026-09-30; the owner pays $30.90). db-bridge's pre-slab link takes a catalog price within [0.5x, 2x] of the config, and 58.42 is
 * 1.89x of 30.90, so a pre-slab link to that row unfixed would RAISE slab quotes. For each catalog row named LESCO Crosscheck Plus,
 * Step P does what the inventory price handler does for a manual $30.90 entry with no shipping or tax on the product's SiteOne
 * row (item D00001542 AND its vendors row named SiteOne: another vendor can list the same number): PUT /:productId/pricing writes
 * the vendor row (previous price, price, price_amount, landed cost, per-oz figures, last_checked_at) and a price_history row
 * holding the OLD price, records the new price as the row's price evidence (a price_snapshots row linked as its
 * latest_snapshot_id; the handler writes that after its transaction, best effort, and Step P only where the table and the link
 * column exist), then runs its own best-price recalculation in the same transaction (recalcBestPrice from
 * routes/admin-inventory, as migrations 20260907000020 and 20260928060000 do; it takes the same product lock, held here already).
 * The recalculation picks the winner from current prices and writes the catalog best price, its flags and its status, a stale or
 * needs-pricing mark included: the pre-slab and mosquito links read only an unmarked row, and job costing reads best_price
 * directly (calculateInventoryCost), so the catalog must not keep $58.42 or a mark. Step P acts only while the SiteOne row still
 * looks exactly as read on 2026-11-18, its price_amount (what costing reads first), its own pack (1 gal, priced per oz: the handler
 * derives the unit cost from it), an open quote (no expires_at passed: the inventory price rules skip an expired row) and its landed
 * and per-oz figures (the stale price's own: the price sync can store freight in landed_unit_price) included; a row that differs
 * (an edit, shipping or tax: its landed cost would need them) is left alone with a warning.
 * server/data/pricing.csv, the sheet the admin pricing import reads first, lists the same gallon at $30.90, so a re-import keeps it.
 *
 * Stale quotes (pre-push audits 24 and 25), when Step P must leave the price: the 1.89x stale price sits inside the links'
 * [0.5x, 2x] band, so a quote still offering it RAISES slab quotes whenever the inventory recalculation picks it, a later one
 * included (an admin's price entry for another vendor runs it). A mark on the catalog row cannot hold: the next recalculation
 * clears it. So each SiteOne D00001542 quote of the product (the stale entry's own vendor and item number) that is eligible
 * (vendor-pricing-eligibility, the predicate every recalculation and auto-order reads: active, approved or auto-approved,
 * unexpired, positive) and that the recalculation would read as $58.42 a gallon (routes/admin-inventory vendorRowPricePerOz: the
 * authoritative price over its own pack, else its stored per-oz figure; with neither, its raw price) gets expires_at = now.
 * Another vendor's quote, another item number or another pack price is an independent offer and stays: the catalog follows it
 * (owner 2026-07-10). The inventory recalculation then runs at once: the catalog holds the winner of the current quotes, scaled to
 * its own package size, or none (best_price null, needs_pricing, 'no_valid_price'). When no current quote can be scaled to the
 * catalog, the recalculation keeps the catalog price, marked stale, and job costing reads best_price as it stands
 * (calculateInventoryCost); a catalog it leaves on the stale price that way gets the recalculation's own no-price state instead.
 * The pre-slab and mosquito links read only a priced row backed by an eligible quote, inside their band, so quotes keep the
 * config's or code's 30.90 / 128 for every config shape, and job and service-usage costing follow the catalog. A catalog row that
 * still holds the stale price at its package size with no such quote (a price written without a recalculation, a SiteOne row
 * already at $30.90 included) gets the recalculation alone, and the no-price state if it keeps the stale price: no vendor write,
 * no price history. Entering the price in Inventory (PUT /:productId/pricing) re-approves the quote with no expiry and
 * recalculates; until then a SiteOne auto-order for the product parks as no_price. The deploy log says how to finish. The config
 * rows move either way. With a required inventory column missing (earlier migrations add each one, and the app's own
 * recalculation reads them), inventory is left alone with a warning.
 *
 * pest_service_costs (the admin Pricing Logic panel's Pest Service Cost Breakdown; display only, pestVisitCostModel prices the
 * visit): its Talak line, 4 fl oz a visit at 41.57 / 128, becomes Crosscheck Plus at the engine's 0.97 (4 fl oz at 30.90 / 128) in
 * the same place, and each total that held the Talak line moves by the same 0.33. Only while that line holds the Talak values.
 *
 * db-bridge reads `catalogProductName ?? catalog_product_name`, `containerCost ?? container_cost ?? bottleCost ?? bottle_cost`, and so
 * on, so a camelCase or bottle alias would win over the snake_case value written here: the rewrite drops those aliases.
 *
 * Ownership: up() writes one pricing_config_audit row (changed_by TAG) for each pricing_config row it rewrote, one for each product
 * Step P priced, one for each product whose stale quotes it expired or whose stale catalog price it cleared, and one
 * pricing_changelog row when it changed anything; with no pricing_config_audit table it writes nothing (down() could not find its
 * writes). down() restores a product only when this migration's audit row for its row exists AND the product still deep-equals
 * what up() wrote (an admin edit since then is kept); it restores the catalog price only when its audit row exists AND the vendor
 * row still holds exactly what up() wrote, and it restores a stale quote's expiry only while the quote still holds exactly what
 * up() wrote; after either it runs the recalculation again, so the catalog follows the restored rows (a mark up()'s recalculation
 * cleared comes back when the winner up() saw returns); with neither, it puts back a catalog price up() cleared only while the
 * catalog still holds exactly what up() wrote; it restores the pest breakdown only when its audit row exists AND the row still
 * deep-equals what up() wrote; then it deletes this migration's price_history and price_snapshots rows (a restored vendor row
 * links its earlier snapshot again), audit rows and changelog row.
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
const STALE_REASON = 'Owner 2026-11-18: the owner pays $30.90 for LESCO Crosscheck Plus (1 gal); a SiteOne quote still offered the stale $58.42, or the catalog kept it, where the inventory recalculation and the engine catalog links would take it. Expired or cleared until the price is entered.';

const CATALOG_NAME = 'LESCO Crosscheck Plus';
const STALE_SKU = 'D00001542';
const STALE_PRICE = 58.42;
const STALE_SIZE_OZ = 128;
const STALE_QUANTITY = '1 gal';
const NEW_PRICE = 30.9;
const NEW_PER_OZ = Math.round((NEW_PRICE / STALE_SIZE_OZ) * 10000) / 10000; // 0.2414, rounded as the price handler does
const STALE_PER_OZ = Math.round((STALE_PRICE / STALE_SIZE_OZ) * 10000) / 10000; // 0.4564

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

const VENDOR_COLUMNS = ['previous_price', 'price', 'price_amount', 'landed_cost', 'price_per_oz', 'normalized_unit_price', 'landed_unit_price', 'last_checked_at',
  'latest_snapshot_id'];
// The handler's price_snapshots fields for a manual entry with no URL, branch, availability or confidence entered (its defaults:
// confidence 0.80, source confidence 0.75, availability unknown). Its expiry is the one the vendor row keeps (pre-push audit 21).
const SNAPSHOT_COLUMNS = ['product_id', 'vendor_id', 'vendor_pricing_id', 'price', 'price_amount', 'quantity', 'uom', 'normalized_unit_price',
  'normalized_unit', 'landed_unit_price', 'availability_status', 'fetched_at', 'captured_at', 'expires_at', 'source_type', 'price_type',
  'confidence_score', 'source_confidence', 'price_confidence', 'metadata'];
// The catalog prices a recalculation rewrites.
const CATALOG_SEEN_COLUMNS = ['best_price', 'best_price_amount_cached', 'best_price_updated_at', 'best_vendor', 'best_vendor_pricing_id',
  'best_price_vendor_id_cached', 'unit_size_oz'];
// The catalog's winner, which down() compares to what up() saw before it restores a mark up()'s recalculation cleared.
const WINNER_COLUMNS = ['best_price', 'best_price_amount_cached', 'best_vendor_pricing_id', 'unit_size_oz'];
const REQUIRED_VENDOR_COLUMNS = ['product_id', 'vendor_id', 'vendor_sku', 'is_active', 'approval_status', 'price', 'quantity', 'expires_at'];
const REQUIRED_CATALOG_COLUMNS = ['name', 'best_price', 'unit_size_oz', 'best_vendor_pricing_id'];
// The mark recalcBestPriceLocked writes on a catalog price it cannot trust or cannot find (routes/admin-inventory.js).
const MARK_COLUMNS = ['needs_pricing', 'best_price_status'];
// The audit entries' catalog row before and after the recalculation.
const CATALOG_AUDIT_COLUMNS = [...CATALOG_SEEN_COLUMNS, ...MARK_COLUMNS];
// What recalcBestPriceLocked writes when no eligible quote remains (routes/admin-inventory.js): the catalog has no price.
const NO_PRICE = {
  best_price: null, best_vendor: null, best_vendor_pricing_id: null, best_price_amount_cached: null, best_price_vendor_id_cached: null,
  best_price_status: 'no_valid_price', needs_pricing: true,
};
// A stale quote's audit entry: its price figures and pack (so down() can tell no price was entered since) and its expiry.
const QUOTE_COLUMNS = ['price', 'price_amount', 'quantity', 'landed_cost', 'price_per_oz', 'normalized_unit_price', 'landed_unit_price',
  'is_active', 'approval_status', 'expires_at'];

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
// The landed and per-oz figures of the stale entry itself. A row holding others (the price sync can store freight in
// landed_unit_price with no shipping column) has a cost Step P cannot see, so it is left alone.
const STALE_FIGURES = { landed_cost: STALE_PRICE, landed_unit_price: STALE_PER_OZ, price_per_oz: STALE_PER_OZ, normalized_unit_price: STALE_PER_OZ };

// The SiteOne row Step P may correct: active, approved, unexpired (vendor-pricing-eligibility: expires_at null or later than now),
// at the stale price (price_amount too, when set: costing reads it first), the 1 gal pack priced per oz (the handler derives the
// unit cost from the row's own quantity), with no shipping or tax and the stale entry's own landed and per-oz figures. Returns null
// when it is, else the reason it is not.
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
  if (carries(row.shipping_cost) || carries(row.shipping_estimate) || carries(row.tax_rate)) {
    return `the vendor row carries shipping (${row.shipping_cost ?? row.shipping_estimate}) or tax (${row.tax_rate}) - enter the price in the app`;
  }
  const changed = Object.keys(STALE_FIGURES).filter((column) => filled(row[column]) && !same(row[column], STALE_FIGURES[column]));
  if (changed.length) return `the vendor row's ${changed.join(', ')} differ from the $${STALE_PRICE} entry's own - enter the price in the app`;
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

async function insertPriceHistory(knex, productId, row) {
  if (!(await knex.schema.hasTable('price_history'))) return null;
  const inserted = await knex('price_history')
    .insert({ product_id: productId, vendor_id: row.vendor_id, price: STALE_PRICE, quantity: row.quantity, source: 'manual' })
    .returning('id');
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  return first && typeof first === 'object' ? first.id : first || null;
}

// The handler's price evidence for the new price (see the header): a price_snapshots row, linked as the row's latest_snapshot_id.
// Only where the table and the link column exist (older installs have neither; the handler skips them the same way). Returns its id.
async function insertPriceSnapshot(knex, productId, row, now) {
  if (!(await knex.schema.hasTable('price_snapshots'))) return null;
  if (!(await existingColumns(knex, 'vendor_pricing', ['latest_snapshot_id'])).length) return null;
  const columns = await existingColumns(knex, 'price_snapshots', SNAPSHOT_COLUMNS);
  const inserted = await knex('price_snapshots').insert(pickColumns({
    product_id: productId, vendor_id: row.vendor_id, vendor_pricing_id: row.id, price: NEW_PRICE, price_amount: NEW_PRICE,
    quantity: row.quantity, uom: row.unit ?? null, normalized_unit_price: NEW_PER_OZ, normalized_unit: 'oz', landed_unit_price: NEW_PER_OZ,
    availability_status: 'unknown', fetched_at: now, captured_at: now, expires_at: row.expires_at ?? null, source_type: 'manual',
    price_type: 'manual', confidence_score: 0.8,
    source_confidence: 0.75, price_confidence: 0.8, metadata: JSON.stringify({ source: TAG }),
  }, columns)).returning('id');
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  const snapshotId = first && typeof first === 'object' ? first.id : first || null;
  if (snapshotId) await knex('vendor_pricing').where({ id: row.id }).update({ latest_snapshot_id: snapshotId });
  return snapshotId;
}

// Mirrors PUT /:productId/pricing on the existing SiteOne row for a manual $30.90 entry: the vendor row, its price_history row, then
// the handler's own recalculation (see the header). Each catalog row named LESCO Crosscheck Plus on its own: every check is about
// that product's own vendor rows. Returns what moved, one entry for each product that changed: 'priced' (Step P), 'expired' (stale
// quotes expired, then the recalculation), 'cleared' (the recalculation alone kept the stale price, now cleared) or 'recalculated'
// (the recalculation alone).
async function fixCatalogPrice(knex) {
  const moved = [];
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendor_pricing'))) return moved;
  for (const { id } of await knex('products_catalog').where({ name: CATALOG_NAME })) {
    const outcome = await fixProductPrice(knex, id);
    if (outcome) moved.push(outcome);
  }
  return moved;
}

async function fixProductPrice(knex, productId) {
  await lockProduct(knex, productId);
  const missing = await missingColumns(knex);
  if (missing) {
    console.warn(`${LOG} ${CATALOG_NAME} (${productId}) price left alone: ${missing}`);
    return null;
  }
  const product = await knex('products_catalog').where({ id: productId }).forUpdate().first();
  if (!product) return null;
  const rows = await knex('vendor_pricing').where({ product_id: productId }).forUpdate();
  const now = new Date();
  const siteOne = [];
  for (const quote of rows) if (await isSiteOneRow(knex, quote)) siteOne.push(quote);
  const row = correctableRow(productId, siteOne, now);
  const stale = await staleQuotes(knex, productId, siteOne.filter((quote) => quote !== row), now);
  if (!row && !stale.length && !holdsStalePrice(product)) return null;

  const catalogColumns = await existingColumns(knex, 'products_catalog', CATALOG_AUDIT_COLUMNS);
  const vendorColumns = await existingColumns(knex, 'vendor_pricing', VENDOR_COLUMNS);
  const before = { product_id: productId, catalog_seen: pickColumns(product, catalogColumns) };
  if (row) Object.assign(before, await writeNewPrice(knex, productId, row, now, vendorColumns));
  const expired = await expireQuotes(knex, stale, now);
  before.stale_quotes = expired.before;
  await recalcBestPrice(knex, productId);
  const cleared = await clearStalePrice(knex, productId, now);

  const catalogRecalculated = pickColumns(await knex('products_catalog').where({ id: productId }).first(), catalogColumns);
  const best = catalogRecalculated.best_price ?? 'none (needs pricing)';
  if (!row && !stale.length && !cleared) {
    console.info(`${LOG} ${CATALOG_NAME} (${productId}): the catalog still held the stale $${STALE_PRICE.toFixed(2)} with no quote `
      + `offering it; the inventory recalculation set the catalog best price to ${best}`);
    return 'recalculated';
  }
  const written = { catalog_recalculated: catalogRecalculated, stale_quotes: expired.written, catalog_cleared: cleared };
  if (row) written.vendor_pricing = pickColumns(await knex('vendor_pricing').where({ id: row.id }).first(), vendorColumns);
  const [configKey, reason] = row ? [CATALOG_AUDIT_KEY, CATALOG_REASON] : [STALE_AUDIT_KEY, STALE_REASON];
  await knex('pricing_config_audit').insert({
    config_key: configKey, old_value: JSON.stringify(before), new_value: JSON.stringify(written), changed_by: TAG, reason,
  });
  warnPrice(productId, { row, stale, cleared, best });
  return row ? 'priced' : stale.length ? 'expired' : 'cleared';
}

// The SiteOne row Step P corrects, or null with the reason logged. A SiteOne row already at $30.90 (a re-run, or the price entered
// before this deploy) is the correction itself: no warning.
function correctableRow(productId, siteOne, now) {
  const blocker = siteOne.length === 1 ? vendorRowBlocker(siteOne[0], now) : `it does not have exactly one SiteOne ${STALE_SKU} vendor row`;
  if (!blocker) return siteOne[0];
  if (!(siteOne.length === 1 && readsNewPrice(siteOne[0]))) console.warn(`${LOG} ${CATALOG_NAME} (${productId}) price left alone: ${blocker}`);
  return null;
}

// The stale entry Step P had to leave (see the header): each eligible SiteOne D00001542 quote it did not correct that the inventory
// recalculation would read as $58.42 a gallon. Eligible by the shared predicate itself, and read by the recalculation's own per-oz
// price for a quote.
async function staleQuotes(knex, productId, siteOne, now) {
  if (!siteOne.length) return [];
  const { eligibleVendorPricing } = require('../../services/vendor-pricing-eligibility');
  const eligible = new Set((await eligibleVendorPricing(knex('vendor_pricing').where({ product_id: productId }), now)).map((quote) => quote.id));
  const { vendorRowPricePerOz } = inventory();
  return siteOne.filter((quote) => {
    const perOz = vendorRowPricePerOz(quote);
    const gallon = perOz != null ? perOz * STALE_SIZE_OZ : num(filled(quote.price_amount) ? quote.price_amount : quote.price);
    return eligible.has(quote.id) && Math.round(gallon * 100) / 100 === STALE_PRICE;
  });
}

// The recalculation keeps the catalog price, marked stale, when no current quote can be scaled to the catalog (recalcBestPriceLocked),
// and job costing reads best_price as it stands (calculateInventoryCost). So a catalog it left on the stale price unconfirmed gets
// the recalculation's own no-price state (pre-push audit 25). A stale-sized price it wrote as current is an independent offer's own
// price, and stays. True when it cleared one.
async function clearStalePrice(knex, productId, now) {
  const catalog = await knex('products_catalog').where({ id: productId }).first();
  if (!catalog || catalog.best_price_status === 'current' || !holdsStalePrice(catalog)) return false;
  const fields = { ...NO_PRICE, best_price_updated_at: now };
  await knex('products_catalog').where({ id: productId }).update(pickColumns(fields, await existingColumns(knex, 'products_catalog', Object.keys(fields))));
  return true;
}

// Step P's vendor write (see the header): the price fields, the price_history row and the price evidence. Returns what down() needs.
async function writeNewPrice(knex, productId, row, now, vendorColumns) {
  const priceFields = {
    previous_price: STALE_PRICE, price: NEW_PRICE, price_amount: NEW_PRICE, landed_cost: NEW_PRICE,
    price_per_oz: NEW_PER_OZ, normalized_unit_price: NEW_PER_OZ, landed_unit_price: NEW_PER_OZ, last_checked_at: now,
  };
  const before = { vendor_pricing_id: row.id, vendor_pricing: pickColumns(row, vendorColumns) };
  // Only the price fields: the snapshot link is written with its snapshot (insertPriceSnapshot), never nulled here.
  await knex('vendor_pricing').where({ id: row.id }).update(pickColumns(priceFields, vendorColumns.filter((column) => column in priceFields)));
  before.price_history_id = await insertPriceHistory(knex, productId, row);
  before.price_snapshot_id = await insertPriceSnapshot(knex, productId, row, now);
  return before;
}

// The deploy log for a product whose price moved: what changed, and how to finish when the price waits on an entry in Inventory.
function warnPrice(productId, { row, stale, cleared, best }) {
  if (row) {
    console.info(`${LOG} ${CATALOG_NAME}: SiteOne price ${STALE_PRICE} -> ${NEW_PRICE} per ${STALE_SIZE_OZ} oz; the inventory `
      + `recalculation set the catalog best price to ${best}`);
  }
  if (stale.length) {
    console.warn(`${LOG} ${CATALOG_NAME} (${productId}): vendor_pricing ${stale.map((quote) => quote.id).join(', ')} (SiteOne item `
      + `${STALE_SKU}) still offered the stale $${STALE_PRICE.toFixed(2)} a gallon, which the inventory recalculation would pick and the `
      + `pre-slab and mosquito catalog links would take over $${NEW_PRICE.toFixed(2)}. Each such quote now expires at this deploy, so no `
      + `recalculation or auto-order reads it; the catalog best price is ${best}. Enter the current price for each in Inventory `
      + `($${NEW_PRICE.toFixed(2)}): that re-approves the quote. Until then a SiteOne auto-order for it parks as no_price.`);
  }
  if (cleared) {
    console.warn(`${LOG} ${CATALOG_NAME} (${productId}): no current quote could be scaled to the catalog, so the inventory `
      + `recalculation kept the stale $${STALE_PRICE.toFixed(2)}; the catalog price is cleared (needs pricing) so no job cost reads it. `
      + 'Enter the current price in Inventory.');
  }
}

// The inventory route module, loaded only when a price may move: its own recalculation (PUT /:productId/pricing runs it in its
// transaction after the vendor write; it takes the product lock Step P already holds and writes the winner, its flags and status),
// and the per-oz price it ranks a quote by.
const inventory = () => require('../../routes/admin-inventory');
function recalcBestPrice(knex, productId) {
  return inventory().recalcBestPrice(productId, knex);
}

const readsNewPrice = (row) => same(row.price, NEW_PRICE) && (!filled(row.price_amount) || same(row.price_amount, NEW_PRICE));
// The stale price at the catalog row's own package size: the recalculation scales the per-oz winner to unit_size_oz and rounds to the
// cent ($58.42 on a 128 oz row, $43.82 on a 96 oz row).
const holdsStalePrice = (row) => num(row.unit_size_oz) > 0
  && Math.abs(num(row.best_price) - (STALE_PRICE / STALE_SIZE_OZ) * num(row.unit_size_oz)) < 0.01;

// Each stale quote expires now (see the header). Returns each one's figures before and after, for down().
async function expireQuotes(knex, stale, now) {
  const columns = await existingColumns(knex, 'vendor_pricing', QUOTE_COLUMNS);
  const expired = { before: [], written: [] };
  for (const quote of stale) {
    await knex('vendor_pricing').where({ id: quote.id }).update({ expires_at: now });
    expired.before.push({ vendor_pricing_id: quote.id, columns: pickColumns(quote, columns) });
    expired.written.push({ vendor_pricing_id: quote.id, columns: pickColumns(await knex('vendor_pricing').where({ id: quote.id }).first(), columns) });
  }
  return expired;
}

async function restoreCatalogPrice(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendor_pricing'))) return;
  for (const key of [CATALOG_AUDIT_KEY, STALE_AUDIT_KEY]) {
    for (const own of await knex('pricing_config_audit').where({ config_key: key, changed_by: TAG })) {
      await restoreProductPrice(knex, parse(own.old_value), parse(own.new_value));
    }
  }
}

// The SiteOne row back to what up() saw (its earlier snapshot link included) with its price_history and price_snapshots rows removed,
// and each quote up() expired back to its own expiry, each only while it still holds exactly what up() wrote (a price entered since
// re-approves a quote with its own expiry, and is kept); then the recalculation again, so the catalog follows the restored rows.
async function restoreProductPrice(knex, before, written) {
  if (!before || !written) return;
  await lockProduct(knex, before.product_id);
  let restored = await restoreQuoteExpiries(knex, before.stale_quotes, written.stale_quotes);
  if (before.vendor_pricing && written.vendor_pricing) {
    const row = await knex('vendor_pricing').where({ id: before.vendor_pricing_id }).forUpdate().first();
    if (!row || !sameColumns(row, written.vendor_pricing)) {
      console.warn(`${LOG} down: the ${CATALOG_NAME} price changed since this migration - leaving it alone`);
    } else {
      await knex('vendor_pricing').where({ id: row.id }).update(before.vendor_pricing);
      if (before.price_history_id && await knex.schema.hasTable('price_history')) {
        await knex('price_history').where({ id: before.price_history_id }).del();
      }
      if (before.price_snapshot_id && await knex.schema.hasTable('price_snapshots')) {
        await knex('price_snapshots').where({ id: before.price_snapshot_id }).del();
      }
      restored = true;
    }
  }
  if (restored) await recalcRestoringMark(knex, before.product_id, before.catalog_seen);
  else if (written.catalog_cleared) await restoreClearedPrice(knex, before.product_id, before.catalog_seen, written.catalog_recalculated);
}

// A catalog price up() cleared, with no vendor row restored to recalculate from: the catalog as up() saw it, only while it still holds
// exactly what up() wrote (a price entered since recalculates the catalog, and is kept).
async function restoreClearedPrice(knex, productId, seen, wrote) {
  const catalog = await knex('products_catalog').where({ id: productId }).forUpdate().first();
  if (!catalog || !seen || !wrote || !sameColumns(catalog, wrote)) {
    console.warn(`${LOG} down: the ${CATALOG_NAME} catalog price changed since this migration - leaving it alone`);
    return;
  }
  await knex('products_catalog').where({ id: productId }).update(seen);
}

// True when it put back at least one quote's expiry.
async function restoreQuoteExpiries(knex, before, written) {
  let restored = false;
  for (const { vendor_pricing_id: id, columns } of Array.isArray(before) ? before : []) {
    const wrote = (Array.isArray(written) ? written : []).find((quote) => quote.vendor_pricing_id === id);
    const row = await knex('vendor_pricing').where({ id }).forUpdate().first();
    if (!wrote || !row || !sameColumns(row, wrote.columns)) {
      console.warn(`${LOG} down: the ${CATALOG_NAME} quote ${id} changed since this migration - leaving it alone`);
      continue;
    }
    await knex('vendor_pricing').where({ id }).update({ expires_at: columns.expires_at ?? null });
    restored = true;
  }
  return restored;
}

// down()'s recalculation after it restored vendor rows: the catalog follows them, and a mark up()'s recalculation cleared (stale, or
// needing a price) comes back when the winner up() saw returns.
async function recalcRestoringMark(knex, productId, seen) {
  await recalcBestPrice(knex, productId);
  const after = await knex('products_catalog').where({ id: productId }).first();
  const mark = pickColumns(seen || {}, await existingColumns(knex, 'products_catalog', MARK_COLUMNS));
  if (after && seen && sameColumns(after, pickColumns(seen, WINNER_COLUMNS)) && !sameColumns(after, mark)) {
    await knex('products_catalog').where({ id: productId }).update(mark);
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

function changelogAfter(rewritten, pricesMoved) {
  if (!rewritten.includes('onetime_preslab')) {
    return 'LESCO Crosscheck Plus: 128 fl oz at $30.90; the pre-slab products did not move (see the deploy log)';
  }
  if (pricesMoved.includes('expired')) {
    return `LESCO Crosscheck Plus: 128 fl oz at $30.90; a SiteOne ${CATALOG_NAME} quote still at the stale $58.42 is expired, so no inventory recalculation picks it until the price is entered in Inventory (see the deploy log)`;
  }
  if (pricesMoved.includes('cleared')) {
    return `LESCO Crosscheck Plus: 128 fl oz at $30.90; the ${CATALOG_NAME} catalog price, still the stale $58.42, is cleared until the price is entered in Inventory (see the deploy log)`;
  }
  return 'LESCO Crosscheck Plus: 128 fl oz at $30.90 (pre-slab links to the Crosscheck Plus catalog row)';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) {
    console.warn(`${LOG} no pricing_config_audit table - nothing rewritten (down() could not find its writes)`);
    return;
  }
  const pricesMoved = await fixCatalogPrice(knex);
  const hasConfig = await knex.schema.hasTable('pricing_config');
  const rewritten = hasConfig ? await rewriteConfigRows(knex) : [];
  const pestMoved = hasConfig ? await rewritePestCosts(knex) : false;
  if ((rewritten.length || pricesMoved.length || pestMoved) && await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['pre_slab_termiticide', 'trenching', 'mosquito', 'pest_control']),
      before_value: JSON.stringify({ bifenthrin: 'Atticus Talak 7.9 F: 96 fl oz at $41.57; LESCO Crosscheck Plus catalog price $58.42 per 1 gal (stale)' }),
      after_value: JSON.stringify({ bifenthrin: changelogAfter(rewritten, pricesMoved) }),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await restoreCatalogPrice(knex);
  if (await knex.schema.hasTable('pricing_config')) {
    await restoreConfigRows(knex);
    await restorePestCosts(knex);
  }
  await knex('pricing_config_audit').where({ changed_by: TAG }).del();
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
