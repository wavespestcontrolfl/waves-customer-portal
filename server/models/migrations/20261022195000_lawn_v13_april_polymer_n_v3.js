/**
 * Lawn protocol v13, April feeding on the 12x plan becomes one long-release nitrogen bag (owner 2026-10-22,
 * "lets go ahead and do this"). One migration, deliberately small: it only INSERTS, and it rolls back all or nothing.
 *
 * Why. The April feeding (LESCO 24-0-11 with PolyPlus OPTI, 2.1 lb per 1,000 sq ft, 0.5 lb N) ran out before summer.
 * The state nitrogen ban runs June 1 to September 30. The new bag is LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass
 * Granular Fertilizer (SiteOne 511333, 50 lb bag, available by request): all of its nitrogen is polymer coated and
 * releases over about 3 to 4 months, so one pass in April carries the lawn into July. Rate: 2.27 lb of product per
 * 1,000 sq ft = 1.0 lb N (2.27 x 0.44 = 0.9988; the plan derives the rate from the 1.0 lb N target, 1.0 / 0.44).
 * The 12x year gains 0.5 lb N: 3.18 to 3.68 lb N per 1,000 sq ft, under the 4 lb a year in every ordinance row.
 *
 * What this does not touch. The 9x plan April row (LESCO Dimension 0.21% 18-0-10, 2.78 lb, 0.5 lb N) keeps its
 * product, rate and gates. The February and November 24-0-11 rows stay. North Port keeps its hold: the staged April
 * row carries gates.northPortBlocked and the new product carries nitrogen, so the ordinance block (N from April 1 in
 * North Port) reads it exactly as it read the 24-0-11; the April visit there is Nutra-TECH only.
 *
 * up(), all in the migration's one transaction:
 *   1. If ANY catalog row matches the product by exact name or exact alias, in any state (active or not, correct or
 *      not), up() THROWS and writes nothing: "a row named X already exists; this migration only inserts". It never
 *      reads, fills, links or changes an existing row. Staff remove or rename that row, then run it again.
 *      The one exception is the row this migration inserted itself (its catalog audit row names the id): a re-run after a
 *      rollback that was a no-op (see down()) finds its own row and carries on without inserting a second.
 *   2. Otherwise it INSERTS the full row: analysis 44-0-0, 100% slow-release, default rate 2.27 lb, the 0.25 inch within
 *      24 hours watering rule (owner precedent of the 24-0-11 and 10-0-22; the label was not read for it), approved for
 *      the service report with a plain customer summary, draft, internal only, needs_pricing. NO PRICE IS WRITTEN: the
 *      bag is "available by request" and has no quote yet; the price is set in Inventory later. An unpriced product
 *      plans, mixes and reports normally; its material cost reads null and the cost summary counts it as unpriced.
 *   3. The staged April row of EVERY v13 protocol: the 12x row named for the 24-0-11 becomes the 44-0-0 (name, product
 *      id) with gates.targetN '1.0 lb N/1000'. The row stays a lb_n row: the plan derives the rate from the visit's
 *      N target and the product's analysis. Its other gates (blackoutSensitive, northPortBlocked, planVisitsPerYear 12)
 *      and the window are not touched. A protocol whose April window has no 24-0-11 row, or already has the 44-0-0,
 *      is skipped. One audit row per protocol records each row before and after; one catalog audit row names the
 *      inserted product (the marker down() reads).
 *
 * Future visits only. Planning reads the live staged rows for an open April visit. A closed visit keeps what it
 * recorded: its service_products rows carry the product and amount applied, and the report facts frozen at completion
 * (approved_report_product_facts); nothing here rewrites either. No v13 April visit has closed yet.
 *
 * down() is all or nothing, so the database never holds some April windows on the 44-0-0 and others on the 24-0-11:
 *   - if ANY scheduled visit or completion references ANY v13 protocol, it does nothing and logs why;
 *   - if ANY April row this wrote is no longer exactly as written (renamed, relinked, regated, deleted), it does
 *     nothing and logs which;
 *   - otherwise it puts EVERY April row back as it was, and deletes the catalog row it inserted only if that row is
 *     still exactly as inserted (the four workflow values too), unpriced and referenced by nothing (any foreign key,
 *     any table); a changed, priced or used row is kept. It never touches a row it did not insert.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_april_polymer_n';
const CATALOG_ACTION = 'v13_april_polymer_n_catalog';
const ACTOR = 'migration 20261022195000';
const MIGRATION = '20261022195000_lawn_v13_april_polymer_n_v3';
const APRIL_WINDOW = 'apr_v13_spreader_feeding';
const OLD_NAME = staged.NAMES.F24;
const NEW_NAME = 'LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass Granular Fertilizer';

// 2.27 lb x 44% = 0.9988 lb N, shown as 1.0 lb N (the plan derives 1.0 / 0.44 = 2.2727 lb).
const APRIL_RATE = 2.27;
const OLD_TARGET_N = '0.5 lb N/1000';
const NEW_GATES = { targetN: '1.0 lb N/1000' };

const VERIFIED_AT = '2026-10-22T00:00:00.000Z';
const VERIFIED_BY = 'owner-rule-2026-10-22';
// Same shape and values as the 24-0-11 and 10-0-22 rules: 0.25 inch within 24 hours.
const WATERING_RULE = {
  mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner',
  label_note: 'Owner: 0.25 inch within 24 hours, the granular fertilizer rule the LESCO 24-0-11 and 10-0-22 carry. The label was not read for this rule.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const SUMMARY = 'A slow-release nitrogen fertilizer. Its coating releases the feeding slowly over about 3 to 4 months, so the lawn keeps feeding into summer.';
const PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf. Watering-in follows the visit notes. No re-entry wait once watered in and dry.';

// The inserted row. Price fields are never written: needs_pricing stays true until a price is set in Inventory.
const CATALOG = {
  name: NEW_NAME,
  display_name: 'LESCO 44-0-0 Turf Fertilizer',
  category: 'fertilizer',
  product_type: 'fertilizer',
  manufacturer: 'LESCO / SiteOne',
  active_ingredient: 'Polymer-coated nitrogen fertilizer',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  siteone_sku: '511333',
  epa_reg_number: 'N/A',
  analysis_n: 44,
  analysis_p: 0,
  analysis_k: 0,
  slow_release_n_pct: 100,
  default_rate_per_1000: APRIL_RATE,
  rate_unit: 'lb',
  label_source_note: 'LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass Granular Fertilizer, SiteOne 511333, 50 lb bag, available by request. 100% polymer-coated nitrogen, released over about 3 to 4 months. April on the 12x plan: 2.27 lb per 1,000 sq ft = 1.0 lb N (owner 2026-10-22). The product label was not read for this row. No price written: set it in Inventory when SiteOne quotes it.',
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

// Swaps the 12x April row of every v13 protocol to the new product; one audit row per protocol holds each row before and after.
async function swapStagedRows(knex, productId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windows = (await knex('lawn_protocol_windows').where({ window_key: APRIL_WINDOW }).select('id', 'lawn_protocol_id'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select('id', 'product_id', 'product_name', 'gates');
    const old = rows.find((row) => row.product_name === OLD_NAME);
    if (!old || rows.some((row) => row.product_name === NEW_NAME)) continue;
    const gatesBefore = asObject(old.gates);
    const gatesAfter = { ...gatesBefore, ...NEW_GATES };
    await knex('lawn_protocol_products').where({ id: old.id }).update({
      product_name: NEW_NAME, product_id: productId, gates: JSON.stringify(gatesAfter), updated_at: knex.fn.now(),
    });
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: window.lawn_protocol_id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: window.lawn_protocol_id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({
        oldTargetN: OLD_TARGET_N,
        rows: [{
          rowId: old.id,
          before: { product_name: old.product_name, product_id: old.product_id ?? null, gates: gatesBefore },
          after: { product_name: NEW_NAME, product_id: productId, gates: gatesAfter },
        }],
      }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
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
    throw new Error(`lawn v13 April 44-0-0: a catalog row named "${NEW_NAME}" already exists; this migration only inserts. Remove or rename it (catalog id ${matches.join(', ')}) and run this migration again. Nothing was written.`);
  } else {
    productId = await insertCatalog(knex);
  }
  await swapStagedRows(knex, productId);
};

// ── down ─────────────────────────────────────────────────────────────────────

// Any table that holds a foreign key to the product: a row there means the product is in use.
async function productReferenced(knex, productId) {
  const { rows } = await knex.raw(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'products_catalog'::regclass
  `);
  for (const { tbl, col } of rows) {
    if (await knex(tbl).where({ [col]: productId }).first(col)) return true;
  }
  return false;
}

// A recorded April row is still exactly what up() wrote: same name, same product id, same gates.
async function rowAsWritten(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first('id', 'product_name', 'product_id', 'gates');
  return Boolean(row) && row.product_name === record.after.product_name && String(row.product_id) === String(record.after.product_id)
    && isDeepStrictEqual(asObject(row.gates), asObject(record.after.gates));
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const protocolLogs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  if (!protocolLogs.length && !catalogLogs.length) return;

  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-april-polymer-n] rollback did nothing: a scheduled visit or completion references ${V13_VERSION}`);
    return;
  }
  const records = protocolLogs.flatMap((log) => asObject(log.after_snapshot).rows || []);
  for (const record of records) {
    if (!(await rowAsWritten(knex, record))) {
      console.log(`[lawn-v13-april-polymer-n] rollback did nothing: April row ${record.rowId} is no longer exactly as written`);
      return;
    }
  }

  for (const record of records) {
    await knex('lawn_protocol_products').where({ id: record.rowId }).update({
      product_name: record.before.product_name, product_id: record.before.product_id, gates: JSON.stringify(asObject(record.before.gates)), updated_at: knex.fn.now(),
    });
  }
  for (const log of protocolLogs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();

  for (const log of catalogLogs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted) {
      const row = await knex('products_catalog').where({ id: productId }).first();
      // Unchanged: every written field as written (the workflow values too), and no price set on the row since.
      const unchanged = row && Object.entries(inserted).every(([column, value]) => same(row[column], value))
        && PRICE_FIELDS.every((column) => row[column] == null);
      if (unchanged && !(await productReferenced(knex, productId))) await knex('products_catalog').where({ id: productId }).del();
      else console.log('[lawn-v13-april-polymer-n] catalog row kept: it was changed, priced or is in use');
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.APRIL_WINDOW = APRIL_WINDOW;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.APRIL_RATE = APRIL_RATE;
exports.OLD_TARGET_N = OLD_TARGET_N;
exports.NEW_GATES = NEW_GATES;
exports.CATALOG = CATALOG;
exports.INSERT_DEFAULTS = INSERT_DEFAULTS;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: NEW_NAME, rule: WATERING_RULE }];
exports.SUMMARY = SUMMARY;
exports.PRECAUTION = PRECAUTION;
