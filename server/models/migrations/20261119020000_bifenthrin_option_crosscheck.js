/**
 * The pre-slab and trenching `talstar_p` and `bifen_it` options are the LESCO Crosscheck Plus bottle (owner 2026-11-18: "we need to
 * swap out atticus talak for lesco crosscheck", then "yes all linked services follow it"). Crosscheck Plus is bifenthrin 7.9%,
 * EPA Reg. No. 10404-120, sold as 1 gal (128 fl oz); the owner pays $30.90. The option KEYS stay because saved estimates store them;
 * only the product they name, its cost and its copy change.
 *
 * Pricing is DB-authoritative (db-bridge loads pricing_config over constants.js), so the persisted rows must follow the code:
 *  1. onetime_preslab.products.{talstar_p,bifen_it}: Talak 96 fl oz at 41.57 -> Crosscheck Plus 128 fl oz at 30.90, plus label,
 *     catalog link, package label and warnings. margin_divisor, product_oz_per_10_sqft and positioning are kept.
 *  2. onetime_trenching.products.{talstar_p,bifen_it}: the same bottle, label and warnings; the rate fields are kept.
 * A product is rewritten only while it still holds the Talak values, or is exactly the admin seed's Talak product (41.57 / 96 with
 * its rate fields and nothing else: what ensureTable in routes/admin-pricing-config.js inserted from 2026-10-25 until this change,
 * when it creates the table). One already on Crosscheck is left alone silently (re-run); one an admin changed is left alone with a
 * warning. A missing table, row or key is never an error.
 *
 * Step P (first, same transaction): production holds a stale SiteOne price for LESCO Crosscheck Plus ($58.42 per 1 gal, entered
 * 2026-09-30; the owner pays $30.90). db-bridge's pre-slab link takes a catalog price within [0.5x, 2x] of the config, and 58.42 is
 * 1.89x of 30.90, so a pre-slab link to that row unfixed would RAISE slab quotes. Step P writes $30.90 on the product's one vendor
 * row and the catalog best price exactly the way the inventory price handler does for a manual entry with no shipping or tax
 * (PUT /:productId/pricing + recalcBestPriceLocked: previous price, price, price_amount, landed cost, per-oz figures, last_checked_at,
 * a price_history row holding the OLD price, and the catalog best_price / best_price_amount_cached / best_price_updated_at). It acts
 * only when the rows still look exactly as read on 2026-11-18, the vendor row's price_amount (what costing reads first) and its own
 * pack (1 gal, priced per oz: the handler derives the unit cost from it) included; anything else (a second vendor row, a vendor
 * row carrying shipping or tax: its landed cost would need them) is left alone with a warning. It does not import the route.
 * server/data/pricing.csv, the sheet the admin pricing import reads first, lists the same gallon at $30.90, so a re-import keeps it.
 *
 * Pre-slab hold: while a catalog row named LESCO Crosscheck Plus still holds the stale $58.42 for 128 oz after Step P (Step P had
 * to leave it), each pre-slab bifenthrin option this migration moves, and each one that would take the code default link (no
 * link of its own, as in the admin seed, or no product), links to the Atticus Talak 7.9 F catalog row instead. Its quote keeps
 * today's cost (db-bridge takes the Talak catalog price, as before this change), while its label and copy name the Crosscheck Plus
 * bottle the trucks now carry (#7984). An option with a link of its own is the admin's and stays. The deploy log says how to
 * finish. Otherwise pre-slab links to the Crosscheck Plus catalog row: a price Step P leaves alone is then a later entry, and the
 * quote follows the catalog price (owner 2026-07-10) inside the bridge's band. Trenching has no catalog link, so it moves either way.
 *
 * pest_service_costs (the admin Pricing Logic panel's Pest Service Cost Breakdown; display only, pestVisitCostModel prices the
 * visit): its Talak line, 4 fl oz a visit at 41.57 / 128, becomes Crosscheck Plus at the engine's 0.97 (4 fl oz at 30.90 / 128) in
 * the same place, and each total that held the Talak line moves by the same 0.33. Only while that line holds the Talak values.
 *
 * db-bridge reads `catalogProductName ?? catalog_product_name`, `containerCost ?? container_cost ?? bottleCost ?? bottle_cost`, and so
 * on, so a camelCase or bottle alias would win over the snake_case value written here: the rewrite drops those aliases.
 *
 * Ownership: up() writes one pricing_config_audit row (changed_by TAG) for each pricing_config row it rewrote, one for Step P, and one
 * pricing_changelog row when it changed anything; with no pricing_config_audit table it writes nothing (down() could not find its
 * writes). down() restores a product only when this migration's audit row for its row exists
 * AND the product still deep-equals what up() wrote (an admin edit since then is kept); it restores the catalog price only when its
 * audit row exists AND the vendor row and catalog row still hold exactly what up() wrote; it restores the pest breakdown only when
 * its audit row exists AND the row still deep-equals what up() wrote; then it deletes this migration's price_history row, audit rows
 * and changelog row.
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

const CATALOG_NAME = 'LESCO Crosscheck Plus';
const STALE_SKU = 'D00001542';
const STALE_PRICE = 58.42;
const STALE_SIZE_OZ = 128;
const STALE_QUANTITY = '1 gal';
const NEW_PRICE = 30.9;
const NEW_PER_OZ = Math.round((NEW_PRICE / STALE_SIZE_OZ) * 10000) / 10000; // 0.2414, rounded as the price handler does
// The catalog row the Talak products link to (production, 2026-11-18), and the one the pre-slab hold keeps.
const TALAK_LINK = 'Atticus Talak 7.9 F';

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
  catalog_product_name: TALAK_LINK,
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
const REQUIRED_VENDOR_COLUMNS = ['product_id', 'vendor_id', 'vendor_sku', 'is_active', 'approval_status', 'price', 'quantity'];
const REQUIRED_CATALOG_COLUMNS = ['name', 'active', 'best_price', 'unit_size_oz', 'best_vendor_pricing_id'];

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

// The one vendor row Step P may correct: active, approved, at the stale price (price_amount too, when set: costing reads it
// first), the 1 gal pack priced per oz (the handler derives the unit cost from the row's own quantity), with no shipping or tax.
// Returns null when it is, else the reason it is not.
function vendorRowBlocker(row) {
  if (row.is_active !== true || row.approval_status !== 'approved' || !same(row.price, STALE_PRICE)
    || (filled(row.price_amount) && !same(row.price_amount, STALE_PRICE))) {
    return `the vendor row is not the active, approved $${STALE_PRICE} row (price ${row.price}, price_amount ${row.price_amount})`
      + ' - an admin changed it';
  }
  if (String(row.quantity ?? '').trim().toLowerCase() !== STALE_QUANTITY || ('unit_normalized' in row && row.unit_normalized !== 'oz')) {
    return `the vendor row is not the ${STALE_QUANTITY} pack priced per oz (quantity ${row.quantity}, unit ${row.unit_normalized})`;
  }
  if (carries(row.shipping_cost) || carries(row.tax_rate)) {
    return `the vendor row carries shipping (${row.shipping_cost}) or tax (${row.tax_rate}) - enter the price in the app`;
  }
  return null;
}

// Returns null when Step P may act, 'done' when the price is already right, or the reason it must leave the rows alone.
async function catalogBlocker(knex, product, rows) {
  if (rows.length === 1 && same(rows[0].price, NEW_PRICE)) return 'done';
  const missing = [
    ...(await existingColumns(knex, 'vendor_pricing', REQUIRED_VENDOR_COLUMNS)).length === REQUIRED_VENDOR_COLUMNS.length ? [] : ['vendor_pricing columns'],
    ...(await existingColumns(knex, 'products_catalog', REQUIRED_CATALOG_COLUMNS)).length === REQUIRED_CATALOG_COLUMNS.length ? [] : ['products_catalog columns'],
  ];
  if (missing.length) return `a required ${missing.join(' and ')} is missing`;
  if (product.active !== true) return 'the product is not active';
  if (rows.length !== 1 || rows[0].vendor_sku !== STALE_SKU) return `it does not have exactly one vendor row with SKU ${STALE_SKU}`;
  const row = rows[0];
  const rowBlocker = vendorRowBlocker(row);
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

// Mirrors PUT /:productId/pricing (existing row) + recalcBestPriceLocked for a manual $30.90 entry. True when it changed the rows.
async function fixCatalogPrice(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendor_pricing'))) return false;
  const found = await knex('products_catalog').where({ name: CATALOG_NAME });
  if (found.length === 0) return false;
  if (found.length > 1) {
    console.warn(`${LOG} ${found.length} catalog rows named ${CATALOG_NAME} - leaving the price alone`);
    return false;
  }
  const productId = found[0].id;
  await lockProduct(knex, productId);
  const product = await knex('products_catalog').where({ id: productId }).forUpdate().first();
  const rows = await knex('vendor_pricing').where({ product_id: productId }).forUpdate();
  const blocker = await catalogBlocker(knex, product, rows);
  if (blocker === 'done') return false;
  if (blocker) {
    console.warn(`${LOG} ${CATALOG_NAME} price left alone: ${blocker}`);
    return false;
  }
  const row = rows[0];
  const vendorColumns = await existingColumns(knex, 'vendor_pricing', VENDOR_COLUMNS);
  const catalogColumns = await existingColumns(knex, 'products_catalog', CATALOG_COLUMNS);
  const now = new Date();
  const vendorPatch = pickColumns({
    previous_price: STALE_PRICE, price: NEW_PRICE, price_amount: NEW_PRICE, landed_cost: NEW_PRICE,
    price_per_oz: NEW_PER_OZ, normalized_unit_price: NEW_PER_OZ, landed_unit_price: NEW_PER_OZ, last_checked_at: now,
  }, vendorColumns);
  const catalogPatch = pickColumns({ best_price: NEW_PRICE, best_price_amount_cached: NEW_PRICE, best_price_updated_at: now }, catalogColumns);
  const before = { vendor_pricing: pickColumns(row, vendorColumns), products_catalog: pickColumns(product, catalogColumns) };

  await knex('vendor_pricing').where({ id: row.id }).update(vendorPatch);
  await knex('products_catalog').where({ id: productId }).update(catalogPatch);
  const historyId = await insertPriceHistory(knex, productId, row);

  const writtenVendor = await knex('vendor_pricing').where({ id: row.id }).first();
  const writtenCatalog = await knex('products_catalog').where({ id: productId }).first();
  await knex('pricing_config_audit').insert({
    config_key: CATALOG_AUDIT_KEY,
    old_value: JSON.stringify({ product_id: productId, vendor_pricing_id: row.id, price_history_id: historyId, ...before }),
    new_value: JSON.stringify({
      vendor_pricing: pickColumns(writtenVendor, vendorColumns),
      products_catalog: pickColumns(writtenCatalog, catalogColumns),
    }),
    changed_by: TAG,
    reason: CATALOG_REASON,
  });
  console.info(`${LOG} ${CATALOG_NAME}: SiteOne price ${STALE_PRICE} -> ${NEW_PRICE} per ${STALE_SIZE_OZ} oz (catalog best price follows)`);
  return true;
}

// True while a catalog row named LESCO Crosscheck Plus still holds the stale price for 128 oz after Step P (it had to leave the
// rows: a second vendor row, an edited or inactive row, another pack, shipping or tax). db-bridge's pre-slab link would take that
// price over the config's 30.90 (1.89x sits inside its [0.5x, 2x] band) and RAISE slab quotes, now or on the day an inactive
// backing row comes back, so the pre-slab options keep the Talak catalog link until the price is fixed in the app.
async function catalogStillStale(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return false;
  const rows = await knex('products_catalog').where({ name: CATALOG_NAME });
  return rows.some((row) => same(row.best_price, STALE_PRICE) && same(row.unit_size_oz, STALE_SIZE_OZ));
}

async function restoreCatalogPrice(knex) {
  const own = await knex('pricing_config_audit').where({ config_key: CATALOG_AUDIT_KEY, changed_by: TAG }).first('old_value', 'new_value');
  if (!own) return;
  const before = parse(own.old_value);
  const written = parse(own.new_value);
  if (!before || !written || !before.vendor_pricing || !before.products_catalog || !written.vendor_pricing || !written.products_catalog
    || !(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendor_pricing'))) return;
  await lockProduct(knex, before.product_id);
  const product = await knex('products_catalog').where({ id: before.product_id }).forUpdate().first();
  const row = await knex('vendor_pricing').where({ id: before.vendor_pricing_id }).forUpdate().first();
  if (!product || !row || !sameColumns(row, written.vendor_pricing) || !sameColumns(product, written.products_catalog)) {
    console.warn(`${LOG} down: the ${CATALOG_NAME} price changed since this migration - leaving it alone`);
    return;
  }
  await knex('vendor_pricing').where({ id: row.id }).update(before.vendor_pricing);
  await knex('products_catalog').where({ id: product.id }).update(before.products_catalog);
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

// Rewrites the Talak products of one row; returns the new data, or null when nothing changed.
function rewriteRow(configKey, data, plan) {
  const products = { ...data.products };
  let changed = false;
  for (const key of OPTION_KEYS) {
    const product = products[key];
    if (!product || typeof product !== 'object') {
      console.warn(`${LOG} ${configKey} has no products.${key} - the code default (Crosscheck Plus) applies; leaving it alone`);
    } else if (holds(product, plan.to)) {
      // already Crosscheck (a re-run): not ours
    } else if (!isTalak(product, plan)) {
      console.warn(`${LOG} ${configKey}.products.${key} was edited since the Talak swap - leaving the admin's values alone`);
    } else {
      products[key] = toCrosscheck(product, plan.to);
      changed = true;
    }
  }
  return changed ? { ...data, products } : null;
}

// The catalog row db-bridge links a pre-slab product to: its own catalogProductName ?? catalog_product_name when that is a
// non-blank string (setString), else the code default, which is now LESCO Crosscheck Plus.
function ownLink(product) {
  const name = product && typeof product === 'object' ? product.catalogProductName ?? product.catalog_product_name : null;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

// The pre-slab hold (see the header): each option this migration moves (`moved` = rewriteRow's result), and each one with no link
// of its own, gets the Talak catalog link. Returns the new data, or null when nothing changes.
function holdPreSlabLinks(data, moved) {
  const base = moved || data;
  const products = { ...base.products };
  let changed = !!moved;
  for (const key of OPTION_KEYS) {
    const ours = !!moved && !isDeepStrictEqual(moved.products[key], data.products[key]);
    if (!ours && ownLink(products[key])) continue;
    const current = products[key] && typeof products[key] === 'object' ? products[key] : {};
    const { catalogProductName: _blankAlias, ...product } = current;
    products[key] = { ...product, catalog_product_name: TALAK_LINK };
    changed = true;
  }
  return changed ? { ...base, products } : null;
}

// Returns the config keys it wrote.
async function rewriteConfigRows(knex, holdPreSlab) {
  const rewritten = [];
  for (const [key, plan] of Object.entries(PLANS)) {
    const row = await knex('pricing_config').where({ config_key: key }).forUpdate().first('data');
    const data = row && parse(row.data);
    if (!data || !data.products || typeof data.products !== 'object') continue;
    const held = key === 'onetime_preslab' && holdPreSlab;
    const moved = rewriteRow(key, data, plan);
    const next = held ? holdPreSlabLinks(data, moved) : moved;
    if (held) {
      console.warn(`${LOG} onetime_preslab: the ${CATALOG_NAME} catalog row still holds the stale $${STALE_PRICE.toFixed(2)}, which `
        + `the pre-slab link would take over $${NEW_PRICE.toFixed(2)}, so the pre-slab bifenthrin options link to ${TALAK_LINK} and `
        + `slab quotes do not move. Enter $${NEW_PRICE.toFixed(2)} for ${CATALOG_NAME} in Inventory, then set their catalog link to `
        + `${CATALOG_NAME}.`);
    }
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
    if (!current || !current.products || !before || !before.products || !written || !written.products) continue;
    const products = { ...current.products };
    for (const option of OPTION_KEYS) {
      if (isDeepStrictEqual(before.products[option], written.products[option])) continue; // up() did not change this key
      if (isDeepStrictEqual(current.products[option], written.products[option])) {
        products[option] = before.products[option];
      } else {
        console.warn(`${LOG} down: ${key}.products.${option} changed since this migration - leaving it alone`);
      }
    }
    if (isDeepStrictEqual(products, current.products)) continue; // nothing restored: leave the row (and its updated_at) alone
    await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify({ ...current, products }), updated_at: knex.fn.now() });
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
exports.TALAK_LINK = TALAK_LINK;
exports.TALAK_PEST_LINE = TALAK_PEST_LINE;
exports.CROSSCHECK_PEST_LINE = CROSSCHECK_PEST_LINE;

function changelogAfter(rewritten, holdPreSlab) {
  if (!rewritten.includes('onetime_preslab')) {
    return 'LESCO Crosscheck Plus: 128 fl oz at $30.90; the pre-slab products did not move (see the deploy log)';
  }
  return holdPreSlab
    ? `LESCO Crosscheck Plus: 128 fl oz at $30.90; the pre-slab catalog link stays on ${TALAK_LINK} until the ${CATALOG_NAME} catalog price is fixed (see the deploy log)`
    : 'LESCO Crosscheck Plus: 128 fl oz at $30.90 (pre-slab links to the Crosscheck Plus catalog row)';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) {
    console.warn(`${LOG} no pricing_config_audit table - nothing rewritten (down() could not find its writes)`);
    return;
  }
  const priceFixed = await fixCatalogPrice(knex);
  const holdPreSlab = await catalogStillStale(knex);
  const hasConfig = await knex.schema.hasTable('pricing_config');
  const rewritten = hasConfig ? await rewriteConfigRows(knex, holdPreSlab) : [];
  const pestMoved = hasConfig ? await rewritePestCosts(knex) : false;
  if ((rewritten.length || priceFixed || pestMoved) && await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['pre_slab_termiticide', 'trenching', 'mosquito', 'pest_control']),
      before_value: JSON.stringify({ bifenthrin: 'Atticus Talak 7.9 F: 96 fl oz at $41.57; LESCO Crosscheck Plus catalog price $58.42 per 1 gal (stale)' }),
      after_value: JSON.stringify({ bifenthrin: changelogAfter(rewritten, holdPreSlab) }),
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
