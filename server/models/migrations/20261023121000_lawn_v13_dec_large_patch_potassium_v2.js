/**
 * Lawn protocol v13, the December potassium-only bag for a lawn with a mapped large patch (owner 2026-10-23, "do whatever is going
 * to make the grass look its best, based on the research we did"). One migration. It only INSERTS, and it rolls back all or nothing.
 *
 * Why. UF/IFAS Large Patch (SS-PLP-5) says to reduce nitrogen in the disease window. The v13 December visit puts down LESCO 10-0-22
 * at 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O). On a lawn with an ACTIVE mapped large patch the visit uses LESCO Black Out
 * 0-0-24 AM Spar-TECH (SiteOne 511512, 50 lb bag; 0 N, 0 P, 24% K2O, with iron, manganese, sulfur and humic) at 4.1 lb per
 * 1,000 sq ft: the same 0.99 lb K2O (the plan derives 0.99 / 0.24 = 4.125 lb) and no nitrogen. Healthy lawns keep the 10-0-22. The
 * swap itself is code behind GATE_LAWN_DEC_LARGE_PATCH_K (config/lawn-v13-trouble-product-swaps.js, waveguard-plan-engine.js); this
 * migration gives the plan the two rows it needs and changes nothing it already has.
 *
 * up(), all in the migration's one transaction:
 *   1. If ANY catalog row matches the product by exact name or exact alias, in any state (active or not, correct or not), up()
 *      THROWS and writes nothing: "a row named X already exists; this migration only inserts". It never reads, fills, links or
 *      changes an existing row. Staff remove or rename that row, then run it again. The one exception is the row this migration
 *      inserted itself (its catalog audit row names the id): a re-run after a rollback that was a no-op finds its own row and carries
 *      on without inserting a second.
 *   2. Otherwise it INSERTS the full row: analysis 0-0-24, default rate 4.1 lb, the 0.25 inch within 24 hours watering rule (the
 *      granular fertilizer rule the 24-0-11, 10-0-22 and 44-0-0 carry; the label was not read for it), approved for the service
 *      report with a plain customer summary, draft, internal only, needs_pricing. NO PRICE IS WRITTEN. SiteOne lists it at $30.06
 *      for the 50 lb bag; the price is set in Inventory (PUT /:productId/pricing writes vendor_pricing and recalculates the best
 *      price in one transaction, code a migration should not copy). An unpriced product plans, mixes and reports normally; its
 *      material cost reads null and the cost summary counts it as unpriced.
 *   3. The December window of EVERY v13 protocol that has the 10-0-22 row gains ONE row for the new product: a lb_k nutrition row
 *      (the plan derives the rate from the visit's K target and the product's analysis), default_in_plan FALSE (the recipe line
 *      stays the 10-0-22; the plan selects the new row only through the swap), gates.targetK '0.99 lb K2O/1000' and
 *      gates.trigger 'active_large_patch_mapped'. The 10-0-22 row's other gates (for example fertilizerSafety) are copied; its
 *      targetN, targetK2O and blackoutSensitive are not (no nitrogen). The 10-0-22 row itself is not touched. A protocol whose
 *      December window has no 10-0-22 row, or already has the new product, is skipped. One audit row per protocol records the row;
 *      one catalog audit row names the inserted product (the marker down() reads).
 *
 * Future visits only. Nothing here rewrites a closed visit: its service_products rows and frozen report facts stay as recorded.
 *
 * down() is all or nothing, and it compares EVERYTHING this wrote:
 *   - if ANY scheduled visit or completion references ANY v13 protocol, it does nothing and logs why;
 *   - every December row this wrote is compared, column by column (the window link, product id and name, role, application mode,
 *     rate, unit, carrier, default flag, all four JSON columns, sort order), with the exact values up() wrote (kept whole in its audit
 *     row); the catalog row is compared the same way (every column written, the workflow values too, and every price field empty);
 *     any difference, a missing row, an actual that uses a December row, or anything else that references the catalog row makes the
 *     whole rollback a no-op that logs which;
 *   - otherwise it deletes EVERY December row this wrote and the catalog row it inserted. It never touches a row it did not insert.
 *
 * This migration replaces 20261023120000 (same change, frozen by a push before its rollback compared every column); that file is not
 * in the tree. The audit actions are the same, so a database that already ran the first file finds its own catalog row and its
 * December rows and carries on without a second insert; a rollback there is a no-op (the first file kept a partial snapshot).
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_dec_large_patch_k';
const CATALOG_ACTION = 'v13_dec_large_patch_k_catalog';
const ACTOR = 'migration 20261023121000';
const MIGRATION = '20261023121000_lawn_v13_dec_large_patch_potassium_v2';
const DEC_WINDOW = 'dec_v13_spreader_feeding';
const FROM_NAME = 'LESCO 10-0-22 50% PolyPlus OPTI45 50% YaraRega 2% Fe 2% Mg KMAG MOP SOP Turfgrass Granular Fertilizer';
const NEW_NAME = 'LESCO Black Out 0-0-24 AM Spar-TECH';

// 4.1 lb x 24% = 0.984 lb K2O, shown as 0.99 lb K2O (the plan derives 0.99 / 0.24 = 4.125 lb).
const DEC_RATE = 4.1;
// The new row's gates: the 10-0-22 row's other gates are copied under these keys, minus the nitrogen ones.
const NEW_GATES = { targetK: '0.99 lb K2O/1000', trigger: 'active_large_patch_mapped' };
const DROPPED_GATES = ['targetN', 'targetK2O', 'blackoutSensitive'];

const VERIFIED_AT = '2026-10-23T00:00:00.000Z';
const VERIFIED_BY = 'owner-rule-2026-10-23';
// Same shape and values as the 24-0-11, 10-0-22 and 44-0-0 rules: 0.25 inch within 24 hours.
const WATERING_RULE = {
  mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner',
  label_note: 'Owner: 0.25 inch within 24 hours, the granular fertilizer rule the LESCO 24-0-11, 10-0-22 and 44-0-0 carry. The label was not read for this rule.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const SUMMARY = 'A potassium fertilizer with no nitrogen or phosphorus. Potassium helps the lawn handle cold and stress through the winter.';
const PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf. Watering-in follows the visit notes. No re-entry wait once watered in and dry.';

// The inserted row. Price fields are never written: needs_pricing stays true until a price is set in Inventory.
const CATALOG = {
  name: NEW_NAME,
  display_name: 'LESCO Black Out 0-0-24 Potash',
  category: 'fertilizer',
  product_type: 'fertilizer',
  manufacturer: 'LESCO / SiteOne',
  active_ingredient: 'Potassium (potash) fertilizer with iron, manganese, sulfur and humic',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  siteone_sku: '511512',
  epa_reg_number: 'N/A',
  analysis_n: 0,
  analysis_p: 0,
  analysis_k: 24,
  default_rate_per_1000: DEC_RATE,
  rate_unit: 'lb',
  label_source_note: 'LESCO Black Out 0-0-24 AM Spar-TECH, SiteOne 511512, 50 lb bag (SiteOne listed $30.06; 45 in stock at store 238 on 2026-10-23). 0% N, 0% P, 24% K2O, with Fe, Mn, S and humic. December on a lawn with a mapped large patch: 4.1 lb per 1,000 sq ft = 0.99 lb K2O, no nitrogen (owner 2026-10-23). The product label was not read for this row. No price written: set $30.06 in Inventory.',
  public_summary: SUMMARY,
  service_report_summary: SUMMARY,
  customer_precaution_summary: PRECAUTION,
  approved_for_service_report: true,
  post_application_watering: WATERING_RULE,
};
// What the insert also sets, beside the CATALOG fields; part of the "unchanged" test in down().
const INSERT_DEFAULTS = Object.freeze({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
const JSON_COLUMNS = new Set(['post_application_watering']);
// Never written here; a value in any of them means someone priced the row after this inserted it.
const PRICE_FIELDS = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), dates by time, JSON deeply.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

// ── up ───────────────────────────────────────────────────────────────────────

// Ids of every catalog row that spells the name exactly (normalized) or has an exact alias for it, in any state.
async function matchingIds(knex, name) {
  const wanted = normalize(name);
  const ids = new Set((await knex('products_catalog').select('id', 'name')).filter((row) => normalize(row.name) === wanted).map((row) => String(row.id)));
  if (await knex.schema.hasTable('product_aliases')) {
    for (const row of await knex('product_aliases').select('product_id', 'alias_name')) if (normalize(row.alias_name) === wanted) ids.add(String(row.product_id));
  }
  return [...ids];
}

// The id of the catalog row an earlier run of THIS migration inserted, else null.
async function ownInsertedId(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted && productId) return String(productId);
  }
  return null;
}

async function insertCatalog(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const known = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key in columns));
  const fields = known(CATALOG);
  const workflow = known(INSERT_DEFAULTS);
  const insert = { ...fields, ...workflow, created_at: knex.fn.now(), updated_at: knex.fn.now() };
  for (const column of JSON_COLUMNS) if (column in insert) insert[column] = JSON.stringify(insert[column]);
  const [made] = await knex('products_catalog').insert(insert).returning('id');
  const productId = made && typeof made === 'object' ? made.id : made;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId, inserted: { ...fields, ...workflow } }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
  return productId;
}

// Adds the potassium-only row to the December window of every v13 protocol; one audit row per protocol holds the row as written.
async function addStagedRows(knex, productId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windows = (await knex('lawn_protocol_windows').where({ window_key: DEC_WINDOW }).select('id', 'lawn_protocol_id'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select('id', 'product_name', 'role', 'application_mode', 'gates', 'sort_order');
    const base = rows.find((row) => row.product_name === FROM_NAME);
    if (!base || rows.some((row) => row.product_name === NEW_NAME)) continue;
    const gates = { ...asObject(base.gates) };
    for (const key of DROPPED_GATES) delete gates[key];
    Object.assign(gates, NEW_GATES);
    const sortOrder = Math.max(...rows.map((row) => Number(row.sort_order) || 0)) + 1;
    const row = {
      lawn_protocol_window_id: window.id,
      product_id: productId,
      product_name: NEW_NAME,
      role: base.role,
      application_mode: base.application_mode,
      rate_per_1000: null,
      rate_unit: 'lb_k',
      carrier_gal_per_1000: null,
      default_in_plan: false,
      gates,
      annual_counter: {},
      mixing: {},
      report_copy: { role: base.role },
      sort_order: sortOrder,
    };
    const [inserted] = await knex('lawn_protocol_products').insert({
      ...row, gates: JSON.stringify(row.gates), annual_counter: JSON.stringify(row.annual_counter), mixing: JSON.stringify(row.mixing), report_copy: JSON.stringify(row.report_copy),
    }).returning('id');
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: window.lawn_protocol_id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: window.lawn_protocol_id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      // The whole row as written: down() compares every one of these columns before it removes anything.
      after_snapshot: JSON.stringify({ rows: [{ rowId: inserted && (inserted.id || inserted), after: row }] }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_DEC_LARGE_PATCH_K' }),
    });
  }
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (!(await knex('lawn_protocols').where({ version: V13_VERSION }).first('id'))) return;

  const matches = await matchingIds(knex, NEW_NAME);
  let productId;
  if (matches.length === 1 && matches[0] === await ownInsertedId(knex)) {
    // Our own row from an earlier run whose rollback did nothing (down() is all or nothing): carry on, insert nothing.
    productId = matches[0];
  } else if (matches.length) {
    throw new Error(`lawn v13 December 0-0-24: a catalog row named "${NEW_NAME}" already exists; this migration only inserts. Remove or rename it (catalog id ${matches.join(', ')}) and run this migration again. Nothing was written.`);
  } else {
    productId = await insertCatalog(knex);
  }
  await addStagedRows(knex, productId);
};

// ── down ─────────────────────────────────────────────────────────────────────

// Any table that holds a foreign key to the product: a row there means the product is in use. The December rows this migration wrote
// reference it by design, so they are left out of the count.
async function productReferenced(knex, productId, ownRowIds) {
  const { rows } = await knex.raw(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'products_catalog'::regclass
  `);
  for (const { tbl, col } of rows) {
    const query = knex(tbl).where({ [col]: productId });
    if (/(^|\.)lawn_protocol_products$/.test(tbl)) query.whereNotIn('id', ownRowIds);
    if (await query.first(col)) return true;
  }
  return false;
}

const ROW_COLUMNS = ['lawn_protocol_window_id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit',
  'carrier_gal_per_1000', 'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy', 'sort_order'];

// Why a recorded December row is not exactly what up() wrote (null = it is): every column up() inserted is compared with the value
// recorded for it, the window link included; a row that is gone, or that a completion actual uses, is a difference too.
async function rowDifference(knex, record) {
  const written = record.after;
  if (!record.rowId || !written || ROW_COLUMNS.some((column) => !(column in written))) return `row ${record.rowId} has no complete record of what was written`;
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  if (!row) return `row ${record.rowId} is gone`;
  const changed = ROW_COLUMNS.filter((column) => !same(row[column], written[column]));
  if (changed.length) return `row ${record.rowId} changed: ${changed.join(', ')}`;
  if (await knex.schema.hasTable('lawn_protocol_product_actuals')
    && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: record.rowId }).first('id')) return `row ${record.rowId} is used by a completion actual`;
  return null;
}

// Why the catalog row is not exactly what up() inserted (null = it is): every column written (the workflow values too), no price field,
// and nothing that references it but the December rows.
async function catalogDifference(knex, productId, inserted, ownRowIds) {
  const row = await knex('products_catalog').where({ id: productId }).first();
  if (!row) return `catalog row ${productId} is gone`;
  const changed = Object.entries(inserted).filter(([column, value]) => !same(row[column], value)).map(([column]) => column);
  const priced = PRICE_FIELDS.filter((column) => row[column] != null);
  if (changed.length || priced.length) return `catalog row ${productId} changed: ${[...changed, ...priced].join(', ')}`;
  if (await productReferenced(knex, productId, ownRowIds)) return `catalog row ${productId} is referenced`;
  return null;
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const protocolLogs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  if (!protocolLogs.length && !catalogLogs.length) return;

  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-dec-large-patch-k] rollback did nothing: a scheduled visit or completion references ${V13_VERSION}`);
    return;
  }
  const records = protocolLogs.flatMap((log) => asObject(log.after_snapshot).rows || []);
  const ownRowIds = records.map((record) => record.rowId).filter(Boolean);
  // Everything is checked before anything is written: one difference anywhere and nothing changes.
  const differences = [];
  for (const record of records) differences.push(await rowDifference(knex, record));
  for (const log of catalogLogs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted) differences.push(await catalogDifference(knex, productId, inserted, ownRowIds));
  }
  const found = differences.filter(Boolean);
  if (found.length) {
    console.log(`[lawn-v13-dec-large-patch-k] rollback did nothing: ${found.join('; ')}`);
    return;
  }

  for (const record of records) await knex('lawn_protocol_products').where({ id: record.rowId }).del();
  for (const log of protocolLogs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  for (const log of catalogLogs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted) await knex('products_catalog').where({ id: productId }).del();
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.DEC_WINDOW = DEC_WINDOW;
exports.FROM_NAME = FROM_NAME;
exports.NEW_NAME = NEW_NAME;
exports.DEC_RATE = DEC_RATE;
exports.NEW_GATES = NEW_GATES;
exports.CATALOG = CATALOG;
exports.INSERT_DEFAULTS = INSERT_DEFAULTS;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: NEW_NAME, rule: WATERING_RULE }];
exports.SUMMARY = SUMMARY;
exports.PRECAUTION = PRECAUTION;
